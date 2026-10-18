import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store';

it('keeps the Runs of a version-1 database and adds the clone column to them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const path = join(dir, 'orchestrator.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, ticket_id TEXT NOT NULL, title TEXT NOT NULL,
      state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, pr_url TEXT, note TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    INSERT INTO runs (project, ticket_id, title, state, attempt, pr_url, started_at, ended_at) VALUES ('thaivis', 'tv-1', 'old Run', 'in-review', 1, 'https://pr/1', 5, 9);
    PRAGMA user_version = 1`);
    old.close();

    const store = openStore(path);
    const [row] = store.history(10);
    assert.deepEqual(
      [row.ticketId, row.state, row.prUrl, row.prBase, row.startedAt, row.endedAt, row.cloneDir, row.archivedAt, row.model, row.usage],
      ['tv-1', 'in-review', 'https://pr/1', null, 5, 9, null, null, null, {}],
    );
    store.updateRun(row.id, { cloneDir: '/clones/x' });
    assert.equal(store.getRun(row.id)?.cloneDir, '/clones/x');
    assert.equal(openStore(path).getRun(row.id)?.cloneDir, '/clones/x'); // reopening migrates nothing twice
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('lists needs-attention Runs as live but not as slot holders, and ended Runs as history', () => {
  const store = openStore(':memory:');
  const run = (project: string, state: Parameters<typeof store.insertRun>[0]['state']) =>
    store.insertRun({ project, ticketId: `${project}-1`, title: 't', state, startedAt: 1 });
  run('a', 'agent');
  run('b', 'needs-attention');
  run('c', 'killed');
  assert.deepEqual(store.liveRuns().map((r) => r.project), ['a', 'b']);
  assert.deepEqual(store.slotProjects(), ['a']);
  assert.deepEqual(store.history(10).map((r) => r.project), ['c']);
  assert.equal(store.getRun(999), undefined);
});

it('lists archived Runs apart from the history, and deletes a Run', () => {
  const store = openStore(':memory:');
  const run = (ticketId: string) => store.insertRun({ project: 'a', ticketId, title: 't', state: 'merged', startedAt: 1 });
  const [kept, shelved, gone] = [run('kept'), run('shelved'), run('gone')];
  store.updateRun(shelved, { archivedAt: 5 });
  store.deleteRun(gone);
  assert.deepEqual(store.history(10).map((r) => [r.ticketId, r.archivedAt]), [['kept', null]]);
  assert.deepEqual(store.archived(10).map((r) => [r.ticketId, r.archivedAt]), [['shelved', 5]]);
  assert.equal(store.getRun(gone), undefined);
  assert.equal(store.getRun(kept)?.ticketId, 'kept');
});

it('lists every Run for the Stats page, live and archived ones too, oldest first', () => {
  const store = openStore(':memory:');
  const run = (ticketId: string, state: Parameters<typeof store.insertRun>[0]['state']) => store.insertRun({ project: 'a', ticketId, title: 't', state, startedAt: 1 });
  run('ended', 'merged');
  store.updateRun(run('shelved', 'merged'), { archivedAt: 5 });
  run('live', 'agent');
  assert.deepEqual(store.allRuns().map((r) => r.ticketId), ['ended', 'shelved', 'live']);
});

it('keeps a Run\'s host job across a reopen, and has none until one is saved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const path = join(dir, 'orchestrator.db');
    const store = openStore(path);
    const id = store.insertRun({ project: 'thaivis', ticketId: 'tv-1', title: 't', state: 'host', startedAt: 1 });
    assert.equal(store.hostJob(id), null);
    store.setHostJob(id, '{"tip":"abc"}');
    assert.equal(openStore(path).hostJob(id), '{"tip":"abc"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps each agent\'s latest usage under its log part name', () => {
  const store = openStore(':memory:');
  const id = store.insertRun({ project: 'a', ticketId: 'a-1', title: 't', state: 'agent', startedAt: 1 });
  store.setUsage(id, 'attempt1-implement', { context: 10, tokens: 20 });
  store.setUsage(id, 'attempt1-review', { context: 5, tokens: 6 });
  store.setUsage(id, 'attempt1-implement', { context: 30, tokens: 90 });
  assert.deepEqual(store.getRun(id)?.usage, { 'attempt1-implement': { context: 30, tokens: 90 }, 'attempt1-review': { context: 5, tokens: 6 } });
});

it("keeps a Project's Backlog counts only when they change from its last ones, across a reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const path = join(dir, 'orchestrator.db');
    const store = openStore(path);
    store.recordBacklog('a', 1, { backlog: 5, ready: 2 });
    store.recordBacklog('a', 2, { backlog: 5, ready: 2 });
    store.recordBacklog('b', 3, { backlog: 5, ready: 2 });
    store.recordBacklog('a', 4, { backlog: 6, ready: 2 });
    openStore(path).recordBacklog('a', 5, { backlog: 6, ready: 2 }); // a restart compares against the stored row
    store.recordBacklog('a', 6, { backlog: 5, ready: 2 });
    store.recordBacklog('a', 7, { backlog: 5, ready: 3 });
    assert.deepEqual(store.backlogHistory(), [
      { project: 'a', at: 1, backlog: 5, ready: 2 },
      { project: 'b', at: 3, backlog: 5, ready: 2 },
      { project: 'a', at: 4, backlog: 6, ready: 2 },
      { project: 'a', at: 6, backlog: 5, ready: 2 },
      { project: 'a', at: 7, backlog: 5, ready: 3 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('migrates a version-8 database: its Runs have no reports, and reports saved on one survive a reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const path = join(dir, 'orchestrator.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, ticket_id TEXT NOT NULL, title TEXT NOT NULL,
      state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, pr_url TEXT, note TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
      clone_dir TEXT, host_job TEXT, archived_at INTEGER, model TEXT, usage TEXT, pr_base TEXT, pr_closed_at INTEGER
    );
    INSERT INTO runs (project, ticket_id, title, state, started_at) VALUES ('thaivis', 'tv-1', 'old Run', 'merged', 5);
    PRAGMA user_version = 8`);
    old.close();

    const store = openStore(path);
    const [row] = store.history(10);
    assert.equal(row.reports, null);
    const reports = { followUps: [], friction: [{ id: 'ysz-1', title: 'no php', seenAgain: false }] };
    store.setReports(row.id, reports);
    assert.deepEqual(openStore(path).getRun(row.id)?.reports, reports);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

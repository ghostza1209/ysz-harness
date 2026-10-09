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
      [row.ticketId, row.state, row.prUrl, row.startedAt, row.endedAt, row.cloneDir],
      ['tv-1', 'in-review', 'https://pr/1', 5, 9, null],
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

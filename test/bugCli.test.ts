import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bugCommand, probePort, type BugDeps } from '../src/bugCli';
import type { Facts } from '../src/bugReport';
import { openStore, type RunState } from '../src/store';

const facts: Facts = { 'ysz-version': 'abc1234', modified: 'no', os: 'linux x64', node: 'v22', docker: 'Docker 27', bd: 'bd 1', gh: 'gh 2', claude: '2.1' };
const NOW = 10 * 3_600_000;

/** A checkout in a temp dir with the given Runs (ids 1.. in order), each with an optional host log. */
function setup(runs: { ticketId: string; state: RunState; note?: string; log?: string; endedAt?: number }[]) {
  const root = mkdtempSync(join(tmpdir(), 'ysz-bug-'));
  mkdirSync(join(root, 'data/logs'), { recursive: true });
  const store = openStore(join(root, 'data/orchestrator.db'));
  for (const r of runs) {
    const id = store.insertRun({ project: 'p', ticketId: r.ticketId, title: `title of ${r.ticketId}`, state: 'claimed', startedAt: NOW - 3_600_000 });
    store.updateRun(id, { state: r.state, note: r.note ?? null, endedAt: r.endedAt ?? null });
    if (r.log !== undefined) writeFileSync(join(root, `data/logs/${id}-host.log`), r.log);
  }
  return root;
}

/** Fake deps recording what the CLI printed and opened, in order. `answers` are what the reporter types. */
function harness(root: string, over: Partial<BugDeps> & { answers?: string[]; up?: boolean } = {}) {
  const events: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const answers = [...(over.answers ?? [])];
  const deps: BugDeps = {
    root,
    now: NOW,
    facts: async () => facts,
    loadProjects: async () => [],
    yszUp: async () => {
      events.push('probe');
      return over.up ?? false;
    },
    open: (target, reveal) => events.push(`${reveal ? 'reveal' : 'open'} ${target}`),
    interactive: true,
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...over,
  };
  return { deps, events, out, err, prompts };
}
const reports = (root: string) => (existsSync(join(root, 'data/bug-reports')) ? readdirSync(join(root, 'data/bug-reports')) : []);
const opened = (event: string) => new URL(event.replace(/^open /, ''));

describe('npm run bug <ticket-id>', () => {
  it('writes the redacted excerpt of a failed Run, reveals it, then opens the link', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'failed', note: 'Attempt 1 failed: no commits', log: 'host line\n' }]);
    const h = harness(root);
    assert.equal(await bugCommand('x-1', h.deps), 0);
    const file = join(root, 'data/bug-reports/x-1-run1.log');
    assert.match(readFileSync(file, 'utf8'), /^ysz Bug report: x-1, Run 1\nState: failed\n[\s\S]*--- host ---\nhost line/);
    assert.equal(h.events.length, 2);
    assert.equal(h.events[0], `reveal ${file}`);
    const link = opened(h.events[1]);
    assert.deepEqual([link.searchParams.get('run-state'), link.searchParams.get('title'), link.searchParams.get('node')], ['failed', 'No commits', 'v22']);
    assert.ok(h.out.includes(file) && h.out.includes(link.href));
    assert.match(h.out.join('\n'), /Drag the file into the form's Run log excerpt field\. The issue and the file are public\./);
    assert.equal(h.events.includes('probe'), false); // nothing holds a slot: no port probe
  });

  it('reports the newest reportable Run of the Ticket and overwrites its file on a rerun', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'failed', note: 'Attempt 1 failed: old' }, { ticketId: 'x-1', state: 'killed' }, { ticketId: 'x-2', state: 'failed', note: 'other' }]);
    await bugCommand('x-1', harness(root).deps);
    assert.deepEqual(reports(root), ['x-1-run2.log']);
    writeFileSync(join(root, 'data/bug-reports/x-1-run2.log'), 'stale');
    await bugCommand('x-1', harness(root).deps);
    assert.match(readFileSync(join(root, 'data/bug-reports/x-1-run2.log'), 'utf8'), /^ysz Bug report: x-1, Run 2/);
  });

  it('a live Run with ysz answering exits 1 saying Kill it first, and writes and opens nothing', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'agent' }]);
    const h = harness(root, { up: true });
    assert.equal(await bugCommand('x-1', h.deps), 1);
    assert.deepEqual(h.err, ["x-1's Run is live: Kill it first (its newest Run holds a slot and ysz answers)."]);
    assert.deepEqual(h.events, ['probe']);
    assert.deepEqual(reports(root), []);
  });

  it('the same live Run with ysz silent is reported', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'agent' }]);
    const h = harness(root, { up: false });
    assert.equal(await bugCommand('x-1', h.deps), 0);
    assert.deepEqual(reports(root), ['x-1-run1.log']);
    assert.equal(h.events.length, 3); // probe, reveal, open
  });

  it('an unknown id exits 1 with one line and writes nothing', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'failed' }]);
    const h = harness(root);
    assert.equal(await bugCommand('nope-9', h.deps), 1);
    assert.deepEqual(h.err, ['No Run of nope-9.']);
    assert.deepEqual([h.events, reports(root)], [[], []]);
  });

  it('a Ticket whose only Run merged exits 1 with the general-report hint', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'merged' }]);
    const h = harness(root);
    assert.equal(await bugCommand('x-1', h.deps), 1);
    assert.deepEqual(h.err, ["x-1's Run reached its goal: run npm run bug with no argument for a general report."]);
    assert.deepEqual([h.events, reports(root)], [[], []]);
  });

  it('a Project config that throws gives the general report, prints the error and writes no file', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'failed', note: 'Attempt 1 failed: x', log: 'secret log\n' }]);
    const h = harness(root, { loadProjects: async () => { throw new Error('projects.json: Unexpected token'); } });
    assert.equal(await bugCommand('x-1', h.deps), 0);
    assert.match(h.out.join('\n'), /cannot load[\s\S]*projects\.json: Unexpected token/);
    assert.deepEqual(reports(root), []);
    assert.equal(h.events.length, 1);
    const link = opened(h.events[0]);
    assert.deepEqual([link.searchParams.has('run-state'), link.searchParams.has('note'), link.searchParams.has('title')], [false, false, false]);
  });

  it('a Project config that throws skips the picker too', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'failed' }]);
    const h = harness(root, { loadProjects: async () => { throw new Error('bad config'); } });
    await bugCommand(undefined, h.deps);
    assert.deepEqual(h.prompts, []);
    assert.match(h.out.join('\n'), /bad config/);
  });
});

describe('npm run bug with no argument', () => {
  const runs = Array.from({ length: 12 }, (_, i) => ({ ticketId: `x-${i + 1}`, state: 'failed' as RunState, endedAt: NOW - (12 - i) * 60_000 }));

  it('lists the newest 10 reportable Runs, numbered with state, Ticket id, title and age; a number picks one', async () => {
    const root = setup([{ ticketId: 'old-1', state: 'merged' }, ...runs]);
    const h = harness(root, { answers: ['2'] });
    assert.equal(await bugCommand(undefined, h.deps), 0);
    assert.equal(h.out[0], '1. failed  x-12  title of x-12  (1m ago)');
    assert.equal(h.out[9], '10. failed  x-3  title of x-3  (10m ago)');
    assert.equal(h.out.some((l) => l.includes('x-2  ') || l.includes('old-1')), false);
    assert.deepEqual(reports(root), ['x-11-run12.log']);
  });

  it('Enter alone opens the general report and writes no file', async () => {
    const root = setup(runs);
    const h = harness(root, { answers: [''] });
    assert.equal(await bugCommand(undefined, h.deps), 0);
    assert.deepEqual(reports(root), []);
    assert.equal(h.events.length, 1);
    assert.equal(opened(h.events[0]).searchParams.has('run-state'), false);
  });

  it('anything else asks again', async () => {
    const root = setup(runs);
    const h = harness(root, { answers: ['abc', '0', '11', '3'] });
    assert.equal(await bugCommand(undefined, h.deps), 0);
    assert.equal(h.prompts.length, 4);
    assert.deepEqual(reports(root), ['x-10-run10.log']);
  });

  it('stdin not a terminal, or no reportable Run: the general report, saying why', async () => {
    const piped = harness(setup(runs), { interactive: false });
    assert.equal(await bugCommand(undefined, piped.deps), 0);
    assert.match(piped.out[0], /not a terminal/);
    assert.equal(piped.events.length, 1);

    const none = harness(setup([{ ticketId: 'x-1', state: 'merged' }]));
    assert.equal(await bugCommand(undefined, none.deps), 0);
    assert.match(none.out[0], /No Run to report/);
    assert.deepEqual(none.prompts, []);
  });

  it('lists a stuck Run only when ysz is down, by how long ago it started, probing the port just once', async () => {
    const root = setup([{ ticketId: 'x-1', state: 'agent' }, { ticketId: 'x-2', state: 'host' }]);
    const down = harness(root, { answers: [''] });
    await bugCommand(undefined, down.deps);
    assert.deepEqual(down.out.slice(0, 2), ['1. host  x-2  title of x-2  (1h ago)', '2. agent  x-1  title of x-1  (1h ago)']);
    assert.equal(down.events.filter((e) => e === 'probe').length, 1);

    const up = harness(root, { up: true });
    await bugCommand(undefined, up.deps);
    assert.match(up.out[0], /No Run to report/);
  });
});

describe('probePort', () => {
  it('is true for a listening port and false once it is closed', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    assert.equal(await probePort(port), true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(await probePort(port), false);
  });
});

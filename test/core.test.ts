import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { BeadsGateway, Ticket } from '../src/beads';
import { createOrchestrator } from '../src/core';
import type { Project } from '../src/projects';
import { openStore, type RunState, type Store } from '../src/store';

const projects: Project[] = ['fazwaz', 'PopDeal', 'thaivis'].map((name) => ({ name, repoPath: `/repos/${name}`, baseBranch: 'main' }));

/** Each Project's bd queue, or the error its bd call fails with. */
type Queues = Record<string, Ticket[] | Error>;

function ticket(id: string, priority: number, createdAt: string): Ticket {
  return { id, title: `title of ${id}`, priority, createdAt };
}

const fakeBeads = (queues: Queues): BeadsGateway => ({
  async listReady(project) {
    const queue = queues[project.name];
    if (queue instanceof Error) throw queue;
    return queue ?? [];
  },
});

let store: Store;
let queues: Queues;
let now: number;

beforeEach(() => {
  store = openStore(':memory:');
  queues = {};
  now = Date.parse('2026-10-08T12:00:00Z');
});

async function polled() {
  const orchestrator = createOrchestrator({ projects, beads: fakeBeads(queues), store, clock: { now: () => now } });
  await orchestrator.poll();
  return orchestrator;
}

const order = (o: Awaited<ReturnType<typeof polled>>) => o.readyQueue().map((t) => t.id);
const startRun = (project: string, state: RunState) => store.insertRun({ project, ticketId: `${project}-run`, state });

describe('pick order', () => {
  it('ranks priority across Projects before age', async () => {
    queues = {
      fazwaz: [ticket('fz-old-p2', 2, '2026-01-01T00:00:00Z')],
      PopDeal: [ticket('pd-new-p1', 1, '2026-09-01T00:00:00Z')],
      thaivis: [ticket('tv-p0', 0, '2026-10-01T00:00:00Z'), ticket('tv-p3', 3, '2026-01-01T00:00:00Z')],
    };
    assert.deepEqual(order(await polled()), ['tv-p0', 'pd-new-p1', 'fz-old-p2', 'tv-p3']);
  });

  it('round-robins Projects on equal priority', async () => {
    queues = {
      fazwaz: [ticket('fz1', 2, '2026-01-01T00:00:00Z'), ticket('fz2', 2, '2026-01-02T00:00:00Z'), ticket('fz3', 2, '2026-01-03T00:00:00Z')],
      PopDeal: [ticket('pd1', 2, '2026-05-01T00:00:00Z'), ticket('pd2', 2, '2026-05-02T00:00:00Z')],
      thaivis: [ticket('tv1', 2, '2026-09-01T00:00:00Z')],
    };
    assert.deepEqual(order(await polled()), ['fz1', 'pd1', 'tv1', 'fz2', 'pd2', 'fz3']);
  });

  it('restarts the round-robin for each priority tier', async () => {
    queues = {
      fazwaz: [ticket('fz-p1', 1, '2026-01-01T00:00:00Z'), ticket('fz-p2', 2, '2026-01-01T00:00:00Z')],
      PopDeal: [ticket('pd-p1', 1, '2026-01-01T00:00:00Z'), ticket('pd-p2', 2, '2026-01-01T00:00:00Z')],
    };
    assert.deepEqual(order(await polled()), ['fz-p1', 'pd-p1', 'fz-p2', 'pd-p2']);
  });

  it('takes the oldest first within a Project, whatever order bd returned', async () => {
    queues = {
      fazwaz: [
        ticket('fz-b', 2, '2026-03-01T00:00:00Z'),
        ticket('fz-newest', 2, '2026-04-01T00:00:00Z'),
        ticket('fz-oldest', 2, '2026-02-01T00:00:00Z'),
        ticket('fz-a', 2, '2026-03-01T00:00:00Z'),
      ],
    };
    assert.deepEqual(order(await polled()), ['fz-oldest', 'fz-a', 'fz-b', 'fz-newest']);
  });
});

describe('wait reasons with 2 slots, 1 per Project', () => {
  // Pick order: fz1, pd1, tv1, fz2
  beforeEach(() => {
    queues = {
      fazwaz: [ticket('fz1', 2, '2026-01-01T00:00:00Z'), ticket('fz2', 2, '2026-01-02T00:00:00Z')],
      PopDeal: [ticket('pd1', 2, '2026-01-01T00:00:00Z')],
      thaivis: [ticket('tv1', 2, '2026-01-01T00:00:00Z')],
    };
  });
  const reasons = (o: Awaited<ReturnType<typeof polled>>) => o.readyQueue().map((t) => `${t.id}: ${t.waitReason}`);

  it('with no Run, the first two Projects are next up and the rest wait', async () => {
    assert.deepEqual(reasons(await polled()), [
      'fz1: next up',
      'pd1: next up',
      'tv1: waiting for slot',
      'fz2: Project already has a Run',
    ]);
  });

  it('with one Run, a Project that has it is blocked and one slot is left', async () => {
    startRun('thaivis', 'agent');
    const o = await polled();
    assert.deepEqual(reasons(o), [
      'fz1: next up',
      'pd1: waiting for slot',
      'tv1: Project already has a Run',
      'fz2: Project already has a Run',
    ]);
    assert.deepEqual(o.slots(), { used: 1, total: 2 });
  });

  it('with both slots busy, only a Project without a Run waits for a slot', async () => {
    startRun('fazwaz', 'claimed');
    startRun('PopDeal', 'host');
    const o = await polled();
    assert.deepEqual(reasons(o), [
      'fz1: Project already has a Run',
      'pd1: Project already has a Run',
      'tv1: waiting for slot',
      'fz2: Project already has a Run',
    ]);
    assert.deepEqual(o.slots(), { used: 2, total: 2 });
  });

  it('a needs-attention or finished Run frees its slot', async () => {
    startRun('fazwaz', 'needs-attention');
    startRun('PopDeal', 'in-review');
    const o = await polled();
    assert.deepEqual(reasons(o), [
      'fz1: next up',
      'pd1: next up',
      'tv1: waiting for slot',
      'fz2: Project already has a Run',
    ]);
    assert.deepEqual(o.slots(), { used: 0, total: 2 });
  });
});

describe('polling', () => {
  it('reports each Ticket age from the clock', async () => {
    queues = { fazwaz: [ticket('fz1', 2, '2026-10-08T11:30:00Z'), ticket('fz2', 2, '2026-10-05T12:00:00Z')] };
    const o = await polled();
    assert.deepEqual(
      o.readyQueue().map((t) => [t.id, t.ageMs]),
      [['fz2', 259_200_000], ['fz1', 1_800_000]],
    );
  });

  it('a failing Project does not hide the others and reports its error', async () => {
    queues = {
      fazwaz: new Error('bd timed out after 30000ms'),
      PopDeal: [ticket('pd1', 2, '2026-01-01T00:00:00Z')],
    };
    const o = await polled();
    assert.deepEqual(order(o), ['pd1']);
    assert.deepEqual(o.projectStatuses(), [
      { name: 'fazwaz', ready: 0, error: 'bd timed out after 30000ms' },
      { name: 'PopDeal', ready: 1, error: null },
      { name: 'thaivis', ready: 0, error: null },
    ]);
  });

  it('keeps the last known Tickets of a Project whose poll fails, and recovers on the next', async () => {
    queues = { fazwaz: [ticket('fz1', 2, '2026-01-01T00:00:00Z')] };
    const o = await polled();
    queues.fazwaz = new Error('boom');
    await o.poll();
    assert.deepEqual(order(o), ['fz1']);
    assert.equal(o.projectStatuses()[0].error, 'boom');

    queues.fazwaz = [ticket('fz9', 2, '2026-01-01T00:00:00Z')];
    await o.poll();
    assert.deepEqual(order(o), ['fz9']);
    assert.equal(o.projectStatuses()[0].error, null);
  });
});

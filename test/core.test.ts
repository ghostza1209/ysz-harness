import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { BeadsGateway, Ticket } from '../src/beads';
import { createOrchestrator } from '../src/core';
import type { HostSteps } from '../src/host';
import type { Project } from '../src/projects';
import type { AgentResult, SandboxRunner } from '../src/sandbox';
import { openStore, type RunState, type Store } from '../src/store';

const projects: Project[] = ['fazwaz', 'PopDeal', 'thaivis'].map((name) => ({ name, repoPath: `/repos/${name}`, baseBranch: 'main', image: 'img' }));

/** Each Project's bd queue, or the error its bd call fails with. */
type Queues = Record<string, Ticket[] | Error>;

function ticket(id: string, priority: number, createdAt: string): Ticket {
  return { id, title: `title of ${id}`, priority, createdAt };
}

const PR_URL = 'https://github.com/thaivis/app/pull/7';

/** Every bead write and host step, as "<op> <project>/<id>" lines in the order they happened. */
let writes: string[];
let hostSteps: string[];
/** Tickets another actor claims first ("project/id"), and the claim error of a broken Project, by name. */
let lostClaims: Set<string>;
let claimErrors: Record<string, Error>;
let failError: Error | undefined;
/** What each agent was asked: "<role> attempt <n> <summary of the previous Attempt, if any>". */
let agentCalls: string[];
let agent: (attempt: number) => Promise<AgentResult>;
let reviewer: (attempt: number) => Promise<AgentResult>;
let publish: () => Promise<string>;
let publishOpts: unknown;
/** What the host finds in a clone after its agent: commits ahead of base, or an error. */
let collected: (dir: string) => { tip: string; commits: number } | Error;
let clones: number;

const fakeBeads = (queues: Queues): BeadsGateway => ({
  async listReady(project) {
    const queue = queues[project.name];
    if (queue instanceof Error) throw queue;
    return queue ?? [];
  },
  async claim(project, id) {
    if (claimErrors[project.name]) throw claimErrors[project.name];
    writes.push(`claim ${project.name}/${id}`);
    return !lostClaims.has(`${project.name}/${id}`);
  },
  async release(project, id) {
    writes.push(`release ${project.name}/${id}`);
  },
  async fail(project, id, reason) {
    if (failError) throw failError;
    writes.push(`fail ${project.name}/${id}: ${reason}`);
  },
  async showContext(_project, id) {
    return { ticket: { id }, parent: null, closedBlockers: [] };
  },
  async markInReview(project, id, prUrl) {
    writes.push(`markInReview ${project.name}/${id} ${prUrl}`);
  },
});

const complete: AgentResult = { outcome: 'complete' };
const dirAttempt = (dir: string) => Number(dir.split('-').at(-1));

const fakeSandbox: SandboxRunner = {
  implement(req) {
    agentCalls.push(`implement attempt ${req.attempt} ${req.previousAttemptSummary ?? ''}`.trim());
    return agent(req.attempt);
  },
  review(req) {
    agentCalls.push(`review attempt ${req.attempt}`);
    return reviewer(req.attempt);
  },
};

const fakeHost: HostSteps = {
  async prepare(project, ticketId) {
    hostSteps.push(`prepare ${project.name}/${ticketId}`);
    return { branch: `agent/${ticketId}`, dir: `/clones/${ticketId}-${++clones}`, base: 'b'.repeat(40) };
  },
  async collect(_project, { dir }) {
    hostSteps.push(`collect ${dir}`);
    const found = collected(dir);
    if (found instanceof Error) throw found;
    return found;
  },
  async publish(_project, _ticket, { branch }, opts) {
    hostSteps.push(`publish ${branch}`);
    publishOpts = opts;
    return publish();
  },
  async removeClone({ dir }) {
    hostSteps.push(`removeClone ${dir}`);
  },
};

let store: Store;
let queues: Queues;
let now: number;

beforeEach(() => {
  store = openStore(':memory:');
  queues = {};
  now = Date.parse('2026-10-08T12:00:00Z');
  writes = [];
  hostSteps = [];
  lostClaims = new Set();
  claimErrors = {};
  failError = undefined;
  agentCalls = [];
  agent = async () => complete;
  reviewer = async () => complete;
  publish = async () => PR_URL;
  publishOpts = undefined;
  collected = () => ({ tip: 'a'.repeat(40), commits: 1 });
  clones = 0;
});

async function polled(registry: readonly Project[] = projects) {
  const orchestrator = createOrchestrator({
    projects: registry,
    beads: fakeBeads(queues),
    sandbox: fakeSandbox,
    host: fakeHost,
    store,
    clock: { now: () => now },
  });
  await orchestrator.poll();
  return orchestrator;
}

const order = (o: Awaited<ReturnType<typeof polled>>) => o.readyQueue().map((t) => t.id);
const startRun = (project: string, state: RunState) =>
  store.insertRun({ project, ticketId: `${project}-run`, title: 'a Run', state, startedAt: now });

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

/** Let started Runs advance to their first wait. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** An agent that keeps its Run in the agent state until the test lets it finish. */
function gatedAgent() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  agent = async () => {
    await gate;
    return complete;
  };
  return open;
}

describe('starting Runs', () => {
  it('claims the Tickets that are next up and shows their Runs in the agent state', async () => {
    queues = {
      fazwaz: [ticket('fz1', 2, '2026-01-01T00:00:00Z')],
      PopDeal: [ticket('pd1', 2, '2026-01-01T00:00:00Z')],
    };
    const finish = gatedAgent();
    const o = await polled();
    await o.tick();
    await flush();

    assert.deepEqual(writes, ['claim fazwaz/fz1', 'claim PopDeal/pd1']);
    assert.deepEqual(
      o.runs().live.map((r) => [r.project, r.ticketId, r.state, r.attempt]),
      [['fazwaz', 'fz1', 'agent', 1], ['PopDeal', 'pd1', 'agent', 1]],
    );
    assert.deepEqual(o.readyQueue(), []);
    finish();
    await o.whenIdle();
  });

  it('runs at most 2 Runs in total and 1 per Project, and fills freed slots on the next tick', async () => {
    queues = {
      fazwaz: [ticket('fz1', 2, '2026-01-01T00:00:00Z'), ticket('fz2', 2, '2026-01-02T00:00:00Z')],
      PopDeal: [ticket('pd1', 2, '2026-01-01T00:00:00Z')],
      thaivis: [ticket('tv1', 2, '2026-01-01T00:00:00Z')],
    };
    const finish = gatedAgent();
    const o = await polled();
    await o.tick();
    assert.deepEqual(writes, ['claim fazwaz/fz1', 'claim PopDeal/pd1']);
    assert.deepEqual(o.slots(), { used: 2, total: 2 });

    await o.tick(); // nothing is free
    assert.deepEqual(writes, ['claim fazwaz/fz1', 'claim PopDeal/pd1']);

    finish();
    await o.whenIdle();
    await o.tick();
    assert.deepEqual(writes.filter((w) => w.startsWith('claim')), ['claim fazwaz/fz1', 'claim PopDeal/pd1', 'claim fazwaz/fz2', 'claim thaivis/tv1']);
    await o.whenIdle(); // or these Runs write into the next test
  });

  it('skips a lost claim race quietly: no Run, and the free slot goes to the next Ticket', async () => {
    queues = {
      fazwaz: [ticket('fz1', 2, '2026-01-01T00:00:00Z')],
      PopDeal: [ticket('pd1', 2, '2026-01-01T00:00:00Z')],
      thaivis: [ticket('tv1', 2, '2026-01-01T00:00:00Z')],
    };
    lostClaims.add('fazwaz/fz1');
    const finish = gatedAgent();
    const o = await polled();
    await o.tick();

    assert.deepEqual(writes, ['claim fazwaz/fz1', 'claim PopDeal/pd1', 'claim thaivis/tv1']);
    assert.deepEqual(o.runs().live.map((r) => r.ticketId), ['pd1', 'tv1']);
    assert.deepEqual(o.projectStatuses().map((p) => p.error), [null, null, null]);
    finish();
    await o.whenIdle();
    assert.deepEqual(o.runs().history.map((r) => r.ticketId).sort(), ['pd1', 'tv1']);
  });

  it('shows a failing claim as the Project error and creates no Run', async () => {
    queues = { fazwaz: [ticket('fz1', 2, '2026-01-01T00:00:00Z')] };
    claimErrors.fazwaz = new Error('bd claim failed: no such repo');
    const o = await polled();
    await o.tick();
    assert.deepEqual(o.runs(), { live: [], history: [] });
    assert.equal(o.projectStatuses()[0].error, 'claiming fz1: bd claim failed: no such repo');
  });

  it('never claims a Ticket of a Project without a sandbox image', async () => {
    queues = { legacy: [ticket('lg1', 0, '2026-01-01T00:00:00Z')] };
    const o = await polled([{ name: 'legacy', repoPath: '/repos/legacy', baseBranch: 'main' }]);
    await o.tick();
    assert.deepEqual(writes, []);
    assert.deepEqual(o.readyQueue().map((t) => t.waitReason), ['not onboarded']);
  });
});

describe('a happy-path Run', () => {
  it('ends in-review: pushes via the host, marks the bead in review, removes the clone', async () => {
    queues = { thaivis: [ticket('tv1', 2, '2026-01-01T00:00:00Z')] };
    const o = await polled();
    await o.tick();
    await o.whenIdle();

    assert.deepEqual(writes, ['claim thaivis/tv1', 'markInReview thaivis/tv1 ' + PR_URL]);
    assert.deepEqual(hostSteps, ['prepare thaivis/tv1', 'collect /clones/tv1-1', 'publish agent/tv1', 'removeClone /clones/tv1-1']);
    assert.deepEqual(agentCalls, ['implement attempt 1', 'review attempt 1']);
    assert.deepEqual(publishOpts, { tip: undefined, reviewSkipped: undefined });
    assert.deepEqual(o.runs().live, []);
    assert.deepEqual(o.slots(), { used: 0, total: 2 });
    const [run] = o.runs().history;
    assert.deepEqual(
      { project: run.project, ticketId: run.ticketId, title: run.title, state: run.state, attempt: run.attempt, prUrl: run.prUrl, note: run.note },
      { project: 'thaivis', ticketId: 'tv1', title: 'title of tv1', state: 'in-review', attempt: 1, prUrl: PR_URL, note: null },
    );
  });

  it('does not claim the in-review Ticket again before the next poll', async () => {
    queues = { thaivis: [ticket('tv1', 2, '2026-01-01T00:00:00Z')] };
    const o = await polled();
    await o.tick();
    await o.whenIdle();
    await o.tick();
    assert.deepEqual(writes, ['claim thaivis/tv1', 'markInReview thaivis/tv1 ' + PR_URL]);
  });

  it('reports start and end times from the clock', async () => {
    queues = { thaivis: [ticket('tv1', 2, '2026-01-01T00:00:00Z')] };
    const finish = gatedAgent();
    const o = await polled();
    await o.tick();
    now += 90_000;
    finish();
    await o.whenIdle();
    const [run] = o.runs().history;
    assert.deepEqual([run.startedAt, run.endedAt], [Date.parse('2026-10-08T12:00:00Z'), Date.parse('2026-10-08T12:01:30Z')]);
  });
});

describe('a Run that does not reach a PR', () => {
  async function failedRun() {
    queues = { thaivis: [ticket('tv1', 2, '2026-01-01T00:00:00Z')] };
    const o = await polled();
    await o.tick();
    await o.whenIdle();
    return o;
  }
  const historyOf = (o: Awaited<ReturnType<typeof polled>>) => o.runs().history.map((r) => [r.state, r.attempt, r.note]);

  it('fails and releases when pushing the PR fails, keeping the clone and not retrying the agent', async () => {
    publish = async () => {
      throw new Error('git push failed: rejected');
    };
    const o = await failedRun();
    assert.deepEqual(writes, ['claim thaivis/tv1', 'release thaivis/tv1']);
    assert.deepEqual(hostSteps, ['prepare thaivis/tv1', 'collect /clones/tv1-1', 'publish agent/tv1']);
    assert.deepEqual(historyOf(o), [['failed', 1, 'git push failed: rejected']]);
  });

  it('does not pick the failed Ticket again while the process lives', async () => {
    publish = async () => {
      throw new Error('git push failed: rejected');
    };
    const o = await failedRun();
    await o.poll(); // the released bead is Ready again
    await o.tick();
    assert.deepEqual(writes, ['claim thaivis/tv1', 'release thaivis/tv1']);
  });

  it('falls back to a plain release, keeping the reason, when the failed hand-back itself fails', async () => {
    agent = async () => ({ outcome: 'needs-info', question: 'which API?' });
    failError = new Error('bd timed out');
    const o = await failedRun();
    assert.deepEqual(writes, ['claim thaivis/tv1', 'release thaivis/tv1']);
    assert.deepEqual(historyOf(o), [['failed', 1, 'The implement agent needs information:\nwhich API?\nhanding the Ticket back failed: bd timed out']]);
  });
});

describe('the Attempt policy', () => {
  async function run() {
    queues = { thaivis: [ticket('tv1', 2, '2026-01-01T00:00:00Z')] };
    const o = await polled();
    await o.tick();
    await o.whenIdle();
    return o;
  }
  const historyOf = (o: Awaited<ReturnType<typeof polled>>) => o.runs().history.map((r) => [r.state, r.attempt, r.note]);

  it('reviews on the same clone after implementing, and publishes what the clone holds', async () => {
    const o = await run();
    assert.deepEqual(agentCalls, ['implement attempt 1', 'review attempt 1']);
    assert.deepEqual(historyOf(o), [['in-review', 1, null]]);
    assert.deepEqual(publishOpts, { tip: undefined, reviewSkipped: undefined });
  });

  it('retries a thrown implement agent once, in a fresh clone, handing over the failure', async () => {
    agent = async (attempt) => {
      if (attempt === 1) throw new Error('idle for 600s');
      return complete;
    };
    const o = await run();
    assert.deepEqual(agentCalls, [
      'implement attempt 1',
      'implement attempt 2 Attempt 1 failed: the implement agent failed: idle for 600s',
      'review attempt 2',
    ]);
    assert.deepEqual(hostSteps, [
      'prepare thaivis/tv1',
      'removeClone /clones/tv1-1',
      'prepare thaivis/tv1',
      'collect /clones/tv1-2',
      'publish agent/tv1',
      'removeClone /clones/tv1-2',
    ]);
    assert.deepEqual(writes, ['claim thaivis/tv1', 'markInReview thaivis/tv1 ' + PR_URL]);
    assert.deepEqual(historyOf(o), [['in-review', 2, null]]);
  });

  it('retries an agent that stops without a signal, passing the end of its output', async () => {
    agent = async (attempt) => (attempt === 1 ? { outcome: 'stopped', tail: 'the build needs a database' } : complete);
    await run();
    assert.equal(agentCalls[1], 'implement attempt 2 Attempt 1 failed: the implement agent stopped without signalling COMPLETE: the build needs a database');
  });

  it('counts no commits as a failed Attempt, so there is no review of it', async () => {
    collected = (dir) => ({ tip: 'a'.repeat(40), commits: dirAttempt(dir) === 1 ? 0 : 2 });
    const o = await run();
    assert.deepEqual(agentCalls, ['implement attempt 1', 'implement attempt 2 Attempt 1 failed: the agent made no commits', 'review attempt 2']);
    assert.deepEqual(historyOf(o), [['in-review', 2, null]]);
  });

  it('counts a clone that cannot be read back as a failed Attempt', async () => {
    collected = (dir) => (dirAttempt(dir) === 1 ? new Error('refusing to read the clone: objects/info/alternates could point outside it') : { tip: 'a'.repeat(40), commits: 1 });
    await run();
    assert.equal(
      agentCalls[1],
      "implement attempt 2 Attempt 1 failed: the agent's commits could not be read back: refusing to read the clone: objects/info/alternates could point outside it",
    );
  });

  it('ends the Run failed when Attempt 2 fails too: one failed hand-back, no release, the clone kept', async () => {
    agent = async (attempt) => {
      throw new Error(`boom ${attempt}`);
    };
    const o = await run();
    assert.deepEqual(writes, [
      'claim thaivis/tv1',
      'fail thaivis/tv1: Attempt 1 failed: the implement agent failed: boom 1\nAttempt 2 failed: the implement agent failed: boom 2',
    ]);
    assert.deepEqual(hostSteps, ['prepare thaivis/tv1', 'removeClone /clones/tv1-1', 'prepare thaivis/tv1']);
    assert.deepEqual(historyOf(o), [
      ['failed', 2, 'Attempt 1 failed: the implement agent failed: boom 1\nAttempt 2 failed: the implement agent failed: boom 2'],
    ]);
    assert.deepEqual(o.slots(), { used: 0, total: 2 });
  });

  it('publishes the implement commits with a "review skipped" reason when the review agent throws', async () => {
    reviewer = async () => {
      throw new Error('idle for 600s');
    };
    const o = await run();
    assert.deepEqual(publishOpts, { tip: 'a'.repeat(40), reviewSkipped: 'the review agent failed: idle for 600s' });
    assert.deepEqual(historyOf(o), [['in-review', 1, null]]);
    assert.deepEqual(writes, ['claim thaivis/tv1', 'markInReview thaivis/tv1 ' + PR_URL]);
  });

  it('skips the review, not the PR, when the review agent stops without a signal', async () => {
    reviewer = async () => ({ outcome: 'stopped', tail: 'x' });
    await run();
    assert.deepEqual(publishOpts, { tip: 'a'.repeat(40), reviewSkipped: 'the review agent stopped without signalling COMPLETE' });
  });

  it('keeps the review-skipped reason to one line of at most 300 characters', async () => {
    reviewer = async () => {
      throw new Error(`line one\nline two ${'x'.repeat(400)}`);
    };
    await run();
    const { reviewSkipped } = publishOpts as { reviewSkipped: string };
    assert.equal(reviewSkipped.length, 300);
    assert.ok(reviewSkipped.startsWith('the review agent failed: line one line two xxx'));
  });

  it('ends failed with the question and no second Attempt when the implement agent needs info', async () => {
    agent = async () => ({ outcome: 'needs-info', question: 'Which of the two APIs?' });
    const o = await run();
    assert.deepEqual(agentCalls, ['implement attempt 1']);
    assert.deepEqual(writes, ['claim thaivis/tv1', 'fail thaivis/tv1: The implement agent needs information:\nWhich of the two APIs?']);
    assert.deepEqual(historyOf(o), [['failed', 1, 'The implement agent needs information:\nWhich of the two APIs?']]);
    assert.deepEqual(hostSteps, ['prepare thaivis/tv1']);
  });

  it('ends failed with the question and no second Attempt when the review agent needs info', async () => {
    reviewer = async () => ({ outcome: 'needs-info', question: 'Is the old export still wanted?' });
    const o = await run();
    assert.deepEqual(agentCalls, ['implement attempt 1', 'review attempt 1']);
    assert.deepEqual(writes, ['claim thaivis/tv1', 'fail thaivis/tv1: The review agent needs information:\nIs the old export still wanted?']);
    assert.deepEqual(historyOf(o), [['failed', 1, 'The review agent needs information:\nIs the old export still wanted?']]);
    assert.equal(publishOpts, undefined);
  });

  it('ends failed with the question when Attempt 2 needs info after a failed Attempt 1', async () => {
    agent = async (attempt) => (attempt === 1 ? { outcome: 'stopped', tail: '' } : { outcome: 'needs-info', question: 'Which API?' });
    const o = await run();
    assert.deepEqual(historyOf(o), [['failed', 2, 'The implement agent needs information:\nWhich API?']]);
  });
});

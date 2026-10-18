import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { createBeadsGateway } from '../src/beads';

const run = promisify(execFile);

/** These tests drive the real `bd` binary against a throwaway Beads repo. */
describe('Beads gateway against real bd', () => {
  let dir: string;
  let project: { name: string; repoPath: string; baseBranch: string };
  const ids: Record<string, string> = {};
  const env = { ...process.env, BEADS_ACTOR: 'tester' };

  const bd = (...args: string[]) => run('bd', args, { cwd: dir, env });
  async function create(key: string, title: string, ...flags: string[]) {
    ids[key] = (await bd('create', title, '--silent', ...flags)).stdout.trim();
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'beads-contract-'));
    project = { name: 'lab', repoPath: dir, baseBranch: 'main' };
    await bd('init', '-p', 'lab', '--non-interactive', '--skip-agents', '--skip-hooks');
    await create('ready', 'ready one', '-l', 'ready-for-agent', '-p', '1');
    await create('skipped', 'opted out', '-l', 'ready-for-agent,orchestrator:skip');
    await create('blocked', 'blocked', '-l', 'ready-for-agent');
    await create('blocker', 'the blocker');
    await bd('dep', 'add', ids.blocked, ids.blocker);
    await create('assigned', 'claimed by someone', '-l', 'ready-for-agent', '-a', 'someone');
    await create('unlabelled', 'no label');
    await create('parent', 'split into children');
    await create('child', 'open child', '--parent', ids.parent);
    await bd('update', ids.parent, '--add-label', 'ready-for-agent');
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('lists only unassigned, unblocked ready-for-agent Tickets without orchestrator:skip, and counts every unclosed bead', async () => {
    const { tickets, backlog } = await createBeadsGateway().listReady(project);
    assert.equal(backlog, 8);
    assert.deepEqual(
      tickets.map(({ id, title, priority }) => ({ id, title, priority })),
      [{ id: ids.ready, title: 'ready one', priority: 1 }],
    );
    assert.match(tickets[0].createdAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('releases a Ticket once its blocker is closed', async () => {
    await bd('close', ids.blocker, '-r', 'done');
    const found = (await createBeadsGateway().listReady(project)).tickets.map((t) => t.id).sort();
    assert.deepEqual(found, [ids.blocked, ids.ready].sort());
  });

  it('holds a parent back until every child is closed', async () => {
    await bd('close', ids.child, '-r', 'done');
    const found = (await createBeadsGateway().listReady(project)).tickets.map((t) => t.id).sort();
    assert.deepEqual(found, [ids.blocked, ids.parent, ids.ready].sort());
  });

  it('kills a bd call that runs past the timeout', async () => {
    await assert.rejects(createBeadsGateway({ timeoutMs: 1 }).listReady(project), /timed out after 1ms/);
  });

  it('does not wait on a bd that hangs', async () => {
    const hung = join(dir, 'hung-bd');
    await writeFile(hung, '#!/bin/sh\nexec sleep 60\n');
    await chmod(hung, 0o755);
    const started = Date.now();
    await assert.rejects(createBeadsGateway({ bin: hung, timeoutMs: 300 }).listReady(project), /timed out after 300ms/);
    assert.ok(Date.now() - started < 5_000);
  });

  const state = async (id: string) => {
    const [issue] = JSON.parse((await bd('show', id, '--json')).stdout);
    return { status: issue.status, assignee: issue.assignee ?? '', labels: issue.labels ?? [] };
  };

  it('claims a Ticket as orchestrator', async () => {
    await create('toClaim', 'to claim');
    assert.equal(await createBeadsGateway().claim(project, ids.toClaim), true);
    assert.deepEqual(await state(ids.toClaim), { status: 'in_progress', assignee: 'orchestrator', labels: [] });
  });

  it('reports a lost claim as false, leaving the other actor in place', async () => {
    await create('taken', 'taken by hand', '-a', 'someone');
    assert.equal(await createBeadsGateway().claim(project, ids.taken), false);
    assert.equal((await state(ids.taken)).assignee, 'someone');
  });

  it('lets exactly one of two simultaneous claimers win', async () => {
    await create('raced', 'raced');
    const [mine, rival] = await Promise.all([
      createBeadsGateway().claim(project, ids.raced),
      bd('--actor', 'rival', 'update', ids.raced, '--claim').then(() => true, () => false),
    ]);
    assert.equal(Number(mine) + Number(rival), 1);
    assert.equal((await state(ids.raced)).assignee, mine ? 'orchestrator' : 'rival');
  });

  it('throws instead of reporting a lost race when the claim fails for another reason', async () => {
    await assert.rejects(createBeadsGateway().claim(project, 'lab-nope'));
    await assert.rejects(createBeadsGateway().claim({ ...project, repoPath: join(dir, 'missing') }, ids.toClaim));
  });

  it('releases a claimed Ticket back to open and unassigned', async () => {
    await createBeadsGateway().release(project, ids.toClaim);
    assert.deepEqual(await state(ids.toClaim), { status: 'open', assignee: '', labels: [] });
  });

  it('marks a claimed Ticket in review with a PR comment, leaving it in_progress for the orchestrator', async () => {
    await createBeadsGateway().claim(project, ids.toClaim);
    await createBeadsGateway().markInReview(project, ids.toClaim, 'https://github.com/o/r/pull/9');
    assert.deepEqual(await state(ids.toClaim), { status: 'in_progress', assignee: 'orchestrator', labels: ['in-review'] });
    const [issue] = JSON.parse((await bd('show', ids.toClaim, '--json', '--include-comments')).stdout);
    assert.deepEqual(issue.comments.map((c: { author: string; text: string }) => [c.author, c.text]), [
      ['orchestrator', 'PR opened: https://github.com/o/r/pull/9'],
    ]);
  });

  /** A Ticket the Orchestrator claimed and marked in review, as a Run leaves it once its PR is open. */
  async function inReview(key: string, ...flags: string[]) {
    await create(key, key, ...flags);
    await createBeadsGateway().claim(project, ids[key]);
    await createBeadsGateway().markInReview(project, ids[key], 'https://github.com/o/r/pull/3');
  }

  it('closes an in-review Ticket whose PR merged, with the PR as the reason and in-review dropped, even with an open blocker', async () => {
    await inReview('merging', '-l', 'ready-for-agent');
    await create('lateBlocker', 'blocker added after the PR opened');
    await bd('dep', 'add', ids.merging, ids.lateBlocker);
    assert.equal(await createBeadsGateway().merged(project, ids.merging, 'https://github.com/o/r/pull/3'), true);
    const [issue] = JSON.parse((await bd('show', ids.merging, '--json')).stdout);
    assert.deepEqual([issue.status, issue.close_reason, issue.labels], ['closed', 'PR merged: https://github.com/o/r/pull/3', ['ready-for-agent']]);
  });

  it('hands back an in-review Ticket whose PR closed unmerged: commented, needs-info, not Ready', async () => {
    await inReview('rejected', '-l', 'ready-for-agent,keep-me');
    assert.equal(await createBeadsGateway().prClosed(project, ids.rejected, 'https://github.com/o/r/pull/3'), true);
    const { labels, ...rest } = await state(ids.rejected);
    assert.deepEqual({ ...rest, labels: labels.sort() }, { status: 'open', assignee: '', labels: ['keep-me', 'needs-info'] });
    const [issue] = JSON.parse((await bd('show', ids.rejected, '--json', '--include-comments')).stdout);
    assert.deepEqual(issue.comments.at(-1).text, 'PR closed unmerged: https://github.com/o/r/pull/3');
    assert.ok(!(await createBeadsGateway().listReady(project)).tickets.some((t) => t.id === ids.rejected));
  });

  it('writes nothing to an in-review Ticket the human already closed or took over', async () => {
    await inReview('closedByHand');
    await bd('close', ids.closedByHand, '-r', 'by hand', '--force');
    await inReview('takenOver', '-l', 'ready-for-agent');
    await bd('update', ids.takenOver, '--assignee', 'someone', '--force');

    assert.equal(await createBeadsGateway().merged(project, ids.closedByHand, 'https://github.com/o/r/pull/3'), false);
    assert.equal(await createBeadsGateway().prClosed(project, ids.takenOver, 'https://github.com/o/r/pull/3'), false);

    const [closed] = JSON.parse((await bd('show', ids.closedByHand, '--json')).stdout);
    assert.deepEqual([closed.status, closed.close_reason, closed.labels], ['closed', 'by hand', ['in-review']]);
    assert.deepEqual(await state(ids.takenOver), { status: 'in_progress', assignee: 'someone', labels: ['in-review', 'ready-for-agent'] });
  });

  it('hands a claimed Ticket back as failed: reason commented, needs-info added, ready-for-agent dropped, open and unassigned', async () => {
    await create('failing', 'will fail', '-l', 'ready-for-agent,keep-me');
    await createBeadsGateway().claim(project, ids.failing);
    const reason = 'Attempt 1 failed: the agent made no commits\nAttempt 2 failed: "quoted" -- and \'single\'';

    await createBeadsGateway().fail(project, ids.failing, reason);

    const { labels, ...rest } = await state(ids.failing);
    assert.deepEqual({ ...rest, labels: labels.sort() }, { status: 'open', assignee: '', labels: ['keep-me', 'needs-info'] });
    const [issue] = JSON.parse((await bd('show', ids.failing, '--json', '--include-comments')).stdout);
    assert.deepEqual(issue.comments.map((c: { author: string; text: string }) => [c.author, c.text]), [['orchestrator', reason]]);
    assert.ok(!(await createBeadsGateway().listReady(project)).tickets.some((t) => t.id === ids.failing));
  });

  it('re-queues a failed Ticket: needs-info dropped, ready-for-agent back, Ready again', async () => {
    await create('requeued', 'failed then retried', '-l', 'ready-for-agent,keep-me');
    await createBeadsGateway().claim(project, ids.requeued);
    await createBeadsGateway().fail(project, ids.requeued, 'the agent made no commits');

    await createBeadsGateway().requeue(project, ids.requeued);

    const { labels, ...rest } = await state(ids.requeued);
    assert.deepEqual({ ...rest, labels: labels.sort() }, { status: 'open', assignee: '', labels: ['keep-me', 'ready-for-agent'] });
    assert.ok((await createBeadsGateway().listReady(project)).tickets.some((t) => t.id === ids.requeued));
  });

  it('re-queues a Ticket that was only released, never labelled needs-info', async () => {
    await create('released', 'released on a failure', '-l', 'ready-for-agent');
    await createBeadsGateway().requeue(project, ids.released);
    assert.deepEqual(await state(ids.released), { status: 'open', assignee: '', labels: ['ready-for-agent'] });
  });

  it('leaves the Ticket claimed when the failed hand-back cannot even comment', async () => {
    await create('unfailable', 'cannot fail', '-l', 'ready-for-agent');
    await createBeadsGateway().claim(project, ids.unfailable);
    await assert.rejects(createBeadsGateway().fail({ ...project, repoPath: join(dir, 'missing') }, ids.unfailable, 'x'));
    assert.deepEqual(await state(ids.unfailable), { status: 'in_progress', assignee: 'orchestrator', labels: ['ready-for-agent'] });
  });

  it('hands a killed Ticket back: reason commented, orchestrator:skip added, ready-for-agent kept, open and unassigned, never Ready again', async () => {
    await create('killing', 'will be killed', '-l', 'ready-for-agent,keep-me');
    await createBeadsGateway().claim(project, ids.killing);

    await createBeadsGateway().kill(project, ids.killing, 'Killed from the dashboard while agent.');

    const { labels, ...rest } = await state(ids.killing);
    assert.deepEqual({ ...rest, labels: labels.sort() }, { status: 'open', assignee: '', labels: ['keep-me', 'orchestrator:skip', 'ready-for-agent'] });
    const [issue] = JSON.parse((await bd('show', ids.killing, '--json', '--include-comments')).stdout);
    assert.deepEqual(issue.comments.map((c: { author: string; text: string }) => [c.author, c.text]), [['orchestrator', 'Killed from the dashboard while agent.']]);
    assert.ok(!(await createBeadsGateway().listReady(project)).tickets.some((t) => t.id === ids.killing));
  });

  it('leaves the Ticket claimed when the kill hand-back cannot even comment', async () => {
    await create('unkillable', 'cannot kill', '-l', 'ready-for-agent');
    await createBeadsGateway().claim(project, ids.unkillable);
    await assert.rejects(createBeadsGateway().kill({ ...project, repoPath: join(dir, 'missing') }, ids.unkillable, 'x'));
    assert.deepEqual(await state(ids.unkillable), { status: 'in_progress', assignee: 'orchestrator', labels: ['ready-for-agent'] });
  });

  it('lists the Tickets the orchestrator holds, bar in-review ones, other actors\' and open ones', async () => {
    await create('held', 'held', '-l', 'ready-for-agent');
    await create('reviewed', 'in review');
    await create('hers', 'someone else\'s', '-a', 'someone');
    await create('idle', 'idle');
    await createBeadsGateway().claim(project, ids.held);
    await createBeadsGateway().claim(project, ids.reviewed);
    await createBeadsGateway().markInReview(project, ids.reviewed, 'https://github.com/o/r/pull/1');
    await bd('update', ids.hers, '--status', 'in_progress');

    const claimed = await createBeadsGateway().listClaimed(project);

    assert.ok(claimed.includes(ids.held));
    for (const key of ['reviewed', 'hers', 'idle', 'ready']) assert.ok(!claimed.includes(ids[key]), key);
  });

  it('hands an interrupted Ticket back: reason commented, open and unassigned, labels kept, Ready again', async () => {
    await create('interrupted', 'will be interrupted', '-l', 'ready-for-agent,keep-me');
    await createBeadsGateway().claim(project, ids.interrupted);

    await createBeadsGateway().interrupt(project, ids.interrupted, 'Interrupted by an Orchestrator restart while agent.');

    const { labels, ...rest } = await state(ids.interrupted);
    assert.deepEqual({ ...rest, labels: labels.sort() }, { status: 'open', assignee: '', labels: ['keep-me', 'ready-for-agent'] });
    const [issue] = JSON.parse((await bd('show', ids.interrupted, '--json', '--include-comments')).stdout);
    assert.deepEqual(issue.comments.map((c: { author: string; text: string }) => [c.author, c.text]), [['orchestrator', 'Interrupted by an Orchestrator restart while agent.']]);
    assert.ok((await createBeadsGateway().listReady(project)).tickets.some((t) => t.id === ids.interrupted));
  });

  /** bd leases last 5 minutes and no setting shortens them, so age every lease straight in its Dolt table, as if that long had passed. */
  const expireLeases = () =>
    run('dolt', ['sql', '-q', "update leases set lease_expires_at = '2020-01-01 00:00:00'"], { cwd: join(dir, '.beads', 'embeddeddolt', 'lab') });

  it('keeps in-flight and in-review Tickets in_progress through bd reclaim after their leases lapse, unlike another actor\'s claim', async () => {
    await create('inFlight', 'being worked');
    await create('inReview', 'awaiting merge');
    await create('rivals', 'someone else\'s claim');
    for (const key of ['inFlight', 'inReview']) await createBeadsGateway().claim(project, ids[key]);
    await createBeadsGateway().markInReview(project, ids.inReview, 'https://github.com/o/r/pull/2');
    await bd('--actor', 'rival', 'update', ids.rivals, '--claim');
    await expireLeases();

    await createBeadsGateway().heartbeat(project);
    await bd('reclaim', '--older-than', '0s');

    assert.deepEqual(await state(ids.inFlight), { status: 'in_progress', assignee: 'orchestrator', labels: [] });
    assert.deepEqual(await state(ids.inReview), { status: 'in_progress', assignee: 'orchestrator', labels: ['in-review'] });
    assert.deepEqual(await state(ids.rivals), { status: 'open', assignee: '', labels: [] });
  });

  it('reclaims a lapsed Orchestrator claim when nothing heartbeats it', async () => {
    await create('unbeaten', 'no heartbeat');
    await createBeadsGateway().claim(project, ids.unbeaten);
    await expireLeases();

    await bd('reclaim', '--older-than', '0s');

    assert.equal((await state(ids.unbeaten)).status, 'open');
  });

  it('heartbeats the rest of the held Tickets when one heartbeat fails, then reports the failure', async () => {
    const fake = join(dir, 'fake-bd');
    const log = join(dir, 'fake-bd.log');
    await writeFile(fake, `#!/bin/sh
case " $* " in
  *" list "*) echo '[{"id":"x-1"},{"id":"x-2"}]' ;;
  *" heartbeat x-1 "*) echo "lease gone" >&2; exit 1 ;;
  *" heartbeat x-2 "*) echo beat x-2 >> '${log}' ;;
esac
`);
    await chmod(fake, 0o755);

    await assert.rejects(createBeadsGateway({ bin: fake }).heartbeat(project), /heartbeat failed for x-1: [^]*lease gone/);
    assert.equal(await readFile(log, 'utf8'), 'beat x-2\n');
  });

  it('shows a Ticket with its comments, parent epic and closed blockers only', async () => {
    await create('epic', 'the epic', '-t', 'epic', '-d', 'epic body');
    await create('child', 'the child', '--parent', ids.epic);
    await create('doneBlocker', 'finished first');
    await create('openBlocker', 'still open');
    await bd('dep', 'add', ids.child, ids.doneBlocker);
    await bd('dep', 'add', ids.child, ids.openBlocker);
    await bd('close', ids.doneBlocker, '-r', 'shipped in abc123');
    await bd('comment', ids.child, 'remember the edge case');

    const context = await createBeadsGateway().showContext(project, ids.child);
    assert.equal(context.ticket.title, 'the child');
    assert.deepEqual((context.ticket.comments as { text: string }[]).map((c) => c.text), ['remember the edge case']);
    assert.deepEqual([context.parent?.title, context.parent?.description], ['the epic', 'epic body']);
    assert.deepEqual(context.closedBlockers, [{ id: ids.doneBlocker, title: 'finished first', closeReason: 'shipped in abc123' }]);
    assert.equal(context.inReviewBlocker, null);
  });

  it('shows a Ticket without a parent as parent null', async () => {
    assert.equal((await createBeadsGateway().showContext(project, ids.ready)).parent, null);
  });
});

describe('Beads gateway with In review blockers, against real bd', () => {
  let dir: string;
  let project: { name: string; repoPath: string; baseBranch: string };
  const ids: Record<string, string> = {};
  const env = { ...process.env, BEADS_ACTOR: 'tester' };

  const bd = (...args: string[]) => run('bd', args, { cwd: dir, env });
  async function create(key: string, title: string, ...flags: string[]) {
    ids[key] = (await bd('create', title, '--silent', ...flags)).stdout.trim();
  }
  /** A Ticket a Run took to In review: in_progress, the Orchestrator's, labelled in-review. */
  async function inReview(key: string, title: string) {
    await create(key, title, '-l', 'ready-for-agent');
    await bd('--actor', 'orchestrator', 'update', ids[key], '--claim');
    await bd('update', ids[key], '--add-label', 'in-review');
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'beads-stack-'));
    project = { name: 'lab', repoPath: dir, baseBranch: 'main' };
    await bd('init', '-p', 'lab', '--non-interactive', '--skip-agents', '--skip-hooks');
    await inReview('reviewA', 'PR open A');
    await inReview('reviewB', 'PR open B');
    await create('done', 'merged long ago');
    await bd('close', ids.done, '-r', 'done');
    await create('working', 'a Run is still on it', '-l', 'ready-for-agent');
    await bd('--actor', 'orchestrator', 'update', ids.working, '--claim');

    await create('stacked', 'on A', '-l', 'ready-for-agent');
    await bd('dep', 'add', ids.stacked, ids.reviewA);
    await bd('dep', 'add', ids.stacked, ids.done);
    await create('twoReviews', 'on A and B', '-l', 'ready-for-agent');
    await bd('dep', 'add', ids.twoReviews, ids.reviewA);
    await bd('dep', 'add', ids.twoReviews, ids.reviewB);
    await create('onWorking', 'on a Run without a PR', '-l', 'ready-for-agent');
    await bd('dep', 'add', ids.onWorking, ids.working);
    await create('skipped', 'opted out, on A', '-l', 'ready-for-agent,orchestrator:skip');
    await bd('dep', 'add', ids.skipped, ids.reviewA);
    await create('unlabelled', 'not for agents, on A');
    await bd('dep', 'add', ids.unlabelled, ids.reviewA);
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('lists a Ticket whose only unclosed blocker is In review, and not one with two or with a blocker still being worked', async () => {
    const { tickets } = await createBeadsGateway().listReady(project);
    assert.deepEqual(
      tickets.map(({ id, title, priority }) => ({ id, title, priority })),
      [{ id: ids.stacked, title: 'on A', priority: 2 }],
    );
    assert.match(tickets[0].createdAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('shows the In review blocker of a Ticket stacked on it', async () => {
    const context = await createBeadsGateway().showContext(project, ids.stacked);
    assert.deepEqual(context.inReviewBlocker, { id: ids.reviewA, title: 'PR open A' });
    assert.deepEqual(context.closedBlockers.map((b) => b.id), [ids.done]);
  });
});

describe('Friction in ysz\'s own queue, against real bd', () => {
  let yszDir: string;
  const env = { ...process.env, BEADS_ACTOR: 'tester' };
  const project = { name: 'PopDeal', repoPath: '/not/used', baseBranch: 'main' };

  before(async () => {
    yszDir = await mkdtemp(join(tmpdir(), 'beads-ysz-'));
    await run('bd', ['init', '-p', 'ysz', '--non-interactive', '--skip-agents', '--skip-hooks'], { cwd: yszDir, env });
  });

  after(() => rm(yszDir, { recursive: true, force: true }));

  it('creates a needs-triage Ticket with the Project label, as the orchestrator, at default type and priority, ending with where it came from', async () => {
    const id = await createBeadsGateway({ yszRepo: yszDir }).createFriction({
      project, title: '--phpunit cannot run', body: 'It exited 127.\nI skipped it.', ticketId: 'pd-42', runId: 17, attempt: 2, role: 'review',
    });
    const [issue] = JSON.parse((await run('bd', ['show', id, '--json'], { cwd: yszDir, env })).stdout);
    assert.match(id, /^ysz-/);
    assert.deepEqual(
      [issue.title, issue.status, issue.priority, issue.issue_type, issue.created_by, [...issue.labels].sort()],
      ['--phpunit cannot run', 'open', 2, 'task', 'orchestrator', ['friction', 'needs-triage', 'project:PopDeal']],
    );
    assert.equal(issue.description, 'It exited 127.\nI skipped it.\n\nProject: PopDeal · Ticket: pd-42 · Run: 17 · Attempt: 2 · Agent: review');
  });

  it('puts only the provenance line in the body of a Friction with no body', async () => {
    const id = await createBeadsGateway({ yszRepo: yszDir }).createFriction({
      project, title: 'lint is slow to start', body: '', ticketId: 'pd-43', runId: 18, attempt: 1, role: 'implement',
    });
    const [issue] = JSON.parse((await run('bd', ['show', id, '--json'], { cwd: yszDir, env })).stdout);
    assert.equal(issue.description, 'Project: PopDeal · Ticket: pd-43 · Run: 18 · Attempt: 1 · Agent: implement');
  });

  it('refuses to write Friction when no ysz checkout is configured', async () => {
    await assert.rejects(
      createBeadsGateway().createFriction({ project, title: 't', body: '', ticketId: 'x', runId: 1, attempt: 1, role: 'implement' }),
      /ysz checkout is not configured/,
    );
  });
});

describe('Open Friction and "seen again" comments in ysz\'s own queue, against real bd', () => {
  let yszDir: string;
  const env = { ...process.env, BEADS_ACTOR: 'tester' };
  const popdeal = { name: 'PopDeal', repoPath: '/not/used', baseBranch: 'main' };
  const fazwaz = { name: 'fazwaz', repoPath: '/not/used', baseBranch: 'main' };
  const bd = (...args: string[]) => run('bd', args, { cwd: yszDir, env });
  const friction = (project: typeof popdeal, title: string) =>
    createBeadsGateway({ yszRepo: yszDir }).createFriction({ project, title, body: '', ticketId: 'pd-1', runId: 1, attempt: 1, role: 'implement' });
  let open: string, inProgress: string, pinned: string, closed: string, other: string;

  before(async () => {
    yszDir = await mkdtemp(join(tmpdir(), 'beads-ysz-open-'));
    await bd('init', '-p', 'ysz', '--non-interactive', '--skip-agents', '--skip-hooks');
    open = await friction(popdeal, 'open one');
    inProgress = await friction(popdeal, 'the human is fixing this');
    pinned = await friction(popdeal, 'pinned for later');
    closed = await friction(popdeal, 'fixed already');
    other = await friction(fazwaz, 'another project');
    await bd('update', inProgress, '--status', 'in_progress');
    await bd('update', pinned, '--status', 'pinned');
    await bd('close', closed, '--reason', 'fixed');
  });

  after(() => rm(yszDir, { recursive: true, force: true }));

  it('lists the Project\'s Friction that is not closed, an in_progress and a pinned one included', async () => {
    const found = await createBeadsGateway({ yszRepo: yszDir }).listOpenFriction(popdeal);
    assert.deepEqual(found.sort((a, b) => a.title.localeCompare(b.title)), [
      { id: inProgress, title: 'the human is fixing this' },
      { id: open, title: 'open one' },
      { id: pinned, title: 'pinned for later' },
    ].sort((a, b) => a.title.localeCompare(b.title)));
    assert.deepEqual(await createBeadsGateway({ yszRepo: yszDir }).listOpenFriction(fazwaz), [{ id: other, title: 'another project' }]);
  });

  it('lists nothing for a Project with no Friction, and refuses when no ysz checkout is configured', async () => {
    assert.deepEqual(await createBeadsGateway({ yszRepo: yszDir }).listOpenFriction({ ...popdeal, name: 'thaivis' }), []);
    await assert.rejects(createBeadsGateway().listOpenFriction(popdeal), /ysz checkout is not configured/);
  });

  it('comments on the Ticket as the orchestrator, saying what happened this time and ending with where it came from', async () => {
    await createBeadsGateway({ yszRepo: yszDir }).commentFriction(open, {
      project: popdeal, title: '--phpunit exited 127 again', body: 'Skipped it.', ticketId: 'pd-9', runId: 21, attempt: 2, role: 'review',
    });
    const [comment, ...rest] = JSON.parse((await bd('comments', open, '--json')).stdout);
    assert.equal(rest.length, 0);
    assert.equal(comment.author, 'orchestrator');
    assert.equal(comment.text, 'Seen again: --phpunit exited 127 again\nSkipped it.\n\nProject: PopDeal · Ticket: pd-9 · Run: 21 · Attempt: 2 · Agent: review');
  });
});

describe('Follow-up Tickets in the Project\'s own queue, against real bd', () => {
  let dir: string;
  let project: { name: string; repoPath: string; baseBranch: string };
  const env = { ...process.env, BEADS_ACTOR: 'tester' };
  const bd = (...args: string[]) => run('bd', args, { cwd: dir, env });
  let ticket: string, followUp: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'beads-followup-'));
    project = { name: 'lab', repoPath: dir, baseBranch: 'main' };
    await bd('init', '-p', 'lab', '--non-interactive', '--skip-agents', '--skip-hooks');
    ticket = (await bd('create', 'the Run\'s Ticket', '--silent', '-l', 'ready-for-agent')).stdout.trim();
    followUp = await createBeadsGateway().createFollowUp({
      project, title: '--drop the old export', body: 'Nothing imports it.', ticketId: ticket, runId: 17, attempt: 2, role: 'review',
    });
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('is needs-triage and discovered-from the Ticket, with no parent, at default type and priority, as the orchestrator, ending with where it came from', async () => {
    const [issue] = JSON.parse((await bd('show', followUp, '--json')).stdout);
    assert.deepEqual(
      [issue.title, issue.status, issue.priority, issue.issue_type, issue.created_by, [...issue.labels], issue.parent ?? null],
      ['--drop the old export', 'open', 2, 'task', 'orchestrator', ['needs-triage'], null],
    );
    assert.deepEqual(issue.dependencies.map((d: { id: string; dependency_type: string }) => [d.id, d.dependency_type]), [[ticket, 'discovered-from']]);
    assert.equal(issue.description, `Nothing imports it.\n\nProject: lab · Ticket: ${ticket} · Run: 17 · Attempt: 2 · Agent: review`);
  });

  it('never appears in listReady, though it counts in the Backlog', async () => {
    const { tickets, backlog } = await createBeadsGateway().listReady(project);
    assert.deepEqual(tickets.map((t) => t.id), [ticket]);
    assert.equal(backlog, 2);
  });
});

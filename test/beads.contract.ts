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
    await create('readyEpic', 'labelled epic, no children', '-t', 'epic', '-l', 'ready-for-agent');
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('lists only unassigned, unblocked ready-for-agent Tickets without orchestrator:skip or epic type, then the childless epic as a Spec, and counts every unclosed bead', async () => {
    const { tickets, rows } = await createBeadsGateway().listReady(project);
    assert.equal(rows.length, 9);
    assert.deepEqual(
      tickets.map(({ id, title, priority, spec }) => ({ id, title, priority, spec })),
      [
        { id: ids.ready, title: 'ready one', priority: 1, spec: undefined },
        { id: ids.readyEpic, title: 'labelled epic, no children', priority: 2, spec: true },
      ],
    );
    assert.match(tickets[0].createdAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('releases a Ticket once its blocker is closed', async () => {
    await bd('close', ids.blocker, '-r', 'done');
    const found = (await createBeadsGateway().listReady(project)).tickets.map((t) => t.id).sort();
    assert.deepEqual(found, [ids.blocked, ids.ready, ids.readyEpic].sort());
  });

  it('holds a parent back even once every child is closed: its children did its work', async () => {
    await bd('close', ids.child, '-r', 'done');
    const found = (await createBeadsGateway().listReady(project)).tickets.map((t) => t.id).sort();
    assert.deepEqual(found, [ids.blocked, ids.ready, ids.readyEpic].sort());
  });

  it('keeps every unclosed bead as a row with its type, labels, parent, edges and comment count, and no closed one', async () => {
    await bd('comment', ids.ready, 'a note');
    await create('child2', 'unclosed child', '--parent', ids.parent);
    const { rows } = await createBeadsGateway().listReady(project);
    assert.deepEqual(rows.map((r) => r.id).sort(), Object.values(ids).filter((id) => id !== ids.blocker && id !== ids.child).sort());
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ready = byId.get(ids.ready)!;
    assert.match(ready.created_at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(ready, {
      id: ids.ready, title: 'ready one', status: 'open', issue_type: 'task', priority: 1, assignee: null,
      labels: ['ready-for-agent'], parent: null, dependencies: [], comment_count: 1, created_at: ready.created_at,
    });
    assert.equal(byId.get(ids.readyEpic)!.issue_type, 'epic');
    assert.equal(byId.get(ids.assigned)!.assignee, 'someone');
    assert.deepEqual(byId.get(ids.blocked)!.dependencies, [{ depends_on_id: ids.blocker, type: 'blocks' }]);
    assert.equal(byId.get(ids.child2)!.parent, ids.parent);
    assert.deepEqual(byId.get(ids.child2)!.dependencies, [{ depends_on_id: ids.parent, type: 'parent-child' }]);
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

  it('closes a ready-for-agent non-epic parent once its last child merges, but not an epic still waiting for its breakdown', async () => {
    await create('specTask', 'spec as a task', '-l', 'ready-for-agent');
    await inReview('firstChild', '--parent', ids.specTask);
    await inReview('lastChild', '--parent', ids.specTask);
    await create('specEpic', 'spec as an epic', '-t', 'epic', '-l', 'ready-for-agent');
    await inReview('epicChild', '--parent', ids.specEpic);

    await createBeadsGateway().merged(project, ids.firstChild, 'https://github.com/o/r/pull/4');
    assert.equal((await state(ids.specTask)).status, 'open');
    await createBeadsGateway().merged(project, ids.lastChild, 'https://github.com/o/r/pull/5');
    await createBeadsGateway().merged(project, ids.epicChild, 'https://github.com/o/r/pull/6');

    const [issue] = JSON.parse((await bd('show', ids.specTask, '--json')).stdout);
    assert.deepEqual([issue.status, issue.close_reason], ['closed', 'Every child closed, the last by https://github.com/o/r/pull/5']);
    assert.deepEqual(await state(ids.specEpic), { status: 'open', assignee: '', labels: ['ready-for-agent'] });
  });

  it('leaves a parent open whose last child merged when it is not ready-for-agent or waits on its epic-branch PR', async () => {
    await create('handParent', 'the human\'s own parent');
    await inReview('handChild', '--parent', ids.handParent);
    await create('branchEpic', 'epic on its own branch', '-t', 'epic', '-l', 'ready-for-agent,epic-branch');
    await inReview('branchChild', '--parent', ids.branchEpic);

    await createBeadsGateway().merged(project, ids.handChild, 'https://github.com/o/r/pull/7');
    await createBeadsGateway().merged(project, ids.branchChild, 'https://github.com/o/r/pull/8');

    assert.equal((await state(ids.handParent)).status, 'open');
    assert.equal((await state(ids.branchEpic)).status, 'open');
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
    await create('epicOnA', 'labelled epic, on A', '-t', 'epic', '-l', 'ready-for-agent');
    await bd('dep', 'add', ids.epicOnA, ids.reviewA);
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('lists a Ticket whose only unclosed blocker is In review, and not one with two, with a blocker still being worked, or an epic', async () => {
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
    const { tickets, rows } = await createBeadsGateway().listReady(project);
    assert.deepEqual(tickets.map((t) => t.id), [ticket]);
    assert.equal(rows.length, 2);
  });
});

describe('Backlog actions against real bd', () => {
  let dir: string;
  let project: { name: string; repoPath: string; baseBranch: string };
  const env = { ...process.env, BEADS_ACTOR: 'tester' };
  const bd = (...args: string[]) => run('bd', args, { cwd: dir, env });
  const create = async (title: string, ...flags: string[]) => (await bd('create', title, '--silent', ...flags)).stdout.trim();
  const show = async (id: string) => JSON.parse((await bd('show', id, '--json')).stdout)[0];
  const labels = async (id: string) => [...(await show(id)).labels].sort();
  const gateway = createBeadsGateway();
  let actor: string | undefined;

  before(async () => {
    // The gateway runs bd with this process's environment, so the suite's actor is set here too.
    actor = process.env.BEADS_ACTOR;
    process.env.BEADS_ACTOR = 'tester';
    dir = await mkdtemp(join(tmpdir(), 'beads-actions-'));
    project = { name: 'lab', repoPath: dir, baseBranch: 'main' };
    await bd('init', '-p', 'lab', '--non-interactive', '--skip-agents', '--skip-hooks');
  });

  after(async () => {
    if (actor === undefined) delete process.env.BEADS_ACTOR;
    else process.env.BEADS_ACTOR = actor;
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the fields the Backlog actions are decided from', async () => {
    const id = await create('held elsewhere', '-l', 'ready-for-agent,other', '-a', 'someone');
    const facts = await gateway.ticketFacts(project, id);
    assert.deepEqual({ ...facts, labels: [...facts.labels!].sort() }, { id, issue_type: 'task', status: 'open', assignee: 'someone', labels: ['other', 'ready-for-agent'] });
    const bare = await create('bare');
    assert.deepEqual(await gateway.ticketFacts(project, bare), { id: bare, issue_type: 'task', status: 'open', assignee: null, labels: [] });
  });

  it("reads a Ticket's description and its comments with author and text, oldest first, and none for a Ticket without", async () => {
    const id = await create('described', '-d', 'first line\nsecond <b>line</b>');
    assert.deepEqual(await gateway.ticketDetail(project, id), { description: 'first line\nsecond <b>line</b>', comments: [] });
    await bd('comment', id, 'one');
    await bd('comment', id, 'two\nlines');
    const { description, comments } = await gateway.ticketDetail(project, id);
    assert.equal(description, 'first line\nsecond <b>line</b>');
    assert.deepEqual(comments.map(({ author, text }) => ({ author, text })), [{ author: 'tester', text: 'one' }, { author: 'tester', text: 'two\nlines' }]);
    assert.match(comments[0].createdAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('mark-ready adds ready-for-agent and drops needs-info, leaving orchestrator:skip and the assignee alone', async () => {
    const id = await create('answered', '-l', 'needs-info,orchestrator:skip,other', '-a', 'someone');
    await gateway.ticketAction(project, id, 'mark-ready');
    assert.deepEqual(await labels(id), ['orchestrator:skip', 'other', 'ready-for-agent']);
    assert.equal((await show(id)).assignee, 'someone');
  });

  it("unassign clears the assignee and puts the human's own claim back to open, leaving its labels alone", async () => {
    const id = await create('claimed by hand', '-l', 'ready-for-agent,other');
    await bd('update', id, '--claim');
    await gateway.ticketAction(project, id, 'unassign');
    const { assignee, status } = await show(id);
    assert.deepEqual({ assignee: assignee ?? null, status }, { assignee: null, status: 'open' });
    assert.deepEqual(await labels(id), ['other', 'ready-for-agent']);
  });

  it("unassign leaves someone else's live claim to bd's guard: refused, nothing changed", async () => {
    const id = await create('their claim', '-a', 'someone');
    await bd('update', id, '--status', 'in_progress');
    await assert.rejects(gateway.ticketAction(project, id, 'unassign'), /held by "someone"/);
    const { assignee, status } = await show(id);
    assert.deepEqual({ assignee, status }, { assignee: 'someone', status: 'in_progress' });
  });

  it('unmark-ready drops only ready-for-agent', async () => {
    const id = await create('retracted', '-l', 'ready-for-agent,needs-info,other');
    await gateway.ticketAction(project, id, 'unmark-ready');
    assert.deepEqual(await labels(id), ['needs-info', 'other']);
  });

  it('skip adds only orchestrator:skip, and allow drops only it', async () => {
    const id = await create('opted out', '-l', 'ready-for-agent,other');
    await gateway.ticketAction(project, id, 'skip');
    assert.deepEqual(await labels(id), ['orchestrator:skip', 'other', 'ready-for-agent']);
    await gateway.ticketAction(project, id, 'allow');
    assert.deepEqual(await labels(id), ['other', 'ready-for-agent']);
  });

  it("records bd's default actor for the write, never the orchestrator", async () => {
    const id = await create('who wrote it');
    await gateway.ticketAction(project, id, 'skip');
    const events = (await bd('history', id, '--events')).stdout;
    assert.match(events, /label_added by tester/);
    assert.doesNotMatch(events, /by orchestrator/);
  });
});

describe('Specs against real bd', () => {
  let dir: string;
  let project: { name: string; repoPath: string; baseBranch: string };
  const ids: Record<string, string> = {};
  const env = { ...process.env, BEADS_ACTOR: 'tester' };
  const bd = (...args: string[]) => run('bd', args, { cwd: dir, env });
  async function create(key: string, title: string, ...flags: string[]) {
    ids[key] = (await bd('create', title, '--silent', ...flags)).stdout.trim();
  }
  const show = async (id: string) => JSON.parse((await bd('show', id, '--json', '--include-comments')).stdout)[0];
  const children = async (id: string) => JSON.parse((await bd('children', id, '--json')).stdout) as { id: string }[];
  const commentsOf = (i: { comments?: { text: string }[] }) => (i.comments ?? []).map((c) => c.text);
  const blockers = (i: { dependencies?: { id: string; dependency_type: string }[] }) => (i.dependencies ?? []).filter((d) => d.dependency_type === 'blocks').map((d) => d.id);
  const plain = (key: string, ...blockedBy: string[]) => ({ key, title: key, body: '', blockedBy });
  const CHANGED = 'This Spec changed since its last breakdown read it, so its children may not cover all of it. Label it ready-for-agent to have what they do not cover yet broken down.';

  /** Claim a Spec as its Run does, and return what its agent saw, which the Run hands back to breakDown. */
  async function claimAndSee(id: string) {
    const gateway = createBeadsGateway();
    assert.equal(await gateway.claim(project, id), true);
    const { children, baseline } = await gateway.showContext(project, id);
    return { children: children!.map((c) => c.id), baseline: baseline! };
  }
  /** The Orchestrator holds the Ticket In review, as a Run leaves it once its PR is open. */
  async function inReview(id: string) {
    await bd('--actor', 'orchestrator', 'update', id, '--claim');
    await bd('update', id, '--add-label', 'in-review');
  }
  /** A Spec ysz broke down into one child, which the Orchestrator holds In review. Returns that child's id. */
  async function brokenDown(key: string, ...flags: string[]) {
    await create(key, key, '-t', 'epic', '-l', 'ready-for-agent', '-d', 'what to build', '--design', 'how', '--acceptance', 'done when', ...flags);
    const seen = await claimAndSee(ids[key]);
    const [child] = (await createBeadsGateway().breakDown(project, { id: ids[key], priority: 2 }, [plain('only')], seen))!.created;
    await inReview(child);
    return child;
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'beads-spec-'));
    project = { name: 'lab', repoPath: dir, baseBranch: 'main' };
    await bd('init', '-p', 'lab', '--non-interactive', '--skip-agents', '--skip-hooks');
    await create('spec', 'the Spec', '-t', 'epic', '-l', 'ready-for-agent', '-p', '1');
    await create('finished', 'every child closed', '-t', 'epic', '-l', 'ready-for-agent');
    await create('finishedChild', 'the only child', '--parent', ids.finished);
    await bd('close', ids.finishedChild, '-r', 'done');
    await create('relabelled', 'broken down before, labelled again', '-t', 'epic', '-l', 'ready-for-agent,needs-info', '-p', '0');
    await create('relabelled1', 'the open child', '--parent', ids.relabelled, '--no-inherit-labels', '-d', 'open body');
    await create('relabelled2', 'the closed child', '--parent', ids.relabelled, '--no-inherit-labels', '-d', 'closed body');
    await bd('close', ids.relabelled2, '-r', 'PR merged: https://github.com/o/r/pull/1');
    await create('branchSpec', 'on its own branch', '-t', 'epic', '-l', 'ready-for-agent,epic-branch');
    await create('branchSpecChild', 'its child', '--parent', ids.branchSpec);
    await bd('close', ids.branchSpecChild, '-r', 'done');
    await create('unlabelled', 'not for agents', '-t', 'epic');
    await create('blockedSpec', 'waits on a Ticket', '-t', 'epic', '-l', 'ready-for-agent');
    await create('gate', 'the gate');
    await bd('dep', 'add', ids.blockedSpec, ids.gate);
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('lists a labelled epic as a Spec whether or not it has children, one on its own branch never for its Epic PR, and not an unlabelled or blocked one', async () => {
    const { tickets } = await createBeadsGateway().listReady(project);
    assert.deepEqual(
      tickets.map(({ id, spec, epicPr }) => [id, spec, epicPr]).sort(),
      [[ids.spec, true, undefined], [ids.finished, true, undefined], [ids.relabelled, true, undefined], [ids.branchSpec, true, undefined]].sort(),
    );
  });

  it('shows a Spec with every child, closed ones included, by title, status, body and close reason', async () => {
    const { children } = await createBeadsGateway().showContext(project, ids.relabelled);
    assert.deepEqual([...children!].sort((a, b) => a.id.localeCompare(b.id)), [
      { id: ids.relabelled1, title: 'the open child', status: 'open', body: 'open body', closeReason: '' },
      { id: ids.relabelled2, title: 'the closed child', status: 'closed', body: 'closed body', closeReason: 'PR merged: https://github.com/o/r/pull/1' },
    ]);
  });

  it('creates the plan under the claimed Spec, labelled ready-for-agent at its priority with the blocking edges, then comments, drops its label and releases it', async () => {
    const gateway = createBeadsGateway();
    const seen = await claimAndSee(ids.spec);
    const result = await gateway.breakDown(project, { id: ids.spec, priority: 1 }, [
      { key: 'schema', title: '--add the column', body: '## What to build\nThe column.', blockedBy: [] },
      { key: 'ui', title: 'show it', body: '', blockedBy: ['schema'] },
    ], seen);
    assert.deepEqual(result, { created: [`${ids.spec}.1`, `${ids.spec}.2`], left: 'released' });
    const [schema, ui] = await Promise.all(result!.created.map(show));
    assert.deepEqual(
      [schema, ui].map((i) => [i.title, i.description ?? '', i.status, i.priority, i.parent, [...i.labels], i.created_by]),
      [
        ['--add the column', '## What to build\nThe column.', 'open', 1, ids.spec, ['ready-for-agent'], 'orchestrator'],
        ['show it', '', 'open', 1, ids.spec, ['ready-for-agent'], 'orchestrator'],
      ],
    );
    assert.deepEqual([blockers(schema), blockers(ui)], [[], [schema.id]]);

    const spec = await show(ids.spec);
    assert.deepEqual([spec.status, spec.assignee ?? '', spec.labels ?? [], commentsOf(spec)], ['open', '', [], [`Broken down into ${schema.id}, ${ui.id}`]]);
    const listed = (await gateway.listReady(project)).tickets.map((t) => t.id);
    assert.deepEqual([ids.spec, schema.id, ui.id].filter((id) => listed.includes(id)), [schema.id]);
  });

  it('adds new children after the existing ones, blocked by an existing one, drops ready-for-agent and needs-info, and closes the Spec once they merge', async () => {
    const gateway = createBeadsGateway();
    const seen = await claimAndSee(ids.relabelled);
    assert.deepEqual(await gateway.breakDown(project, { id: ids.relabelled, priority: 0 }, [plain('more', ids.relabelled1)], seen), { created: [`${ids.relabelled}.3`], left: 'released' });
    const added = await show(`${ids.relabelled}.3`);
    assert.deepEqual([added.parent, [...added.labels], added.priority, blockers(added)], [ids.relabelled, ['ready-for-agent'], 0, [ids.relabelled1]]);
    const spec = await show(ids.relabelled);
    assert.deepEqual([spec.status, spec.assignee ?? '', spec.labels ?? [], commentsOf(spec)], ['open', '', [], [`Broken down into ${ids.relabelled}.3`]]);

    await bd('close', ids.relabelled1, '-r', 'done');
    await inReview(added.id);
    await gateway.merged(project, added.id, 'https://github.com/o/r/pull/2');
    const closed = await show(ids.relabelled);
    assert.deepEqual([closed.status, closed.close_reason], ['closed', 'Every child closed, the last by https://github.com/o/r/pull/2']);
  });

  it('creates nothing, keeps the label and releases the Spec when it got a child by hand after its agent saw it', async () => {
    await create('splitByHand', 'split while its agent ran', '-t', 'epic', '-l', 'ready-for-agent');
    const gateway = createBeadsGateway();
    const seen = await claimAndSee(ids.splitByHand);
    await create('handChild', 'by hand', '--parent', ids.splitByHand);
    assert.equal(await gateway.breakDown(project, { id: ids.splitByHand, priority: 2 }, [plain('a')], seen), null);
    assert.deepEqual((await children(ids.splitByHand)).map((c) => c.id), [ids.handChild]);
    const spec = await show(ids.splitByHand);
    assert.deepEqual([spec.status, spec.assignee ?? '', spec.labels], ['open', '', ['ready-for-agent']]);
  });

  it('writes nothing, leaving the Spec claimed, on a plan bd refuses', async () => {
    await create('cyclic', 'planned in a circle', '-t', 'epic', '-l', 'ready-for-agent');
    const gateway = createBeadsGateway();
    const seen = await claimAndSee(ids.cyclic);
    await assert.rejects(gateway.breakDown(project, { id: ids.cyclic, priority: 2 }, [plain('a', 'b'), plain('b', 'a')], seen), /cycle/);
    assert.deepEqual(await children(ids.cyclic), []);
    assert.equal((await show(ids.cyclic)).status, 'in_progress');
  });

  it('closes a Spec whose children are all closed when nothing is left to break down', async () => {
    const seen = await claimAndSee(ids.finished);
    assert.deepEqual(await createBeadsGateway().breakDown(project, { id: ids.finished, priority: 2 }, [], seen), { created: [], left: 'closed' });
    const spec = await show(ids.finished);
    assert.deepEqual([spec.status, commentsOf(spec)], ['closed', ['Nothing left to break down']]);
  });

  it('leaves a Spec on its own branch open and unlabelled for its Epic PR when nothing is left to break down', async () => {
    const gateway = createBeadsGateway();
    const seen = await claimAndSee(ids.branchSpec);
    assert.deepEqual(await gateway.breakDown(project, { id: ids.branchSpec, priority: 2 }, [], seen), { created: [], left: 'released' });
    const spec = await show(ids.branchSpec);
    assert.deepEqual([spec.status, spec.assignee ?? '', spec.labels], ['open', '', ['epic-branch']]);
    assert.deepEqual((await gateway.listReady(project)).tickets.filter((t) => t.id === ids.branchSpec).map((t) => [t.spec, t.epicPr]), [[undefined, true]]);
  });

  it('releases a Spec with an open child, its label off, when nothing is left to break down', async () => {
    await create('pending', 'one child still open', '-t', 'epic', '-l', 'ready-for-agent');
    await create('pendingChild', 'still open', '--parent', ids.pending, '--no-inherit-labels');
    const seen = await claimAndSee(ids.pending);
    assert.deepEqual(await createBeadsGateway().breakDown(project, { id: ids.pending, priority: 2 }, [], seen), { created: [], left: 'released' });
    const spec = await show(ids.pending);
    assert.deepEqual([spec.status, spec.assignee ?? '', spec.labels ?? []], ['open', '', []]);
  });

  it('hands a Spec back instead of closing it when nothing was left to break down but its text changed while its agent ran', async () => {
    await create('editedMidRun', 'edited mid-Run', '-t', 'epic', '-l', 'ready-for-agent', '-d', 'before');
    await create('editedMidRunChild', 'done', '--parent', ids.editedMidRun);
    await bd('close', ids.editedMidRunChild, '-r', 'done');
    const seen = await claimAndSee(ids.editedMidRun);
    await bd('update', ids.editedMidRun, '-d', 'after');
    assert.deepEqual(await createBeadsGateway().breakDown(project, { id: ids.editedMidRun, priority: 2 }, [], seen), { created: [], left: 'handed-back' });
    const spec = await show(ids.editedMidRun);
    assert.deepEqual([spec.status, spec.assignee ?? '', spec.labels, commentsOf(spec)], ['open', '', ['needs-info'], ['Nothing left to break down', CHANGED]]);
  });

  it('hands a Spec back, open with needs-info and a comment, when its last child merges after its description, design or acceptance criteria changed', async () => {
    for (const [key, flag] of [['newDescription', '-d'], ['newDesign', '--design'], ['newAcceptance', '--acceptance']]) {
      const child = await brokenDown(key);
      await bd('update', ids[key], flag, 'changed');
      assert.equal(await createBeadsGateway().merged(project, child, 'https://github.com/o/r/pull/10'), true);
      assert.equal((await show(child)).status, 'closed');
      const spec = await show(ids[key]);
      assert.deepEqual([key, spec.status, spec.labels, commentsOf(spec)], [key, 'open', ['needs-info'], [`Broken down into ${child}`, CHANGED]]);
    }
  });

  it('catches an edit made after its agent saw the Spec but before the breakdown was written, once its last child merges', async () => {
    await create('midRun', 'edited before the write', '-t', 'epic', '-l', 'ready-for-agent', '-d', 'before');
    const seen = await claimAndSee(ids.midRun);
    await bd('update', ids.midRun, '-d', 'after');
    const [child] = (await createBeadsGateway().breakDown(project, { id: ids.midRun, priority: 2 }, [plain('only')], seen))!.created;
    await inReview(child);
    await createBeadsGateway().merged(project, child, 'https://github.com/o/r/pull/11');
    const spec = await show(ids.midRun);
    assert.deepEqual([spec.status, spec.labels], ['open', ['needs-info']]);
  });

  it('closes a Spec whose title, notes or comments changed when its last child merges', async () => {
    const child = await brokenDown('renamed');
    await bd('update', ids.renamed, '--title', 'a new title', '--notes', 'a note');
    await bd('comment', ids.renamed, 'a comment');
    await createBeadsGateway().merged(project, child, 'https://github.com/o/r/pull/12');
    assert.equal((await show(ids.renamed)).status, 'closed');
  });

  it('lists an unchanged Spec on its own branch for its Epic PR once its last child lands, and a changed one never: it goes back to the human', async () => {
    const gateway = createBeadsGateway();
    const unchanged = await brokenDown('unchangedBranch', '-l', 'epic-branch');
    const changed = await brokenDown('changedBranch', '-l', 'epic-branch');
    await bd('update', ids.changedBranch, '-d', 'changed');
    assert.equal(await gateway.landed(project, unchanged, `epic/${ids.unchangedBranch}`, 'abc123'), true);
    assert.equal(await gateway.landed(project, changed, `epic/${ids.changedBranch}`, 'abc123'), true);

    const kept = await show(ids.unchangedBranch);
    assert.deepEqual([kept.status, kept.labels], ['open', ['epic-branch']]);
    const back = await show(ids.changedBranch);
    assert.deepEqual([back.status, [...back.labels].sort(), commentsOf(back).at(-1)], ['open', ['epic-branch', 'needs-info'], CHANGED]);
    const listed = (await gateway.listReady(project)).tickets;
    assert.deepEqual(listed.filter((t) => [ids.unchangedBranch, ids.changedBranch].includes(t.id)).map((t) => [t.id, t.epicPr]), [[ids.unchangedBranch, true]]);
  });
});

describe('An epic on its own branch (ADR 0008), against real bd', () => {
  let dir: string;
  let project: { name: string; repoPath: string; baseBranch: string };
  const ids: Record<string, string> = {};
  const env = { ...process.env, BEADS_ACTOR: 'tester' };
  const bd = (...args: string[]) => run('bd', args, { cwd: dir, env });
  async function create(key: string, title: string, ...flags: string[]) {
    ids[key] = (await bd('create', title, '--silent', ...flags)).stdout.trim();
  }
  /** An epic with one child per status, each child closed or left open. */
  async function epic(key: string, labels: string, children: ('closed' | 'open')[], ...flags: string[]) {
    await create(key, key, '-t', 'epic', '-l', labels, ...flags);
    for (const [i, status] of children.entries()) {
      await create(`${key}${i}`, `${key} child ${i}`, '--parent', ids[key]);
      if (status === 'closed') await bd('close', ids[`${key}${i}`], '-r', 'done');
    }
  }
  const show = async (id: string) => JSON.parse((await bd('show', id, '--json')).stdout)[0];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'beads-epic-'));
    project = { name: 'lab', repoPath: dir, baseBranch: 'main' };
    await bd('init', '-p', 'lab', '--non-interactive', '--skip-agents', '--skip-hooks');
    await epic('done', 'epic-branch', ['closed', 'closed'], '-p', '1');
    await epic('pending', 'epic-branch', ['closed', 'open']);
    await epic('handedBack', 'epic-branch,needs-info', ['closed']);
    await epic('skipped', 'epic-branch,orchestrator:skip', ['closed']);
    await epic('taken', 'epic-branch', ['closed'], '-a', 'someone');
    await epic('plain', 'ready-for-agent', ['closed']);

    // An In review child of an epic on its own branch never lets its sibling stack; under any other parent it does.
    for (const [key, labels] of [['branchy', 'epic-branch'], ['stacky', 'ready-for-human']]) {
      await create(key, key, '-t', 'epic', '-l', labels);
      await create(`${key}Review`, 'in review', '--parent', ids[key], '-l', 'ready-for-agent');
      await bd('--actor', 'orchestrator', 'update', ids[`${key}Review`], '--claim');
      await bd('update', ids[`${key}Review`], '--add-label', 'in-review');
      await create(`${key}Next`, 'blocked by it', '--parent', ids[key], '-l', 'ready-for-agent');
      await bd('dep', 'add', ids[`${key}Next`], ids[`${key}Review`]);
    }
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('lists an open unassigned epic-branch epic with every child closed for its PR, not one with an open child, handed back, skipped or taken, nor any other epic', async () => {
    const { tickets } = await createBeadsGateway().listReady(project);
    assert.deepEqual(
      tickets.map(({ id, priority, spec, epicPr }) => ({ id, priority, spec, epicPr })),
      [
        { id: ids.stackyNext, priority: 2, spec: undefined, epicPr: undefined },
        { id: ids.plain, priority: 2, spec: true, epicPr: undefined }, // a Spec, labelled ready-for-agent (ADR 0009)
        { id: ids.done, priority: 1, spec: undefined, epicPr: true },
      ],
    );
  });

  it('claims the epic for its PR, marks it in review, and closes it once that PR merges', async () => {
    const gateway = createBeadsGateway();
    assert.equal(await gateway.claim(project, ids.done), true);
    await gateway.markInReview(project, ids.done, 'https://github.com/o/r/pull/30');
    assert.ok(!(await gateway.listReady(project)).tickets.some((t) => t.id === ids.done));
    assert.equal(await gateway.merged(project, ids.done, 'https://github.com/o/r/pull/30'), true);
    const closed = await show(ids.done);
    assert.deepEqual([closed.status, closed.close_reason], ['closed', 'PR merged: https://github.com/o/r/pull/30']);
  });

  it('closes a claimed child as landed, naming the branch and tip, and writes nothing to one changed by hand since', async () => {
    const gateway = createBeadsGateway();
    await create('lander', 'lands', '-l', 'ready-for-agent');
    await gateway.claim(project, ids.lander);
    assert.equal(await gateway.landed(project, ids.lander, 'epic/lab-x', 'abc123'), true);
    const issue = await show(ids.lander);
    assert.deepEqual([issue.status, issue.close_reason], ['closed', 'Landed on epic/lab-x at abc123']);

    await create('takenBack', 'taken back by hand', '-l', 'ready-for-agent');
    await gateway.claim(project, ids.takenBack);
    await bd('update', ids.takenBack, '--assignee', 'someone', '--force');
    assert.equal(await gateway.landed(project, ids.takenBack, 'epic/lab-x', 'abc123'), false);
    assert.equal((await show(ids.takenBack)).status, 'in_progress');
  });
});

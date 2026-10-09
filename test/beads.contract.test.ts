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
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it('lists only unassigned, unblocked ready-for-agent Tickets without orchestrator:skip', async () => {
    const tickets = await createBeadsGateway().listReady(project);
    assert.deepEqual(
      tickets.map(({ id, title, priority }) => ({ id, title, priority })),
      [{ id: ids.ready, title: 'ready one', priority: 1 }],
    );
    assert.match(tickets[0].createdAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('releases a Ticket once its blocker is closed', async () => {
    await bd('close', ids.blocker, '-r', 'done');
    const found = (await createBeadsGateway().listReady(project)).map((t) => t.id).sort();
    assert.deepEqual(found, [ids.blocked, ids.ready].sort());
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

  it('hands a claimed Ticket back as failed: reason commented, needs-info added, ready-for-agent dropped, open and unassigned', async () => {
    await create('failing', 'will fail', '-l', 'ready-for-agent,keep-me');
    await createBeadsGateway().claim(project, ids.failing);
    const reason = 'Attempt 1 failed: the agent made no commits\nAttempt 2 failed: "quoted" -- and \'single\'';

    await createBeadsGateway().fail(project, ids.failing, reason);

    const { labels, ...rest } = await state(ids.failing);
    assert.deepEqual({ ...rest, labels: labels.sort() }, { status: 'open', assignee: '', labels: ['keep-me', 'needs-info'] });
    const [issue] = JSON.parse((await bd('show', ids.failing, '--json', '--include-comments')).stdout);
    assert.deepEqual(issue.comments.map((c: { author: string; text: string }) => [c.author, c.text]), [['orchestrator', reason]]);
    assert.ok(!(await createBeadsGateway().listReady(project)).some((t) => t.id === ids.failing));
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
    assert.ok(!(await createBeadsGateway().listReady(project)).some((t) => t.id === ids.killing));
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
    assert.ok((await createBeadsGateway().listReady(project)).some((t) => t.id === ids.interrupted));
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
  });

  it('shows a Ticket without a parent as parent null', async () => {
    assert.equal((await createBeadsGateway().showContext(project, ids.ready)).parent, null);
  });
});

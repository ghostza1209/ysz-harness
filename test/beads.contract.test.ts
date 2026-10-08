import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});

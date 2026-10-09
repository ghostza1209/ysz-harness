import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createWorktree } from '@ai-hero/sandcastle';
import { createHostSteps, worktreePath } from '../src/host';
import type { Project } from '../src/projects';

/** These tests drive real git against a throwaway origin and clone. */
describe('host steps against real git', () => {
  let root: string;
  let origin: string;
  let project: Project;
  const context = { ticket: { id: 't-1', title: 'a ticket' }, parent: null, closedBlockers: [] };
  const host = createHostSteps('test-model');

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'host-steps-')));
    origin = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'develop', origin);
    const repo = join(root, 'repo');
    git(root, 'clone', origin, repo);
    git(repo, 'switch', '-c', 'develop');
    writeFileSync(join(repo, '.gitignore'), '.env\n.sandcastle/\n');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'push', '-u', 'origin', 'develop');
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    project = { name: 'lab', repoPath: repo, baseBranch: 'develop', copyToWorktree: ['.env', 'apps/x/.env'] };
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('branches agent/<id> from the freshly fetched origin tip, not the stale local ref', async () => {
    const other = join(root, 'other');
    git(root, 'clone', '-b', 'develop', origin, other);
    writeFileSync(join(other, 'new.txt'), 'new');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'landed after the clone');
    git(other, 'push', 'origin', 'develop');

    const { branch } = await host.prepare(project, 't-1', context);

    assert.equal(branch, 'agent/t-1');
    const dir = worktreePath(project, branch);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
    assert.equal(git(dir, 'branch', '--show-current'), 'agent/t-1');
  });

  it('writes ticket.json and the gitignored files, none of which an agent can commit by accident', () => {
    const dir = worktreePath(project, 'agent/t-1');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.orchestrator/ticket.json'), 'utf8')), context);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'SECRET=1');
    assert.equal(existsSync(join(dir, 'apps/x/.env')), false);
    assert.equal(git(dir, 'status', '--porcelain'), '');

    git(dir, 'add', '-A');
    git(dir, 'commit', '--allow-empty', '-m', 'agent work');
    assert.equal(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD'), '.gitignore\na.txt\nnew.txt');
  });

  it('prepares the worktree sandcastle attaches to for the same branch', async () => {
    const attached = await createWorktree({ cwd: project.repoPath, branchStrategy: { type: 'branch', branch: 'agent/t-1' } });
    assert.equal(realpathSync(attached.worktreePath), realpathSync(worktreePath(project, 'agent/t-1')));
  });

  it('restarts a Ticket whose earlier worktree is still there', async () => {
    await host.prepare(project, 't-1', context);
    const dir = worktreePath(project, 'agent/t-1');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(project.repoPath, 'rev-parse', 'origin/develop'));
  });

  it('refuses to push a branch that commits .orchestrator/', async () => {
    const dir = worktreePath(project, 'agent/t-1');
    git(dir, 'add', '-f', '.orchestrator/ticket.json');
    git(dir, 'commit', '-m', 'oops');
    await assert.rejects(host.publish(project, { id: 't-1', title: 'a ticket' }, 'agent/t-1'), /\.orchestrator\/ is committed/);
    assert.equal(git(origin, 'branch', '--list', 'agent/t-1'), '');
  });

  it('removes the worktree and keeps the local branch', async () => {
    await host.removeWorktree(project, 'agent/t-1');
    assert.equal(existsSync(worktreePath(project, 'agent/t-1')), false);
    assert.equal(git(project.repoPath, 'branch', '--list', 'agent/t-1').includes('agent/t-1'), true);
  });
});

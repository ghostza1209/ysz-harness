import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createHostSteps } from '../src/host';
import type { Project } from '../src/projects';

/** These tests drive real git against a throwaway origin and Project repo, with fake `claude` and `gh` on PATH. */
describe('host steps against real git', () => {
  let root: string;
  let origin: string;
  let repo: string;
  let sentinels: string;
  let log: string;
  let project: Project;
  let host: ReturnType<typeof createHostSteps>;
  const context = { ticket: { id: 't-1', title: 'a ticket' }, parent: null, closedBlockers: [] };
  const ticket = (id: string) => ({ id, title: 'a ticket' });
  const savedPath = process.env.PATH;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  const commit = (cwd: string, file: string, content: string) => {
    writeFileSync(join(cwd, file), content);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', `add ${file}`);
  };
  /** A project hook an agent could leave for whoever runs claude in its checkout next. */
  const plantClaudeHook = (clone: string) => {
    mkdirSync(join(clone, '.claude'), { recursive: true });
    writeFileSync(join(clone, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${sentinels}/claude` }] }] } }));
  };
  const realRepoGitState = () =>
    JSON.stringify([readFileSync(join(repo, '.git/config'), 'utf8'), readdirSync(join(repo, '.git/hooks')).map((f) => readFileSync(join(repo, '.git/hooks', f), 'utf8'))]);

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'host-steps-')));
    origin = join(root, 'origin.git');
    repo = join(root, 'repo');
    sentinels = join(root, 'sentinels');
    log = join(root, 'log');
    mkdirSync(sentinels);
    mkdirSync(log);
    git(root, 'init', '--bare', '-b', 'develop', origin);
    git(root, 'clone', '-q', origin, repo);
    git(repo, 'switch', '-q', '-c', 'develop');
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'push', '-q', '-u', 'origin', 'develop');
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    project = { name: 'lab', repoPath: repo, baseBranch: 'develop', copyToWorktree: ['.env', 'apps/x/.env'] };
    host = createHostSteps('test-model', join(root, 'clones'));

    const bin = join(root, 'bin');
    mkdirSync(bin);
    script(join(bin, 'claude'), `pwd > ${log}/claude.cwd\nprintf '%s\\n' "$@" > ${log}/claude.argv\necho 'the PR body'`);
    script(join(bin, 'gh'), 'echo https://example.test/pull/1');
    process.env.PATH = `${bin}:${savedPath}`;
  });

  after(() => {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('clones onto agent/<id> at the freshly fetched origin tip, not the stale local ref, with origin pointing at the real remote', async () => {
    const other = join(root, 'other');
    git(root, 'clone', '-q', '-b', 'develop', origin, other);
    commit(other, 'new.txt', 'new');
    git(other, 'push', '-q', 'origin', 'develop');

    const { branch, dir } = await host.prepare(project, 't-1', context);

    const clone = join(dir, 'repo');
    assert.equal(branch, 'agent/t-1');
    assert.equal(git(clone, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
    assert.equal(git(clone, 'rev-parse', 'origin/develop'), git(other, 'rev-parse', 'HEAD'));
    assert.equal(git(clone, 'branch', '--show-current'), 'agent/t-1');
    assert.equal(git(clone, 'remote', 'get-url', 'origin'), origin);
  });

  it('writes ticket.json and the gitignored files, none of which an agent can commit by accident', async () => {
    const clone = join((await host.prepare(project, 't-1', context)).dir, 'repo');
    assert.deepEqual(JSON.parse(readFileSync(join(clone, '.orchestrator/ticket.json'), 'utf8')), context);
    assert.equal(readFileSync(join(clone, '.env'), 'utf8'), 'SECRET=1');
    assert.equal(existsSync(join(clone, 'apps/x/.env')), false);
    assert.equal(git(clone, 'status', '--porcelain'), '');

    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'agent work');
    assert.equal(git(clone, 'ls-tree', '-r', '--name-only', 'HEAD'), '.gitignore\na.txt\nnew.txt');
  });

  it('gives every Run of a Ticket its own fresh clone', async () => {
    const first = await host.prepare(project, 't-1', context);
    commit(join(first.dir, 'repo'), 'b.txt', 'b');
    const second = await host.prepare(project, 't-1', context);
    assert.notEqual(second.dir, first.dir);
    assert.equal(git(join(second.dir, 'repo'), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/develop'));
  });

  it('publishes: fetches the agent branch back, pushes it, and writes the PR body outside the clone and the repo', async () => {
    const prepared = await host.prepare(project, 't-2', context);
    const clone = join(prepared.dir, 'repo');
    commit(clone, 'b.txt', 'the agent change\n');
    const tip = git(clone, 'rev-parse', 'HEAD');
    plantClaudeHook(clone);

    assert.equal(await host.publish(project, ticket('t-2'), prepared), 'https://example.test/pull/1');
    await host.removeClone(prepared);

    assert.equal(git(origin, 'rev-parse', 'agent/t-2'), tip);
    assert.equal(git(repo, 'rev-parse', 'agent/t-2'), tip);
    assert.equal(existsSync(prepared.dir), false);
    const cwd = readFileSync(join(log, 'claude.cwd'), 'utf8').trim();
    assert.ok(!cwd.startsWith(prepared.dir) && !cwd.startsWith(repo), `claude ran in ${cwd}`);
    assert.match(readFileSync(join(log, 'claude.argv'), 'utf8'), /\+the agent change/);
  });

  it('refuses a branch with no commits', async () => {
    const prepared = await host.prepare(project, 't-3', context);
    await assert.rejects(host.publish(project, ticket('t-3'), prepared), /the agent made no commits/);
    assert.equal(git(origin, 'branch', '--list', 'agent/t-3'), '');
  });

  it('refuses to push a branch whose history committed .orchestrator/ even after a later commit untracked it', async () => {
    const prepared = await host.prepare(project, 't-4', context);
    const clone = join(prepared.dir, 'repo');
    git(clone, 'add', '-f', '.orchestrator/ticket.json');
    git(clone, 'commit', '-q', '-m', 'oops');
    git(clone, 'rm', '--cached', '-q', '.orchestrator/ticket.json');
    git(clone, 'commit', '-q', '-m', 'hide it');
    await assert.rejects(host.publish(project, ticket('t-4'), prepared), /\.orchestrator\/ is committed/);
    assert.equal(git(origin, 'branch', '--list', 'agent/t-4'), '');
  });

  it('refuses a clone whose object store reaches into another repo on the host', async () => {
    const other = join(root, 'other-project');
    git(root, 'init', '-q', other);
    commit(other, 'secret.txt', 'TOP SECRET');
    const secret = git(other, 'rev-parse', 'HEAD:secret.txt');
    const prepared = await host.prepare(project, 't-6', context);
    const clone = join(prepared.dir, 'repo');
    writeFileSync(join(clone, '.git/objects/info/alternates'), `${join(other, '.git/objects')}\n`);
    git(clone, 'update-index', '--add', '--cacheinfo', `100644,${secret},leak.txt`);
    git(clone, 'commit', '-q', '-m', 'leak');

    await assert.rejects(host.publish(project, ticket('t-6'), prepared));
    assert.throws(() => git(origin, 'cat-file', '-e', secret));
    assert.throws(() => git(repo, 'cat-file', '-e', secret));
  });

  it('runs nothing on the host for a sandbox that poisons its git dir and smuggles .orchestrator/ in through a merge', async () => {
    rmSync(join(log, 'claude.cwd'), { force: true });
    const before = realRepoGitState();
    const prepared = await host.prepare(project, 't-5', context);
    const clone = join(prepared.dir, 'repo');
    const { branch } = prepared;

    // The agent's commits come first, so the test's own git does not trip the traps planted after them.
    git(clone, 'switch', '-q', '-c', 'side');
    commit(clone, 'side.txt', 'side');
    git(clone, 'switch', '-q', branch);
    commit(clone, 'main.txt', 'main');
    git(clone, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    git(clone, 'add', '-f', '.orchestrator/ticket.json');
    git(clone, 'commit', '-q', '-m', 'merge side');
    // ...and out again through a second merge, so no plain commit's diff ever names it.
    git(clone, 'switch', '-q', '-c', 'side2', 'side');
    commit(clone, 'side2.txt', 'side2');
    git(clone, 'switch', '-q', branch);
    git(clone, 'merge', '-q', '--no-ff', '--no-commit', 'side2');
    git(clone, 'rm', '--cached', '-q', '.orchestrator/ticket.json');
    git(clone, 'commit', '-q', '-m', 'merge side2');
    const tip = git(clone, 'rev-parse', 'HEAD');

    const common = git(clone, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const evil = join(common, 'evil');
    mkdirSync(join(evil, 'hooks'), { recursive: true });
    for (const hook of ['pre-push', 'reference-transaction', 'post-checkout', 'post-merge', 'post-commit', 'pre-commit', 'post-index-change', 'pre-auto-gc']) {
      script(join(evil, 'hooks', hook), `touch ${sentinels}/hook-${hook}`);
    }
    script(join(evil, 'fsmonitor'), `touch ${sentinels}/fsmonitor`);
    writeFileSync(join(evil, 'included'), `[core]\n\thooksPath = ${join(evil, 'hooks')}\n`);
    writeFileSync(
      join(common, 'config'),
      readFileSync(join(common, 'config'), 'utf8') +
        `[core]\n\tfsmonitor = ${join(evil, 'fsmonitor')}\n[credential]\n\thelper = "!touch ${sentinels}/credential"\n[include]\n\tpath = ${join(evil, 'included')}\n`,
    );
    // Collapse a guard range taken from the clone: its origin/<base> now claims to be the agent's tip.
    writeFileSync(join(common, 'refs/remotes/origin/develop'), `${tip}\n`);
    plantClaudeHook(clone);

    await assert.rejects(host.publish(project, ticket('t-5'), prepared), /\.orchestrator\/ is committed/);
    await host.removeClone(prepared);

    assert.deepEqual(readdirSync(sentinels), []);
    assert.equal(realRepoGitState(), before);
    assert.equal(git(origin, 'branch', '--list', branch), '');
    assert.equal(existsSync(join(log, 'claude.cwd')), false);
  });
});

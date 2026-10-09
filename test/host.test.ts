import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    script(join(bin, 'gh'), `while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" ${log}/gh.body; shift; done\necho https://example.test/pull/1`);
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

  it('stops a step whose signal is already aborted, before it makes a clone', async () => {
    const before = readdirSync(join(root, 'clones')).length;
    await assert.rejects(host.prepare(project, 't-aborted', context, AbortSignal.abort()), { name: 'AbortError' });
    assert.equal(readdirSync(join(root, 'clones')).length, before);
  });

  it('removes a clone it could not finish, so a failed or killed prepare leaves nothing behind', async () => {
    mkdirSync(join(repo, 'adir'), { recursive: true });
    writeFileSync(join(repo, 'adir/f'), 'f');
    const before = readdirSync(join(root, 'clones')).length;
    await assert.rejects(host.prepare({ ...project, copyToWorktree: ['adir'] }, 't-broken', context), /directory/i);
    assert.equal(readdirSync(join(root, 'clones')).length, before);
    rmSync(join(repo, 'adir'), { recursive: true });
  });

  it('kills the claude process of a publish that is aborted, and opens no PR', async () => {
    const prepared = await host.prepare(project, 't-hang', context);
    commit(join(prepared.dir, 'repo'), 'h.txt', 'h');
    const bin = join(root, 'bin-hang');
    mkdirSync(bin);
    script(join(bin, 'claude'), `touch ${log}/hang.claude\nexec sleep 60`);
    script(join(bin, 'gh'), `touch ${log}/hang.gh`);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const abort = new AbortController();
      const publishing = host.publish(project, ticket('t-hang'), prepared, { signal: abort.signal });
      for (let i = 0; i < 200 && !existsSync(join(log, 'hang.claude')); i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(existsSync(join(log, 'hang.claude')), 'claude never started');
      const aborted = Date.now();
      abort.abort();
      await assert.rejects(publishing, { name: 'AbortError' });
      assert.ok(Date.now() - aborted < 5_000);
      assert.equal(existsSync(join(log, 'hang.gh')), false);
    } finally {
      process.env.PATH = path;
    }
  });

  it('refuses to remove a directory outside the clones directory, or the clones directory itself', async () => {
    const outside = mkdtempSync(join(root, 'outside-'));
    await assert.rejects(host.removeClone({ dir: outside }), /refusing to remove/);
    await assert.rejects(host.removeClone({ dir: join(root, 'clones') }), /refusing to remove/);
    await assert.rejects(host.removeClone({ dir: '' }), /refusing to remove/);
    assert.ok(existsSync(outside));
    assert.ok(existsSync(join(root, 'clones')));
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

  it('collects: counts the agent commits over base and brings them into the Project repo without pushing', async () => {
    const prepared = await host.prepare(project, 't-13', context);
    const clone = join(prepared.dir, 'repo');
    assert.deepEqual(await host.collect(project, prepared), { tip: git(clone, 'rev-parse', 'HEAD'), commits: 0 });
    commit(clone, 'one.txt', '1');
    commit(clone, 'two.txt', '2');

    const collected = await host.collect(project, prepared);
    assert.deepEqual(collected, { tip: git(clone, 'rev-parse', 'HEAD'), commits: 2 });
    assert.equal(git(repo, 'rev-parse', 'agent/t-13'), collected.tip);
    assert.equal(git(origin, 'branch', '--list', 'agent/t-13'), '');
  });

  it('publishes a given tip instead of whatever the review agent left on the branch, and says the review was skipped', async () => {
    const prepared = await host.prepare(project, 't-14', context);
    const clone = join(prepared.dir, 'repo');
    commit(clone, 'impl.txt', 'implemented');
    const { tip } = await host.collect(project, prepared);
    commit(clone, 'half-review.txt', 'unfinished');

    await host.publish(project, ticket('t-14'), prepared, { tip, reviewSkipped: 'the review agent failed: idle for 600s' });

    assert.equal(git(origin, 'rev-parse', 'agent/t-14'), tip);
    assert.equal(readFileSync(join(log, 'gh.body'), 'utf8'), '> review skipped: the review agent failed: idle for 600s\n\nthe PR body');
  });

  it('publishes the reviewed branch with the body as written when the review was not skipped', async () => {
    const prepared = await host.prepare(project, 't-15', context);
    const clone = join(prepared.dir, 'repo');
    commit(clone, 'impl.txt', 'implemented');
    commit(clone, 'review-fix.txt', 'fixed in review');

    await host.publish(project, ticket('t-15'), prepared);

    assert.equal(git(origin, 'rev-parse', 'agent/t-15'), git(clone, 'rev-parse', 'HEAD'));
    assert.equal(readFileSync(join(log, 'gh.body'), 'utf8'), 'the PR body');
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

  it('clones only origin/<base>: no stash, local branch or unreachable object of the Project repo', async () => {
    git(repo, 'switch', '-q', '-c', 'local-only');
    commit(repo, 'local.txt', 'LOCAL ONLY');
    const local = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', 'develop');
    writeFileSync(join(repo, 'a.txt'), 'STASHED SECRET');
    git(repo, 'stash', '-q');
    const stash = git(repo, 'rev-parse', 'stash');
    const clone = join((await host.prepare(project, 't-7', context)).dir, 'repo');
    git(repo, 'stash', 'drop', '-q');
    git(repo, 'branch', '-q', '-D', 'local-only');
    assert.throws(() => git(clone, 'cat-file', '-e', stash));
    assert.throws(() => git(clone, 'cat-file', '-e', local));
  });

  it('refuses an alternates file whose name differs only in case, which a case-insensitive disk still serves to git', async () => {
    const other = join(root, 'other-project-2');
    git(root, 'init', '-q', other);
    commit(other, 'secret.txt', 'TOP SECRET 2');
    const secret = git(other, 'rev-parse', 'HEAD:secret.txt');
    const prepared = await host.prepare(project, 't-8', context);
    const clone = join(prepared.dir, 'repo');
    git(clone, 'update-index', '--add', '--cacheinfo', `100644,${secret},leak.txt`, '--info-only');
    writeFileSync(join(clone, '.git/objects/info/Alternates'), `${join(other, '.git/objects')}\n`);
    git(clone, 'commit', '-q', '-m', 'leak');

    await assert.rejects(host.publish(project, ticket('t-8'), prepared), /refusing to read the clone/);
    assert.throws(() => git(origin, 'cat-file', '-e', secret));
    assert.throws(() => git(repo, 'cat-file', '-e', secret));
  });

  it('packs only objects the clone holds, not ones it names from the Project repo\'s own store', async () => {
    git(repo, 'switch', '-q', '-c', 'local-secret');
    commit(repo, 'local-secret.txt', 'LOCAL SECRET');
    const secret = git(repo, 'rev-parse', 'HEAD:local-secret.txt');
    git(repo, 'switch', '-q', 'develop');
    const prepared = await host.prepare(project, 't-11', context);
    const clone = join(prepared.dir, 'repo');
    git(clone, 'update-index', '--add', '--info-only', '--cacheinfo', `100644,${secret},leak.txt`);
    const tree = git(clone, 'write-tree', '--missing-ok');
    git(clone, 'update-ref', `refs/heads/${prepared.branch}`, git(clone, 'commit-tree', tree, '-p', 'HEAD', '-m', 'leak'));

    await assert.rejects(host.publish(project, ticket('t-11'), prepared));
    assert.throws(() => git(origin, 'cat-file', '-e', secret));
    git(repo, 'branch', '-q', '-D', 'local-secret');
  });

  it('refuses a copyToWorktree or .orchestrator/ path committed in another case, which is the same file on a case-insensitive disk', async () => {
    const prepared = await host.prepare(project, 't-12', context);
    const clone = join(prepared.dir, 'repo');
    git(clone, 'update-index', '--add', '--cacheinfo', `100644,${git(clone, 'hash-object', '-w', '.env')},.ENV`);
    git(clone, 'commit', '-q', '-m', 'oops');
    await assert.rejects(host.publish(project, ticket('t-12'), prepared), /\.env is committed/);
    assert.equal(git(origin, 'branch', '--list', 'agent/t-12'), '');
  });

  it('refuses a clone whose refs reach out of it through a symlink', async () => {
    const prepared = await host.prepare(project, 't-9', context);
    const clone = join(prepared.dir, 'repo');
    commit(clone, 'b.txt', 'b');
    const outside = join(root, 'outside-refs');
    mkdirSync(outside);
    writeFileSync(join(outside, 't-9'), `${git(clone, 'rev-parse', 'HEAD')}\n`);
    git(clone, 'switch', '-q', '--detach');
    rmSync(join(clone, '.git/refs/heads/agent'), { recursive: true });
    symlinkSync(outside, join(clone, '.git/refs/heads/agent'));

    await assert.rejects(host.publish(project, ticket('t-9'), prepared), /refusing to read the clone/);
    assert.equal(git(origin, 'branch', '--list', 'agent/t-9'), '');
  });

  it('refuses to push a branch that commits a copyToWorktree file', async () => {
    const prepared = await host.prepare(project, 't-10', context);
    const clone = join(prepared.dir, 'repo');
    git(clone, 'add', '-f', '.env');
    git(clone, 'commit', '-q', '-m', 'oops');
    await assert.rejects(host.publish(project, ticket('t-10'), prepared), /\.env is committed/);
    assert.equal(git(origin, 'branch', '--list', 'agent/t-10'), '');
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

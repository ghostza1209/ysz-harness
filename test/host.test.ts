import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createHostSteps, prTitleAndBody, ticketKey } from '../src/host';
import type { Project } from '../src/projects';

/** git reads a case variant of objects/info/alternates only where the disk ignores case, as macOS does and Linux does not. */
const caseInsensitiveDisk = existsSync(tmpdir().toUpperCase());

/** These tests drive real git against a throwaway origin and Project repo, with fake `claude` and `gh` on PATH. */
describe('host steps against real git', () => {
  let root: string;
  let origin: string;
  let repo: string;
  let sentinels: string;
  let log: string;
  let project: Project;
  let host: ReturnType<typeof createHostSteps>;
  const context = { ticket: { id: 't-1', title: 'a ticket' }, parent: null, closedBlockers: [], inReviewBlocker: null, openFriction: [] };
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
    script(join(bin, 'gh'), `[ "$1" = auth ] && [ "$2" = token ] && { echo "tok-$4"; exit 0; }\necho "\${GH_TOKEN:-none}" > ${log}/gh.token\nwhile [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" ${log}/gh.body; [ "$1" = --title ] && printf '%s' "$2" > ${log}/gh.title; shift; done\necho https://example.test/pull/1`);
    process.env.PATH = `${bin}:${savedPath}`;
  });

  after(() => {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('runs the preflight command in the Project repo: passes on exit 0, fails on non-zero, passes when there is none', async () => {
    const probe = join(root, 'probe');
    const withPreflight = (code: number) => ({ ...project, preflight: ['sh', '-c', `pwd > ${probe}; exit ${code}`] });
    await host.preflight(withPreflight(0));
    assert.equal(readFileSync(probe, 'utf8').trim(), repo);
    await assert.rejects(host.preflight(withPreflight(1)), /sh -c failed/);
    await host.preflight(project);
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

    assert.deepEqual(await host.publish(project, ticket('t-2'), prepared), { url: 'https://example.test/pull/1', base: 'develop' });
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

  it('stacks on the In review blocker: clones its branch, counts only the new commits, opens the PR onto it and links the stack', async () => {
    const other = join(root, 'other-stack');
    git(root, 'clone', '-q', '-b', 'develop', origin, other);
    git(other, 'switch', '-q', '-c', 'agent/t-a');
    commit(other, 'blocker.txt', 'the blocker change');
    git(other, 'push', '-q', 'origin', 'agent/t-a');
    const blocker = { id: 't-a', title: 'the blocker', prUrl: 'https://example.test/pull/7' };

    const prepared = await host.prepare(project, 't-st', { ...context, inReviewBlocker: blocker });
    const clone = join(prepared.dir, 'repo');
    assert.equal(git(clone, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
    assert.deepEqual(JSON.parse(readFileSync(join(clone, '.orchestrator/ticket.json'), 'utf8')).inReviewBlocker, blocker);
    commit(clone, 'dependent.txt', 'the dependent change');
    assert.equal((await host.collect(project, prepared)).commits, 1);

    const bin = join(root, 'bin-stack');
    mkdirSync(bin, { recursive: true });
    script(join(bin, 'gh'), `[ "$1" = auth ] && exit 0\necho "$*" >> ${log}/gh.stack\n[ "$2" = view ] && { echo '{"baseRefName":"release"}'; exit 0; }\n[ "$1" = pr ] && echo https://example.test/pull/8\nexit 0`);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const lines: string[] = [];
    try {
      assert.deepEqual(await host.publish(project, ticket('t-st'), prepared, { log: (line) => lines.push(line) }), { url: 'https://example.test/pull/8', base: 'agent/t-a' });
    } finally {
      process.env.PATH = path;
    }
    const calls = readFileSync(join(log, 'gh.stack'), 'utf8').trim().split('\n');
    assert.equal(calls[0], 'pr view https://example.test/pull/7 --json state,baseRefName');
    assert.match(calls[1], /^pr create --head agent\/t-st --base agent\/t-a /);
    // The blocker's own base, or gh stack link retargets the blocker's PR onto the repo's default branch.
    assert.equal(calls[2], 'stack link --base release https://example.test/pull/7 https://example.test/pull/8');
    assert.equal(lines.at(-2), 'Opening the PR against agent/t-a');
    assert.equal(lines.at(-1), 'Stacking it on https://example.test/pull/7');
    assert.match(readFileSync(join(log, 'claude.argv'), 'utf8'), /since origin\/agent\/t-a/);
    assert.doesNotMatch(readFileSync(join(log, 'claude.argv'), 'utf8'), /\+the blocker change/);
  });

  it('moves a stacked Run whose blocker squash-merged meanwhile onto the blocker base, with only its own commits, and stacks nothing', async () => {
    const other = join(root, 'other-stack-merged');
    git(root, 'clone', '-q', '-b', 'develop', origin, other);
    git(other, 'switch', '-q', '-c', 'agent/t-m');
    commit(other, 'blocker-m.txt', 'the merged blocker change');
    git(other, 'push', '-q', 'origin', 'agent/t-m');
    const prepared = await host.prepare(project, 't-sm', { ...context, inReviewBlocker: { id: 't-m', title: 'm', prUrl: 'https://example.test/pull/11' } });
    commit(join(prepared.dir, 'repo'), 'sm.txt', 'sm');
    // The squash merge: develop gets the blocker change as a new commit, the branch is deleted on origin and pruned here.
    git(other, 'switch', '-q', 'develop');
    git(other, 'merge', '-q', '--squash', 'agent/t-m');
    git(other, 'commit', '-q', '-m', 'the squash commit');
    git(other, 'push', '-q', 'origin', 'develop', ':agent/t-m');
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/agent/t-m');

    assert.equal((await host.collect(project, prepared)).commits, 1);

    const bin = join(root, 'bin-stack-merged');
    mkdirSync(bin, { recursive: true });
    script(join(bin, 'gh'), `[ "$1" = auth ] && exit 0\necho "$*" >> ${log}/gh.merged\n[ "$2" = view ] && { echo '{"state":"MERGED","baseRefName":"develop"}'; exit 0; }\n[ "$1" = pr ] && echo https://example.test/pull/12\nexit 0`);
    // The first publish pushes, then gets an empty PR body; its Retry replays onto a develop that moved on since.
    script(join(bin, 'claude'), `printf '%s\\n' "$@" > ${log}/claude.argv\n[ -f ${log}/claude.once ] && echo 'the PR body'\ntouch ${log}/claude.once`);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await assert.rejects(host.publish(project, ticket('t-sm'), prepared), /empty PR body/);
      commit(other, 'later.txt', 'later');
      git(other, 'push', '-q', 'origin', 'develop');
      assert.deepEqual(await host.publish(project, ticket('t-sm'), prepared), { url: 'https://example.test/pull/12', base: 'develop' });
    } finally {
      process.env.PATH = path;
    }
    const calls = readFileSync(join(log, 'gh.merged'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 3);
    assert.match(calls[2], /^pr create --head agent\/t-sm --base develop /);
    assert.equal(git(origin, 'rev-parse', 'agent/t-sm~1'), git(other, 'rev-parse', 'develop'));
    assert.equal(git(origin, 'log', '--format=%s', 'develop..agent/t-sm'), 'add sm.txt');
    assert.doesNotMatch(readFileSync(join(log, 'claude.argv'), 'utf8'), /\+the merged blocker change/);
  });

  it('still returns the PR when linking the stack fails, and logs why', async () => {
    const other = join(root, 'other-stack-fail');
    git(root, 'clone', '-q', '-b', 'develop', origin, other);
    git(other, 'switch', '-q', '-c', 'agent/t-b');
    commit(other, 'blocker-b.txt', 'b');
    git(other, 'push', '-q', 'origin', 'agent/t-b');
    const prepared = await host.prepare(project, 't-sf', { ...context, inReviewBlocker: { id: 't-b', title: 'b', prUrl: 'https://example.test/pull/9' } });
    commit(join(prepared.dir, 'repo'), 'sf.txt', 'sf');

    const bin = join(root, 'bin-stack-fail');
    mkdirSync(bin, { recursive: true });
    script(join(bin, 'gh'), `[ "$1" = auth ] && exit 0\n[ "$2" = view ] && { echo '{"baseRefName":"develop"}'; exit 0; }\n[ "$1" = stack ] && { echo 'Cannot update stack: this would remove #2 from the stack' >&2; exit 5; }\necho https://example.test/pull/10`);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const lines: string[] = [];
    try {
      assert.deepEqual(await host.publish(project, ticket('t-sf'), prepared, { log: (line) => lines.push(line) }), { url: 'https://example.test/pull/10', base: 'agent/t-b' });
    } finally {
      process.env.PATH = path;
    }
    assert.match(lines.at(-1)!, /^Could not stack it on https:\/\/example.test\/pull\/9, so it stays a plain PR onto agent\/t-b: .*would remove #2/);
  });

  /** Run `fn` with a gh on PATH that answers `pr list` with `list` and records `pr create`'s argv, title and body. */
  async function withEpicGh<T>(list: string, fn: () => Promise<T>): Promise<T> {
    const bin = join(root, 'bin-epic');
    mkdirSync(bin, { recursive: true });
    rmSync(join(log, 'gh.create'), { force: true });
    script(
      join(bin, 'gh'),
      `[ "$1" = auth ] && [ "$2" = token ] && { echo "tok-$4"; exit 0; }\n[ "$2" = list ] && { echo '${list}'; exit 0; }\nprintf '%s\\n' "$@" > ${log}/gh.create\n` +
        `while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" ${log}/gh.create.body; shift; done\necho https://example.test/pull/20`,
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = path;
    }
  }
  const epicChild = (epicId: string) => ({ ...context, parent: { id: epicId, labels: ['epic-branch'] } });

  it('clones a child of an epic-branch epic that origin lacks at a local epic branch cut from origin/<base>, never pushed', async () => {
    const first = await host.prepare(project, 't-e1', epicChild('e-1'));
    const develop = git(origin, 'rev-parse', 'develop');
    assert.deepEqual([first.epic, first.land], ['epic/e-1', true]);
    assert.equal(git(repo, 'rev-parse', 'refs/heads/epic/e-1'), develop);
    assert.equal(git(origin, 'branch', '--list', 'epic/e-1'), '');
    assert.equal(git(join(first.dir, 'repo'), 'rev-parse', 'HEAD'), develop);
    assert.equal(git(join(first.dir, 'repo'), 'rev-parse', 'origin/epic/e-1'), develop);
  });

  it('lands a child by fast-forwarding the local epic branch, again without harm, and the next child starts from it', async () => {
    const first = await host.prepare(project, 't-e1', epicChild('e-1'));
    commit(join(first.dir, 'repo'), 'e1.txt', 'e1');
    const tip = git(join(first.dir, 'repo'), 'rev-parse', 'HEAD');
    const lines: string[] = [];
    assert.equal(await host.land(project, first, { log: (line) => lines.push(line) }), tip);
    assert.equal(await host.land(project, first), tip);
    assert.deepEqual(lines, ['Landing agent/t-e1 on epic/e-1']);
    assert.equal(git(repo, 'rev-parse', 'refs/heads/epic/e-1'), tip);
    assert.equal(git(origin, 'branch', '--list', 'epic/e-1'), '');

    const second = await host.prepare(project, 't-e2', epicChild('e-1'));
    assert.equal(git(join(second.dir, 'repo'), 'rev-parse', 'HEAD'), tip);
    assert.equal(second.base, tip);
  });

  it('refuses to land on an epic branch that moved elsewhere since the clone, or that a worktree has checked out, or a secret', async () => {
    const child = await host.prepare(project, 't-e5', epicChild('e-5'));
    commit(join(child.dir, 'repo'), 'e5.txt', 'e5');
    const cut = git(repo, 'rev-parse', 'refs/heads/epic/e-5');
    const elsewhere = git(repo, 'commit-tree', '-p', cut, '-m', 'by hand', `${cut}^{tree}`);
    git(repo, 'update-ref', 'refs/heads/epic/e-5', elsewhere);
    await assert.rejects(host.land(project, child), /non-fast-forward/);
    assert.equal(git(repo, 'rev-parse', 'refs/heads/epic/e-5'), elsewhere);

    git(repo, 'update-ref', 'refs/heads/epic/e-5', cut);
    const worktree = join(root, 'wt-e5');
    git(repo, 'worktree', 'add', '-q', worktree, 'epic/e-5');
    try {
      await assert.rejects(host.land(project, child), /checked out/);
    } finally {
      git(repo, 'worktree', 'remove', '--force', worktree);
    }
    assert.equal(git(repo, 'rev-parse', 'refs/heads/epic/e-5'), cut);

    const leaky = await host.prepare(project, 't-e6', epicChild('e-5'));
    writeFileSync(join(leaky.dir, 'repo/.env'), 'SECRET=2');
    git(join(leaky.dir, 'repo'), 'add', '-f', '.env');
    git(join(leaky.dir, 'repo'), 'commit', '-q', '-m', 'leak');
    await assert.rejects(host.land(project, leaky), /refusing to push: \.env is committed/);
    assert.equal(git(repo, 'rev-parse', 'refs/heads/epic/e-5'), cut);
  });

  it('refuses to clone a child that lands on its epic branch onto an In review blocker', async () => {
    const stacked = { ...epicChild('e-8'), inReviewBlocker: { id: 't-b', title: 'blocker', prUrl: 'https://example.test/pull/9' } };
    await assert.rejects(host.prepare(project, 't-e8', stacked), /lands on epic\/e-8, so it cannot stack on https:\/\/example.test\/pull\/9/);
  });

  it('keeps a child of an epic already on origin on opening its PR onto that branch (ADR 0006)', async () => {
    const other = join(root, 'other-epic');
    git(root, 'clone', '-q', '-b', 'develop', origin, other);
    git(other, 'switch', '-q', '-c', 'epic/e-9');
    commit(other, 'merged-child.txt', 'merged');
    git(other, 'push', '-q', 'origin', 'epic/e-9');

    const child = await host.prepare(project, 't-e9', epicChild('e-9'));
    assert.deepEqual([child.epic, child.land], ['epic/e-9', undefined]);
    assert.equal(git(join(child.dir, 'repo'), 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
    assert.equal(git(repo, 'branch', '--list', 'epic/e-9'), '');
    commit(join(child.dir, 'repo'), 'e9.txt', 'e9');
    assert.equal((await host.publish(project, ticket('t-e9'), child)).base, 'epic/e-9');
  });

  it("names the epic branch with the Project's prefix, and keeps a Ticket whose parent lacks the label on baseBranch", async () => {
    const custom = await host.prepare({ ...project, epicBranchPrefix: 'train/' }, 't-e3', epicChild('e-2'));
    assert.equal(custom.epic, 'train/e-2');
    assert.equal(git(repo, 'rev-parse', 'refs/heads/train/e-2'), git(origin, 'rev-parse', 'develop'));

    const plain = await host.prepare(project, 't-e4', { ...context, parent: { id: 'e-3', labels: ['ready-for-human'] } });
    assert.deepEqual([plain.epic, plain.land], [undefined, undefined]);
    assert.equal(git(repo, 'branch', '--list', 'epic/e-3'), '');
    assert.equal(git(join(plain.dir, 'repo'), 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'develop'));
  });

  it("pushes the local epic branch and opens the epic's PR onto baseBranch, titled by its key, with the skipped reviews on top", async () => {
    const child = await host.prepare(project, 't-p1', epicChild('e-p'));
    commit(join(child.dir, 'repo'), 'p1.txt', 'p1');
    const tip = await host.land(project, child);
    const lines: string[] = [];

    const pr = await withEpicGh('[]', () =>
      host.publishEpic(project, { id: 'e-p', title: 'the epic' }, 'OP-5', { reviewSkipped: 't-p1: boom', log: (line) => lines.push(line) }),
    );

    assert.deepEqual(pr, { url: 'https://example.test/pull/20', base: 'develop' });
    assert.equal(git(origin, 'rev-parse', 'epic/e-p'), tip);
    const argv = readFileSync(join(log, 'gh.create'), 'utf8').split('\n');
    assert.deepEqual(argv.slice(0, 8), ['pr', 'create', '--head', 'epic/e-p', '--base', 'develop', '--title', 'chore: OP-5 the epic']);
    assert.equal(readFileSync(join(log, 'gh.create.body'), 'utf8'), '> review skipped: t-p1: boom\n\nthe PR body');
    assert.match(readFileSync(join(log, 'claude.argv'), 'utf8'), /Ticket e-p "the epic"\. Its commits since origin\/develop/);
    assert.deepEqual(lines, ['Pushing epic/e-p to origin', 'Writing the PR body (claude -p)', 'Opening the PR against develop']);
  });

  it("takes the epic's open PR instead of opening a second, and refuses an epic branch with no commits over the base", async () => {
    const child = await host.prepare(project, 't-q1', epicChild('e-q'));
    commit(join(child.dir, 'repo'), 'q1.txt', 'q1');
    await host.land(project, child);
    const pr = await withEpicGh('[{"url":"https://example.test/pull/76","state":"CLOSED"},{"url":"https://example.test/pull/77","state":"OPEN"}]', () =>
      host.publishEpic(project, { id: 'e-q', title: 'the epic' }, 'e-q'),
    );
    assert.deepEqual(pr, { url: 'https://example.test/pull/77', base: 'develop' });
    assert.equal(existsSync(join(log, 'gh.create')), false);

    await host.prepare(project, 't-r1', epicChild('e-r'));
    await assert.rejects(withEpicGh('[]', () => host.publishEpic(project, { id: 'e-r', title: 'empty' }, 'e-r')), /epic\/e-r has no commits over develop/);
  });

  it('opens the PR of an epic begun before ADR 0008 from its branch on origin, pushing nothing', async () => {
    const other = join(root, 'other-old-epic');
    git(root, 'clone', '-q', '-b', 'develop', origin, other);
    git(other, 'switch', '-q', '-c', 'epic/e-old');
    commit(other, 'old.txt', 'old');
    git(other, 'push', '-q', 'origin', 'epic/e-old');

    const pr = await withEpicGh('[]', () => host.publishEpic(project, { id: 'e-old', title: 'old epic' }, 'e-old'));
    assert.equal(pr.url, 'https://example.test/pull/20');
    assert.equal(git(repo, 'branch', '--list', 'epic/e-old'), '');
    assert.equal(git(origin, 'rev-parse', 'epic/e-old'), git(other, 'rev-parse', 'HEAD'));
    assert.deepEqual(readFileSync(join(log, 'gh.create'), 'utf8').split('\n').slice(2, 6), ['--head', 'epic/e-old', '--base', 'develop']);
  });

  it('takes the merged PR of an epic begun before ADR 0008 whose branch origin has deleted since, but not one with a local branch', async () => {
    const mergedPr = '[{"url":"https://example.test/pull/88","state":"MERGED"}]';
    const pr = await withEpicGh(mergedPr, () => host.publishEpic(project, { id: 'e-gone', title: 'merged by hand' }, 'e-gone'));
    assert.deepEqual(pr, { url: 'https://example.test/pull/88', base: 'develop' });
    assert.equal(existsSync(join(log, 'gh.create')), false);

    const child = await host.prepare(project, 't-m1', epicChild('e-m'));
    commit(join(child.dir, 'repo'), 'm1.txt', 'm1');
    await host.land(project, child);
    assert.equal((await withEpicGh(mergedPr, () => host.publishEpic(project, { id: 'e-m', title: 'reopened' }, 'e-m'))).url, 'https://example.test/pull/20');
  });

  it("reads a PR's state and when it closed as the Project's gh account", async () => {
    const bin = join(root, 'bin-pr-view');
    mkdirSync(bin, { recursive: true });
    script(join(bin, 'gh'), `[ "$1" = auth ] && [ "$2" = token ] && { echo "tok-$4"; exit 0; }\necho "\${GH_TOKEN:-none} $*" > ${log}/gh.view\necho '{"state":"MERGED","closedAt":"2026-10-16T07:05:01Z"}'`);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      assert.deepEqual(await host.prState({ ...project, ghUser: 'work-acct' }, 'https://example.test/pull/4'), { state: 'MERGED', closedAt: Date.UTC(2026, 9, 16, 7, 5, 1) });
      assert.equal(readFileSync(join(log, 'gh.view'), 'utf8').trim(), 'tok-work-acct pr view https://example.test/pull/4 --json state,closedAt');
    } finally {
      process.env.PATH = path;
    }
  });

  it("opens the PR as the Project's gh account, and as gh's active account when it names none", async () => {
    for (const [ghUser, token] of [['work-acct', 'tok-work-acct'], [undefined, 'none']] as const) {
      const id = `t-gh-${ghUser ?? 'default'}`;
      const prepared = await host.prepare(project, id, context);
      commit(join(prepared.dir, 'repo'), 'c.txt', id);
      const lines: string[] = [];
      await host.publish({ ...project, ghUser }, ticket(id), prepared, { log: (line) => lines.push(line) });
      assert.equal(readFileSync(join(log, 'gh.token'), 'utf8').trim(), token);
      assert.deepEqual(lines, [
        `Pushing agent/${id} to origin`,
        'Writing the PR body (claude -p)',
        ghUser ? `Opening the PR against develop as ${ghUser}` : 'Opening the PR against develop',
      ]);
    }
  });

  it('titles the PR as a Conventional Commit naming the Ticket by its Jira key, and keeps the rest as the body', async () => {
    const prepared = await host.prepare(project, 't-16', { ...context, ticket: { id: 't-16', external_ref: 'jira-OP-7' } });
    commit(join(prepared.dir, 'repo'), 'd.txt', 'd');
    const bin = join(root, 'bin-title');
    mkdirSync(bin, { recursive: true });
    script(join(bin, 'claude'), `printf 'feat(api): run the checks\\n\\n## Summary\\nthe body\\n'`);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await host.publish(project, ticket('t-16'), prepared);
    } finally {
      process.env.PATH = path;
    }
    assert.equal(readFileSync(join(log, 'gh.title'), 'utf8'), 'feat(api): OP-7 run the checks');
    assert.equal(readFileSync(join(log, 'gh.body'), 'utf8'), '## Summary\nthe body');
  });

  it('lists the given Follow-up titles in a ## Follow-ups section at the end of the PR body, and leaves it out when there are none', async () => {
    const withTitles = await host.prepare(project, 't-17', context);
    commit(join(withTitles.dir, 'repo'), 'e.txt', 'e');
    await host.publish(project, ticket('t-17'), withTitles, { reviewSkipped: 'no review', followUps: ['drop the old export', 'cover the empty case'] });
    assert.equal(readFileSync(join(log, 'gh.body'), 'utf8'), '> review skipped: no review\n\nthe PR body\n\n## Follow-ups\n\n- drop the old export\n- cover the empty case');

    const without = await host.prepare(project, 't-18', context);
    commit(join(without.dir, 'repo'), 'f.txt', 'f');
    await host.publish(project, ticket('t-18'), without, { followUps: [] });
    assert.equal(readFileSync(join(log, 'gh.body'), 'utf8'), 'the PR body');
  });

  it('does not ask claude to collect or invent follow-ups for the PR body', async () => {
    const prepared = await host.prepare(project, 't-19', context);
    commit(join(prepared.dir, 'repo'), 'g.txt', 'g');
    await host.publish(project, ticket('t-19'), prepared);
    assert.doesNotMatch(readFileSync(join(log, 'claude.argv'), 'utf8'), /Follow-ups/i);
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
    assert.equal(readFileSync(join(log, 'gh.title'), 'utf8'), 'chore: t-15 a ticket');
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

  it("clones origin's branches, which a Ticket may port from, but no stash, local branch or unreachable object of the Project repo", async () => {
    git(repo, 'switch', '-q', '-c', 'pushed');
    commit(repo, 'pushed.txt', 'pushed');
    git(repo, 'push', '-q', 'origin', 'pushed');
    git(repo, 'switch', '-q', 'develop');
    git(repo, 'branch', '-q', '-D', 'pushed');
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
    assert.equal(git(clone, 'show', 'origin/pushed:pushed.txt'), 'pushed');
  });

  it('refuses an alternates file whose name differs only in case, which a case-insensitive disk still serves to git', { skip: !caseInsensitiveDisk && 'the disk is case-sensitive' }, async () => {
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

  describe('writeTicket', () => {
    const ticketPath = (dir: string) => join(dir, 'repo/.orchestrator/ticket.json');
    const handed = { ...context, implementReports: { followUps: [{ ref: 'F1', title: 'drop it', body: 'why' }], friction: [] } };

    it('rewrites the Ticket file with the given context', async () => {
      const prepared = await host.prepare(project, 't-wt1', context);
      await host.writeTicket(prepared, handed);
      assert.deepEqual(JSON.parse(readFileSync(ticketPath(prepared.dir), 'utf8')), handed);
    });

    it('refuses a ticket.json that is a symlink and leaves its target untouched', async () => {
      const prepared = await host.prepare(project, 't-wt2', context);
      const target = join(root, 'wt2-target');
      writeFileSync(target, 'host file');
      rmSync(ticketPath(prepared.dir));
      symlinkSync(target, ticketPath(prepared.dir));
      await assert.rejects(host.writeTicket(prepared, handed), /not a plain file/);
      assert.equal(readFileSync(target, 'utf8'), 'host file');
    });

    it('refuses an .orchestrator that is a symlink and leaves the directory it points at untouched', async () => {
      const prepared = await host.prepare(project, 't-wt3', context);
      const targetDir = join(root, 'wt3-target');
      mkdirSync(targetDir);
      writeFileSync(join(targetDir, 'ticket.json'), 'host file');
      rmSync(join(prepared.dir, 'repo/.orchestrator'), { recursive: true });
      symlinkSync(targetDir, join(prepared.dir, 'repo/.orchestrator'));
      await assert.rejects(host.writeTicket(prepared, handed), /not a plain directory/);
      assert.equal(readFileSync(join(targetDir, 'ticket.json'), 'utf8'), 'host file');
    });

    it('refuses a clone whose repo is a symlink', async () => {
      const prepared = await host.prepare(project, 't-wt4', context);
      const moved = join(root, 'wt4-moved');
      renameSync(join(prepared.dir, 'repo'), moved);
      symlinkSync(moved, join(prepared.dir, 'repo'));
      await assert.rejects(host.writeTicket(prepared, handed), /not a plain directory/);
      assert.deepEqual(JSON.parse(readFileSync(join(moved, '.orchestrator/ticket.json'), 'utf8')), context);
    });

    it('refuses when the sandbox deleted the Ticket file', async () => {
      const prepared = await host.prepare(project, 't-wt5', context);
      rmSync(ticketPath(prepared.dir));
      await assert.rejects(host.writeTicket(prepared, handed), /not a plain file/);
    });
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
    // Collapse a guard range taken from the clone: its origin/<base> now claims to be the agent's tip. Loose, over the packed one.
    mkdirSync(join(common, 'refs/remotes/origin'), { recursive: true });
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

describe('PR title', () => {
  it('names a Ticket by its own Jira key, else its parent epic\'s, else its own id', () => {
    const key = (ticket: Record<string, unknown>, parent: Record<string, unknown> | null) => ticketKey('t-9', { ticket, parent, closedBlockers: [], inReviewBlocker: null, openFriction: [] });
    assert.equal(key({ external_ref: 'jira-OP-7' }, { external_ref: 'jira-OP-1' }), 'OP-7');
    assert.equal(key({}, { external_ref: 'jira-OP-1' }), 'OP-1');
    assert.equal(key({ external_ref: 'gh-12' }, null), 't-9');
    assert.equal(key({}, {}), 't-9');
  });

  it('also takes a Jira key from a bare external_ref or a label, the Ticket\'s before its parent\'s', () => {
    const key = (ticket: Record<string, unknown>, parent: Record<string, unknown> | null) => ticketKey('t-9', { ticket, parent, closedBlockers: [], inReviewBlocker: null, openFriction: [] });
    assert.equal(key({ labels: ['in-review'] }, { labels: ['epic-branch', 'OP-2567', 'ready-for-agent'] }), 'OP-2567');
    assert.equal(key({ external_ref: 'TV-839' }, { labels: ['OP-1'] }), 'TV-839');
    assert.equal(key({ labels: ['DW-5482'] }, { external_ref: 'jira-OP-1' }), 'DW-5482');
    assert.equal(key({ labels: ['op-7', 'needs-info'] }, null), 't-9');
  });

  it('puts the key before the subject of a Conventional Commit first line, with or without a scope', () => {
    assert.deepEqual(prTitleAndBody('fix(chat): render the badge\n\nbody', 'OP-2', 'Render it'), { title: 'fix(chat): OP-2 render the badge', body: 'body' });
    assert.deepEqual(prTitleAndBody('refactor: drop ClaimTypeEnum\n\nbody', 'OP-2', 'Drop it'), { title: 'refactor: OP-2 drop ClaimTypeEnum', body: 'body' });
  });

  it('falls back to chore and the Ticket title, keeping the whole output as the body, when the first line is no Conventional Commit', () => {
    for (const output of ['## Summary\nbody', 'feature: add x\n\nbody', 'feat!: drop the API\n\nbody', 'Feat: add x\n\nbody']) {
      assert.deepEqual(prTitleAndBody(output, 'OP-2', 'Add x'), { title: 'chore: OP-2 Add x', body: output }, output);
    }
  });

  it('names the key once in that fallback when the Ticket title already starts with it', () => {
    assert.equal(prTitleAndBody('## Summary', 'OP-2567', 'OP-2567: Gmail sync attaches').title, 'chore: OP-2567 Gmail sync attaches');
    assert.equal(prTitleAndBody('## Summary', 'OP-25', 'OP-2567 is unrelated').title, 'chore: OP-25 OP-2567 is unrelated');
  });
});

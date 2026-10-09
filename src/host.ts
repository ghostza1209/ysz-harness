import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { TicketContext } from './beads';
import type { Project } from './projects';

const execFileAsync = promisify(execFile);

/**
 * One Run's disposable clone of the Project repo is `<dir>/repo`; the sandbox mounts it and may rewrite all of it,
 * .git included. So no host git runs in it once the sandbox has started: commits come back as plain object data.
 */
export interface Prepared {
  branch: string;
  dir: string;
  /** The origin/<baseBranch> sha the clone was made at. */
  base: string;
}

export interface HostSteps {
  /** A fresh clone on `agent/<ticket-id>` at the just-fetched origin/<baseBranch>, with the Ticket context in place. */
  prepare(project: Project, ticketId: string, context: TicketContext, signal?: AbortSignal): Promise<Prepared>;
  /** Bring the agent's commits on the branch into the Project repo. Returns the branch tip and how many commits it has over origin/<baseBranch>. */
  collect(project: Project, prepared: Prepared, signal?: AbortSignal): Promise<{ tip: string; commits: number }>;
  /**
   * Bring the agent's branch back into the Project repo, push it and open the PR against baseBranch. Returns the PR URL.
   * `tip` publishes that commit instead of the clone's current tip; `reviewSkipped` is the reason the PR body gives for a missing review;
   * aborting `signal` kills the git, claude and gh processes in flight.
   */
  publish(
    project: Project,
    ticket: { id: string; title: string },
    prepared: Prepared,
    opts?: { tip?: string; reviewSkipped?: string; signal?: AbortSignal },
  ): Promise<string>;
  /** Delete a Run's clone with rm -rf, running no git in it. Refuses a path outside the clones directory. */
  removeClone(clone: Pick<Prepared, 'dir'>): Promise<void>;
}

/** Under /Users, which Docker Desktop shares, and outside every repo's working tree. */
const CLONES_DIR = join(homedir(), '.cache/ysz-harness/clones');

/** Most of a PR's git log and diff that goes into the PR-body prompt. */
const PROMPT_GIT_CHARS = 100_000;

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  { timeout = 120_000, input, env, signal }: { timeout?: number; input?: string | Buffer; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const pending = execFileAsync(cmd, args, { cwd, env, timeout, signal, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  pending.child.stdin?.on('error', () => {}); // the child may exit before reading it all; its exit status reports that
  if (input !== undefined) pending.child.stdin?.end(input);
  try {
    return (await pending).stdout;
  } catch (err) {
    if (signal?.aborted) throw err; // an abort is the caller's own doing, not a failure to describe
    const e = err as { killed?: boolean; stderr?: Buffer; message: string };
    throw new Error(e.killed ? `${cmd} ${args[0]} timed out after ${timeout}ms` : `${cmd} ${args[0]} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

const text = async (...args: Parameters<typeof run>) => (await run(...args)).toString().trim();

/** `run` and `text` whose processes die with `signal`. */
function within(signal?: AbortSignal) {
  type Opts = Parameters<typeof run>[3];
  return {
    run: (cmd: string, args: string[], cwd: string, opts: Opts = {}) => run(cmd, args, cwd, { ...opts, signal }),
    text: (cmd: string, args: string[], cwd: string, opts: Opts = {}) => text(cmd, args, cwd, { ...opts, signal }),
  };
}

/** A regular file of sane size, read without following links or blocking on a FIFO the sandbox planted. */
function readPlainFile(path: string): string | undefined {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return st?.isFile() && st.size < 64 * 1024 * 1024 ? readFileSync(path, 'utf8') : undefined;
}

/** The clone's tip of `branch`, read as text: loose ref, else packed-refs. */
function cloneTip(gitDir: string, branch: string): string {
  const ref = `refs/heads/${branch}`;
  const sha =
    readPlainFile(join(gitDir, ref))?.trim() ??
    readPlainFile(join(gitDir, 'packed-refs'))
      ?.split('\n')
      .find((line) => line.endsWith(` ${ref}`))
      ?.split(' ')[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the clone has no valid ${branch}`);
  return sha;
}

/**
 * Git follows alternates files and symlinks out of an object dir, so the sandbox could point pack-objects at another
 * repo's objects and get them pushed, or point a ref read at a host file. Only plain files and dirs may be in objects/
 * and refs/, under ASCII names: a case-insensitive disk serves info/Alternates to git as info/alternates. The sandbox
 * has stopped, so no race.
 */
function assertSelfContained(gitDir: string): void {
  for (const path of [dirname(gitDir), gitDir]) {
    if (!lstatSync(path).isDirectory()) throw new Error(`refusing to read the clone: ${path} is not a plain directory`);
  }
  for (const sub of ['objects', 'refs']) {
    const top = join(gitDir, sub);
    if (!lstatSync(top).isDirectory()) throw new Error(`refusing to read the clone: ${sub} is not a plain directory`);
    for (const entry of readdirSync(top, { recursive: true, withFileTypes: true })) {
      const rel = relative(gitDir, join(entry.parentPath, entry.name));
      if (!(entry.isFile() || entry.isDirectory()) || !/^[\w.-]+$/.test(entry.name) || /^objects\/info\/(http-)?alternates$/i.test(rel)) {
        throw new Error(`refusing to read the clone: ${rel} could point outside it`);
      }
    }
  }
}

/**
 * Copy the clone's commits on `branch` into the Project repo. `git fetch <clone>` would run upload-pack under the
 * clone's config, so pack-objects reads the clone's object dir as its only store: a commit naming an object that only
 * the Project repo holds fails instead of carrying it out. index-pack recomputes every object id.
 */
async function fetchBack(project: Project, { branch, dir, base }: Prepared, wantedTip?: string, signal?: AbortSignal): Promise<string> {
  const { run, text } = within(signal);
  const repo = project.repoPath;
  const gitDir = join(dir, 'repo/.git');
  assertSelfContained(gitDir);
  const tip = wantedTip ?? cloneTip(gitDir, branch);
  const pack = await run(
    'git',
    ['-c', 'core.commitGraph=false', '-c', 'pack.useBitmaps=false', '-c', 'core.multiPackIndex=false', 'pack-objects', '--revs', '--stdout', '--quiet'],
    repo,
    { input: `${tip}\n^${base}\n`, env: { ...process.env, GIT_OBJECT_DIRECTORY: join(gitDir, 'objects') } },
  );
  await run('git', ['index-pack', '--stdin', '--fix-thin', '--strict'], repo, { input: pack });
  if ((await text('git', ['cat-file', '-t', tip], repo)) !== 'commit') throw new Error(`${branch} in the clone is not a commit`);
  await run('git', ['update-ref', `refs/heads/${branch}`, tip], repo);
  return tip;
}

const PR_BODY_PROMPT = (ticket: { id: string; title: string }, base: string, log: string, diff: string) =>
  `Write the pull request body for a branch that implements Ticket ${ticket.id} "${ticket.title}". ` +
  `Its commits since origin/${base} and their diff are below; they are the only source, so do not look for the repository. ` +
  `Use the mattpocock-skills:pr skill. ` +
  `End with a "## Follow-ups" section listing the follow-up work noted in the commit messages or that you notice in the change, or "None". ` +
  `Output only the Markdown body.\n\n<git-log>\n${log}\n</git-log>\n\n<git-diff>\n${diff}\n</git-diff>`;

const clip = (s: string) => (s.length > PROMPT_GIT_CHARS ? `${s.slice(0, PROMPT_GIT_CHARS)}\n[truncated]` : s);

export function createHostSteps(model: string, clonesDir = CLONES_DIR): HostSteps {
  return {
    async prepare(project, ticketId, context, signal) {
      const { run, text } = within(signal);
      const repo = project.repoPath;
      const base = project.baseBranch;
      const branch = `agent/${ticketId}`;

      await run('git', ['fetch', 'origin', base], repo);
      const sha = await text('git', ['rev-parse', '--verify', `origin/${base}^{commit}`], repo);
      const url = await text('git', ['remote', 'get-url', 'origin'], repo);

      mkdirSync(clonesDir, { recursive: true });
      const dir = mkdtempSync(join(clonesDir, `${project.name}-${ticketId}-`));
      const clone = join(dir, 'repo');
      // Only origin/<base>'s history: a local clone would copy the whole object dir, stashes and local branches included.
      await run('git', ['init', '--quiet', clone], dir);
      await run('git', ['fetch', '--quiet', '--no-tags', repo, `refs/remotes/origin/${base}`], clone, { timeout: 10 * 60_000 });
      await run('git', ['remote', 'add', 'origin', url], clone);
      await run('git', ['update-ref', `refs/remotes/origin/${base}`, sha], clone);
      await run('git', ['switch', '--quiet', '--no-track', '-c', branch, sha], clone);

      for (const file of project.copyToWorktree ?? []) {
        if (!existsSync(join(repo, file))) continue;
        mkdirSync(dirname(join(clone, file)), { recursive: true });
        cpSync(join(repo, file), join(clone, file));
      }
      mkdirSync(join(clone, '.orchestrator'));
      writeFileSync(join(clone, '.orchestrator/ticket.json'), JSON.stringify(context, null, 2));
      mkdirSync(join(clone, '.git/info'), { recursive: true });
      appendFileSync(join(clone, '.git/info/exclude'), '.orchestrator/\n');
      return { branch, dir, base: sha };
    },

    async collect(project, prepared, signal) {
      const tip = await fetchBack(project, prepared, undefined, signal);
      const commits = Number(await within(signal).text('git', ['rev-list', '--count', `origin/${project.baseBranch}..${prepared.branch}`], project.repoPath));
      return { tip, commits };
    },

    async publish(project, ticket, prepared, { tip, reviewSkipped, signal } = {}) {
      const { run, text } = within(signal);
      const repo = project.repoPath;
      const { branch } = prepared;
      const range = `origin/${project.baseBranch}..${branch}`;
      await fetchBack(project, prepared, tip, signal);
      if ((await text('git', ['rev-list', '--count', range], repo)) === '0') throw new Error('the agent made no commits');
      // Every commit, merges against each parent included: a ticket.json added and then deleted would still be pushed in history.
      // The copyToWorktree files hold secrets. Lowercased: the clone's disk is case-insensitive, so .ENV is .env.
      // Their content committed under another name is not caught.
      const touched = (await text('git', ['log', '-m', '-z', '--format=', '--name-only', range], repo)).split('\0').map((path) => path.trim().toLowerCase());
      if (touched.some((path) => path.startsWith('.orchestrator/'))) throw new Error('refusing to push: .orchestrator/ is committed on the branch');
      const secret = project.copyToWorktree?.find((file) => touched.includes(file.toLowerCase()));
      if (secret) throw new Error(`refusing to push: ${secret} is committed on the branch`);
      await run('git', ['push', '-u', 'origin', branch], repo);

      const log = clip(await text('git', ['log', '--format=%h %s%n%n%b', range], repo));
      const diff = clip(await text('git', ['diff', `origin/${project.baseBranch}...${branch}`], repo));
      // In an empty dir with only user settings and the Skill tool: the change is agent-written text, so it gets nothing to act on.
      const tmp = mkdtempSync(join(tmpdir(), 'pr-body-'));
      try {
        const body = await text(
          'claude',
          [
            '-p', PR_BODY_PROMPT(ticket, project.baseBranch, log, diff),
            '--model', model, '--effort', 'high',
            '--setting-sources', 'user', '--strict-mcp-config',
            '--tools', 'Skill', '--allowedTools', 'Skill',
          ],
          tmp,
          { timeout: 5 * 60_000, input: '' }, // closed stdin, or claude waits 3s for piped input
        );
        if (!body) throw new Error('claude -p returned an empty PR body');
        writeFileSync(join(tmp, 'body.md'), reviewSkipped ? `> review skipped: ${reviewSkipped}\n\n${body}` : body);
        const out = await text(
          'gh',
          ['pr', 'create', '--head', branch, '--base', project.baseBranch, '--title', `${ticket.id}: ${ticket.title}`, '--body-file', join(tmp, 'body.md')],
          repo,
        );
        return out.split('\n').pop()!;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },

    async removeClone({ dir }) {
      // The path may come from the database; rm -rf must not leave the clones directory, nor be the directory itself.
      const inside = relative(clonesDir, dir);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`refusing to remove ${dir}: not inside ${clonesDir}`);
      await rm(dir, { recursive: true, force: true }); // async: a clone holds a node_modules
    },
  };
}

import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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
}

export interface HostSteps {
  /** A fresh clone on `agent/<ticket-id>` at the just-fetched origin/<baseBranch>, with the Ticket context in place. */
  prepare(project: Project, ticketId: string, context: TicketContext): Promise<Prepared>;
  /** Bring the agent's branch back into the Project repo, push it and open the PR against baseBranch. Returns the PR URL. */
  publish(project: Project, ticket: { id: string; title: string }, prepared: Prepared): Promise<string>;
  /** Delete the Run's clone. */
  removeClone(prepared: Prepared): Promise<void>;
}

/** Under /Users, which Docker Desktop shares, and outside every repo's working tree. */
const CLONES_DIR = join(homedir(), '.cache/ysz-harness/clones');

/** Most of a PR's git log and diff that goes into the PR-body prompt. */
const PROMPT_GIT_CHARS = 100_000;

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  { timeout = 120_000, input, env }: { timeout?: number; input?: string | Buffer; env?: NodeJS.ProcessEnv } = {},
): Promise<Buffer> {
  const pending = execFileAsync(cmd, args, { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  pending.child.stdin?.on('error', () => {}); // the child may exit before reading it all; its exit status reports that
  if (input !== undefined) pending.child.stdin?.end(input);
  try {
    return (await pending).stdout;
  } catch (err) {
    const e = err as { killed?: boolean; stderr?: Buffer; message: string };
    throw new Error(e.killed ? `${cmd} ${args[0]} timed out after ${timeout}ms` : `${cmd} ${args[0]} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

const text = async (...args: Parameters<typeof run>) => (await run(...args)).toString().trim();

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
 * repo's objects and get them pushed. Only plain files and dirs may be there. The sandbox has stopped, so no race.
 */
function assertSelfContained(objects: string): void {
  for (const path of [dirname(dirname(objects)), dirname(objects), objects]) {
    if (!lstatSync(path).isDirectory()) throw new Error(`refusing to read the clone: ${path} is not a plain directory`);
  }
  for (const entry of readdirSync(objects, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (!(entry.isFile() || entry.isDirectory()) || /^info\/(http-)?alternates$/.test(relative(objects, path))) {
      throw new Error(`refusing to read the clone: ${relative(objects, path)} could point outside it`);
    }
  }
}

/**
 * Copy the clone's commits on `branch` into the Project repo. `git fetch <clone>` would run upload-pack under the
 * clone's config, so the clone's object dir is only read as an alternate, and index-pack recomputes every object id.
 */
async function fetchBack(project: Project, { branch, dir }: Prepared): Promise<void> {
  const repo = project.repoPath;
  const gitDir = join(dir, 'repo/.git');
  const tip = cloneTip(gitDir, branch);
  assertSelfContained(join(gitDir, 'objects'));
  const pack = await run(
    'git',
    ['-c', 'core.commitGraph=false', '-c', 'pack.useBitmaps=false', '-c', 'core.multiPackIndex=false', 'pack-objects', '--revs', '--stdout', '--quiet'],
    repo,
    { input: `${tip}\n^origin/${project.baseBranch}\n`, env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, 'objects') } },
  );
  await run('git', ['index-pack', '--stdin', '--fix-thin', '--strict'], repo, { input: pack });
  if ((await text('git', ['cat-file', '-t', tip], repo)) !== 'commit') throw new Error(`${branch} in the clone is not a commit`);
  await run('git', ['update-ref', `refs/heads/${branch}`, tip], repo);
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
    async prepare(project, ticketId, context) {
      const repo = project.repoPath;
      const base = project.baseBranch;
      const branch = `agent/${ticketId}`;

      await run('git', ['fetch', 'origin', base], repo);
      const sha = await text('git', ['rev-parse', '--verify', `origin/${base}^{commit}`], repo);
      const url = await text('git', ['remote', 'get-url', 'origin'], repo);

      mkdirSync(clonesDir, { recursive: true });
      const dir = mkdtempSync(join(clonesDir, `${project.name}-${ticketId}-`));
      const clone = join(dir, 'repo');
      // No --shared: its alternates would point the sandbox into the repo's own object dir.
      await run('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', repo, clone], dir, { timeout: 10 * 60_000 });
      await run('git', ['remote', 'set-url', 'origin', url], clone);
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
      return { branch, dir };
    },

    async publish(project, ticket, prepared) {
      const repo = project.repoPath;
      const { branch } = prepared;
      const range = `origin/${project.baseBranch}..${branch}`;
      await fetchBack(project, prepared);
      if ((await text('git', ['rev-list', '--count', range], repo)) === '0') throw new Error('the agent made no commits');
      // Every commit, merges against each parent included: a ticket.json added and then deleted would still be pushed in history.
      const touched = (await text('git', ['log', '-m', '-z', '--format=', '--name-only', range], repo)).split('\0');
      if (touched.some((path) => path.trim().startsWith('.orchestrator/'))) throw new Error('refusing to push: .orchestrator/ is committed on the branch');
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
        writeFileSync(join(tmp, 'body.md'), body);
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
      await rm(dir, { recursive: true, force: true }); // async: a clone holds a node_modules
    },
  };
}

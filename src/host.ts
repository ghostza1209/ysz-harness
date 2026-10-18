import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  /** The sha the clone was made at: the tip of origin/<baseBranch>, of the epic branch, or of the stacked-on branch. */
  base: string;
  /** The In review blocker's branch and PR the clone starts on, which the PR then targets unless the blocker merged meanwhile. Absent: the epic branch, else baseBranch. */
  stack?: { branch: string; prUrl: string };
  /** The labelled parent epic's branch (ADR 0006), which the clone starts on and the PR targets when there is no stack. Absent: baseBranch. */
  epic?: string;
  /** What the PR title and the agents' commit subjects name the Ticket by: see `ticketKey`. */
  key: string;
}

export interface HostSteps {
  /** Run the Project's preflight command in its repo. Throws if it fails or times out; passes when the Project has none. */
  preflight(project: Project): Promise<void>;
  /**
   * A fresh clone on `agent/<ticket-id>` with the Ticket context in place, at the just-fetched origin/<baseBranch>,
   * at the In review blocker's `agent/<id>` when the context names one with its PR, or else at the epic branch when the
   * parent epic is labelled `epic-branch`, which is first pushed from origin/<baseBranch> if origin lacks it.
   */
  prepare(project: Project, ticketId: string, context: TicketContext, signal?: AbortSignal): Promise<Prepared>;
  /**
   * Rewrite the clone's Ticket file with `context`, once the implement agent has stopped. The sandbox could have made
   * the clone's repo/, .orchestrator or ticket.json a link, so it throws, writing nothing, unless all three are plain,
   * and never writes through a link.
   */
  writeTicket(prepared: Pick<Prepared, 'dir'>, context: TicketContext): Promise<void>;
  /** Bring the agent's commits on the branch into the Project repo. Returns the branch tip and how many commits it has over what it was cloned onto. */
  collect(project: Project, prepared: Prepared, signal?: AbortSignal): Promise<{ tip: string; commits: number }>;
  /**
   * Bring the agent's branch back into the Project repo, push it and open the PR against what it was cloned onto, then
   * link a stacked PR to its blocker's with `gh stack link` (a failure only logs). A blocker PR that merged meanwhile
   * has the agent's commits replayed onto its base instead, which the PR then targets, unstacked; one that cannot be
   * read fails the publish. Returns the PR URL and the branch it targets.
   * `tip` publishes that commit instead of the clone's current tip; `reviewSkipped` is the reason the PR body gives for a missing review; `followUps` are the titles its "## Follow-ups" section lists;
   * aborting `signal` kills the git, claude and gh processes in flight; `log` gets a line as each step starts.
   */
  publish(
    project: Project,
    ticket: { id: string; title: string },
    prepared: Prepared,
    opts?: { tip?: string; reviewSkipped?: string; followUps?: string[]; signal?: AbortSignal; log?: (line: string) => void },
  ): Promise<{ url: string; base: string }>;
  /** Delete a Run's clone with rm -rf, running no git in it. Refuses a path outside the clones directory. */
  removeClone(clone: Pick<Prepared, 'dir'>): Promise<void>;
  /** The PR's state on GitHub and when it merged or closed (null while open), asked as the Project's gh account. */
  prState(project: Project, prUrl: string): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; closedAt: number | null }>;
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

/** gh's env to act as the Project's gh account; undefined keeps gh's active one. */
async function ghEnv(project: Project): Promise<NodeJS.ProcessEnv | undefined> {
  return project.ghUser ? { ...process.env, GH_TOKEN: await text('gh', ['auth', 'token', '-u', project.ghUser], project.repoPath) } : undefined;
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

/** No `!`: only the human marks a breaking change, which bumps a release-please major version. */
const COMMIT_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
const CONVENTIONAL_TITLE = new RegExp(`^(${COMMIT_TYPES.join('|')})(\\([\\w./-]+\\))?: (\\S.*)$`);

const PR_BODY_PROMPT = (ticket: { id: string; title: string }, base: string, log: string, diff: string) =>
  `Write the pull request title and body for a branch that implements Ticket ${ticket.id} "${ticket.title}". ` +
  `Its commits since origin/${base} and their diff are below; they are the only source, so do not look for the repository. ` +
  `The title is a Conventional Commit, \`type(scope): subject\`: pick the type from the diff (one of ${COMMIT_TYPES.join(', ')}); ` +
  `add a scope only when the change sits in one clear module; never mark a breaking change with ! or BREAKING CHANGE. ` +
  `The subject restates the Ticket title, starting lower-case unless it starts with an identifier, and names no Ticket id or Jira key. ` +
  `Write the body with the mattpocock-skills:pr skill. ` +
  `Output only the title line, a blank line, then the Markdown body.\n\n<git-log>\n${log}\n</git-log>\n\n<git-diff>\n${diff}\n</git-diff>`;

/** What a Ticket is named by: its own Jira key from external_ref, else its parent epic's, else its own id. */
export function ticketKey(id: string, { ticket, parent }: TicketContext): string {
  for (const ref of [ticket.external_ref, parent?.external_ref]) {
    if (typeof ref === 'string' && ref.startsWith('jira-')) return ref.slice('jira-'.length);
  }
  return id;
}

/**
 * Split claude's output into the PR title, with `key` put before the subject, and the body. A first line that is no
 * Conventional Commit gets `chore` and the Ticket title instead: a title the human can retitle is not worth a failed Run.
 */
export function prTitleAndBody(output: string, key: string, ticketTitle: string): { title: string; body: string } {
  const [first, ...rest] = output.split('\n');
  const m = CONVENTIONAL_TITLE.exec(first.trim());
  if (!m) return { title: `chore: ${key} ${ticketTitle}`, body: output };
  return { title: `${m[1]}${m[2] ?? ''}: ${key} ${m[3]}`, body: rest.join('\n').trim() };
}

/** The branch a Run's clone was made on, which its PR targets. */
const onto = (project: Project, prepared: Prepared) => prepared.stack?.branch ?? prepared.epic ?? project.baseBranch;

/** ADR 0006: the branch the children of a parent epic labelled `epic-branch` share. */
function epicBranch(project: Project, { parent }: TicketContext): string | undefined {
  const labels = parent?.labels;
  if (Array.isArray(labels) && labels.includes('epic-branch')) return `${project.epicBranchPrefix ?? 'epic/'}${parent!.id}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const clip = (s: string) => (s.length > PROMPT_GIT_CHARS ? `${s.slice(0, PROMPT_GIT_CHARS)}\n[truncated]` : s);

export function createHostSteps(model: string, clonesDir = CLONES_DIR): HostSteps {
  return {
    async preflight({ preflight, repoPath }) {
      if (preflight) await run(preflight[0], preflight.slice(1), repoPath, { timeout: 60_000 });
    },

    async prepare(project, ticketId, context, signal) {
      const { run, text } = within(signal);
      const repo = project.repoPath;
      const blocker = context.inReviewBlocker;
      const stack = blocker?.prUrl ? { branch: `agent/${blocker.id}`, prUrl: blocker.prUrl } : undefined;
      const epic = epicBranch(project, context);
      const base = stack?.branch ?? epic ?? project.baseBranch;
      const branch = `agent/${ticketId}`;

      if (base === epic && !(await text('git', ['ls-remote', '--heads', 'origin', `refs/heads/${epic}`], repo))) {
        // The epic's first child: cut its branch from the base. One Run per Project, so no other Run races this push.
        await run('git', ['fetch', 'origin', project.baseBranch], repo);
        await run('git', ['push', 'origin', `refs/remotes/origin/${project.baseBranch}:refs/heads/${epic}`], repo);
      }
      await run('git', ['fetch', 'origin', base], repo);
      const sha = await text('git', ['rev-parse', '--verify', `origin/${base}^{commit}`], repo);
      const url = await text('git', ['remote', 'get-url', 'origin'], repo);

      mkdirSync(clonesDir, { recursive: true });
      const dir = mkdtempSync(join(clonesDir, `${project.name}-${ticketId}-`));
      const clone = join(dir, 'repo');
      try {
        // Only origin's branches, which a Ticket may port from: a local clone would copy the whole object dir, stashes and local branches included.
        // ponytail: they are as fresh as the repo's last fetch of them; fetch them all here if a Ticket names a branch pushed since.
        // Git writes a first fetch's refs to packed-refs, so assertSelfContained never meets a loose branch named like `TV-122(new)`.
        await run('git', ['init', '--quiet', clone], dir);
        await run('git', ['fetch', '--quiet', '--no-tags', repo, 'refs/remotes/origin/*:refs/remotes/origin/*'], clone, { timeout: 10 * 60_000 });
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
      } catch (err) {
        // A half-made clone (a kill aborts the fetch) is never handed out, so nothing else could remove it.
        await rm(dir, { recursive: true, force: true });
        throw err;
      }
      return { branch, dir, base: sha, key: ticketKey(ticketId, context), ...(stack && { stack }), ...(epic && { epic }) };
    },

    async writeTicket({ dir }, context) {
      const orchestrator = join(dir, 'repo/.orchestrator');
      const file = join(orchestrator, 'ticket.json');
      for (const [path, kind] of [[join(dir, 'repo'), 'directory'], [orchestrator, 'directory'], [file, 'file']] as const) {
        const st = lstatSync(path, { throwIfNoEntry: false });
        if (!(kind === 'file' ? st?.isFile() : st?.isDirectory())) throw new Error(`refusing to write the Ticket file: ${path} is not a plain ${kind}`);
      }
      // lstat above is the plain check; O_NOFOLLOW makes a link planted since fail the open instead of being followed. The sandbox has stopped, so no race.
      const fd = openSync(file, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      try {
        writeFileSync(fd, JSON.stringify(context, null, 2));
      } finally {
        closeSync(fd);
      }
    },

    async collect(project, prepared, signal) {
      const tip = await fetchBack(project, prepared, undefined, signal);
      const commits = Number(await within(signal).text('git', ['rev-list', '--count', `${prepared.base}..${prepared.branch}`], project.repoPath));
      return { tip, commits };
    },

    async publish(project, ticket, prepared, { tip, reviewSkipped, followUps = [], signal, log: step = () => {} } = {}) {
      const { run, text } = within(signal);
      const repo = project.repoPath;
      const { branch, stack } = prepared;
      const env = await ghEnv(project);
      const blocker = stack && JSON.parse(await text('gh', ['pr', 'view', stack.prUrl, '--json', 'state,baseRefName'], repo, { env }));
      const merged = stack && blocker.state === 'MERGED';
      const base = merged ? blocker.baseRefName : onto(project, prepared);
      // The sha, not origin/<base>: a stacked-on blocker that merged meanwhile has its branch deleted and pruned.
      let from = prepared.base;
      await fetchBack(project, prepared, tip, signal);
      if (merged) {
        // Its squash commit is not the blocker's commits, so only the agent's own move onto the blocker's base.
        step(`${stack.prUrl} merged meanwhile: replaying ${branch} onto ${base}`);
        await run('git', ['fetch', 'origin', base], repo);
        const onBase = await text('git', ['rev-parse', '--verify', `origin/${base}^{commit}`], repo);
        await run('git', ['replay', '--ref-action=update', '--onto', onBase, `${from}..${branch}`], repo).catch((err) => {
          throw new Error(`${stack.prUrl} merged meanwhile and ${branch} does not replay onto ${base}: ${message(err)}`);
        });
        from = onBase;
      }
      const range = `${from}..${branch}`;
      if ((await text('git', ['rev-list', '--count', range], repo)) === '0') throw new Error('the agent made no commits');
      // Every commit, merges against each parent included: a ticket.json added and then deleted would still be pushed in history.
      // The copyToWorktree files hold secrets. Lowercased: the clone's disk is case-insensitive, so .ENV is .env.
      // Their content committed under another name is not caught.
      const touched = (await text('git', ['log', '-m', '-z', '--format=', '--name-only', range], repo)).split('\0').map((path) => path.trim().toLowerCase());
      if (touched.some((path) => path.startsWith('.orchestrator/'))) throw new Error('refusing to push: .orchestrator/ is committed on the branch');
      const secret = project.copyToWorktree?.find((file) => touched.includes(file.toLowerCase()));
      if (secret) throw new Error(`refusing to push: ${secret} is committed on the branch`);
      step(`Pushing ${branch} to origin`);
      // A Retry replays again onto a newer base, so it overwrites its own earlier push: no PR was opened from it yet.
      await run('git', ['push', '-u', ...(merged ? ['--force-with-lease'] : []), 'origin', branch], repo);

      const log = clip(await text('git', ['log', '--format=%h %s%n%n%b', range], repo));
      const diff = clip(await text('git', ['diff', range], repo));
      // In an empty dir with only user settings and the Skill tool: the change is agent-written text, so it gets nothing to act on.
      const tmp = mkdtempSync(join(tmpdir(), 'pr-body-'));
      try {
        step('Writing the PR body (claude -p)');
        const output = await text(
          'claude',
          [
            '-p', PR_BODY_PROMPT(ticket, base, log, diff),
            '--model', model, '--effort', 'high',
            '--setting-sources', 'user', '--strict-mcp-config',
            '--tools', 'Skill', '--allowedTools', 'Skill',
          ],
          tmp,
          { timeout: 5 * 60_000, input: '' }, // closed stdin, or claude waits 3s for piped input
        );
        // A host job saved before Prepared had a key resumes without one.
        const { title, body } = prTitleAndBody(output, prepared.key ?? ticket.id, ticket.title);
        if (!body) throw new Error('claude -p returned an empty PR body');
        const followUpsSection = followUps.length ? `\n\n## Follow-ups\n\n${followUps.map((t) => `- ${t}`).join('\n')}` : '';
        writeFileSync(join(tmp, 'body.md'), `${reviewSkipped ? `> review skipped: ${reviewSkipped}\n\n` : ''}${body}${followUpsSection}`);
        // The SSH key that pushed may belong to another account than gh's active one, which then cannot see the repo.
        step(`Opening the PR against ${base}${project.ghUser ? ` as ${project.ghUser}` : ''}`);
        const out = await text(
          'gh',
          ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body-file', join(tmp, 'body.md')],
          repo,
          { env },
        );
        const prUrl = out.split('\n').pop()!;
        if (stack && !merged) {
          // The PR already targets the blocker's branch; the GitHub stack adds the stack map and retargets it once the blocker merges.
          // --base is the blocker's own base: any other, and gh stack link retargets the blocker's PR onto it. A blocker already
          // in a stack fails the link (it would drop that stack's upper PRs), so a second dependent stays a plain PR.
          step(`Stacking it on ${stack.prUrl}`);
          await text('gh', ['stack', 'link', '--base', blocker.baseRefName, stack.prUrl, prUrl], repo, { env })
            .catch((err) => step(`Could not stack it on ${stack.prUrl}, so it stays a plain PR onto ${base}: ${message(err)}`));
        }
        return { url: prUrl, base };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },

    async prState(project, prUrl) {
      // GitHub sets closedAt on a merge too, to the merge time.
      const out = await text('gh', ['pr', 'view', prUrl, '--json', 'state,closedAt'], project.repoPath, { env: await ghEnv(project) });
      const { state, closedAt } = JSON.parse(out);
      return { state, closedAt: closedAt ? Date.parse(closedAt) : null };
    },

    async removeClone({ dir }) {
      // The path may come from the database; rm -rf must not leave the clones directory, nor be the directory itself.
      const inside = relative(clonesDir, dir);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`refusing to remove ${dir}: not inside ${clonesDir}`);
      await rm(dir, { recursive: true, force: true }); // async: a clone holds a node_modules
    },
  };
}

import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TicketContext } from './beads';
import type { Project } from './projects';

const execFileAsync = promisify(execFile);

export interface HostSteps {
  /** Fresh `agent/<ticket-id>` worktree off the just-fetched origin/<baseBranch>, with the Ticket context in place. */
  prepare(project: Project, ticketId: string, context: TicketContext): Promise<{ branch: string }>;
  /** Push the branch and open the PR against baseBranch. Returns the PR URL. */
  publish(project: Project, ticket: { id: string; title: string }, branch: string): Promise<string>;
  /** Delete the worktree of `branch`, keeping the local branch. */
  removeWorktree(project: Project, branch: string): Promise<void>;
}

/** Where sandcastle looks for the worktree of a branch; the sandbox attaches to the one prepared here. */
export function worktreePath(project: Project, branch: string): string {
  return join(project.repoPath, '.sandcastle/worktrees', branch.replace(/\//g, '-'));
}

async function run(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<string> {
  try {
    return (await execFileAsync(cmd, args, { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (err) {
    const e = err as { killed?: boolean; stderr?: string; message: string };
    throw new Error(e.killed ? `${cmd} ${args[0]} timed out after ${timeout}ms` : `${cmd} ${args[0]} failed: ${e.stderr?.trim() || e.message}`);
  }
}

const PR_BODY_PROMPT = (ticket: { id: string; title: string }, base: string) =>
  `Write the pull request body for the current branch, which implements Ticket ${ticket.id} "${ticket.title}". ` +
  `The change is the commits since origin/${base}. Use the mattpocock-skills:pr skill. ` +
  `End with a "## Follow-ups" section listing the follow-up work noted in the commit messages or that you notice in the change, or "None". ` +
  `Output only the Markdown body.`;

export function createHostSteps(model: string): HostSteps {
  return {
    async prepare(project, ticketId, context) {
      const repo = project.repoPath;
      const branch = `agent/${ticketId}`;
      const dir = worktreePath(project, branch);

      await run('git', ['fetch', 'origin', project.baseBranch], repo);
      // A worktree left by an earlier Run of this Ticket would block -B; the new Run starts from origin anyway.
      await run('git', ['worktree', 'remove', '--force', dir], repo).catch(() => {});
      await run('git', ['worktree', 'prune'], repo);
      await run('git', ['worktree', 'add', '--no-track', '-B', branch, dir, `origin/${project.baseBranch}`], repo);

      for (const file of project.copyToWorktree ?? []) {
        if (!existsSync(join(repo, file))) continue;
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        cpSync(join(repo, file), join(dir, file));
      }

      mkdirSync(join(dir, '.orchestrator'));
      writeFileSync(join(dir, '.orchestrator/ticket.json'), JSON.stringify(context, null, 2));
      // All worktrees of a repo share one exclude file, so the entry is added once.
      const exclude = resolve(dir, (await run('git', ['rev-parse', '--git-path', 'info/exclude'], dir)).trim());
      if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes('.orchestrator/')) {
        mkdirSync(dirname(exclude), { recursive: true });
        appendFileSync(exclude, '.orchestrator/\n');
      }
      return { branch };
    },

    async publish(project, ticket, branch) {
      const repo = project.repoPath;
      const tracked = await run('git', ['ls-tree', '-r', '--name-only', branch], repo);
      if (/^\.orchestrator\//m.test(tracked)) throw new Error('refusing to push: .orchestrator/ is committed on the branch');
      await run('git', ['push', '-u', 'origin', branch], repo);

      // Run in the worktree so the host's user-level plugins (the pr skill) load and the branch is the checked-out one.
      const body = (
        await run(
          'claude',
          [
            '-p', PR_BODY_PROMPT(ticket, project.baseBranch),
            '--model', model, '--effort', 'high',
            '--allowedTools', 'Skill,Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)',
          ],
          worktreePath(project, branch),
          5 * 60_000,
        )
      ).trim();
      if (!body) throw new Error('claude -p returned an empty PR body');

      const tmp = mkdtempSync(join(tmpdir(), 'pr-body-'));
      try {
        writeFileSync(join(tmp, 'body.md'), body);
        const out = await run(
          'gh',
          ['pr', 'create', '--head', branch, '--base', project.baseBranch, '--title', `${ticket.id}: ${ticket.title}`, '--body-file', join(tmp, 'body.md')],
          repo,
        );
        return out.trim().split('\n').pop()!;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },

    async removeWorktree(project, branch) {
      await run('git', ['worktree', 'remove', '--force', worktreePath(project, branch)], project.repoPath);
    },
  };
}

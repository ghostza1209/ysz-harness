import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { claudeCode, createBindMountSandboxProvider, createWorktree } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { startCheckServer } from './checks';
import type { Prepared } from './host';
import type { Project } from './projects';

export const MODEL = 'claude-sonnet-5-5';
export const TICKET_JSON = '.orchestrator/ticket.json';

/** How an agent ended without throwing. `stopped` = no signal: it ran out of iterations or said it was blocked. */
export type AgentResult =
  | { outcome: 'complete' }
  | { outcome: 'needs-info'; question: string }
  | { outcome: 'stopped'; tail: string };

/** Aborting `signal` stops the agent and tears its sandbox down: the call then rejects. */
type AgentRequest = { project: Project; runId: number; attempt: number; signal: AbortSignal } & Prepared;

export interface SandboxRunner {
  /** Whether the Project's sandbox image exists locally. Never throws: docker being unreachable counts as missing. */
  hasImage(project: Project): Promise<boolean>;
  /** One implement agent in a fresh sandbox on the host-prepared clone. Throws if the agent errors or idles out. */
  implement(req: AgentRequest & { previousAttemptSummary?: string }): Promise<AgentResult>;
  /** One review agent in a fresh sandbox on the same clone, after the implement agent. Throws like `implement`. */
  review(req: AgentRequest): Promise<AgentResult>;
  /** Remove the Run's sandbox container now, if any is left. Throws unless it is gone afterwards: sandcastle's own teardown ignores docker errors. */
  stop(prepared: Pick<Prepared, 'dir'>): Promise<void>;
  /** Remove every leftover sandcastle container, of any Run. Throws unless none is left. */
  removeLeftovers(): Promise<void>;
}

const execFileAsync = promisify(execFile);

/**
 * Remove every container `docker ps` lists under `filter`. `docker rm -f` may lose a race with sandcastle's own removal,
 * so what counts is whether the container is gone afterwards.
 */
async function removeContainers(filter: string, dockerBin: string): Promise<void> {
  const listed = async () => (await execFileAsync(dockerBin, ['ps', '-aq', '--no-trunc', '--filter', filter], { timeout: 30_000 })).stdout.split('\n').filter(Boolean);
  const ids = await listed();
  if (!ids.length) return;
  const removal = await execFileAsync(dockerBin, ['rm', '-f', ...ids], { timeout: 60_000 }).then(() => null, (err: Error) => err);
  const left = await listed();
  if (left.length) throw new Error(`the sandbox container ${left.join(' ')} is still there${removal ? `: ${removal.message}` : ''}`);
}

/** Remove every container that mounts the Run's clone. The clone path is unique per Attempt, so this never touches another Run's or the user's own containers. */
export const stopSandbox = ({ dir }: Pick<Prepared, 'dir'>, dockerBin = 'docker') => removeContainers(`volume=${join(dir, 'repo')}`, dockerBin);

/** Remove every sandcastle container, whichever Run made it: the ones a crashed Orchestrator left behind. */
export const removeLeftoverSandboxes = (dockerBin = 'docker') => removeContainers('name=sandcastle-', dockerBin);

export async function imageExists(image: string, dockerBin = 'docker'): Promise<boolean> {
  return execFileAsync(dockerBin, ['image', 'inspect', image], { timeout: 30_000 }).then(() => true, () => false);
}

const COMPLETE = '<promise>COMPLETE</promise>';
const NEEDS_INFO = '<promise>NEEDS_INFO</promise>';

export function agentResult({ completionSignal, stdout }: { completionSignal?: string; stdout: string }): AgentResult {
  // sandcastle reports the first signal in its list that the output holds anywhere, so COMPLETE wins over a NEEDS_INFO
  // given after it. The signal the agent ended on is the one that counts.
  if (completionSignal === undefined) return { outcome: 'stopped', tail: stdout.trim().slice(-500) };
  if (stdout.lastIndexOf(NEEDS_INFO) > stdout.lastIndexOf(COMPLETE)) {
    const question = [...stdout.matchAll(/<question>([\s\S]*?)<\/question>/g)].at(-1)?.[1].trim();
    return { outcome: 'needs-info', question: question || 'the agent signalled NEEDS_INFO without a <question>' };
  }
  return { outcome: 'complete' };
}

type CreateSandbox = Parameters<typeof createBindMountSandboxProvider>[0]['create'];
type SandboxHandle = Awaited<ReturnType<CreateSandbox>>;

/**
 * Append `command`'s output to `logPath` as it runs, each line indented so the Run log shows it under the setup step.
 * sandcastle's file log holds a hook's output back until the hook ends, so a long install looks hung.
 */
export function teeCommand(handle: SandboxHandle, command: string, logPath: string): SandboxHandle {
  const write = (line: string) => appendFileSync(logPath, `  ${line}\n`);
  return {
    ...handle,
    exec: async (cmd, opts) => {
      if (cmd !== command) return handle.exec(cmd, opts);
      const result = await handle.exec(cmd, { ...opts, onLine: write });
      // onLine gets stdout only: stderr comes back once the command ends.
      for (const line of result.stderr.split('\n').filter(Boolean)) write(line);
      return result;
    },
  };
}

/** `root` is the ysz-harness checkout: it holds the central .env and prompts/; logs go to `<root>/data/logs/<runId>-attempt<n>-<role>.log`. */
export function createSandboxRunner(root: string): SandboxRunner {
  async function runAgent(
    role: 'implement' | 'review',
    { project, runId, attempt, branch, dir, signal }: AgentRequest,
    promptArgs: Record<string, string>,
  ): Promise<AgentResult> {
    signal.throwIfAborted();
    // Read per Run, so adding the token needs no restart. It reaches the sandbox only through the agent's env.
    const token = parseEnv(readFileSync(join(root, '.env'), 'utf8')).CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is missing from the ysz-harness .env');
    mkdirSync(join(root, 'data/logs'), { recursive: true });
    const logPath = join(root, 'data/logs', `${runId}-attempt${attempt}-${role}.log`);

    // sandcastle runs host git in its cwd and worktree, also after the agent has run. Give it an empty repo the
    // sandbox never sees; the sandbox mounts only the clone. Its commit count is then always 0: publish counts instead.
    const decoy = join(dir, `decoy-${role}`);
    execFileSync('git', ['init', '--quiet', decoy]);
    execFileSync('git', ['-c', 'user.name=ysz-harness', '-c', 'user.email=ysz-harness@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'decoy'], { cwd: decoy });
    const worktree = await createWorktree({ cwd: decoy, branchStrategy: { type: 'branch', branch } });

    const inner = docker({ imageName: project.image, containerUid: project.containerUid, containerGid: project.containerGid });
    // docker's provider has create() at runtime; its public type hides it.
    const create = (inner as unknown as { create: CreateSandbox }).create;
    const sandbox = createBindMountSandboxProvider({
      ...inner,
      create: async (opts) => {
        const handle = await create({ ...opts, mounts: [{ hostPath: join(dir, 'repo'), sandboxPath: '/home/agent/workspace' }] });
        return project.installCommand ? teeCommand(handle, project.installCommand, logPath) : handle;
      },
    });

    // ADR 0002: the agent's only way to run PHP checks; it ends with the agent.
    const checks = project.checkContainer && (await startCheckServer({ ...project.checkContainer, clone: join(dir, 'repo') }));
    const env = { CLAUDE_CODE_OAUTH_TOKEN: token, ...(checks && { PHP_CHECK_URL: checks.url, PHP_CHECK_TOKEN: checks.token }) };

    try {
      const result = await worktree.run({
        // No session capture: it copies a sandbox-written transcript to a host path built from the stream's session id.
        agent: claudeCode(MODEL, { effort: 'high', env, captureSessions: false }),
        // No .beads, no ssh, no push credentials, and no host git dir: the clone's .git is its own.
        sandbox,
        // sandcastle resolves promptFile against process.cwd(), so it must be absolute.
        promptFile: join(root, `prompts/${role}.md`),
        promptArgs: { CHECK_HINT: project.checkHint ?? "Run the repo's own lint and unit-test commands.", TICKET_JSON, ...promptArgs },
        completionSignal: [COMPLETE, NEEDS_INFO],
        idleTimeoutSeconds: 600,
        signal,
        name: `run-${runId}-attempt${attempt}-${role}`,
        logging: { type: 'file', path: logPath },
        hooks: project.installCommand
          ? { sandbox: { onSandboxReady: [{ command: project.installCommand, timeoutMs: 600_000 }] } }
          : undefined,
      });
      return agentResult(result);
    } finally {
      await checks?.close();
    }
  }

  return {
    hasImage: (project) => imageExists(project.image!),
    implement: ({ previousAttemptSummary, ...req }) =>
      runAgent('implement', req, {
        PREVIOUS_ATTEMPT: previousAttemptSummary
          ? `## Previous attempt\n\nAn earlier attempt at this Ticket failed, and its work is discarded. Do not repeat its mistake:\n\n${previousAttemptSummary}\n`
          : '',
      }),
    review: (req) => runAgent('review', req, { BASE: req.base }),
    stop: (prepared) => stopSandbox(prepared),
    removeLeftovers: () => removeLeftoverSandboxes(),
  };
}

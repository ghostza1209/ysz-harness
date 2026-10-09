import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { claudeCode, createBindMountSandboxProvider, createWorktree } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import type { Prepared } from './host';
import type { Project } from './projects';

export const MODEL = 'claude-sonnet-5-5';
export const TICKET_JSON = '.orchestrator/ticket.json';

/** How an agent ended without throwing. `stopped` = no signal: it ran out of iterations or said it was blocked. */
export type AgentResult =
  | { outcome: 'complete' }
  | { outcome: 'needs-info'; question: string }
  | { outcome: 'stopped'; tail: string };

type AgentRequest = { project: Project; runId: number; attempt: number } & Prepared;

export interface SandboxRunner {
  /** One implement agent in a fresh sandbox on the host-prepared clone. Throws if the agent errors or idles out. */
  implement(req: AgentRequest & { previousAttemptSummary?: string }): Promise<AgentResult>;
  /** One review agent in a fresh sandbox on the same clone, after the implement agent. Throws like `implement`. */
  review(req: AgentRequest): Promise<AgentResult>;
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

/** `root` is the ysz-harness checkout: it holds the central .env and prompts/; logs go to `<root>/data/logs/<runId>-attempt<n>-<role>.log`. */
export function createSandboxRunner(root: string): SandboxRunner {
  async function runAgent(
    role: 'implement' | 'review',
    { project, runId, attempt, branch, dir }: AgentRequest,
    promptArgs: Record<string, string>,
  ): Promise<AgentResult> {
    // Read per Run, so adding the token needs no restart. It reaches the sandbox only through the agent's env.
    const token = parseEnv(readFileSync(join(root, '.env'), 'utf8')).CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is missing from the ysz-harness .env');
    mkdirSync(join(root, 'data/logs'), { recursive: true });

    // sandcastle runs host git in its cwd and worktree, also after the agent has run. Give it an empty repo the
    // sandbox never sees; the sandbox mounts only the clone. Its commit count is then always 0: publish counts instead.
    const decoy = join(dir, `decoy-${role}`);
    execFileSync('git', ['init', '--quiet', decoy]);
    execFileSync('git', ['-c', 'user.name=ysz-harness', '-c', 'user.email=ysz-harness@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'decoy'], { cwd: decoy });
    const worktree = await createWorktree({ cwd: decoy, branchStrategy: { type: 'branch', branch } });

    const inner = docker({ imageName: project.image, mounts: project.mounts });
    // docker's provider has create() at runtime; its public type hides it.
    const create = (inner as unknown as { create: CreateSandbox }).create;
    const sandbox = createBindMountSandboxProvider({
      ...inner,
      // Project.mounts are added by docker itself, after these.
      create: (opts) => create({ ...opts, mounts: [{ hostPath: join(dir, 'repo'), sandboxPath: '/home/agent/workspace' }] }),
    });

    const result = await worktree.run({
      // No session capture: it copies a sandbox-written transcript to a host path built from the stream's session id.
      agent: claudeCode(MODEL, { effort: 'high', env: { CLAUDE_CODE_OAUTH_TOKEN: token }, captureSessions: false }),
      // No .beads, no ssh, no push credentials, and no host git dir: the clone's .git is its own.
      sandbox,
      // sandcastle resolves promptFile against process.cwd(), so it must be absolute.
      promptFile: join(root, `prompts/${role}.md`),
      promptArgs: { CHECK_HINT: project.checkHint ?? "Run the repo's own lint and unit-test commands.", TICKET_JSON, ...promptArgs },
      completionSignal: [COMPLETE, NEEDS_INFO],
      idleTimeoutSeconds: 600,
      name: `run-${runId}-attempt${attempt}-${role}`,
      logging: { type: 'file', path: join(root, 'data/logs', `${runId}-attempt${attempt}-${role}.log`) },
      hooks: project.installCommand
        ? { sandbox: { onSandboxReady: [{ command: project.installCommand, timeoutMs: 600_000 }] } }
        : undefined,
    });
    return agentResult(result);
  }

  return {
    implement: ({ previousAttemptSummary, ...req }) =>
      runAgent('implement', req, {
        PREVIOUS_ATTEMPT: previousAttemptSummary
          ? `## Previous attempt\n\nAn earlier attempt at this Ticket failed, and its work is discarded. Do not repeat its mistake:\n\n${previousAttemptSummary}\n`
          : '',
      }),
    review: (req) => runAgent('review', req, { BASE: req.base }),
  };
}

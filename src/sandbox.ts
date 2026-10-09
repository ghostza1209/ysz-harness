import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { claudeCode, createWorktree } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import type { Project } from './projects';

export const MODEL = 'claude-sonnet-5-5';
export const TICKET_JSON = '.orchestrator/ticket.json';

export interface SandboxRunner {
  /** One implement agent in a fresh sandbox on the host-prepared worktree of `branch`. Throws if the agent errors or idles out. */
  implement(req: { project: Project; runId: number; branch: string }): Promise<{ commits: number; completed: boolean }>;
}

/** `root` is the ysz-harness checkout: it holds the central .env and prompts/; logs go to `<root>/data/logs/<runId>.log`. */
export function createSandboxRunner(root: string): SandboxRunner {
  return {
    async implement({ project, runId, branch }) {
      // Read per Run, so adding the token needs no restart. It reaches the sandbox only through the agent's env.
      const token = parseEnv(readFileSync(join(root, '.env'), 'utf8')).CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is missing from the ysz-harness .env');
      mkdirSync(join(root, 'data/logs'), { recursive: true });

      // Attaches to the worktree the host already prepared (same branch, same path). It is never close()d: the host owns its removal.
      const worktree = await createWorktree({ cwd: project.repoPath, branchStrategy: { type: 'branch', branch } });
      const result = await worktree.run({
        agent: claudeCode(MODEL, { effort: 'high', env: { CLAUDE_CODE_OAUTH_TOKEN: token } }),
        // The sandbox gets the worktree and the repo's git dir plus these mounts: no .beads, no ssh, no push credentials.
        sandbox: docker({ imageName: project.image, mounts: project.mounts }),
        // sandcastle resolves promptFile against process.cwd(), so it must be absolute.
        promptFile: join(root, 'prompts/implement.md'),
        promptArgs: { CHECK_HINT: project.checkHint ?? "Run the repo's own lint and unit-test commands.", TICKET_JSON },
        idleTimeoutSeconds: 600,
        name: `run-${runId}`,
        logging: { type: 'file', path: join(root, 'data/logs', `${runId}.log`) },
        hooks: project.installCommand
          ? { sandbox: { onSandboxReady: [{ command: project.installCommand, timeoutMs: 600_000 }] } }
          : undefined,
      });
      return { commits: result.commits.length, completed: result.completionSignal !== undefined };
    },
  };
}

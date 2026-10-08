import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project } from './projects';

const execFileAsync = promisify(execFile);

export interface Ticket {
  id: string;
  title: string;
  /** 0 (highest) to 4. */
  priority: number;
  /** RFC 3339. */
  createdAt: string;
}

export interface BeadsGateway {
  /** Ready Tickets of one Project: ready-for-agent, not orchestrator:skip, unassigned, no open blockers. */
  listReady(project: Project): Promise<Ticket[]>;
}

export interface BeadsOptions {
  bin?: string;
  /** Every bd call is killed after this long: embedded Dolt waits on its lock with no deadline. */
  timeoutMs?: number;
}

export function createBeadsGateway({ bin = 'bd', timeoutMs = 30_000 }: BeadsOptions = {}): BeadsGateway {
  async function bd(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout; // stderr carries bd's "beads.role not configured" warning on every call
    } catch (err) {
      if ((err as { killed?: boolean }).killed) throw new Error(`bd timed out after ${timeoutMs}ms: ${args.join(' ')}`);
      throw err;
    }
  }

  return {
    async listReady(project) {
      const out = await bd([
        '--readonly', '-C', project.repoPath,
        'ready', '-l', 'ready-for-agent', '--exclude-label', 'orchestrator:skip', '-u', '-n', '0', '--json',
      ]);
      const issues: { id: string; title: string; priority: number; created_at: string }[] = JSON.parse(out);
      return issues.map((i) => ({ id: i.id, title: i.title, priority: i.priority, createdAt: i.created_at }));
    },
  };
}

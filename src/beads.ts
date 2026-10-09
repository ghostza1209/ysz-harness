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

/** What the agent gets in .orchestrator/ticket.json: the bead as bd prints it, its parent epic and the closed blockers. */
export interface TicketContext {
  ticket: Record<string, unknown>;
  parent: Record<string, unknown> | null;
  closedBlockers: { id: string; title: string; closeReason: string }[];
}

/** The bd actor behind every Orchestrator write, so its claims and comments are told apart from the user's. */
export const ORCHESTRATOR = 'orchestrator';

export interface BeadsGateway {
  /** Ready Tickets of one Project: ready-for-agent, not orchestrator:skip, unassigned, no open blockers. */
  listReady(project: Project): Promise<Ticket[]>;
  /** Atomic claim as the Orchestrator. false = someone else got the Ticket first. */
  claim(project: Project, id: string): Promise<boolean>;
  /** Hand a claimed Ticket back: open and unassigned. */
  release(project: Project, id: string): Promise<void>;
  showContext(project: Project, id: string): Promise<TicketContext>;
  /** PR opened: comment its link, then label in-review. The bead stays in_progress, assigned to the Orchestrator. */
  markInReview(project: Project, id: string, prUrl: string): Promise<void>;
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

  const write = (project: Project, args: string[]) => bd(['-C', project.repoPath, '--actor', ORCHESTRATOR, ...args]);
  const show = async (project: Project, args: string[]): Promise<Record<string, any>> =>
    JSON.parse(await bd(['--readonly', '-C', project.repoPath, 'show', ...args, '--json']))[0];

  return {
    async listReady(project) {
      const out = await bd([
        '--readonly', '-C', project.repoPath,
        'ready', '-l', 'ready-for-agent', '--exclude-label', 'orchestrator:skip', '-u', '-n', '0', '--json',
      ]);
      const issues: { id: string; title: string; priority: number; created_at: string }[] = JSON.parse(out);
      return issues.map((i) => ({ id: i.id, title: i.title, priority: i.priority, createdAt: i.created_at }));
    },

    async claim(project, id) {
      try {
        await write(project, ['update', id, '--claim']);
        return true;
      } catch (err) {
        // Any other failure (bad repo path, unknown id, timeout) must surface instead of looking like a lost race.
        if (/already claimed|not claimable/.test((err as { stderr?: string }).stderr ?? '')) return false;
        throw err;
      }
    },

    async release(project, id) {
      await write(project, ['update', id, '--assignee', '', '--status', 'open']);
    },

    async showContext(project, id) {
      const ticket = await show(project, [id, '--include-comments']);
      const parent = ticket.parent ? await show(project, [ticket.parent]) : null;
      const closedBlockers = (ticket.dependencies ?? [])
        .filter((d: { dependency_type: string; status: string }) => d.dependency_type === 'blocks' && d.status === 'closed')
        .map((d: { id: string; title: string; close_reason?: string }) => ({ id: d.id, title: d.title, closeReason: d.close_reason ?? '' }));
      return { ticket, parent, closedBlockers };
    },

    async markInReview(project, id, prUrl) {
      // bd batch cannot comment or label, so these are two writes; the label goes last because it is what marks the Ticket done.
      await write(project, ['comment', id, `PR opened: ${prUrl}`]);
      await write(project, ['update', id, '--add-label', 'in-review']);
    },
  };
}

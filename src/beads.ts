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

/**
 * What the agent gets in .orchestrator/ticket.json: the bead as bd prints it, its parent epic, the closed blockers,
 * and the In review blocker the Run stacks on (its PR url added by the Orchestrator).
 */
export interface TicketContext {
  ticket: Record<string, unknown>;
  parent: Record<string, unknown> | null;
  closedBlockers: { id: string; title: string; closeReason: string }[];
  inReviewBlocker: { id: string; title: string; prUrl?: string } | null;
  /** The Project's open Friction in ysz's queue, which an agent refers to by id instead of reporting it as new. The Orchestrator fills it in before each Attempt. */
  openFriction: { id: string; title: string }[];
  /** Only in the Review agent's file: what the Implement agent of its Attempt reported. Follow-ups carry the ref F<n> the Review agent marks fixed; Friction carries its Ticket id. */
  implementReports?: {
    followUps: { ref: string; title: string; body: string }[];
    friction: { id: string; title: string; seenAgain: boolean }[];
  };
}

/** The bd actor behind every Orchestrator write, so its claims and comments are told apart from the user's. */
export const ORCHESTRATOR = 'orchestrator';

export interface BeadsGateway {
  /**
   * Ready Tickets of one Project: ready-for-agent, not orchestrator:skip, not an epic, unassigned, no unclosed children,
   * and every blocker closed except at most one In review. Also counts its Backlog, from the same bd call.
   */
  listReady(project: Project): Promise<{ tickets: Ticket[]; backlog: number }>;
  /** Atomic claim as the Orchestrator. false = someone else got the Ticket first. */
  claim(project: Project, id: string): Promise<boolean>;
  /** Hand a claimed Ticket back: open and unassigned. */
  release(project: Project, id: string): Promise<void>;
  /** The Run failed: comment why, then label needs-info, drop ready-for-agent and release the claim. */
  fail(project: Project, id: string, reason: string): Promise<void>;
  /** Retry a failed Run's Ticket: drop needs-info and label ready-for-agent again, so it is Ready once its blockers allow. */
  requeue(project: Project, id: string): Promise<void>;
  /** The user killed the Run: comment why, then label orchestrator:skip and release the claim. ready-for-agent stays. */
  kill(project: Project, id: string, reason: string): Promise<void>;
  /** The Orchestrator restarted mid-Run: comment why, then release the claim. Labels stay, so the Ticket is Ready again. */
  interrupt(project: Project, id: string, reason: string): Promise<void>;
  /** Ids of the Tickets the Orchestrator holds in_progress without an in-review label. */
  listClaimed(project: Project): Promise<string[]>;
  /**
   * Refresh the 5-minute bd lease of every Ticket the Orchestrator holds in_progress, in-review ones included, so
   * `bd reclaim` leaves them alone. Call more often than the lease lasts. Beats every Ticket, then throws if any failed.
   */
  heartbeat(project: Project): Promise<void>;
  showContext(project: Project, id: string): Promise<TicketContext>;
  /** PR opened: comment its link, then label in-review. The bead stays in_progress, assigned to the Orchestrator. */
  markInReview(project: Project, id: string, prUrl: string): Promise<void>;
  /**
   * The in-review Ticket's PR merged: drop in-review, then close it with the PR link as the reason.
   * false, writing nothing, when the human changed the bead since (no longer in_progress and the Orchestrator's).
   */
  merged(project: Project, id: string, prUrl: string): Promise<boolean>;
  /**
   * The in-review Ticket's PR closed unmerged: comment why, then label needs-info, drop ready-for-agent and in-review,
   * and release the claim. false, writing nothing, when the human changed the bead since.
   */
  prClosed(project: Project, id: string, prUrl: string): Promise<boolean>;
  /**
   * An agent hit Friction: a new Ticket in ysz's own queue, labelled friction, project:<name> and needs-triage, at bd's
   * default type and priority. The body ends with where it came from. Returns the new id.
   */
  createFriction(friction: FrictionReport): Promise<string>;
  /** The Project's open Friction in ysz's own queue: everything not closed, a Friction the human is fixing (in_progress) included. */
  listOpenFriction(project: Project): Promise<{ id: string; title: string }[]>;
  /** An agent hit an open Friction again: comment on its Ticket, as the Orchestrator, what happened this time. The comment ends with where it came from. */
  commentFriction(id: string, friction: FrictionReport): Promise<void>;
  /**
   * An agent found work in the Project's code outside the Ticket: a new Ticket in the Project's own queue, labelled
   * needs-triage, linked discovered-from the Run's Ticket, with no parent, no ready-for-agent and bd's default type and
   * priority. The body ends with where it came from. Returns the new id.
   */
  createFollowUp(followUp: FollowUpReport): Promise<string>;
}

/** One Friction an agent reported, and the Run it came from. */
export interface FrictionReport {
  project: Project;
  title: string;
  body: string;
  ticketId: string;
  runId: number;
  attempt: number;
  role: 'implement' | 'review';
}

/** One Follow-up an agent reported, and the Run it came from. */
export type FollowUpReport = FrictionReport;

/** The fields of a bead as `bd list --json` prints it that the gateway reads. */
interface Bead {
  id: string;
  title: string;
  priority: number;
  created_at: string;
  status: string;
  issue_type: string;
  assignee?: string;
  labels?: string[] | null;
  parent?: string;
  dependencies?: { depends_on_id: string; type: string }[];
}

/** A Run left it In review: in_progress, the Orchestrator's, labelled in-review. */
const isInReview = (b: Pick<Bead, 'status' | 'assignee' | 'labels'>) =>
  b.status === 'in_progress' && b.assignee === ORCHESTRATOR && !!b.labels?.includes('in-review');

export interface BeadsOptions {
  bin?: string;
  /** The ysz checkout, whose queue holds Friction. */
  yszRepo?: string;
  /** Every bd call is killed after this long: embedded Dolt waits on its lock with no deadline. */
  timeoutMs?: number;
}

export function createBeadsGateway({ bin = 'bd', yszRepo, timeoutMs = 30_000 }: BeadsOptions = {}): BeadsGateway {
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
  const yszQueue = () => {
    if (!yszRepo) throw new Error('the ysz checkout is not configured, so Friction has no queue to go to');
    return yszRepo;
  };
  /** A Friction's text, ending with where it came from. */
  const withSource = (text: string, { project, ticketId, runId, attempt, role }: Omit<FrictionReport, 'title' | 'body'>) =>
    `${text ? `${text}\n\n` : ''}Project: ${project.name} · Ticket: ${ticketId} · Run: ${runId} · Attempt: ${attempt} · Agent: ${role}`;
  /** The bead is still in_progress and the Orchestrator's, as a Run left it: the human has not changed it since. */
  const held = async (project: Project, id: string) => {
    const issue = await show(project, [id]);
    return issue.status === 'in_progress' && issue.assignee === ORCHESTRATOR;
  };

  return {
    async listReady(project) {
      const [out, unclosed] = await Promise.all([
        bd(['--readonly', '-C', project.repoPath, 'ready', '-l', 'ready-for-agent', '--exclude-label', 'orchestrator:skip', '--exclude-type', 'epic', '-u', '-n', '0', '--json']),
        // bd ready ignores parent-child links, so a parent would compete with its own children: it waits until they all close.
        bd(['--readonly', '-C', project.repoPath, 'list', '-s', 'open,in_progress,blocked,deferred', '-n', '0', '--json', '--brief']),
      ]);
      const beads: Bead[] = JSON.parse(unclosed);
      const byId = new Map(beads.map((b) => [b.id, b]));
      const parents = new Set(beads.map((b) => b.parent));
      // bd ready counts an In review blocker as open; a Ticket whose only unclosed blocker is one stacks on its PR.
      const stacked = beads.filter((b) => {
        if (b.status !== 'open' || b.issue_type === 'epic' || b.assignee || !b.labels?.includes('ready-for-agent') || b.labels.includes('orchestrator:skip')) return false;
        const blockers = (b.dependencies ?? []).filter((d) => d.type === 'blocks').flatMap((d) => byId.get(d.depends_on_id) ?? []);
        return blockers.length === 1 && isInReview(blockers[0]);
      });
      const issues: { id: string; title: string; priority: number; created_at: string }[] = [...JSON.parse(out), ...stacked];
      const tickets = issues.filter((i) => !parents.has(i.id)).map((i) => ({ id: i.id, title: i.title, priority: i.priority, createdAt: i.created_at }));
      return { tickets, backlog: beads.length };
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

    async fail(project, id, reason) {
      // bd batch cannot comment or edit labels, so this is two writes. The second is one atomic update, and it releases
      // the claim, so a failure before it leaves the Ticket still claimed rather than half handed back.
      await write(project, ['comment', id, reason]);
      await write(project, ['update', id, '--add-label', 'needs-info', '--remove-label', 'ready-for-agent', '--assignee', '', '--status', 'open']);
    },

    async requeue(project, id) {
      await write(project, ['update', id, '--remove-label', 'needs-info', '--add-label', 'ready-for-agent']);
    },

    async kill(project, id, reason) {
      // Two writes like fail(); the second is atomic and releases the claim, so a failure before it leaves the Ticket claimed.
      await write(project, ['comment', id, reason]);
      await write(project, ['update', id, '--add-label', 'orchestrator:skip', '--assignee', '', '--status', 'open']);
    },

    async interrupt(project, id, reason) {
      // Two writes like fail(); the second is atomic and releases the claim, so a failure before it leaves the Ticket claimed.
      await write(project, ['comment', id, reason]);
      await write(project, ['update', id, '--assignee', '', '--status', 'open']);
    },

    async listClaimed(project) {
      const out = await bd(['--readonly', '-C', project.repoPath, 'list', '-s', 'in_progress', '-a', ORCHESTRATOR, '--exclude-label', 'in-review', '-n', '0', '--json']);
      return (JSON.parse(out) as { id: string }[]).map((i) => i.id);
    },

    async heartbeat(project) {
      const out = await bd(['--readonly', '-C', project.repoPath, 'list', '-s', 'in_progress', '-a', ORCHESTRATOR, '-n', '0', '--json']);
      const failures: string[] = [];
      for (const { id } of JSON.parse(out) as { id: string }[]) {
        await write(project, ['heartbeat', id]).catch((err) => void failures.push(`${id}: ${(err as Error).message}`));
      }
      if (failures.length) throw new Error(`heartbeat failed for ${failures.join('; ')}`);
    },

    async showContext(project, id) {
      const ticket = await show(project, [id, '--include-comments']);
      const parent = ticket.parent ? await show(project, [ticket.parent]) : null;
      const closedBlockers = (ticket.dependencies ?? [])
        .filter((d: { dependency_type: string; status: string }) => d.dependency_type === 'blocks' && d.status === 'closed')
        .map((d: { id: string; title: string; close_reason?: string }) => ({ id: d.id, title: d.title, closeReason: d.close_reason ?? '' }));
      const reviewing = (ticket.dependencies ?? []).find((d: Bead & { dependency_type: string }) => d.dependency_type === 'blocks' && isInReview(d));
      return { ticket, parent, closedBlockers, inReviewBlocker: reviewing ? { id: reviewing.id, title: reviewing.title } : null, openFriction: [] };
    },

    async markInReview(project, id, prUrl) {
      // bd batch cannot comment or label, so these are two writes; the label goes last because it is what marks the Ticket done.
      await write(project, ['comment', id, `PR opened: ${prUrl}`]);
      await write(project, ['update', id, '--add-label', 'in-review']);
    },

    async merged(project, id, prUrl) {
      if (!(await held(project, id))) return false;
      // The label goes first: if the close then fails, the next call still finds the bead held and closes it.
      await write(project, ['update', id, '--remove-label', 'in-review']);
      // --force: the human merged, so open children or blockers must not leave the bead in progress forever.
      await write(project, ['close', id, '--reason', `PR merged: ${prUrl}`, '--force']);
      return true;
    },

    async prClosed(project, id, prUrl) {
      if (!(await held(project, id))) return false;
      // Two writes like fail(); the second is atomic and releases the claim, so a failure before it leaves the Ticket held.
      await write(project, ['comment', id, `PR closed unmerged: ${prUrl}`]);
      await write(project, ['update', id, '--add-label', 'needs-info', '--remove-label', 'ready-for-agent', '--remove-label', 'in-review', '--assignee', '', '--status', 'open']);
      return true;
    },

    async createFriction({ project, title, body, ticketId, runId, attempt, role }) {
      const out = await bd([
        '-C', yszQueue(), '--actor', ORCHESTRATOR, 'create', '--silent',
        '--title', title, '-d', withSource(body, { project, ticketId, runId, attempt, role }),
        '-l', `friction,project:${project.name},needs-triage`,
      ]);
      return out.trim();
    },

    async createFollowUp({ project, title, body, ticketId, runId, attempt, role }) {
      const out = await write(project, [
        'create', '--silent', '--title', title, '-d', withSource(body, { project, ticketId, runId, attempt, role }),
        '-l', 'needs-triage', '--deps', `discovered-from:${ticketId}`,
      ]);
      return out.trim();
    },

    async listOpenFriction(project) {
      const out = await bd(['--readonly', '-C', yszQueue(), 'list', '-l', `friction,project:${project.name}`, '-s', 'open,in_progress,blocked,deferred,pinned,hooked', '-n', '0', '--json', '--brief']);
      return (JSON.parse(out) as { id: string; title: string }[]).map(({ id, title }) => ({ id, title }));
    },

    async commentFriction(id, { title, body, ...from }) {
      await bd(['-C', yszQueue(), '--actor', ORCHESTRATOR, 'comment', id, withSource(`Seen again: ${body ? `${title}\n${body}` : title}`, from)]); // the prefix keeps a title that starts with "-" from reading as a flag
    },
  };
}

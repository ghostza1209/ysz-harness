import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project } from './projects';
import { ORCHESTRATOR, type TicketAction, type TicketFacts } from './ticketActions';

const execFileAsync = promisify(execFile);

export interface Ticket {
  id: string;
  title: string;
  /** 0 (highest) to 4. */
  priority: number;
  /** RFC 3339. */
  createdAt: string;
  /** A Spec: its Run breaks it down into child Tickets instead of implementing it (ADR 0007). */
  spec?: true;
}

/** One unclosed bead of a Project's Backlog, as the poll's `bd list --brief` reads it. */
export interface BacklogRow {
  id: string;
  title: string;
  status: string;
  issue_type: string;
  priority: number;
  assignee: string | null;
  labels: string[];
  parent: string | null;
  /** Blocks and parent-child edges alike. */
  dependencies: { depends_on_id: string; type: string }[];
  comment_count: number;
  /** RFC 3339. */
  created_at: string;
}

/** What `bd show` adds to a Backlog row: the description and the comments, oldest first. */
export interface TicketDetail {
  description: string;
  comments: { author: string; text: string; createdAt: string }[];
}

/** One child Ticket a breakdown agent planned; `blockedBy` holds the keys of other planned Tickets. */
export interface PlannedTicket {
  key: string;
  title: string;
  body: string;
  blockedBy: string[];
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

export interface BeadsGateway {
  /**
   * Ready Tickets of one Project: ready-for-agent, not orchestrator:skip, not an epic, unassigned, no children at all,
   * and every blocker closed except at most one In review. Also returns its Backlog rows, from the same bd call.
   * Specs come with them, marked `spec`: open epics labelled ready-for-agent like a Ticket, every blocker closed, and no children at all.
   */
  listReady(project: Project): Promise<{ tickets: Ticket[]; rows: BacklogRow[] }>;
  /** Atomic claim as the Orchestrator. false = someone else got the Ticket first. */
  claim(project: Project, id: string): Promise<boolean>;
  /** Hand a claimed Ticket back: open and unassigned. */
  release(project: Project, id: string): Promise<void>;
  /**
   * Create `plan` as children of the claimed Spec in one bd write, each labelled ready-for-agent at the Spec's priority
   * with its blocking edges, comment their ids on the Spec, then release it. Returns the new ids in plan order, or null,
   * creating nothing, when the Spec has children by now. Rejects, writing nothing, on a plan bd refuses (a cycle).
   */
  breakDown(project: Project, spec: Pick<Ticket, 'id' | 'priority'>, plan: PlannedTicket[]): Promise<string[] | null>;
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
  /** One Ticket as bd shows it now, for the check before a Backlog action. */
  ticketFacts(project: Project, id: string): Promise<TicketFacts>;
  /** One Ticket's description and comments as bd shows them now, for the Backlog tab's detail panel. */
  ticketDetail(project: Project, id: string): Promise<TicketDetail>;
  /** A Backlog action as the human: one atomic bd update with bd's default actor (never the Orchestrator), touching only the labels the action names. */
  ticketAction(project: Project, id: string, action: TicketAction): Promise<void>;
  /** PR opened: comment its link, then label in-review. The bead stays in_progress, assigned to the Orchestrator. */
  markInReview(project: Project, id: string, prUrl: string): Promise<void>;
  /**
   * The in-review Ticket's PR merged: drop in-review, then close it with the PR link as the reason. Its parent closes too
   * when every child of it is now closed, the parent is labelled ready-for-agent and not epic-branch.
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
  comment_count?: number;
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
  const hasChildren = async (project: Project, id: string) => JSON.parse(await bd(['--readonly', '-C', project.repoPath, 'children', id, '--json'])).length > 0;
  const yszQueue = () => {
    if (!yszRepo) throw new Error('the ysz checkout is not configured, so Friction has no queue to go to');
    return yszRepo;
  };
  /** A Friction's text, ending with where it came from. */
  const withSource = (text: string, { project, ticketId, runId, attempt, role }: Omit<FrictionReport, 'title' | 'body'>) =>
    `${text ? `${text}\n\n` : ''}Project: ${project.name} · Ticket: ${ticketId} · Run: ${runId} · Attempt: ${attempt} · Agent: ${role}`;
  /** The bead, if still in_progress and the Orchestrator's, as a Run left it: the human has not changed it since. */
  const held = async (project: Project, id: string) => {
    const issue = await show(project, [id]);
    return issue.status === 'in_progress' && issue.assignee === ORCHESTRATOR ? issue : null;
  };

  return {
    async listReady(project) {
      const [out, unclosed, closed] = await Promise.all([
        bd(['--readonly', '-C', project.repoPath, 'ready', '-l', 'ready-for-agent', '--exclude-label', 'orchestrator:skip', '--exclude-type', 'epic', '-u', '-n', '0', '--json']),
        bd(['--readonly', '-C', project.repoPath, 'list', '-s', 'open,in_progress,blocked,deferred', '-n', '0', '--json', '--brief']),
        // bd ready ignores parent-child links. A parent is never Ready, even once its children close: they did its work.
        // ponytail: lists every closed bead each poll (~0.6s, mostly bd startup, at 38-134 closed); filter on parent if the history grows large.
        bd(['--readonly', '-C', project.repoPath, 'list', '-s', 'closed', '-n', '0', '--json', '--brief']),
      ]);
      const beads: Bead[] = JSON.parse(unclosed);
      const byId = new Map(beads.map((b) => [b.id, b]));
      const parents = new Set([...beads, ...(JSON.parse(closed) as Bead[])].map((b) => b.parent));
      // bd ready counts an In review blocker as open; a Ticket whose only unclosed blocker is one stacks on its PR.
      const stacked = beads.filter((b) => {
        if (b.status !== 'open' || b.issue_type === 'epic' || b.assignee || !b.labels?.includes('ready-for-agent') || b.labels.includes('orchestrator:skip')) return false;
        const blockers = (b.dependencies ?? []).filter((d) => d.type === 'blocks').flatMap((d) => byId.get(d.depends_on_id) ?? []);
        return blockers.length === 1 && isInReview(blockers[0]);
      });
      const issues: { id: string; title: string; priority: number; created_at: string }[] = [...JSON.parse(out), ...stacked];
      const tickets: Ticket[] = issues.filter((i) => !parents.has(i.id)).map((i) => ({ id: i.id, title: i.title, priority: i.priority, createdAt: i.created_at }));
      const specs = beads.filter(
        (b) =>
          b.status === 'open' && b.issue_type === 'epic' && !b.assignee && !!b.labels?.includes('ready-for-agent') && !b.labels.includes('orchestrator:skip') &&
          !parents.has(b.id) && (b.dependencies ?? []).every((d) => d.type !== 'blocks' || !byId.has(d.depends_on_id)),
      );
      for (const b of specs) tickets.push({ id: b.id, title: b.title, priority: b.priority, createdAt: b.created_at, spec: true });
      const rows = beads.map((b): BacklogRow => ({
        id: b.id,
        title: b.title,
        status: b.status,
        issue_type: b.issue_type,
        priority: b.priority,
        assignee: b.assignee || null,
        labels: b.labels ?? [],
        parent: b.parent ?? null,
        dependencies: (b.dependencies ?? []).map((d) => ({ depends_on_id: d.depends_on_id, type: d.type })),
        comment_count: b.comment_count ?? 0,
        created_at: b.created_at,
      }));
      return { tickets, rows };
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

    async breakDown(project, spec, plan) {
      let created: string[] | null = null;
      // The human may have split the Spec by hand while its agent ran.
      if (!(await hasChildren(project, spec.id))) {
        const keys = new Map(plan.map((t, i) => [t.key, `t${i}`])); // bd's own keys, so an agent's key never reaches bd
        const graph = {
          nodes: plan.map((t) => ({ key: keys.get(t.key), title: t.title, description: t.body, parent_id: spec.id, labels: ['ready-for-agent'], priority: spec.priority })),
          edges: plan.flatMap((t) => t.blockedBy.map((b) => ({ from_key: keys.get(t.key), to_key: keys.get(b), type: 'blocks' }))),
        };
        const dir = await mkdtemp(join(tmpdir(), 'ysz-plan-'));
        let ids: Record<string, string>;
        try {
          await writeFile(join(dir, 'plan.json'), JSON.stringify(graph));
          const out = await write(project, ['create', '--graph', join(dir, 'plan.json'), '--json']).catch((err) => {
            // With --json, bd prints why it refused the plan (a cycle) on stdout, which the error's message leaves out.
            let why = (err as Error).message;
            try {
              why = `bd refused the plan: ${JSON.parse((err as { stdout: string }).stdout).error}`;
            } catch {}
            throw new Error(why);
          });
          ids = JSON.parse(out).ids;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        created = plan.map((t) => ids[keys.get(t.key)!]);
        await write(project, ['comment', spec.id, `Broken down into ${created.join(', ')}`]);
      }
      await write(project, ['update', spec.id, '--assignee', '', '--status', 'open']);
      return created;
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

    async ticketFacts(project, id) {
      const { issue_type, status, assignee, labels } = await show(project, [id]);
      return { id, issue_type, status, assignee: assignee || null, labels: labels ?? [] };
    },

    async ticketDetail(project, id) {
      const { description, comments } = await show(project, [id, '--include-comments']);
      return { description: description ?? '', comments: (comments ?? []).map((c: { author: string; text: string; created_at: string }) => ({ author: c.author, text: c.text, createdAt: c.created_at })) };
    },

    async ticketAction(project, id, action) {
      const flags: Record<TicketAction, string[]> = {
        'mark-ready': ['--add-label', 'ready-for-agent', '--remove-label', 'needs-info'], // marking Ready answers needs-info
        'unmark-ready': ['--remove-label', 'ready-for-agent'],
        skip: ['--add-label', 'orchestrator:skip'],
        allow: ['--remove-label', 'orchestrator:skip'],
      };
      await bd(['-C', project.repoPath, 'update', id, ...flags[action]]); // no --actor: bd records its default actor, the human
    },

    async markInReview(project, id, prUrl) {
      // bd batch cannot comment or label, so these are two writes; the label goes last because it is what marks the Ticket done.
      await write(project, ['comment', id, `PR opened: ${prUrl}`]);
      await write(project, ['update', id, '--add-label', 'in-review']);
    },

    async merged(project, id, prUrl) {
      const issue = await held(project, id);
      if (!issue) return false;
      // The label goes first: if the close then fails, the next call still finds the bead held and closes it.
      await write(project, ['update', id, '--remove-label', 'in-review']);
      // --force: the human merged, so open children or blockers must not leave the bead in progress forever.
      await write(project, ['close', id, '--reason', `PR merged: ${prUrl}`, '--force']);
      // A parent the human gave to agents is done once its last child is. An epic-branch epic waits for its own PR (ADR 0006).
      if (issue.parent) {
        const parent = await show(project, [issue.parent]);
        const labels: string[] = parent.labels ?? [];
        if (parent.status !== 'closed' && labels.includes('ready-for-agent') && !labels.includes('epic-branch')) {
          const children: { status: string }[] = JSON.parse(await bd(['--readonly', '-C', project.repoPath, 'children', issue.parent, '--json']));
          if (children.every((c) => c.status === 'closed')) await write(project, ['close', issue.parent, '--reason', `Every child closed, the last by ${prUrl}`, '--force']);
        }
      }
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

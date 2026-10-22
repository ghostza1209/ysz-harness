import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** A Spec: its Run breaks it down into child Tickets instead of implementing it (ADR 0007). */
  spec?: true;
  /** An epic on its own branch whose children are all closed: its Run opens the epic's PR (ADR 0008). */
  epicPr?: true;
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
  /** Only for a Spec: its children, closed ones included, which its breakdown plans around (ADR 0009). */
  children?: { id: string; title: string; status: string; body: string; closeReason: string }[];
  /** Only for a Spec: the baseline of the text shown, which its breakdown records as covered. */
  baseline?: string;
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
   * Ready Tickets of one Project: ready-for-agent, not orchestrator:skip, not an epic, unassigned, no children at all,
   * and every blocker closed except at most one In review. Also counts its Backlog, from the same bd call.
   * Specs come with them, marked `spec`: open epics labelled ready-for-agent like a Ticket, every blocker closed, children or
   * not (ADR 0009). So do epics marked `epicPr`: open, unassigned and labelled epic-branch, not ready-for-agent,
   * orchestrator:skip or needs-info, with every child closed. A child of an open epic-branch epic never counts an In review
   * blocker as Ready: it lands on the epic branch.
   */
  listReady(project: Project): Promise<{ tickets: Ticket[]; backlog: number }>;
  /** Atomic claim as the Orchestrator. false = someone else got the Ticket first. */
  claim(project: Project, id: string): Promise<boolean>;
  /** Hand a claimed Ticket back: open and unassigned. */
  release(project: Project, id: string): Promise<void>;
  /**
   * Create `plan` as children of the claimed Spec in one bd write, after its existing ones, each labelled ready-for-agent
   * at the Spec's priority with its blocking edges, comment their ids on the Spec, then release it with ready-for-agent
   * and needs-info off and `seen.baseline` recorded as covered (ADR 0009). An empty plan with every child closed closes
   * the Spec instead, unless it is on its own branch; if its text changed since `seen`, it is handed back instead.
   * Returns the new ids in plan order and how it left the Spec, or null, creating nothing and releasing the Spec
   * with its labels, when its children are no longer `seen.children`. Rejects, writing nothing, on a plan bd refuses (a cycle).
   */
  breakDown(
    project: Project,
    spec: Pick<Ticket, 'id' | 'priority'>,
    plan: PlannedTicket[],
    seen: { children: string[]; baseline: string },
  ): Promise<{ created: string[]; left: 'released' | 'closed' | 'handed-back' } | null>;
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
   * The in-review Ticket's PR merged: drop in-review, then close it with the PR link as the reason, and its parent with it
   * when that is done (see closeChild). false, writing nothing, when the human changed the bead since (no longer
   * in_progress and the Orchestrator's).
   */
  merged(project: Project, id: string, prUrl: string): Promise<boolean>;
  /**
   * The claimed Ticket's commits landed on its epic branch (ADR 0008): close it, naming the branch and tip, handing its
   * parent back if changed (see closeChild). false, writing nothing, when the human changed the bead since.
   */
  landed(project: Project, id: string, branch: string, tip: string): Promise<boolean>;
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

/** The bd metadata key on a Spec that holds its baseline: what its last breakdown covered (ADR 0009). */
const BASELINE = 'ysz.baseline';
/** A hash of a Spec's text: its description, design and acceptance criteria. The JSON array keeps text from moving between fields unnoticed. */
const baselineOf = (spec: Record<string, any>) =>
  createHash('sha256').update(JSON.stringify([spec.description ?? '', spec.design ?? '', spec.acceptance_criteria ?? ''])).digest('hex');
const CHANGED_COMMENT =
  'This Spec changed since its last breakdown read it, so its children may not cover all of it. Label it ready-for-agent to have what they do not cover yet broken down.';

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
  const childrenOf = async (project: Project, id: string): Promise<Record<string, any>[]> => JSON.parse(await bd(['--readonly', '-C', project.repoPath, 'children', id, '--json']));
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
  /**
   * Close a held child, then its parent once every child of it is closed, if the parent is not on its own branch and is
   * either a Spec whose text still matches its baseline and that waits for no breakdown, or a non-epic parent labelled
   * ready-for-agent. An epic with no baseline was never broken down by ysz and is left as it is. A Spec changed since its
   * baseline goes back to the human before the child closes, so no poll sees every child closed while it still looks
   * ready for its Epic PR (ADR 0009). `by` names what closed the child, in the parent's reason.
   */
  const closeChild = async (project: Project, child: Record<string, any>, reason: string, by: string) => {
    // --force: the human merged, or the commits are on the epic branch, so open children or blockers must not leave the bead in progress forever.
    const close = (id: string, why: string) => write(project, ['close', id, '--reason', why, '--force']);
    if (!child.parent) {
      await close(child.id, reason);
      return;
    }
    const parent = await show(project, [child.parent]);
    const labels: string[] = parent.labels ?? [];
    const epic = parent.issue_type === 'epic';
    const baseline: string | undefined = parent.metadata?.[BASELINE];
    const matches = !!baseline && baseline === baselineOf(parent);
    const closedBut = async (id?: string) => (await childrenOf(project, parent.id)).every((c) => c.id === id || c.status === 'closed');
    if (parent.status !== 'closed' && epic && baseline && !matches && (await closedBut(child.id))) {
      await write(project, ['comment', parent.id, CHANGED_COMMENT]);
      await write(project, ['update', parent.id, '--add-label', 'needs-info']);
    }
    await close(child.id, reason);
    const done = !labels.includes('epic-branch') && (epic ? matches && !labels.includes('ready-for-agent') : labels.includes('ready-for-agent'));
    if (parent.status !== 'closed' && done && (await closedBut())) await close(parent.id, `Every child closed, the last by ${by}`);
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
      const unclosedParents = new Set(beads.map((b) => b.parent));
      // bd ready counts an In review blocker as open; a Ticket whose only unclosed blocker is one stacks on its PR.
      // Not a child of an epic on its own branch: that lands on the epic branch, which must already hold its blockers.
      const stacked = beads.filter((b) => {
        if (b.status !== 'open' || b.issue_type === 'epic' || b.assignee || !b.labels?.includes('ready-for-agent') || b.labels.includes('orchestrator:skip')) return false;
        if (b.parent && byId.get(b.parent)?.labels?.includes('epic-branch')) return false;
        const blockers = (b.dependencies ?? []).filter((d) => d.type === 'blocks').flatMap((d) => byId.get(d.depends_on_id) ?? []);
        return blockers.length === 1 && isInReview(blockers[0]);
      });
      const issues: { id: string; title: string; priority: number; created_at: string }[] = [...JSON.parse(out), ...stacked];
      const tickets: Ticket[] = issues.filter((i) => !parents.has(i.id)).map((i) => ({ id: i.id, title: i.title, priority: i.priority, createdAt: i.created_at }));
      const specs = beads.filter(
        (b) =>
          b.status === 'open' && b.issue_type === 'epic' && !b.assignee && !!b.labels?.includes('ready-for-agent') && !b.labels.includes('orchestrator:skip') &&
          (b.dependencies ?? []).every((d) => d.type !== 'blocks' || !byId.has(d.depends_on_id)),
      );
      for (const b of specs) tickets.push({ id: b.id, title: b.title, priority: b.priority, createdAt: b.created_at, spec: true });
      const epicPrs = beads.filter(
        (b) =>
          b.status === 'open' && b.issue_type === 'epic' && !b.assignee && !!b.labels?.includes('epic-branch') && !b.labels.includes('ready-for-agent') &&
          !b.labels.includes('orchestrator:skip') && !b.labels.includes('needs-info') && parents.has(b.id) && !unclosedParents.has(b.id),
      );
      for (const b of epicPrs) tickets.push({ id: b.id, title: b.title, priority: b.priority, createdAt: b.created_at, epicPr: true });
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

    async breakDown(project, spec, plan, seen) {
      // The human may have split the Spec by hand while its agent ran.
      const children = await childrenOf(project, spec.id);
      if (children.map((c) => c.id).sort().join() !== [...seen.children].sort().join()) {
        await write(project, ['update', spec.id, '--assignee', '', '--status', 'open']);
        return null;
      }
      let created: string[] = [];
      if (plan.length) {
        const keys = new Map(plan.map((t, i) => [t.key, `t${i}`])); // bd's own keys, so an agent's key never reaches bd
        const highest = Math.max(0, ...children.map((c) => Number(c.id.slice(spec.id.length + 1))).filter(Number.isInteger));
        const graph = {
          // Explicit <spec>.N ids after the highest, as bd create --parent mints: --graph would mint random ones. bd refuses a taken id atomically.
          nodes: plan.map((t, i) => ({ key: keys.get(t.key), id: `${spec.id}.${highest + i + 1}`, title: t.title, description: t.body, parent_id: spec.id, labels: ['ready-for-agent'], priority: spec.priority })),
          // A blocker that is no key in the plan is an existing child (planOf checked), which bd links by id in the same write.
          edges: plan.flatMap((t) => t.blockedBy.map((b) => ({ from_key: keys.get(t.key), ...(keys.has(b) ? { to_key: keys.get(b) } : { to_id: b }), type: 'blocks' }))),
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
      }
      // Nothing left, and no open child to close the Spec later: close it here, bar on its own branch, where the next poll
      // lists its Epic PR. An edit made while its agent ran would then be lost, so that hands it back instead.
      let left: 'released' | 'closed' | 'handed-back' = 'released';
      if (!plan.length && children.every((c) => c.status === 'closed')) {
        const current = await show(project, [spec.id]);
        if (baselineOf(current) !== seen.baseline) left = 'handed-back';
        else if (!(current.labels ?? []).includes('epic-branch')) left = 'closed';
      }
      await write(project, ['comment', spec.id, created.length ? `Broken down into ${created.join(', ')}` : 'Nothing left to break down']);
      if (left === 'handed-back') await write(project, ['comment', spec.id, CHANGED_COMMENT]);
      // One atomic write: a crash before it leaves the Spec labelled and claimed, so recover() hands it back to be broken
      // down again, and that breakdown sees the children created above.
      await write(project, [
        'update', spec.id, '--remove-label', 'ready-for-agent', left === 'handed-back' ? '--add-label' : '--remove-label', 'needs-info',
        '--set-metadata', `${BASELINE}=${seen.baseline}`, '--assignee', '', '--status', left === 'closed' ? 'closed' : 'open',
      ]);
      return { created, left };
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
      // A Spec's breakdown plans only what its children do not cover yet, and records the text it read as covered (ADR 0009).
      const specFields = ticket.issue_type === 'epic' && {
        children: (await childrenOf(project, id)).map((c) => ({ id: c.id, title: c.title, status: c.status, body: c.description ?? '', closeReason: c.close_reason ?? '' })),
        baseline: baselineOf(ticket),
      };
      return { ticket, parent, closedBlockers, inReviewBlocker: reviewing ? { id: reviewing.id, title: reviewing.title } : null, openFriction: [], ...specFields };
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
      await closeChild(project, issue, `PR merged: ${prUrl}`, prUrl);
      return true;
    },

    async landed(project, id, branch, tip) {
      const issue = await held(project, id);
      if (!issue) return false;
      await closeChild(project, issue, `Landed on ${branch} at ${tip}`, `${branch} at ${tip}`);
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

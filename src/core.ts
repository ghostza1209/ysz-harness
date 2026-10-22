import type { BeadsGateway, Ticket, TicketContext } from './beads';
import { epicBranchOf, ticketKey, type HostSteps, type Prepared } from './host';
import type { Project } from './projects';
import type { AgentReports, AgentResult, SandboxRunner } from './sandbox';
import type { AgentUsage, BacklogPoint, Reports, RunRow, RunState, Store } from './store';

/** Runs at once, across all Projects. Each Project also runs at most one. */
export const SLOTS_TOTAL = 2;

/** A Spec Run's note when its agent planned no Tickets, by how the breakdown left the Spec (ADR 0009). */
const NOTHING_LEFT = {
  released: 'Nothing left to break down',
  closed: 'Nothing left to break down; closed the Spec',
  'handed-back': 'Nothing left to break down, but the Spec changed while its agent ran, so it went back to the human',
};

export type WaitReason = 'next up' | 'waiting for slot' | 'Project already has a Run' | 'not onboarded' | 'Project paused' | 'run-now · waiting for slot' | 'preflight failed' | 'image missing' | 'docker down';

export interface QueueItem {
  project: string;
  id: string;
  title: string;
  priority: number;
  ageMs: number;
  waitReason: WaitReason;
  /** The user asked to run it ahead of the queue. */
  runNow: boolean;
  /** A Spec, which its Run breaks down into child Tickets. */
  spec?: true;
  /** An epic whose children are all closed, whose Run opens its PR. */
  epicPr?: true;
}

/** A Run as the Stats page gets it: without the fields it never reads, a failure note above all. */
export type StatsRun = Omit<RunRow, 'note' | 'cloneDir' | 'reports'>;

export interface ProjectStatus {
  name: string;
  ready: number;
  /** Paused Projects start no new Runs (Run now excepted); live Runs finish normally. */
  paused: boolean;
  /** Why the last poll failed (e.g. bd timed out); the queue then shows the last known Tickets. */
  error: string | null;
}

export interface Orchestrator {
  /** Query every Project's Beads queue in parallel, recording its Backlog and Ready counts when they change. One failing Project never blocks the others. */
  poll(): Promise<void>;
  /** Claim the Ready Tickets that fit the free slots and start a Run for each; resolves once they are started, not finished. */
  tick(): Promise<void>;
  /** Resolves when no Run is in flight and no clone is being measured. */
  whenIdle(): Promise<void>;
  /**
   * Live Runs (those holding a slot, and needs-attention ones), the newest `limit` ended ones and the newest `limit` archived
   * ones (newest first), and every ended Run that still has its clone, whatever the limit, with their size measured so far.
   */
  runs(limit?: number): { live: RunRow[]; history: RunRow[]; archived: RunRow[]; cloned: RunRow[]; clonedBytes: number };
  /** What the Stats page graphs: every Run, archived ones too, and every change of each Project's Backlog and Ready counts. */
  stats(): { runs: StatsRun[]; backlog: BacklogPoint[] };
  /** Ready Tickets of all Projects in pick order. */
  readyQueue(): QueueItem[];
  slots(): { used: number; total: number };
  projectStatuses(): ProjectStatus[];
  /**
   * Stop a live Run (claimed, agent, agent-review, host or needs-attention): abort its agent and host processes, remove its sandbox
   * container, then release the Ticket with orchestrator:skip and a comment. The Run ends killed and keeps its clone.
   * Rejects, leaving the Run live, if the container could not be removed.
   */
  kill(runId: number): Promise<void>;
  /** Pause or resume picking from a Project. Persists in the store; Runs already live are untouched. */
  setPaused(project: string, paused: boolean): void;
  /**
   * Move a Ready Ticket to the head of the queue, even if its Project is paused. It still waits for a free slot (and
   * for its Project's current Run): nothing is preempted. Throws if the Ticket is not in the Ready queue.
   */
  runNow(project: string, ticketId: string): void;
  /**
   * Run once at startup, before the first tick, to settle what a crash left behind: remove leftover sandbox containers;
   * end agent-phase Runs as interrupted, removing their clone and releasing their Ticket with a comment (not an Attempt);
   * resume host-phase Runs from their host step and re-arm needs-attention ones for Retry; release Tickets the
   * Orchestrator holds with no live Run and no in-review label; remove the clones nobody needs, then measure in the
   * background the ones kept that have no size yet. Never rejects: returns what it could not do.
   */
  recover(): Promise<string[]>;
  /** Resume a needs-attention Run from the host step that failed. Needs a free slot. Resolves once started, not finished. */
  retryHostStep(runId: number): Promise<void>;
  /** Retry a failed Run: put its Ticket back in the Ready queue for a new Run. Only the Ticket's newest Run; the row stays failed. */
  requeue(runId: number): Promise<void>;
  /** Remove the clone of an ended Run. The history row stays. */
  cleanUp(runId: number): Promise<void>;
  /**
   * Delete a failed, interrupted or killed Run: its clone, its log, then its row. Rejects, keeping the row, if the clone
   * could not be removed, or if the Run was killed but its Ticket never released: recover() needs the row to keep it skipped.
   */
  deleteRun(runId: number): Promise<void>;
  /** Archive a merged, PR-closed, broken-down or landed Run out of the history, or bring it back. */
  setArchived(runId: number, archived: boolean): void;
  /**
   * Ask GitHub about each in-review Run's PR, one at a time: a merged one ends the Run merged and closes its bead,
   * one closed unmerged ends it pr-closed and hands the bead back. A bead the human changed is left alone. endedAt keeps the
   * time the Run reached in-review; prClosedAt gets GitHub's. Never rejects: a Run whose check failed stays in-review for the next call.
   */
  watchReviews(): Promise<string[]>;
}

/** A failed or killed Run keeps its clone for the human to inspect. */
const inspected = (state: RunState) => state === 'failed' || state === 'killed';

export interface Clock {
  now(): number;
}

/** How one Attempt ended. A failed Attempt keeps its clone so the caller can remove it or leave it for inspection. */
type Attempted =
  | { kind: 'done'; prepared: Prepared; followUps: FollowUp[]; tip?: string; reviewSkipped?: string }
  | { kind: 'failed'; prepared: Prepared; reason: string }
  | { kind: 'needs-info'; agent: 'implement' | 'review'; question: string };

/** Work in the Project's code outside the Ticket, as an agent reported it, with the Attempt and agent that did. */
type FollowUp = AgentReports['followUps'][number] & { attempt: number; role: 'implement' | 'review' };

/** What a Run needs to resume its host steps. */
interface HostJob {
  project: Project;
  ticket: { id: string; title: string };
  /** The clone the Attempt's work comes from. Absent for an epic's PR (ADR 0008), whose work is on its epic branch. */
  prepared?: Prepared;
  /** An epic's PR: what its title names the epic by. */
  epicKey?: string;
  tip?: string;
  reviewSkipped?: string;
  /** The Follow-ups of the Attempt the PR opens from that have no Ticket yet. */
  followUps: FollowUp[];
  /** Set once the PR is open, so a retry does not open a second one. */
  prUrl: string | null;
}

/** In-process handles on a live Run. Rebuilt by recover() after a restart. */
interface Control {
  /** Aborted by kill(): stops the Run's agent and host processes. */
  ctl: AbortController;
  /** The task driving the Run now; unset while it waits in needs-attention. */
  running?: Promise<void>;
  /** The host steps to resume, while the Run waits in needs-attention. */
  parked?: HostJob;
}

export function createOrchestrator(deps: {
  projects: readonly Project[];
  beads: BeadsGateway;
  sandbox: SandboxRunner;
  host: HostSteps;
  store: Store;
  clock: Clock;
  /** The model the agents run on, recorded on each Run. */
  model: string;
  /** Appends a line to a Run's log. */
  log?: (runId: number, line: string) => void;
  /** Deletes a Run's log. */
  removeLog?: (runId: number) => Promise<void>;
}): Orchestrator {
  const { projects, beads, sandbox, host, store, clock, model, log: logRun = () => {}, removeLog = async () => {} } = deps;
  const snapshots = new Map(projects.map((p) => [p.name, { tickets: [] as Ticket[], error: null as string | null }]));
  const inFlight = new Set<Promise<void>>();
  const controls = new Map<number, Control>();
  /** Runs a kill() is settling, so a second click does not write the bead twice. */
  const killing = new Set<number>();
  /** Tickets whose Run failed since startup, so a failing Ticket is not retried every tick. Failure handling will replace this. */
  const failed = new Set<string>();
  /** Run-now Tickets in the order asked. ponytail: in memory, so a restart forgets them; the Ticket is still Ready and re-queues normally. */
  const runNowKeys = new Set<string>();
  const key = (project: string, id: string) => `${project}/${id}`;

  const byName = new Map(projects.map((p) => [p.name, p]));
  /** Projects whose last infrastructure check failed, and why. Rewritten by every tick that checks them. */
  const gates = new Map<string, 'preflight failed' | 'image missing' | 'docker down'>();

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** End a Run: record the outcome and drop its controls. A failed or killed Run keeps its clone, so its size is measured. */
  function end(runId: number, patch: Parameters<Store['updateRun']>[1]) {
    store.updateRun(runId, { ...patch, endedAt: clock.now() });
    controls.delete(runId);
    if (patch.state && inspected(patch.state)) measure([store.getRun(runId)!]);
  }

  /** In the background, one after another, record the size of each Run's clone still there by then. A failed du leaves it unknown. */
  function measure(runs: RunRow[]) {
    const work = (async () => {
      for (const { id, cloneDir } of runs) {
        const bytes = cloneDir && (await host.cloneSize({ dir: cloneDir }).catch(() => null));
        if (bytes && store.getRun(id)?.cloneDir === cloneDir) store.updateRun(id, { cloneBytes: bytes });
      }
    })().finally(() => inFlight.delete(work));
    inFlight.add(work);
  }

  /** Remove a Run's clone and clear its path. Rejects, keeping the path, if the removal fails. */
  async function removeCloneOf({ id, cloneDir }: RunRow) {
    await host.removeClone({ dir: cloneDir! });
    store.updateRun(id, { cloneDir: null });
  }

  /** Run `work` as a background task of the Run; it never rejects. */
  function track(control: Control, work: Promise<void>) {
    const running = work.finally(() => {
      inFlight.delete(running);
      if (control.running === running) control.running = undefined;
    });
    control.running = running;
    inFlight.add(running);
  }

  /**
   * The host steps after a successful Attempt: publish, create a Ticket for each Follow-up, mark the bead, end in-review.
   * A Run that lands on its epic branch (ADR 0008) lands there instead of publishing, then closes the bead and ends
   * landed; an epic's own PR Run only publishes the epic branch and marks the epic. A failure never burns an Attempt: the
   * Run parks in needs-attention (freeing its slot) with the clone and the bead claim kept, for Retry or Kill. A step that
   * already succeeded is not repeated: once the PR exists, a retry creates only the Follow-ups still missing, then marks
   * the bead; landing again changes nothing. Never rejects.
   */
  async function finish(runId: number, control: Control, job: HostJob): Promise<void> {
    const { signal } = control.ctl;
    const log = (line: string) => logRun(runId, line);
    const { prepared } = job;
    const saveJob = () => store.setHostJob(runId, JSON.stringify({ prepared, epicKey: job.epicKey, tip: job.tip, reviewSkipped: job.reviewSkipped, followUps: job.followUps }));
    store.updateRun(runId, { state: 'host', note: null });
    log(`--- Push & PR started: ${new Date(clock.now()).toISOString()} ---`);
    // What recover() needs to pick the job up again; the PR url is already on the row.
    saveJob();
    try {
      let landed: string | undefined;
      if (prepared?.land) {
        signal.throwIfAborted();
        landed = await host.land(job.project, prepared, { tip: job.tip, signal, log });
        log(`Landed on ${prepared.epic}: ${landed}`);
      } else if (!job.prUrl) {
        signal.throwIfAborted();
        const pr = prepared
          ? await host.publish(job.project, job.ticket, prepared, { tip: job.tip, reviewSkipped: job.reviewSkipped, followUps: job.followUps.map((f) => f.title), signal, log })
          : await host.publishEpic(job.project, job.ticket, job.epicKey!, { reviewSkipped: job.reviewSkipped, signal, log });
        job.prUrl = pr.url;
        store.updateRun(runId, { prUrl: pr.url, prBase: pr.base === job.project.baseBranch ? null : pr.base });
        log(`PR opened: ${job.prUrl}`);
      }
      // One at a time; each id is on the Run before the next write, and out of the job, so a retry or a restart does only the rest.
      while (job.followUps.length) {
        signal.throwIfAborted();
        const { title, body, attempt, role } = job.followUps[0];
        const id = await beads.createFollowUp({ project: job.project, title, body, ticketId: job.ticket.id, runId, attempt, role });
        const reports = store.getRun(runId)!.reports ?? { followUps: [], friction: [] };
        store.setReports(runId, { ...reports, followUps: [...reports.followUps, { id, title }] });
        job.followUps = job.followUps.slice(1);
        saveJob();
      }
      signal.throwIfAborted();
      if (landed) {
        if (!(await beads.landed(job.project, job.ticket.id, prepared!.epic!, landed))) log('Ticket left alone: changed by hand since the Run claimed it');
        signal.throwIfAborted();
        // The note carries a skipped review to the epic's PR, the first the human sees of this work.
        end(runId, { state: 'landed', prBase: prepared!.epic!, note: job.reviewSkipped ? `review skipped: ${job.reviewSkipped}` : null });
      } else {
        await beads.markInReview(job.project, job.ticket.id, job.prUrl!);
        signal.throwIfAborted();
        end(runId, { state: 'in-review' });
      }
      // The work is on a branch and the bead is done, so a leftover clone is only clutter.
      if (prepared) await host.removeClone(prepared).then(() => store.updateRun(runId, { cloneDir: null }), () => {});
      // So are the clones the Ticket's failed or killed Runs kept for inspection. One left behind waits for the next recover().
      for (const run of store.cloned().filter((r) => r.project === job.project.name && r.ticketId === job.ticket.id && inspected(r.state))) {
        await removeCloneOf(run).catch((err) => log(`Removing the clone of Run ${run.id} failed: ${message(err)}`));
      }
    } catch (err) {
      if (signal.aborted) return; // kill() settles the Run
      control.parked = job;
      log(`Failed: ${message(err)}`);
      store.updateRun(runId, { state: 'needs-attention', note: message(err) });
    }
  }

  /**
   * A claimed Spec's Attempts: a breakdown agent plans the child Tickets its existing children do not cover yet, which bd
   * then creates under it and hands it back. No review agent and no PR. Returns null once broken down, else the note to
   * hand the Spec back with. No host job is saved, so after a crash recover() hands the Spec back with its label, and the
   * next breakdown sees any children already created (ADR 0009).
   */
  async function breakDown(runId: number, project: Project, spec: Pick<Ticket, 'id' | 'priority'>, context: TicketContext, signal: AbortSignal): Promise<string | null> {
    // What the agent sees, read once at the Run's start, so an edit made while it runs does not count as covered.
    const children = (context.children ?? []).map((c) => c.id);
    let note = '';
    for (let n = 1; n <= 2; n++) {
      signal.throwIfAborted();
      store.updateRun(runId, { state: 'claimed', attempt: n });
      const prepared = await host.prepare(project, spec.id, context, signal);
      store.updateRun(runId, { state: 'agent', cloneDir: prepared.dir });
      let result: Awaited<ReturnType<SandboxRunner['breakDown']>> | undefined;
      let reason: string;
      try {
        result = await sandbox.breakDown({ project, runId, attempt: n, signal, ...prepared, children, previousAttemptSummary: note || undefined, onUsage: (u) => store.setUsage(runId, `attempt${n}-breakdown`, u) });
      } catch (err) {
        signal.throwIfAborted();
        reason = `the breakdown agent failed: ${message(err)}`;
      } finally {
        // The agent writes no code, so its clone holds nothing to inspect.
        await host.removeClone(prepared).then(() => store.updateRun(runId, { cloneDir: null }), () => {});
      }
      signal.throwIfAborted();
      if (result?.outcome === 'needs-info') return `The breakdown agent needs information:\n${result.question}`;
      if (result?.outcome === 'complete' && typeof result.plan !== 'string') {
        store.updateRun(runId, { state: 'host' });
        const written = await beads.breakDown(project, spec, result.plan, { children, baseline: context.baseline! });
        const done = !written
          ? "The Spec's children changed while its agent ran, so none were created."
          : written.created.length
            ? `Broken down into ${written.created.join(', ')}`
            : NOTHING_LEFT[written.left];
        logRun(runId, done);
        end(runId, { state: 'broken-down', note: done });
        return null;
      }
      if (result?.outcome === 'stopped') reason = `the breakdown agent stopped without signalling COMPLETE${result.tail && `: ${result.tail}`}`;
      else if (result) reason = `the breakdown agent's plan is unusable: ${result.plan}`;
      note += `${note && '\n'}Attempt ${n} failed: ${reason!}`;
    }
    return note;
  }

  /** Run one claimed Ticket to its end: in-review with a PR, parked in needs-attention, or failed and handed back. Never rejects. */
  async function execute(runId: number, project: Project, ticket: Pick<Ticket, 'id' | 'title' | 'priority' | 'spec' | 'epicPr'>, control: Control): Promise<void> {
    const { signal } = control.ctl;
    /** End the Run failed, handing the Ticket back with `note`. */
    async function handBack(note: string) {
      try {
        await beads.fail(project, ticket.id, note);
      } catch (err) {
        throw new Error(`${note}\nhanding the Ticket back failed: ${message(err)}`); // execute's catch releases the claim
      }
      end(runId, { state: 'failed', note });
    }
    try {
      const context = await beads.showContext(project, ticket.id);
      if (ticket.spec) {
        const note = await breakDown(runId, project, ticket, context, signal);
        if (note !== null) await handBack(note);
        return;
      }
      if (ticket.epicPr) {
        // ADR 0008: no Attempt, only the host steps. The PR body owns up to each child that landed unreviewed.
        const branch = epicBranchOf(project, ticket.id);
        const skipped = store.allRuns().filter((r) => r.project === project.name && r.state === 'landed' && r.prBase === branch && r.note);
        const reviewSkipped = skipped.map((r) => `${r.ticketId}: ${r.note!.replace(/^review skipped: /, '')}`).join('; ') || undefined;
        await finish(runId, control, { project, ticket, epicKey: ticketKey(ticket.id, context), reviewSkipped, followUps: [], prUrl: null });
        return;
      }
      // A closed blocker whose PR merged into another Run's agent/<id> branch, while that Run's own PR was still In review,
      // has its code only on that branch, so the Run stacks there too. Follow Runs that merged into one that merged in turn.
      const newest = new Map(store.allRuns().filter((r) => r.project === project.name).map((r) => [r.ticketId, r]));
      const holders = new Map<string, RunRow>();
      for (const { id } of context.closedBlockers) {
        const seen = new Set<string>();
        let run = newest.get(id);
        while (run?.state === 'merged' && run.prBase?.startsWith('agent/') && !seen.has(run.ticketId)) {
          seen.add(run.ticketId);
          const onto = newest.get(run.prBase.slice('agent/'.length));
          // GitHub retargets a PR only when its base branch is deleted, so one merged after that branch's own PR lands where nothing merges on.
          if (onto?.state === 'merged' && run.prClosedAt && onto.prClosedAt && run.prClosedAt > onto.prClosedAt) {
            throw new Error(`${run.ticketId} merged into ${run.prBase} after ${onto.ticketId} had merged, so its code is on no branch to start from`);
          }
          run = onto;
        }
        if (seen.size && run?.state === 'in-review' && run.prUrl) holders.set(run.ticketId, run);
      }
      const stackIds = new Set([...(context.inReviewBlocker ? [context.inReviewBlocker.id] : []), ...holders.keys()]);
      // ponytail: fails and skips the Ticket until a restart, where ADR 0005 has two In review blockers wait; make listReady see Runs if it recurs.
      if (stackIds.size > 1) throw new Error(`the Run would stack on ${[...stackIds].join(' and ')}, but a PR has one base`);
      if (!context.inReviewBlocker && holders.size) {
        const [run] = holders.values();
        context.inReviewBlocker = { id: run.ticketId, title: run.title, prUrl: run.prUrl! };
      }
      const blocker = context.inReviewBlocker;
      if (blocker && !blocker.prUrl) {
        // The Run stacks on the blocker's PR, which only its In review Run knows.
        const prUrl = store.inReview().find((r) => r.project === project.name && r.ticketId === blocker.id)?.prUrl;
        if (!prUrl) throw new Error(`blocker ${blocker.id} is In review, but no In review Run has its PR to stack on`);
        context.inReviewBlocker = { ...blocker, prUrl };
      }

      /** What the Run's agents reported so far, across Attempts. */
      const recorded: Reports = { followUps: [], friction: [] };
      /** The Project's open Friction as this Attempt's agents saw it; what an agent refers to by id is commented on, not duplicated. */
      let openFriction: { id: string; title: string }[] = [];
      /**
       * Record an agent's Friction in ysz's own queue: a comment on the open Ticket it refers to, else a new Ticket (so a
       * mistaken reference loses nothing). A failed write is a log line and nothing more; a kill stops it.
       */
      async function recordFriction(attempt: number, role: 'implement' | 'review', { friction }: AgentReports) {
        const written: Reports['friction'] = [];
        for (const { title, body, ref } of friction) {
          if (signal.aborted) break;
          try {
            const report = { project, title, body, ticketId: ticket.id, runId, attempt, role };
            const open = openFriction.find((f) => f.id === ref);
            if (open) {
              await beads.commentFriction(open.id, report);
              written.push({ id: open.id, title: open.title, seenAgain: true });
            } else {
              const id = await beads.createFriction(report);
              openFriction = [...openFriction, { id, title }]; // open now: a later agent's reference to it is a comment
              written.push({ id, title, seenAgain: false });
            }
            recorded.friction.push(written.at(-1)!);
            store.setReports(runId, recorded);
          } catch (err) {
            logRun(runId, `Recording Friction "${title}" failed: ${message(err)}`);
          }
        }
        return written;
      }

      /**
       * One Attempt: implement, then review, each in a fresh sandbox on a fresh clone of the base branch, or of the
       * In review blocker's branch. A kill throws out of it.
       */
      async function attempt(n: number, previousAttemptSummary?: string): Promise<Attempted> {
        signal.throwIfAborted();
        store.updateRun(runId, { state: 'claimed', attempt: n });
        const found = ({ reports }: AgentResult, role: FollowUp['role']): FollowUp[] => reports.followUps.map((f) => ({ ...f, attempt: n, role }));
        // A Friction the human closed since the last Attempt must not be commented on, so each Attempt asks again.
        openFriction = await beads.listOpenFriction(project).catch((err) => {
          logRun(runId, `Fetching the open Friction failed, so the agents get none: ${message(err)}`);
          return [];
        });
        signal.throwIfAborted();
        const prepared = await host.prepare(project, ticket.id, { ...context, openFriction }, signal);
        store.updateRun(runId, { cloneDir: prepared.dir }); // even if killed meanwhile: Clean up must find the clone
        const req = { project, runId, attempt: n, signal, ...prepared };
        const usage = (role: string) => (u: AgentUsage) => store.setUsage(runId, `attempt${n}-${role}`, u);
        store.updateRun(runId, { state: 'agent' });
        let implemented: AgentResult;
        try {
          implemented = await sandbox.implement({ ...req, previousAttemptSummary, onUsage: usage('implement') });
        } catch (err) {
          signal.throwIfAborted();
          return { kind: 'failed', prepared, reason: `the implement agent failed: ${message(err)}` };
        }
        signal.throwIfAborted();
        const implementFriction = await recordFriction(n, 'implement', implemented.reports);
        signal.throwIfAborted();
        if (implemented.outcome === 'needs-info') return { kind: 'needs-info', agent: 'implement', question: implemented.question };
        if (implemented.outcome === 'stopped') {
          return { kind: 'failed', prepared, reason: `the implement agent stopped without signalling COMPLETE${implemented.tail && `: ${implemented.tail}`}` };
        }

        let collected: { tip: string; commits: number };
        try {
          collected = await host.collect(project, prepared, signal);
        } catch (err) {
          signal.throwIfAborted();
          return { kind: 'failed', prepared, reason: `the agent's commits could not be read back: ${message(err)}` };
        }
        signal.throwIfAborted();
        if (collected.commits === 0) return { kind: 'failed', prepared, reason: 'the agent made no commits' };

        // The Ticket file, not the prompt, carries what the implement agent wrote: sandcastle runs a !-backtick span in a prompt as a shell command.
        const implementReports = { followUps: implemented.reports.followUps.map((f, i) => ({ ref: `F${i + 1}`, ...f })), friction: implementFriction };
        try {
          await host.writeTicket(prepared, { ...context, openFriction, implementReports });
        } catch (err) {
          signal.throwIfAborted();
          return { kind: 'failed', prepared, reason: `the implement agent's reports could not be handed to the review agent: ${message(err)}` };
        }

        store.updateRun(runId, { state: 'agent-review' });
        let skipped: string;
        try {
          const reviewed = await sandbox.review({ ...req, onUsage: usage('review') });
          signal.throwIfAborted();
          await recordFriction(n, 'review', reviewed.reports);
          signal.throwIfAborted();
          if (reviewed.outcome === 'needs-info') return { kind: 'needs-info', agent: 'review', question: reviewed.question };
          if (reviewed.outcome === 'complete') {
            // What the review says nothing about stays; a ref it makes up matches nothing.
            const fixed = new Set(reviewed.reports.fixedFollowUps);
            const kept = found(implemented, 'implement').filter((_, i) => !fixed.has(`F${i + 1}`));
            return { kind: 'done', prepared, followUps: [...kept, ...found(reviewed, 'review')] };
          }
          skipped = 'the review agent stopped without signalling COMPLETE';
        } catch (err) {
          signal.throwIfAborted();
          skipped = `the review agent failed: ${message(err)}`;
        }
        // An unfinished review may have left half a change, so the PR opens from the implement commits.
        return { kind: 'done', prepared, followUps: found(implemented, 'implement'), tip: collected.tip, reviewSkipped: skipped.replace(/\s+/g, ' ').slice(0, 300) };
      }

      let result = await attempt(1);
      let note = '';
      if (result.kind === 'failed') {
        note = `Attempt 1 failed: ${result.reason}`;
        await host.removeClone(result.prepared).then(() => store.updateRun(runId, { cloneDir: null }), () => {});
        result = await attempt(2, note);
        if (result.kind === 'failed') note += `\nAttempt 2 failed: ${result.reason}`;
      }
      signal.throwIfAborted();

      if (result.kind !== 'done') {
        if (result.kind === 'needs-info') note = `The ${result.agent} agent needs information:\n${result.question}`;
        await handBack(note);
        return;
      }

      const { prepared, tip, reviewSkipped, followUps } = result;
      await finish(runId, control, { project, ticket, prepared, tip, reviewSkipped, followUps, prUrl: null });
    } catch (err) {
      if (signal.aborted) return; // kill() settles the Run
      failed.add(key(project.name, ticket.id));
      let note = message(err);
      try {
        await beads.release(project, ticket.id);
      } catch (releaseErr) {
        note += `; releasing the Ticket failed: ${message(releaseErr)}`;
      }
      end(runId, { state: 'failed', note });
    }
  }

  /** Priority ascending across Projects; on ties round-robin over Projects, oldest first within each. */
  function pickOrder() {
    const entries: { project: string; ticket: Ticket; projectIndex: number; rank: number }[] = [];
    projects.forEach((p, projectIndex) => {
      const oldestFirst = snapshots.get(p.name)!.tickets.filter((t) => !failed.has(key(p.name, t.id))).sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1),
      );
      const perPriority = new Map<number, number>();
      for (const ticket of oldestFirst) {
        const rank = perPriority.get(ticket.priority) ?? 0;
        perPriority.set(ticket.priority, rank + 1);
        entries.push({ project: p.name, ticket, projectIndex, rank });
      }
    });
    // ponytail: ties interleave in registry order every time; rotating from the last-picked Project belongs with claiming
    const asked = [...runNowKeys];
    const jump = (e: (typeof entries)[number]) => {
      const i = asked.indexOf(key(e.project, e.ticket.id));
      return i < 0 ? asked.length : i;
    };
    return entries.sort((a, b) => jump(a) - jump(b) || a.ticket.priority - b.ticket.priority || a.rank - b.rank || a.projectIndex - b.projectIndex);
  }

  function readyQueue(): QueueItem[] {
    const now = clock.now();
    const live = store.slotProjects();
    const busy = new Set(live);
    const paused = new Set(store.pausedProjects());
    let free = SLOTS_TOTAL - live.length;
    // Walk in pick order, handing out the free slots as the next ticks would.
    return pickOrder().map(({ project, ticket }) => {
      const runNow = runNowKeys.has(key(project, ticket.id));
      let waitReason: WaitReason;
      if (!byName.get(project)!.image) waitReason = 'not onboarded';
      else if (paused.has(project) && !runNow) waitReason = 'Project paused';
      else if (busy.has(project)) waitReason = runNow ? 'run-now · waiting for slot' : 'Project already has a Run';
      else if (gates.has(project)) waitReason = gates.get(project)!; // takes no slot: the next Project's Ticket may use it
      else if (free > 0) {
        waitReason = 'next up';
        free--;
        busy.add(project);
      } else waitReason = runNow ? 'run-now · waiting for slot' : 'waiting for slot';
      return {
        runNow,
        project,
        id: ticket.id,
        title: ticket.title,
        priority: ticket.priority,
        ageMs: now - Date.parse(ticket.createdAt),
        waitReason,
        ...(ticket.spec && { spec: true as const }),
        ...(ticket.epicPr && { epicPr: true as const }),
      };
    });
  }

  return {
    async tick() {
      // Infrastructure gates, before anything is claimed: a failure never burns an Attempt. Busy or paused Projects claim nothing, so they are not checked.
      const busyNow = store.slotProjects();
      if (busyNow.length >= SLOTS_TOTAL) return;
      const paused = new Set(store.pausedProjects());
      const claimable = new Set(pickOrder().filter((e) => !paused.has(e.project) || runNowKeys.has(key(e.project, e.ticket.id))).map((e) => e.project));
      await Promise.all(
        projects
          .filter((p) => p.image && !busyNow.includes(p.name) && claimable.has(p.name))
          .map(async (p) => {
            const hasImage = await sandbox.hasImage(p).catch(() => null);
            const down = hasImage === null ? ('docker down' as const)
              : !hasImage ? 'image missing'
              : await host.preflight(p).then(() => null, () => 'preflight failed' as const);
            if (down) gates.set(p.name, down);
            else gates.delete(p.name);
          }),
      );
      const skipped = new Set<string>();
      for (;;) {
        // The queue's own slot arithmetic decides what fits; re-read it after every claim.
        const next = readyQueue().find((q) => q.waitReason === 'next up' && !skipped.has(key(q.project, q.id)));
        if (!next) return;
        skipped.add(key(next.project, next.id));
        const project = byName.get(next.project)!;
        const snapshot = snapshots.get(next.project)!;
        let won: boolean;
        try {
          won = await beads.claim(project, next.id);
        } catch (err) {
          snapshot.error = `claiming ${next.id}: ${err instanceof Error ? err.message : err}`;
          continue;
        }
        // Won or lost, the snapshot entry is stale now; the next poll refreshes it.
        snapshot.tickets = snapshot.tickets.filter((t) => t.id !== next.id);
        runNowKeys.delete(key(next.project, next.id));
        if (!won) continue;
        const runId = store.insertRun({ project: next.project, ticketId: next.id, title: next.title, state: 'claimed', startedAt: clock.now(), model });
        const control: Control = { ctl: new AbortController() };
        controls.set(runId, control);
        track(control, execute(runId, project, next, control));
      }
    },

    async whenIdle() {
      while (inFlight.size) await Promise.all(inFlight);
    },

    runs(limit = 50) {
      const cloned = store.cloned();
      return { live: store.liveRuns(), history: store.history(limit), archived: store.archived(limit), cloned, clonedBytes: cloned.reduce((n, r) => n + (r.cloneBytes ?? 0), 0) };
    },

    async kill(runId) {
      const run = store.getRun(runId);
      if (!run || !store.liveRuns().some((r) => r.id === runId)) throw new Error(`Run ${runId} is not live`);
      if (killing.has(runId)) throw new Error(`Run ${runId} is already being killed`);
      killing.add(runId);
      try {
        const control = controls.get(runId);
        control?.ctl.abort();
        // sandcastle removes its container on abort but ignores docker's errors, so check it ourselves.
        if ((run.state === 'agent' || run.state === 'agent-review') && run.cloneDir) await sandbox.stop({ dir: run.cloneDir });
        await control?.running;

        const reason = `Killed from the dashboard while ${run.state}.`;
        let note = reason;
        const { prUrl } = store.getRun(runId)!;
        if (prUrl) note += ` (PR ${prUrl} was opened)`;
        try {
          await beads.kill(byName.get(run.project)!, run.ticketId, reason);
        } catch (err) {
          note += `; releasing the Ticket failed: ${message(err)}`;
        }
        end(runId, { state: 'killed', note });
      } finally {
        killing.delete(runId);
      }
    },

    setPaused(project, paused) {
      if (!byName.has(project)) throw new Error(`Unknown Project ${project}`);
      store.setPaused(project, paused);
    },

    runNow(project, ticketId) {
      if (!byName.get(project)?.image) throw new Error(`${project} is not onboarded`);
      if (!snapshots.get(project)!.tickets.some((t) => t.id === ticketId && !failed.has(key(project, t.id)))) throw new Error(`${ticketId} is not in the Ready queue`);
      runNowKeys.add(key(project, ticketId));
    },

    async recover() {
      const problems: string[] = [];
      const attempt = (what: string, work: () => Promise<void>) => work().catch((err) => void problems.push(`${what}: ${message(err)}`));
      await attempt('removing leftover sandbox containers', () => sandbox.removeLeftovers());

      for (const run of store.liveRuns()) {
        const project = byName.get(run.project);
        if (!project) {
          problems.push(`Run ${run.id}: ${run.project} is not a registered Project`);
          continue;
        }
        const saved = store.hostJob(run.id);
        if (saved) {
          // Past the agents: the clone holds the finished work, so only the host steps are left.
          const control: Control = { ctl: new AbortController() };
          // A host job saved before Follow-ups travelled in it resumes with none.
          const job: HostJob = { project, ticket: { id: run.ticketId, title: run.title }, followUps: [], ...JSON.parse(saved), prUrl: run.prUrl };
          controls.set(run.id, control);
          if (run.state === 'needs-attention') control.parked = job;
          else track(control, finish(run.id, control, job));
          continue;
        }
        // An agent was cut off (or the Run had not got that far). Its work is gone, and no Attempt is spent.
        await attempt(`Run ${run.id}`, async () => {
          let note = `Interrupted by a ysz restart while ${run.state}; not counted as an Attempt.`;
          await beads.interrupt(project, run.ticketId, note).catch((err) => void (note += `; releasing the Ticket failed: ${message(err)}`));
          if (run.cloneDir) await host.removeClone({ dir: run.cloneDir }).then(() => store.updateRun(run.id, { cloneDir: null }), () => {});
          end(run.id, { state: 'interrupted', note });
        });
      }

      const live = new Set(store.liveRuns().map((r) => key(r.project, r.ticketId)));
      await Promise.all(
        projects.map((p) =>
          attempt(`releasing orphan claims in ${p.name}`, async () => {
            for (const id of await beads.listClaimed(p)) {
              if (live.has(key(p.name, id))) continue;
              // A kill whose release failed still means skip: a plain release would make the Ticket Ready and re-run it.
              const killed = store.lastRunState(p.name, id) === 'killed';
              await attempt(`releasing orphan claim ${key(p.name, id)}`, () =>
                killed ? beads.kill(p, id, 'Killed from the dashboard; released after a ysz restart.') : beads.release(p, id),
              );
            }
          }),
        ),
      );

      // A clone outlives its use when its removal failed or a restart cut it short. A failed or killed Run's serves the
      // human's inspection only until a later Run of its Ticket reaches In review (pr-closed and merged ones did) or lands.
      const runs = store.allRuns();
      /** Each Ticket's newest Run that got through, by id. */
      const gotThrough = new Map(runs.filter((r) => ['in-review', 'merged', 'pr-closed', 'landed'].includes(r.state)).map((r) => [key(r.project, r.ticketId), r.id]));
      for (const run of store.cloned()) {
        if (inspected(run.state) && !((gotThrough.get(key(run.project, run.ticketId)) ?? 0) > run.id)) continue;
        await attempt(`removing the clone of Run ${run.id}`, () => removeCloneOf(run));
      }
      // A dir no Run points to, like an Attempt 1 clone whose removal failed, serves no one. Only Runs write there, and none
      // has started yet. A clone just removed is still in `runs`, but gone from the disk.
      const referenced = new Set(runs.map((r) => r.cloneDir));
      await attempt('listing the clones', async () => {
        for (const dir of await host.listClones()) if (!referenced.has(dir)) await attempt(`removing ${dir}`, () => host.removeClone({ dir }));
      });
      measure(store.cloned().filter((r) => r.cloneBytes === null));
      return problems;
    },

    async retryHostStep(runId) {
      const run = store.getRun(runId);
      const control = controls.get(runId);
      const job = control?.parked;
      if (run?.state !== 'needs-attention' || !control || !job || killing.has(runId)) throw new Error(`Run ${runId} has no host step to retry here`);
      const busy = store.slotProjects();
      if (busy.length >= SLOTS_TOTAL || busy.includes(run.project)) throw new Error('No free slot for this Project yet; retry when a Run finishes');
      control.parked = undefined;
      track(control, finish(runId, control, job)); // takes the slot synchronously
    },

    async requeue(runId) {
      const run = store.getRun(runId);
      if (run?.state !== 'failed' || store.lastRunState(run.project, run.ticketId) !== 'failed') throw new Error(`Run ${runId} has no failure to retry`);
      await beads.requeue(byName.get(run.project)!, run.ticketId);
      failed.delete(key(run.project, run.ticketId));
    },

    async cleanUp(runId) {
      const run = store.getRun(runId);
      if (!run?.cloneDir) throw new Error(`Run ${runId} has no clone to clean up`);
      if (store.liveRuns().some((r) => r.id === runId)) throw new Error(`Run ${runId} is still live, and its clone in use`);
      await removeCloneOf(run);
    },

    async deleteRun(runId) {
      const run = store.getRun(runId);
      if (run?.state !== 'failed' && run?.state !== 'interrupted' && run?.state !== 'killed') throw new Error(`Run ${runId} is not failed or killed`);
      // recover() keeps a claimed Ticket skipped only while its newest Run says killed.
      const project = byName.get(run.project);
      if (run.state === 'killed' && project && store.lastRunState(run.project, run.ticketId) === 'killed' && (await beads.listClaimed(project)).includes(run.ticketId)) {
        throw new Error(`${run.ticketId} is still claimed; release it in bd first`);
      }
      if (run.cloneDir) await host.removeClone({ dir: run.cloneDir });
      await removeLog(runId);
      store.deleteRun(runId);
    },

    setArchived(runId, archived) {
      const run = store.getRun(runId);
      if (run?.state !== 'merged' && run?.state !== 'pr-closed' && run?.state !== 'broken-down' && run?.state !== 'landed') throw new Error(`Run ${runId} is not merged, PR closed, broken down or landed`);
      store.updateRun(runId, { archivedAt: archived ? clock.now() : null });
    },

    async watchReviews() {
      const problems: string[] = [];
      for (const run of store.inReview()) {
        const project = byName.get(run.project);
        if (!run.prUrl) continue; // an in-review Run always has its PR
        if (!project) {
          problems.push(`checking ${run.prUrl}: ${run.project} is not a registered Project`);
          continue;
        }
        try {
          const { state, closedAt } = await host.prState(project, run.prUrl);
          if (state !== 'MERGED' && state !== 'CLOSED') continue;
          const merged = state === 'MERGED';
          // Bead first: if its write fails the Run stays in-review, so the next call tries again.
          const written = merged ? await beads.merged(project, run.ticketId, run.prUrl) : await beads.prClosed(project, run.ticketId, run.prUrl);
          store.updateRun(run.id, { state: merged ? 'merged' : 'pr-closed', prClosedAt: closedAt });
          logRun(run.id, `PR ${merged ? 'merged' : 'closed unmerged'}: ${run.prUrl}`);
          if (!written) logRun(run.id, 'Ticket left alone: changed by hand since the PR opened');
        } catch (err) {
          problems.push(`checking ${run.prUrl}: ${message(err)}`);
        }
      }
      return problems;
    },

    async poll() {
      const results = await Promise.allSettled(projects.map((p) => beads.listReady(p)));
      results.forEach((result, i) => {
        const snapshot = snapshots.get(projects[i].name)!;
        if (result.status === 'fulfilled') {
          const { tickets, backlog } = result.value;
          snapshot.tickets = tickets;
          // A Ticket that is no longer Ready (claimed elsewhere, closed) drops its run-now.
          for (const k of runNowKeys) if (k.startsWith(`${projects[i].name}/`) && !tickets.some((t) => key(projects[i].name, t.id) === k)) runNowKeys.delete(k);
          snapshot.error = null;
          store.recordBacklog(projects[i].name, clock.now(), { backlog, ready: tickets.length });
        } else {
          snapshot.error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        }
      });
    },

    stats() {
      // ponytail: every Run on each visit, ~0.4 kB each; filter by range here if the page grows slow.
      return { runs: store.allRuns().map(({ note: _note, cloneDir: _cloneDir, reports: _reports, ...r }) => r), backlog: store.backlogHistory() };
    },

    readyQueue,

    slots() {
      return { used: store.slotProjects().length, total: SLOTS_TOTAL };
    },

    projectStatuses() {
      const pausedNow = new Set(store.pausedProjects());
      return projects.map((p) => {
        const { tickets, error } = snapshots.get(p.name)!;
        return { name: p.name, ready: tickets.length, paused: pausedNow.has(p.name), error };
      });
    },
  };
}

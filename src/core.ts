import type { BeadsGateway, Ticket } from './beads';
import type { HostSteps, Prepared } from './host';
import type { Project } from './projects';
import type { AgentResult, SandboxRunner } from './sandbox';
import type { RunRow, Store } from './store';

/** Runs at once, across all Projects. Each Project also runs at most one. */
export const SLOTS_TOTAL = 2;

export type WaitReason = 'next up' | 'waiting for slot' | 'Project already has a Run' | 'not onboarded' | 'Project paused' | 'run-now · waiting for slot' | 'preflight failed' | 'image missing';

export interface QueueItem {
  project: string;
  id: string;
  title: string;
  priority: number;
  ageMs: number;
  waitReason: WaitReason;
  /** The user asked to run it ahead of the queue. */
  runNow: boolean;
}

export interface ProjectStatus {
  name: string;
  ready: number;
  /** Paused Projects start no new Runs (Run now excepted); live Runs finish normally. */
  paused: boolean;
  /** Why the last poll failed (e.g. bd timed out); the queue then shows the last known Tickets. */
  error: string | null;
}

export interface Orchestrator {
  /** Query every Project's Beads queue in parallel. One failing Project never blocks the others. */
  poll(): Promise<void>;
  /** Claim the Ready Tickets that fit the free slots and start a Run for each; resolves once they are started, not finished. */
  tick(): Promise<void>;
  /** Resolves when no Run is in flight. */
  whenIdle(): Promise<void>;
  /** Live Runs (those holding a slot, and needs-attention ones), and the history of ended ones (newest first). */
  runs(): { live: RunRow[]; history: RunRow[] };
  /** Ready Tickets of all Projects in pick order. */
  readyQueue(): QueueItem[];
  slots(): { used: number; total: number };
  projectStatuses(): ProjectStatus[];
  /**
   * Stop a live Run (claimed, agent, host or needs-attention): abort its agent and host processes, remove its sandbox
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
   * Orchestrator holds with no live Run and no in-review label. Never rejects: returns what it could not do.
   */
  recover(): Promise<string[]>;
  /** Resume a needs-attention Run from the host step that failed. Needs a free slot. Resolves once started, not finished. */
  retryHostStep(runId: number): Promise<void>;
  /** Remove the clone of a failed or killed Run. The history row stays. */
  cleanUp(runId: number): Promise<void>;
}

export interface Clock {
  now(): number;
}

/** How one Attempt ended. A failed Attempt keeps its clone so the caller can remove it or leave it for inspection. */
type Attempted =
  | { kind: 'done'; prepared: Prepared; tip?: string; reviewSkipped?: string }
  | { kind: 'failed'; prepared: Prepared; reason: string }
  | { kind: 'needs-info'; agent: 'implement' | 'review'; question: string };

/** What a Run needs to resume its host steps. */
interface HostJob {
  project: Project;
  ticket: { id: string; title: string };
  prepared: Prepared;
  tip?: string;
  reviewSkipped?: string;
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
}): Orchestrator {
  const { projects, beads, sandbox, host, store, clock } = deps;
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
  const gates = new Map<string, 'preflight failed' | 'image missing'>();

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** End a Run: record the outcome and drop its controls. */
  function end(runId: number, patch: Parameters<Store['updateRun']>[1]) {
    store.updateRun(runId, { ...patch, endedAt: clock.now() });
    controls.delete(runId);
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
   * The host steps after a successful Attempt: publish, mark the bead, end in-review. A failure never burns an Attempt:
   * the Run parks in needs-attention (freeing its slot) with the clone and the bead claim kept, for Retry or Kill.
   * A step that already succeeded is not repeated: once the PR exists, a retry only marks the bead. Never rejects.
   */
  async function finish(runId: number, control: Control, job: HostJob): Promise<void> {
    const { signal } = control.ctl;
    store.updateRun(runId, { state: 'host', note: null });
    // What recover() needs to pick the job up again; the PR url is already on the row.
    store.setHostJob(runId, JSON.stringify({ prepared: job.prepared, tip: job.tip, reviewSkipped: job.reviewSkipped }));
    try {
      if (!job.prUrl) {
        signal.throwIfAborted();
        job.prUrl = await host.publish(job.project, job.ticket, job.prepared, { tip: job.tip, reviewSkipped: job.reviewSkipped, signal });
        store.updateRun(runId, { prUrl: job.prUrl });
      }
      signal.throwIfAborted();
      await beads.markInReview(job.project, job.ticket.id, job.prUrl);
      signal.throwIfAborted();
      end(runId, { state: 'in-review' });
      // The PR is open and the bead is done, so a leftover clone is only clutter.
      await host.removeClone(job.prepared).then(() => store.updateRun(runId, { cloneDir: null }), () => {});
    } catch (err) {
      if (signal.aborted) return; // kill() settles the Run
      control.parked = job;
      store.updateRun(runId, { state: 'needs-attention', note: message(err) });
    }
  }

  /** Run one claimed Ticket to its end: in-review with a PR, parked in needs-attention, or failed and handed back. Never rejects. */
  async function execute(runId: number, project: Project, ticket: { id: string; title: string }, control: Control): Promise<void> {
    const { signal } = control.ctl;
    try {
      const context = await beads.showContext(project, ticket.id);

      /** One Attempt: implement, then review, each in a fresh sandbox on a fresh clone of the base branch. A kill throws out of it. */
      async function attempt(n: number, previousAttemptSummary?: string): Promise<Attempted> {
        signal.throwIfAborted();
        const prepared = await host.prepare(project, ticket.id, context, signal);
        store.updateRun(runId, { cloneDir: prepared.dir }); // even if killed meanwhile: Clean up must find the clone
        const req = { project, runId, attempt: n, signal, ...prepared };
        store.updateRun(runId, { state: 'agent', attempt: n });
        let implemented: AgentResult;
        try {
          implemented = await sandbox.implement({ ...req, previousAttemptSummary });
        } catch (err) {
          signal.throwIfAborted();
          return { kind: 'failed', prepared, reason: `the implement agent failed: ${message(err)}` };
        }
        signal.throwIfAborted();
        if (implemented.outcome === 'needs-info') return { kind: 'needs-info', agent: 'implement', question: implemented.question };
        if (implemented.outcome === 'stopped') {
          return { kind: 'failed', prepared, reason: `the implement agent stopped without signalling COMPLETE${implemented.tail && `: ${implemented.tail}`}` };
        }

        store.updateRun(runId, { state: 'host' });
        let collected: { tip: string; commits: number };
        try {
          collected = await host.collect(project, prepared, signal);
        } catch (err) {
          signal.throwIfAborted();
          return { kind: 'failed', prepared, reason: `the agent's commits could not be read back: ${message(err)}` };
        }
        signal.throwIfAborted();
        if (collected.commits === 0) return { kind: 'failed', prepared, reason: 'the agent made no commits' };

        store.updateRun(runId, { state: 'agent' });
        let skipped: string;
        try {
          const reviewed = await sandbox.review(req);
          signal.throwIfAborted();
          if (reviewed.outcome === 'needs-info') return { kind: 'needs-info', agent: 'review', question: reviewed.question };
          if (reviewed.outcome === 'complete') return { kind: 'done', prepared };
          skipped = 'the review agent stopped without signalling COMPLETE';
        } catch (err) {
          signal.throwIfAborted();
          skipped = `the review agent failed: ${message(err)}`;
        }
        // An unfinished review may have left half a change, so the PR opens from the implement commits.
        return { kind: 'done', prepared, tip: collected.tip, reviewSkipped: skipped.replace(/\s+/g, ' ').slice(0, 300) };
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
        try {
          await beads.fail(project, ticket.id, note);
        } catch (err) {
          throw new Error(`${note}\nhanding the Ticket back failed: ${message(err)}`); // the catch below releases the claim
        }
        end(runId, { state: 'failed', note });
        return;
      }

      const { prepared, tip, reviewSkipped } = result;
      await finish(runId, control, { project, ticket, prepared, tip, reviewSkipped, prUrl: null });
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
            const down = !(await sandbox.hasImage(p))
              ? 'image missing'
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
        const runId = store.insertRun({ project: next.project, ticketId: next.id, title: next.title, state: 'claimed', startedAt: clock.now() });
        const control: Control = { ctl: new AbortController() };
        controls.set(runId, control);
        track(control, execute(runId, project, next, control));
      }
    },

    async whenIdle() {
      while (inFlight.size) await Promise.all(inFlight);
    },

    runs() {
      return { live: store.liveRuns(), history: store.history(50) };
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
        if (run.state === 'agent' && run.cloneDir) await sandbox.stop({ dir: run.cloneDir });
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
          const job: HostJob = { project, ticket: { id: run.ticketId, title: run.title }, ...JSON.parse(saved), prUrl: run.prUrl };
          controls.set(run.id, control);
          if (run.state === 'needs-attention') control.parked = job;
          else track(control, finish(run.id, control, job));
          continue;
        }
        // An agent was cut off (or the Run had not got that far). Its work is gone, and no Attempt is spent.
        await attempt(`Run ${run.id}`, async () => {
          let note = `Interrupted by an Orchestrator restart while ${run.state}; not counted as an Attempt.`;
          await beads.interrupt(project, run.ticketId, note).catch((err) => void (note += `; releasing the Ticket failed: ${message(err)}`));
          if (run.cloneDir) await host.removeClone({ dir: run.cloneDir }).then(() => store.updateRun(run.id, { cloneDir: null }), () => {});
          end(run.id, { state: 'interrupted', note });
        });
      }

      const live = new Set(store.liveRuns().map((r) => key(r.project, r.ticketId)));
      await Promise.all(
        projects.map((p) =>
          attempt(`releasing orphan claims in ${p.name}`, async () => {
            for (const id of await beads.listClaimed(p)) if (!live.has(key(p.name, id))) await beads.release(p, id);
          }),
        ),
      );
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

    async cleanUp(runId) {
      const run = store.getRun(runId);
      if ((run?.state !== 'failed' && run?.state !== 'killed') || !run.cloneDir) throw new Error(`Run ${runId} has no clone to clean up`);
      await host.removeClone({ dir: run.cloneDir });
      store.updateRun(runId, { cloneDir: null });
    },

    async poll() {
      const results = await Promise.allSettled(projects.map((p) => beads.listReady(p)));
      results.forEach((result, i) => {
        const snapshot = snapshots.get(projects[i].name)!;
        if (result.status === 'fulfilled') {
          snapshot.tickets = result.value;
          // A Ticket that is no longer Ready (claimed elsewhere, closed) drops its run-now.
          for (const k of runNowKeys) if (k.startsWith(`${projects[i].name}/`) && !result.value.some((t) => key(projects[i].name, t.id) === k)) runNowKeys.delete(k);
          snapshot.error = null;
        } else {
          snapshot.error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        }
      });
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

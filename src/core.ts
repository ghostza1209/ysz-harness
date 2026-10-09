import type { BeadsGateway, Ticket } from './beads';
import type { HostSteps } from './host';
import type { Project } from './projects';
import type { SandboxRunner } from './sandbox';
import type { RunRow, Store } from './store';

/** Runs at once, across all Projects. Each Project also runs at most one. */
export const SLOTS_TOTAL = 2;

export type WaitReason = 'next up' | 'waiting for slot' | 'Project already has a Run' | 'not onboarded';

export interface QueueItem {
  project: string;
  id: string;
  title: string;
  priority: number;
  ageMs: number;
  waitReason: WaitReason;
}

export interface ProjectStatus {
  name: string;
  ready: number;
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
  /** Live Runs, and the history of ended ones (newest first). */
  runs(): { live: RunRow[]; history: RunRow[] };
  /** Ready Tickets of all Projects in pick order. */
  readyQueue(): QueueItem[];
  slots(): { used: number; total: number };
  projectStatuses(): ProjectStatus[];
}

export interface Clock {
  now(): number;
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
  /** Tickets whose Run failed since startup, so a failing Ticket is not retried every tick. Failure handling will replace this. */
  const failed = new Set<string>();
  const key = (project: string, id: string) => `${project}/${id}`;

  const byName = new Map(projects.map((p) => [p.name, p]));

  /** Run one claimed Ticket to its end: in-review with a PR, or failed and released. Never rejects. */
  async function execute(runId: number, project: Project, ticket: { id: string; title: string }): Promise<void> {
    const end = (patch: Parameters<Store['updateRun']>[1]) => store.updateRun(runId, { ...patch, endedAt: clock.now() });
    let prUrl: string | null = null;
    try {
      const context = await beads.showContext(project, ticket.id);
      const { branch } = await host.prepare(project, ticket.id, context);
      store.updateRun(runId, { state: 'agent', attempt: 1 });
      const result = await sandbox.implement({ project, runId, branch });
      if (!result.completed) throw new Error('the agent stopped without signalling COMPLETE');
      if (result.commits === 0) throw new Error('the agent made no commits');
      store.updateRun(runId, { state: 'host' });
      const url = await host.publish(project, ticket, branch);
      prUrl = url;
      store.updateRun(runId, { prUrl: url });
      await beads.markInReview(project, ticket.id, url);
      end({ state: 'in-review' });
      // The PR is open and the bead is done, so a leftover worktree is only clutter.
      await host.removeWorktree(project, branch).catch(() => {});
    } catch (err) {
      failed.add(key(project.name, ticket.id));
      let note = err instanceof Error ? err.message : String(err);
      if (prUrl) note += ` (PR ${prUrl} was opened)`;
      try {
        await beads.release(project, ticket.id);
      } catch (releaseErr) {
        note += `; releasing the Ticket failed: ${releaseErr instanceof Error ? releaseErr.message : releaseErr}`;
      }
      end({ state: 'failed', note });
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
    return entries.sort((a, b) => a.ticket.priority - b.ticket.priority || a.rank - b.rank || a.projectIndex - b.projectIndex);
  }

  function readyQueue(): QueueItem[] {
    const now = clock.now();
    const live = store.slotProjects();
    const busy = new Set(live);
    let free = SLOTS_TOTAL - live.length;
    // Walk in pick order, handing out the free slots as the next ticks would.
    return pickOrder().map(({ project, ticket }) => {
      let waitReason: WaitReason;
      if (!byName.get(project)!.image) waitReason = 'not onboarded';
      else if (busy.has(project)) waitReason = 'Project already has a Run';
      else if (free > 0) {
        waitReason = 'next up';
        free--;
        busy.add(project);
      } else waitReason = 'waiting for slot';
      return {
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
        if (!won) continue;
        const runId = store.insertRun({ project: next.project, ticketId: next.id, title: next.title, state: 'claimed', startedAt: clock.now() });
        const running = execute(runId, project, next).finally(() => inFlight.delete(running));
        inFlight.add(running);
      }
    },

    async whenIdle() {
      while (inFlight.size) await Promise.all(inFlight);
    },

    runs() {
      return { live: store.liveRuns(), history: store.history(50) };
    },

    async poll() {
      const results = await Promise.allSettled(projects.map((p) => beads.listReady(p)));
      results.forEach((result, i) => {
        const snapshot = snapshots.get(projects[i].name)!;
        if (result.status === 'fulfilled') {
          snapshot.tickets = result.value;
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
      return projects.map((p) => {
        const { tickets, error } = snapshots.get(p.name)!;
        return { name: p.name, ready: tickets.length, error };
      });
    },
  };
}

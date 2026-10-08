import type { BeadsGateway, Ticket } from './beads';
import type { Project } from './projects';
import type { Store } from './store';

/** Runs at once, across all Projects. Each Project also runs at most one. */
export const SLOTS_TOTAL = 2;

export type WaitReason = 'next up' | 'waiting for slot' | 'Project already has a Run';

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
  store: Store;
  clock: Clock;
}): Orchestrator {
  const { projects, beads, store, clock } = deps;
  const snapshots = new Map(projects.map((p) => [p.name, { tickets: [] as Ticket[], error: null as string | null }]));

  /** Priority ascending across Projects; on ties round-robin over Projects, oldest first within each. */
  function pickOrder() {
    const entries: { project: string; ticket: Ticket; projectIndex: number; rank: number }[] = [];
    projects.forEach((p, projectIndex) => {
      const oldestFirst = [...snapshots.get(p.name)!.tickets].sort(
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

  return {
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

    readyQueue() {
      const now = clock.now();
      const live = store.slotProjects();
      const busy = new Set(live);
      let free = SLOTS_TOTAL - live.length;
      // Walk in pick order, handing out the free slots as the next ticks would.
      return pickOrder().map(({ project, ticket }) => {
        let waitReason: WaitReason;
        if (busy.has(project)) waitReason = 'Project already has a Run';
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
    },

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

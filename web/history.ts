import type { RunRow } from '../src/store';

export type GroupBy = 'none' | 'epic' | 'day';

/** History rows under one heading; `key` is null for rows shown ungrouped. */
export interface Group {
  key: string | null;
  runs: RunRow[];
}

/** The epic a Ticket sits under: its id without the last `.n`. A Ticket without one is its own epic. */
export const epicOf = (ticketId: string) => ticketId.replace(/\.[^.]+$/, '');

/** Splits the History by epic (a lone Run stays ungrouped) or by the local day it ended, keeping its order. */
export function groupRuns(runs: RunRow[], by: GroupBy): Group[] {
  if (by === 'none') return [{ key: null, runs }];
  const groups = new Map<string, RunRow[]>();
  for (const r of runs) {
    const key = by === 'epic' ? `${r.project}/${epicOf(r.ticketId)}` : new Date(r.endedAt ?? r.startedAt).toDateString();
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  return [...groups].map(([key, runs]) => ({ key: by === 'epic' && runs.length === 1 ? null : key, runs }));
}

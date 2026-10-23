import type { StatsRun } from '../src/core';
import type { BacklogPoint, Footprint, RunState } from '../src/store';

export type Range = '7' | '30' | 'all';
/** Where a Run is now, as the Stats page groups it; bottom of a stack first. */
export const OUTCOMES = ['merged', 'in-review', 'pr-closed', 'broken-down', 'failed', 'killed', 'running'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Interrupted counts as failed, as in the History filter, and every live state as running. */
export function outcomeOf(state: RunState): Outcome {
  if (state === 'interrupted') return 'failed';
  return (OUTCOMES as readonly string[]).includes(state) ? (state as Outcome) : 'running';
}

/** Local midnight of the day `ms` falls on. */
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** Each local day from the range's first to today: the last 7 or 30, or every one from `earliest`'s. */
export function daysOf(range: Range, now: number, earliest: number): number[] {
  const today = new Date(startOfDay(now));
  const first = range === 'all' ? new Date(startOfDay(Math.min(earliest, now))) : new Date(today.getFullYear(), today.getMonth(), today.getDate() - Number(range) + 1);
  const days: number[] = [];
  for (const d = first; d <= today; d.setDate(d.getDate() + 1)) days.push(d.getTime());
  return days;
}

/** The Runs started on each of `days`, counted by outcome. */
export function runsPerDay(runs: StatsRun[], days: number[]) {
  const rows = new Map(days.map((day) => [day, { day, ...(Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>) }]));
  for (const r of runs) {
    const row = rows.get(startOfDay(r.startedAt));
    if (row) row[outcomeOf(r.state)]++;
  }
  return [...rows.values()];
}

/** Merge rate: Merged out of the Runs left to finish (Merged, PR closed or failed). */
export function mergeRate(runs: StatsRun[]) {
  const outcomes = runs.map((r) => outcomeOf(r.state));
  return { merged: outcomes.filter((o) => o === 'merged').length, of: outcomes.filter((o) => o === 'merged' || o === 'pr-closed' || o === 'failed').length };
}

/** First-Attempt passes out of the Runs that got a PR. */
export function firstAttemptPass(runs: StatsRun[]) {
  const withPr = runs.filter((r) => r.state === 'in-review' || r.state === 'merged' || r.state === 'pr-closed');
  return { passed: withPr.filter((r) => r.attempt === 1).length, of: withPr.length };
}

/** Tokens of the Runs started on each of `days`, by agent over every Attempt; null for a day none of whose Runs recorded usage. */
export function tokensPerDay(runs: StatsRun[], days: number[]) {
  const rows = new Map(days.map((day) => [day, { day, implement: null as number | null, review: null as number | null }]));
  for (const r of runs) {
    const row = rows.get(startOfDay(r.startedAt));
    if (!row || !Object.keys(r.usage).length) continue;
    row.implement ??= 0;
    row.review ??= 0;
    for (const [part, u] of Object.entries(r.usage)) row[part.endsWith('-review') ? 'review' : 'implement']! += u.tokens;
  }
  return [...rows.values()];
}

export const FOOTPRINT_ROLES = ['implement', 'review', 'install', 'checks', 'breakdown'] as const;
export const FOOTPRINT_FIGURES = ['seconds', 'peakMemory', 'cpuAvg', 'cpuPeak', 'disk', 'networkIn'] as const;
export type FootprintFigure = (typeof FOOTPRINT_FIGURES)[number];

/** `attempt2-implement-checks` is the role checks; `attempt1-review-checks` too. */
const roleOf = (part: string) => {
  const role = part.replace(/^attempt\d+-/, '');
  return role.endsWith('-checks') ? 'checks' : role;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2;
};

/**
 * Median and max of each Footprint figure, per Project (by name) and then role, over every part entry (one per Run x
 * Attempt x part). A Project or role with no entry is left out.
 */
export function footprintByRole(runs: StatsRun[]) {
  const parts = new Map<string, Map<string, Footprint[]>>();
  for (const r of runs) {
    for (const [part, fp] of Object.entries(r.footprint)) {
      const roles = parts.get(r.project) ?? parts.set(r.project, new Map()).get(r.project)!;
      const role = roleOf(part);
      (roles.get(role) ?? roles.set(role, []).get(role)!).push(fp);
    }
  }
  const figures = <T,>(fps: Footprint[], f: (xs: number[]) => T) => Object.fromEntries(FOOTPRINT_FIGURES.map((k) => [k, f(fps.map((fp) => fp[k]))])) as Record<FootprintFigure, T>;
  return [...parts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, roles]) => ({
      project,
      roles: FOOTPRINT_ROLES.filter((role) => roles.has(role)).map((role) => {
        const fps = roles.get(role)!;
        return { role, parts: fps.length, median: figures(fps, median), max: figures(fps, (xs) => Math.max(...xs)) };
      }),
    }))
    .filter((p) => p.roles.length);
}

/** How long each ended Run's agents took: from its start to In review, or to its end. */
export const agentTimes = (runs: StatsRun[]) =>
  runs.flatMap((r) => (r.endedAt === null ? [] : [{ id: r.id, ticketId: r.ticketId, at: r.startedAt, minutes: (r.endedAt - r.startedAt) / 60_000, outcome: outcomeOf(r.state) }]));

/** Each Review wait recorded: from reaching In review until the PR merged or closed. */
export const reviewWaits = (runs: StatsRun[]) =>
  runs.flatMap((r) =>
    r.endedAt === null || r.prClosedAt === null ? [] : [{ id: r.id, ticketId: r.ticketId, at: r.endedAt, hours: (r.prClosedAt - r.endedAt) / 3_600_000, outcome: outcomeOf(r.state) }],
  );

/** The Runs In review now and how long each has waited, longest first. */
export const waitingNow = (runs: StatsRun[], now: number) =>
  runs.flatMap((r) => (r.state === 'in-review' && r.endedAt !== null ? [{ run: r, ms: now - r.endedAt }] : [])).sort((a, b) => b.ms - a.ms);

/**
 * The Backlog and Ready counts of `project` (every Project when '') at each change, summed over Projects: a step from
 * `from`, starting at the counts in force then, to `now`. Expects `points` oldest first.
 */
export function backlogOverTime(points: BacklogPoint[], project: string, from: number, now: number) {
  const last = new Map<string, BacklogPoint>();
  const steps: { at: number; backlog: number; ready: number }[] = [];
  for (const p of points) {
    if (project && p.project !== project) continue;
    last.set(p.project, p);
    const at = Math.max(p.at, from);
    // One step per instant: a poll records every Project at once, and the range start gathers all before it.
    if (steps.at(-1)?.at === at) steps.pop();
    const counts = [...last.values()];
    steps.push({ at, backlog: counts.reduce((n, c) => n + c.backlog, 0), ready: counts.reduce((n, c) => n + c.ready, 0) });
  }
  return steps.length ? [...steps, { ...steps.at(-1)!, at: now }] : steps;
}

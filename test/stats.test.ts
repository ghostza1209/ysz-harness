import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { BacklogPoint, RunRow } from '../src/store';
import { agentTimes, backlogOverTime, daysOf, firstAttemptPass, footprintByRole, footprintCsv, mergeRate, outcomeOf, reviewWaits, runsPerDay, tokensPerDay, waitingNow } from '../web/stats';

const run = (over: Partial<RunRow>): RunRow => ({
  id: 1, project: 'a', ticketId: 't', title: 't', state: 'merged', attempt: 1, prUrl: null, prBase: null, note: null,
  startedAt: 0, endedAt: null, cloneDir: null, archivedAt: null, model: null, usage: {}, footprint: {}, prClosedAt: null, reports: null, ...over,
});
/** Local time on a day of October 2026. */
const oct = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

it('counts an interrupted Run as failed and every live state as running', () => {
  assert.deepEqual(
    (['interrupted', 'needs-attention', 'claimed', 'host', 'killed', 'in-review', 'broken-down'] as const).map(outcomeOf),
    ['failed', 'running', 'running', 'running', 'killed', 'in-review', 'broken-down'],
  );
});

it("lists each local day of the range up to today's, or from the earliest day for all", () => {
  const days = daysOf('7', oct(18, 15), oct(1));
  assert.deepEqual([days.length, days[0], days[6]], [7, oct(12), oct(18)]);
  assert.deepEqual(daysOf('all', oct(18, 15), oct(16, 10)), [oct(16), oct(17), oct(18)]);
});

it('counts the Runs started each day by where they are now, leaving out days outside the range', () => {
  const rows = runsPerDay(
    [
      run({ startedAt: oct(17, 9), state: 'merged' }),
      run({ startedAt: oct(17, 23, 59), state: 'interrupted' }),
      run({ startedAt: oct(18, 1), state: 'agent' }),
      run({ startedAt: oct(10, 1), state: 'merged' }),
    ],
    [oct(17), oct(18)],
  );
  assert.deepEqual(rows, [
    { day: oct(17), merged: 1, 'in-review': 0, 'pr-closed': 0, 'broken-down': 0, failed: 1, killed: 0, running: 0 },
    { day: oct(18), merged: 0, 'in-review': 0, 'pr-closed': 0, 'broken-down': 0, failed: 0, killed: 0, running: 1 },
  ]);
});

it('takes the Merge rate over Runs left to finish: killed, In review and broken-down ones are left out', () => {
  const states = ['merged', 'merged', 'pr-closed', 'failed', 'interrupted', 'killed', 'in-review', 'broken-down'] as const;
  assert.deepEqual(mergeRate(states.map((state) => run({ state }))), { merged: 2, of: 5 });
});

it('counts a First-Attempt pass among the Runs that got a PR', () => {
  const runs = [
    run({ state: 'in-review', attempt: 1 }),
    run({ state: 'merged', attempt: 2 }),
    run({ state: 'pr-closed', attempt: 1 }),
    run({ state: 'failed', attempt: 1 }),
  ];
  assert.deepEqual(firstAttemptPass(runs), { passed: 2, of: 3 });
});

it("sums each day's tokens by agent across Attempts, with no value for a day whose Runs predate usage", () => {
  const rows = tokensPerDay(
    [
      run({ startedAt: oct(17, 9), usage: { 'attempt1-implement': { context: 1, tokens: 100 }, 'attempt1-review': { context: 1, tokens: 20 }, 'attempt2-implement': { context: 1, tokens: 50 } } }),
      run({ startedAt: oct(17, 10) }),
      run({ startedAt: oct(18, 10) }),
    ],
    [oct(17), oct(18)],
  );
  assert.deepEqual(rows, [
    { day: oct(17), implement: 150, review: 20 },
    { day: oct(18), implement: null, review: null },
  ]);
});

it('gives the median and max of each Footprint figure per Project and role, folding both checks parts into checks and skipping Runs without one', () => {
  const fp = (n: number) => ({ startedAt: 0, seconds: n, peakMemory: n * 1000, cpuAvg: n / 10, cpuPeak: n / 5, disk: n * 1e6, networkIn: n });
  const rows = footprintByRole([
    run({ project: 'b', footprint: { 'attempt1-implement': fp(10), 'attempt1-review': fp(2), 'attempt1-install': fp(1) } }),
    run({ project: 'a', footprint: { 'attempt1-implement': fp(30), 'attempt2-implement': fp(10), 'attempt2-implement-checks': fp(4), 'attempt2-review-checks': fp(8) } }),
    run({ project: 'a', footprint: { 'attempt1-implement': fp(20), 'attempt1-breakdown': fp(6), 'attempt1-mystery': fp(99) } }),
    run({ project: 'a' }),
    run({ project: 'c', footprint: { 'attempt1-mystery': fp(99) } }),
  ]);
  assert.deepEqual(rows.map((r) => [r.project, r.roles.map((x) => [x.role, x.parts])]), [
    ['a', [['implement', 3], ['checks', 2], ['breakdown', 1]]],
    ['b', [['implement', 1], ['review', 1], ['install', 1]]],
  ]);
  const [implement, checks] = rows[0].roles;
  assert.deepEqual(implement.median, { seconds: 20, peakMemory: 20_000, cpuAvg: 2, cpuPeak: 4, disk: 20e6, networkIn: 20 });
  assert.deepEqual(implement.max, { seconds: 30, peakMemory: 30_000, cpuAvg: 3, cpuPeak: 6, disk: 30e6, networkIn: 30 });
  assert.deepEqual([checks.median.seconds, checks.max.seconds], [6, 8]);
});

it('writes one CSV row per Run x Footprint part with raw numbers and the same part\'s tokens, and none for a Run without a Footprint', () => {
  const fp = (startedAt: number, n: number) => ({ startedAt, seconds: n, peakMemory: n * 1000, cpuAvg: n / 4, cpuPeak: n / 2, disk: n * 1e6, networkIn: n * 10 });
  const csv = footprintCsv([
    run({
      id: 7, project: 'a "b", c', ticketId: 'x-1', state: 'in-review',
      footprint: { 'attempt1-implement': fp(Date.UTC(2026, 9, 18, 9), 8), 'attempt1-install': fp(Date.UTC(2026, 9, 18, 9, 1), 2), 'attempt1-implement-checks': fp(Date.UTC(2026, 9, 18, 9, 30), 4) },
      usage: { 'attempt1-implement': { context: 5, tokens: 1234 }, 'attempt1-review': { context: 1, tokens: 99 } },
    }),
    run({ id: 8, usage: { 'attempt1-implement': { context: 5, tokens: 500 } } }),
  ]);
  assert.equal(
    csv,
    [
      'run,project,ticket,state,part,started,seconds,peak_memory_bytes,cpu_avg_cores,cpu_peak_cores,disk_bytes,network_in_bytes,tokens',
      '7,"a ""b"", c",x-1,in-review,attempt1-implement,2026-10-18T09:00:00.000Z,8,8000,2,4,8000000,80,1234',
      '7,"a ""b"", c",x-1,in-review,attempt1-install,2026-10-18T09:01:00.000Z,2,2000,0.5,1,2000000,20,',
      '7,"a ""b"", c",x-1,in-review,attempt1-implement-checks,2026-10-18T09:30:00.000Z,4,4000,1,2,4000000,40,',
      '',
    ].join('\r\n'),
  );
});

it("gives each ended Run's agent time in minutes, and none for a live Run", () => {
  const times = agentTimes([
    run({ id: 4, ticketId: 'x', state: 'in-review', startedAt: oct(17, 9), endedAt: oct(17, 9, 30) }),
    run({ id: 5, state: 'agent', startedAt: oct(17, 9) }),
  ]);
  assert.deepEqual(times, [{ id: 4, ticketId: 'x', at: oct(17, 9), minutes: 30, outcome: 'in-review' }]);
});

it('gives the Review wait in hours of each Run whose PR merged or closed since it was recorded', () => {
  const waits = reviewWaits([
    run({ id: 1, ticketId: 'm', state: 'merged', endedAt: oct(17, 9), prClosedAt: oct(17, 11) }),
    run({ id: 2, ticketId: 'c', state: 'pr-closed', endedAt: oct(17, 9), prClosedAt: oct(18, 9) }),
    run({ id: 3, state: 'merged', endedAt: oct(17, 9) }),
    run({ id: 4, state: 'in-review', endedAt: oct(17, 9) }),
  ]);
  assert.deepEqual(waits, [
    { id: 1, ticketId: 'm', at: oct(17, 9), hours: 2, outcome: 'merged' },
    { id: 2, ticketId: 'c', at: oct(17, 9), hours: 24, outcome: 'pr-closed' },
  ]);
});

it('lists the Runs In review now, longest waiting first', () => {
  const waiting = waitingNow(
    [
      run({ id: 1, state: 'in-review', endedAt: oct(18, 9) }),
      run({ id: 2, state: 'merged', endedAt: oct(16, 9) }),
      run({ id: 3, state: 'in-review', endedAt: oct(17, 9) }),
    ],
    oct(18, 12),
  );
  assert.deepEqual(waiting.map((w) => [w.run.id, w.ms]), [[3, 27 * 3_600_000], [1, 3 * 3_600_000]]);
});

it("sums the selected Projects' Backlog and Ready counts in force at each change, from the range start to now", () => {
  const points: BacklogPoint[] = [
    { project: 'a', at: 1, backlog: 5, ready: 2 },
    { project: 'b', at: 1, backlog: 3, ready: 1 },
    { project: 'a', at: 2, backlog: 4, ready: 2 },
    { project: 'a', at: 5, backlog: 6, ready: 2 },
    { project: 'b', at: 7, backlog: 2, ready: 0 },
  ];
  assert.deepEqual(backlogOverTime(points, '', 3, 10), [
    { at: 3, backlog: 7, ready: 3 },
    { at: 5, backlog: 9, ready: 3 },
    { at: 7, backlog: 8, ready: 2 },
    { at: 10, backlog: 8, ready: 2 },
  ]);
  assert.deepEqual(backlogOverTime(points, 'b', 0, 10), [
    { at: 1, backlog: 3, ready: 1 },
    { at: 7, backlog: 2, ready: 0 },
    { at: 10, backlog: 2, ready: 0 },
  ]);
  assert.deepEqual(backlogOverTime(points, 'c', 0, 10), []);
});

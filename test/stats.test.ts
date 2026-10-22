import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { BacklogPoint, RunRow } from '../src/store';
import { agentTimes, backlogOverTime, daysOf, firstAttemptPass, mergeRate, outcomeOf, reviewWaits, runsPerDay, tokensPerDay, waitingNow } from '../web/stats';

const run = (over: Partial<RunRow>): RunRow => ({
  id: 1, project: 'a', ticketId: 't', title: 't', state: 'merged', attempt: 1, prUrl: null, prBase: null, note: null,
  startedAt: 0, endedAt: null, cloneDir: null, archivedAt: null, model: null, usage: {}, prClosedAt: null, reports: null, ...over,
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
    { day: oct(17), merged: 1, 'in-review': 0, 'pr-closed': 0, 'broken-down': 0, landed: 0, failed: 1, killed: 0, running: 0 },
    { day: oct(18), merged: 0, 'in-review': 0, 'pr-closed': 0, 'broken-down': 0, landed: 0, failed: 0, killed: 0, running: 1 },
  ]);
});

it('takes the Merge rate over Runs left to finish: killed, In review, broken-down and landed ones are left out', () => {
  const states = ['merged', 'merged', 'pr-closed', 'failed', 'interrupted', 'killed', 'in-review', 'broken-down', 'landed'] as const;
  assert.deepEqual(mergeRate(states.map((state) => run({ state }))), { merged: 2, of: 5 });
});

it('counts a First-Attempt pass among the Runs that got a PR', () => {
  const runs = [
    run({ state: 'in-review', attempt: 1 }),
    run({ state: 'merged', attempt: 2 }),
    run({ state: 'pr-closed', attempt: 1 }),
    run({ state: 'failed', attempt: 1 }),
    run({ state: 'merged', attempt: 0 }), // an epic's own PR Run: no Attempt to pass
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

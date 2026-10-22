import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RunRow } from '../src/store';
import { groupRuns } from '../web/history';

const run = (id: number, project: string, ticketId: string, endedAt: number | null, startedAt = 0) =>
  ({ id, project, ticketId, endedAt, startedAt }) as RunRow;
const ids = (groups: ReturnType<typeof groupRuns>) => groups.map((g) => [g.key, g.runs.map((r) => r.id)]);

it('groups Tickets under their epic per Project, leaving a lone Run ungrouped', () => {
  const runs = [
    run(6, 'PopDeal', 'PopDeal-41f.17', 1),
    run(5, 'PopDeal', 'PopDeal-9zz', 1),
    run(4, 'PopDeal', 'PopDeal-41f.16', 1),
    run(3, 'PopDeal', 'PopDeal-41f.3.2', 1),
    run(2, 'thaivis', 'PopDeal-41f.1', 1),
    run(1, 'PopDeal', 'PopDeal-41f.3.1', 1),
  ];
  assert.deepEqual(ids(groupRuns(runs, 'epic')), [
    ['PopDeal/PopDeal-41f', [4, 6]],
    [null, [5]],
    ['PopDeal/PopDeal-41f.3', [1, 3]],
    [null, [2]],
  ]);
});

it("lists an epic's Runs as the Spec, then its Tickets by number, each Ticket's retries newest first", () => {
  const runs = [
    run(6, 'fazwaz', 'laravel-qfx.10', 1),
    run(5, 'fazwaz', 'laravel-qfx.2', 1),
    run(4, 'fazwaz', 'laravel-qfx', 1),
    run(3, 'fazwaz', 'laravel-qfx.2', 1),
    run(2, 'fazwaz', 'laravel-qfx.1', 1),
    run(1, 'fazwaz', 'laravel-qfx', 1),
  ];
  assert.deepEqual(ids(groupRuns(runs, 'epic')), [['fazwaz/laravel-qfx', [4, 1, 2, 5, 3, 6]]]);
});

it('groups by the local day a Run ended, or started while it has not', () => {
  const runs = [
    run(4, 'p', 'a', new Date(2026, 9, 17, 0, 5).getTime()),
    run(3, 'p', 'b', null, new Date(2026, 9, 17, 9, 0).getTime()),
    run(2, 'p', 'c', new Date(2026, 9, 16, 23, 55).getTime()),
    run(1, 'p', 'd', new Date(2026, 9, 14, 12, 0).getTime()),
  ];
  assert.deepEqual(ids(groupRuns(runs, 'day')), [
    ['Sat Oct 17 2026', [4, 3]],
    ['Fri Oct 16 2026', [2]],
    ['Wed Oct 14 2026', [1]],
  ]);
});

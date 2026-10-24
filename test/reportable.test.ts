import assert from 'node:assert/strict';
import { it } from 'node:test';
import { reportable } from '../src/reportable';

it('failed, killed, interrupted and needs-attention are reportable', () => {
  for (const state of ['failed', 'killed', 'interrupted', 'needs-attention'] as const) assert.deepEqual(reportable(state), { ok: true }, state);
});

it('a slot-holding Run refuses as live', () => {
  for (const state of ['claimed', 'agent', 'agent-review', 'host'] as const) assert.deepEqual(reportable(state), { ok: false, kind: 'live' }, state);
});

it('a Run that reached its goal refuses as goal', () => {
  for (const state of ['merged', 'in-review', 'landed', 'pr-closed', 'broken-down'] as const) assert.deepEqual(reportable(state), { ok: false, kind: 'goal' }, state);
});

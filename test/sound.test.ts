import assert from 'node:assert/strict';
import { it } from 'node:test';
import { stageCue } from '../web/sound';
import type { RunRow, RunState } from '../src/store';

const run = (id: number, state: RunState) => ({ id, state }) as RunRow;

it('stays quiet when no Run changed state', () => {
  assert.equal(stageCue(new Map([[1, 'agent']]), [run(1, 'agent')]), null);
});

it('steps for a new Run or a move between working states', () => {
  assert.equal(stageCue(new Map(), [run(1, 'claimed')]), 'step');
  assert.equal(stageCue(new Map([[1, 'agent']]), [run(1, 'agent-review')]), 'step');
});

it('sounds good on reaching review, and bad news beats good news in the same poll', () => {
  assert.equal(stageCue(new Map([[1, 'host']]), [run(1, 'in-review')]), 'good');
  assert.equal(stageCue(new Map([[1, 'host'], [2, 'agent']]), [run(1, 'in-review'), run(2, 'failed')]), 'bad');
});

it('stays quiet for an older Run coming back into the list, as after an archive or delete', () => {
  assert.equal(stageCue(new Map([[5, 'merged']]), [run(5, 'merged'), run(2, 'failed')]), null);
  assert.equal(stageCue(new Map([[5, 'merged']]), [run(6, 'claimed'), run(5, 'merged')]), 'step');
});

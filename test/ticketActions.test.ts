import assert from 'node:assert/strict';
import { it } from 'node:test';
import { allowedActions, type TicketFacts } from '../src/ticketActions';

const task = (patch: Partial<TicketFacts> = {}): TicketFacts => ({ id: 't-1', issue_type: 'task', status: 'open', assignee: null, labels: [], ...patch });

it('offers Mark Ready and Skip ysz on a plain open Ticket', () => {
  assert.deepEqual(allowedActions(task()), ['mark-ready', 'skip']);
});

it('offers Unmark Ready and Allow ysz on a Ready, skipped Ticket', () => {
  assert.deepEqual(allowedActions(task({ labels: ['ready-for-agent', 'orchestrator:skip'] })), ['unmark-ready', 'allow']);
});

it('still offers Mark Ready on a Ticket a human is assigned, one labelled needs-info, and one a human has in progress', () => {
  assert.deepEqual(allowedActions(task({ assignee: 'somebody' })), ['mark-ready', 'skip']);
  assert.deepEqual(allowedActions(task({ labels: ['needs-info'] })), ['mark-ready', 'skip']);
  assert.deepEqual(allowedActions(task({ status: 'in_progress', assignee: 'somebody' })), ['mark-ready', 'skip']);
});

it('offers nothing on an epic, a closed Ticket, or one ysz holds, in-review included', () => {
  assert.deepEqual(allowedActions(task({ issue_type: 'epic' })), []);
  assert.deepEqual(allowedActions(task({ status: 'closed' })), []);
  assert.deepEqual(allowedActions(task({ status: 'in_progress', assignee: 'orchestrator' })), []);
  assert.deepEqual(allowedActions(task({ status: 'in_progress', assignee: 'orchestrator', labels: ['in-review'] })), []);
});

it('reads a bead whose labels or assignee bd left out', () => {
  assert.deepEqual(allowedActions({ id: 't-2', issue_type: 'task', status: 'open' }), ['mark-ready', 'skip']);
});

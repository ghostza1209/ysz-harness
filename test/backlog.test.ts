import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { BacklogRow } from '../src/beads';
import type { QueueItem } from '../src/core';
import { ageText, build, buttons, stripAge, groupTickets, matches, parseSearch, relations, since, who, type BacklogData, type BacklogProject, type Ticket } from '../web/backlog';
import { en, th } from '../web/i18n';

const row = (id: string, over: Partial<BacklogRow> = {}): BacklogRow => ({
  id, title: `Title of ${id}`, status: 'open', issue_type: 'task', priority: 2, assignee: null, labels: [], parent: null, dependencies: [], comment_count: 0, created_at: '2026-10-01T00:00:00Z', ...over,
});
const blocks = (id: string) => ({ depends_on_id: id, type: 'blocks' });
const queued = (id: string, over: Partial<QueueItem> = {}): QueueItem => ({ project: 'a', id, title: id, priority: 2, ageMs: 0, waitReason: 'waiting for slot', runNow: false, ...over });
const project = (rows: BacklogRow[] | null, over: Partial<BacklogProject> = {}): BacklogProject => ({ name: 'a', rows, updatedAt: 1000, error: null, ...over });
const data = (rows: BacklogRow[], ready: QueueItem[] = []): BacklogData => ({ projects: [project(rows)], ready });
const noStages = new Map<string, string>();
const lines = (d: BacklogData, stages = noStages) => Object.fromEntries(build(d, stages, en).tickets.map((tk) => [tk.row.id, [tk.state, tk.line]]));

it('gives each Ticket the Backlog state and line it earns, first match winning', () => {
  const rows = [
    row('held', { status: 'in_progress', assignee: 'orchestrator' }),
    row('review', { status: 'in_progress', assignee: 'orchestrator', labels: ['in-review'] }),
    row('ready'),
    row('ready-now', { labels: ['ready-for-agent'] }),
    row('marked', { labels: ['ready-for-agent'] }),
    row('asks', { labels: ['needs-info'] }),
    row('plain'),
    row('mine', { status: 'in_progress', assignee: 'yoss' }),
    row('held-and-marked', { status: 'in_progress', assignee: 'orchestrator', labels: ['ready-for-agent', 'needs-info'] }),
  ];
  const ready = [queued('ready', { waitReason: 'next up' }), queued('ready-now', { runNow: true, waitReason: 'next up' }), queued('held-and-marked')];
  assert.deepEqual(lines(data(rows, ready), new Map([['a/held', 'Implement']])), {
    held: ['held', 'Run · Implement'],
    review: ['held', 'In review · waits for your merge'],
    ready: ['ready', '#1 in queue · next up'],
    'ready-now': ['ready', '⚡ Run now: next free slot'],
    marked: ['marked', 'Marked Ready, but ysz waits: not in the Ready queue yet'],
    asks: ['needs-info', 'Needs info · Mark Ready once answered'],
    plain: ['not-ready', 'Not Ready'],
    mine: ['not-ready', 'Not Ready · in progress, yoss'],
    'held-and-marked': ['held', 'Run'],
  });
});

it("shows a Ready Ticket's place in the whole queue and why it waits", () => {
  const d: BacklogData = {
    projects: [project([row('x1')], { name: 'a' }), project([row('y1'), row('y2', { priority: 0 })], { name: 'b' })],
    ready: [queued('x1', { waitReason: 'next up' }), queued('y2', { project: 'b', waitReason: 'Project already has a Run' }), queued('y1', { project: 'b', runNow: true, waitReason: 'run-now · waiting for slot' })],
  };
  assert.deepEqual(lines(d), {
    x1: ['ready', '#1 in queue · next up'],
    y1: ['ready', '#3 in queue · run-now · waiting for slot'],
    y2: ['ready', '#2 in queue · Project already has a Run'],
  });
});

it('lists every reason a Marked Ready Ticket waits, naming only blockers still in the Backlog', () => {
  const rows = [
    row('b1', { title: 'First blocker' }),
    row('b2', { title: 'Second blocker' }),
    row('kid', { parent: 'm' }),
    row('kid2', { parent: 'm' }),
    row('m', { labels: ['ready-for-agent', 'orchestrator:skip'], assignee: 'yoss', dependencies: [blocks('b1'), blocks('b2'), blocks('closed-one')] }),
  ];
  assert.equal(lines(data(rows))['m'][1], 'Marked Ready, but ysz waits: blocked by First blocker; blocked by Second blocker; assigned to yoss; skipped; 2 open children');
});

it('names the status of a Marked Ready Ticket nothing else holds back', () => {
  assert.equal(lines(data([row('d', { status: 'deferred', labels: ['ready-for-agent'] })]))['d'][1], 'Marked Ready, but ysz waits: deferred');
});

it('gives no reason for one In review blocker alone, but names it beside another blocker', () => {
  const review = row('pr', { status: 'in_progress', assignee: 'orchestrator', labels: ['in-review'] });
  const stacked = row('s', { labels: ['ready-for-agent'], dependencies: [blocks('pr')] });
  assert.equal(lines(data([review, stacked]))['s'][1], 'Marked Ready, but ysz waits: not in the Ready queue yet');
  const open = row('o', { title: 'Open blocker' });
  const both = row('s', { labels: ['ready-for-agent'], dependencies: [blocks('pr'), blocks('o')] });
  assert.equal(lines(data([review, open, both]))['s'][1], 'Marked Ready, but ysz waits: blocked by Title of pr; blocked by Open blocker');
});

it('marks a ready-for-agent Ticket missing from the Ready queue as Marked Ready, not Ready', () => {
  assert.equal(lines(data([row('t', { labels: ['ready-for-agent'] })], []))['t'][0], 'marked');
});

it('never makes an epic a Ticket, only the header of its children with its open count', () => {
  const rows = [row('e', { issue_type: 'epic', labels: ['ready-for-agent'] }), row('k1', { parent: 'e' }), row('k2', { parent: 'e' })];
  const m = build(data(rows, [queued('e')]), noStages, en);
  assert.deepEqual(m.tickets.map((t) => t.row.id), ['k1', 'k2']);
  assert.equal(m.headers.get('a/e')!.line, 'Epic · 2 open');
});

it("groups Tickets under their parent, a closed parent or the Project's No epic", () => {
  const rows = [row('e', { issue_type: 'epic' }), row('k', { parent: 'e' }), row('orphan', { parent: 'gone' }), row('loose')];
  const m = build(data(rows), noStages, en);
  assert.deepEqual(
    groupTickets(m.tickets, m).map((g) => [g.header?.row.id ?? null, g.closedId, g.tickets.map((t) => t.row.id)]),
    [['e', null, ['k']], [null, 'gone', ['orphan']], [null, null, ['loose']]],
  );
});

it('shows a feature with children as a row in its own group and as the header of its children', () => {
  const rows = [row('e', { issue_type: 'epic' }), row('f', { issue_type: 'feature', parent: 'e' }), row('c', { parent: 'f' })];
  const m = build(data(rows), noStages, en);
  assert.deepEqual(m.tickets.map((t) => t.row.id), ['f', 'c']);
  assert.equal(m.headers.get('a/f')!.line, 'Not Ready');
  assert.deepEqual(groupTickets(m.tickets, m).map((g) => [g.header!.row.id, g.tickets.map((t) => t.row.id)]), [['e', ['f']], ['f', ['c']]]);
});

it('keeps a matching child under its non-matching header, and hides a group with no match', () => {
  const rows = [
    row('e1', { issue_type: 'epic', title: 'Alpha' }),
    row('e2', { issue_type: 'epic', title: 'Beta' }),
    row('a1', { parent: 'e1', title: 'fix login' }),
    row('b1', { parent: 'e2', title: 'fix cart' }),
  ];
  const m = build(data(rows), noStages, en);
  const hits = m.tickets.filter((t) => matches(t, parseSearch('login')));
  assert.deepEqual(groupTickets(hits, m).map((g) => [g.header!.row.title, g.tickets.map((t) => t.row.id)]), [['Alpha', ['a1']]]);
});

it('orders Projects as registered, then by priority and numeric id, with No epic last', () => {
  const rows = [
    row('e-10', { issue_type: 'epic', priority: 1 }),
    row('e-2', { issue_type: 'epic', priority: 1 }),
    row('e-9', { issue_type: 'epic', priority: 0 }),
    row('loose'),
    ...['e-10', 'e-2', 'e-9'].map((p) => row(`${p}.1`, { parent: p })),
    row('e-2.2', { parent: 'e-2', priority: 0 }),
    row('e-2.10', { parent: 'e-2', priority: 0 }),
  ];
  const d: BacklogData = { projects: [project([row('z')], { name: 'first' }), project(rows, { name: 'second' })], ready: [] };
  const m = build(d, noStages, en);
  const groups = groupTickets([...m.tickets].reverse(), m);
  assert.deepEqual(groups.map((g) => `${g.project}:${g.header?.row.id ?? 'none'}`), ['first:none', 'second:e-9', 'second:e-2', 'second:e-10', 'second:none']);
  assert.deepEqual(groups[2].tickets.map((t) => t.row.id), ['e-2.2', 'e-2.10', 'e-2.1']);
});

const tickets = (): Ticket[] =>
  build(
    data([
      row('t1', { issue_type: 'bug', priority: 1, assignee: 'Yoss', status: 'in_progress', title: 'Login Page broken' }),
      row('t2', { issue_type: 'task', priority: 2, title: 'Cart' }),
      row('t3', { issue_type: 'feature', priority: 1, title: 'Search login history' }),
    ]),
    noStages,
    en,
  ).tickets;
const find = (q: string) => tickets().filter((t) => matches(t, parseSearch(q))).map((t) => t.row.id);

it('searches by each token, kinds combining with AND and several of one kind with OR', () => {
  assert.deepEqual(find('type:bug'), ['t1']);
  assert.deepEqual(find('status:in_progress'), ['t1']);
  assert.deepEqual(find('p2'), ['t2']);
  assert.deepEqual(find('@yoss'), ['t1']);
  assert.deepEqual(find('type:bug type:feature'), ['t1', 't3']);
  assert.deepEqual(find('p1 p2'), ['t1', 't2', 't3']);
  assert.deepEqual(find('p1 type:feature'), ['t3']);
  assert.deepEqual(find('p1 type:task'), []);
});

it('searches the rest as case-insensitive text over id and title', () => {
  assert.deepEqual(find('LOGIN'), ['t1', 't3']);
  assert.deepEqual(find('login page'), ['t1']);
  assert.deepEqual(find('T2'), ['t2']);
  assert.deepEqual(find('login p1 type:bug'), ['t1']);
  assert.deepEqual(find(''), ['t1', 't2', 't3']);
});

it("words a pill's data age only while loading or failed, leaving a healthy one to the strip", () => {
  assert.equal(ageText(project(null, { updatedAt: null }), 100_000, en), 'loading…');
  assert.equal(ageText(project([], { error: 'bd timed out' }), 1000 + 4 * 60_000 + 5000, en), 'last known 4m ago');
  assert.equal(ageText(project([]), 1000 + 12_000, en), null);
});

it("words the strip's data age from its stalest healthy Project, skipping loading and failed ones", () => {
  const ps = [
    project([], { name: 'a', updatedAt: 3000 }),
    project([], { name: 'b', updatedAt: 1000 }),
    project([], { name: 'c', updatedAt: 0, error: 'bd timed out' }),
    project(null, { name: 'd', updatedAt: null }),
  ];
  assert.equal(stripAge(ps, 1000 + 12_000, en), 'updated 12s ago');
  assert.equal(stripAge(ps.slice(0, 1), 3000 + 3 * 3_600_000, en), 'updated 3h ago');
  assert.equal(stripAge(ps.slice(0, 1), 3000 + 12_000, th), 'อัปเดต 12 วิ ที่แล้ว');
  assert.equal(stripAge(ps.slice(2), 100_000, en), null);
});

it('hands a Marked Ready Ticket its reasons one by one for the detail, and no other state any', () => {
  const rows = [
    row('b1', { title: 'First blocker' }),
    row('m', { labels: ['ready-for-agent', 'orchestrator:skip'], assignee: 'yoss', dependencies: [blocks('b1')] }),
    row('plain'),
  ];
  const byId = new Map(build(data(rows), noStages, en).tickets.map((tk) => [tk.row.id, tk]));
  assert.deepEqual(byId.get('m')!.reasons, ['blocked by First blocker', 'assigned to yoss', 'skipped']);
  assert.deepEqual(byId.get('plain')!.reasons, []);
});

it("lists a Ticket's parent, blockers, blocked Tickets and children from the rows, a blocker or parent outside them as closed", () => {
  const rows = [
    row('epic', { issue_type: 'epic' }),
    row('t', { parent: 'epic', status: 'in_progress', dependencies: [blocks('b'), blocks('gone'), { depends_on_id: 'epic', type: 'parent-child' }] }),
    row('b', { title: 'The blocker', status: 'blocked' }),
    row('after', { dependencies: [blocks('t')] }),
    row('kid', { parent: 't', title: 'A child' }),
    row('orphan', { parent: 'closed-epic' }),
  ];
  assert.deepEqual(relations(rows, rows[1]), {
    parent: { id: 'epic', title: 'Title of epic', status: 'open' },
    blockedBy: [
      { id: 'b', title: 'The blocker', status: 'blocked' },
      { id: 'gone', title: null, status: 'closed' },
    ],
    blocks: [{ id: 'after', title: 'Title of after', status: 'open' }],
    children: [{ id: 'kid', title: 'A child', status: 'open' }],
  });
  assert.deepEqual(relations(rows, rows[5]).parent, { id: 'closed-epic', title: null, status: 'closed' });
  assert.equal(relations(rows, rows[0]).parent, null);
});

it('shows ysz for its bd actor in a name and ages a comment from its RFC 3339 time', () => {
  assert.equal(who('orchestrator'), 'ysz');
  assert.equal(who('yoss'), 'yoss');
  const at = Date.parse('2026-10-22T10:00:00Z');
  assert.equal(since('2026-10-22T10:00:00Z', at + 4 * 60_000 + 5000, en), '4m ago');
  assert.equal(since('2026-10-22T10:00:00Z', at + 2 * 86_400_000, en), '2d ago');
});

/** The labels of the last row's buttons (or of `id`'s), primary ones starred. */
const buttonsOf = (rows: BacklogRow[], ready: QueueItem[] = [], id = rows[rows.length - 1].id) => {
  const tk = build(data(rows, ready), noStages, en).tickets.find((x) => x.row.id === id)!;
  return buttons(tk, en).map((b) => b.label + (b.primary ? '*' : ''));
};

it('offers the buttons each Backlog state allows', () => {
  assert.deepEqual(buttonsOf([row('plain')]), ['Mark Ready*', 'Skip ysz']);
  assert.deepEqual(buttonsOf([row('asks', { labels: ['needs-info'] })]), ['Mark Ready*', 'Skip ysz']);
  assert.deepEqual(buttonsOf([row('mine', { status: 'in_progress', assignee: 'yoss' })]), ['Mark Ready*', 'Skip ysz']);
  assert.deepEqual(buttonsOf([row('marked', { labels: ['ready-for-agent'] })]), ['Unmark Ready', 'Skip ysz']);
  assert.deepEqual(buttonsOf([row('ready', { labels: ['ready-for-agent'] })], [queued('ready', { waitReason: 'next up' })]), ['Unmark Ready', 'Run now*', 'Skip ysz']);
  assert.deepEqual(buttonsOf([row('held', { status: 'in_progress', assignee: 'orchestrator' })]), []);
  assert.deepEqual(buttonsOf([row('review', { status: 'in_progress', assignee: 'orchestrator', labels: ['in-review'] })]), []);
});

it('offers no Run now on a Ready Ticket already run-now or waiting on "not onboarded"', () => {
  const rows = [row('now', { labels: ['ready-for-agent'] }), row('new', { labels: ['ready-for-agent'] })];
  const ready = [queued('now', { runNow: true, waitReason: 'next up' }), queued('new', { waitReason: 'not onboarded' })];
  assert.deepEqual(buttonsOf(rows, ready, 'now'), ['Unmark Ready', 'Skip ysz']);
  assert.deepEqual(buttonsOf(rows, ready, 'new'), ['Unmark Ready', 'Skip ysz']);
});

it('words Allow ysz as returning to the queue only when skipped is the sole reason a Marked Ready Ticket waits', () => {
  const skipped = row('k', { labels: ['ready-for-agent', 'orchestrator:skip'] });
  assert.deepEqual(buttonsOf([skipped]), ['Unmark Ready', 'Allow ysz (returns to queue)']);
  assert.deepEqual(buttonsOf([row('b'), { ...skipped, dependencies: [blocks('b')] }], [], 'k'), ['Unmark Ready', 'Allow ysz']);
  assert.deepEqual(buttonsOf([{ ...skipped, status: 'deferred' }]), ['Unmark Ready', 'Allow ysz']); // bd ready leaves a deferred Ticket out
  assert.deepEqual(buttonsOf([row('s', { labels: ['orchestrator:skip'] })]), ['Mark Ready*', 'Allow ysz']);
});

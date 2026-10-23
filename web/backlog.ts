import type { BacklogRow } from '../src/beads';
import type { Orchestrator, QueueItem } from '../src/core';
import { allowedActions, ORCHESTRATOR, type TicketAction } from '../src/ticketActions';
import type { Dict } from './i18n';

/** What GET /api/backlog serves: each Project's rows in registry order, and the Ready queue of all Projects. */
export interface BacklogData {
  projects: ReturnType<Orchestrator['backlog']>;
  ready: QueueItem[];
}
export type BacklogProject = BacklogData['projects'][number];

/** The tabs' states, in tab order; 'all' is every one of them. */
export const STATES = ['needs-info', 'marked', 'ready', 'held', 'not-ready'] as const;
export type BacklogState = (typeof STATES)[number];

const YSZ = ORCHESTRATOR;

export const keyOf = (project: string, id: string) => `${project}/${id}`;
const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const has = (r: BacklogRow, label: string) => r.labels.includes(label);
const isHeld = (r: BacklogRow) => r.status === 'in_progress' && r.assignee === YSZ;
const plain = (status: string) => status.replace('_', ' ');

export interface Ticket {
  project: string;
  row: BacklogRow;
  state: BacklogState;
  /** What the Ticket waits on, or its Run, worded for the row. */
  line: string;
  /** Marked Ready only: each reason `line` joins, so the detail can list them one per line. */
  reasons: string[];
  /** In the Ready queue, not yet run-now and onboarded: Run now would do something. */
  canRunNow: boolean;
}

/** A group's header: a parent that is in the Backlog, with its own state line ("Epic · 9 open" for an epic). */
export interface Header {
  row: BacklogRow;
  state: BacklogState | 'epic';
  line: string;
  reasons: string[];
}

export interface Model {
  tickets: Ticket[];
  headers: Map<string, Header>;
  /** Project names in registry order. */
  projects: string[];
}

/**
 * Every Ticket of every Project with its Backlog state, first match winning: held by ysz, Ready (in the Ready queue,
 * never worked out from the rows), Marked Ready, Needs info, Not Ready. An epic is never a Ticket, only a header.
 * `stages` maps a held Ticket's `project/id` to its Run's stage as the Run card shows it.
 */
export function build(data: BacklogData, stages: ReadonlyMap<string, string>, t: Dict): Model {
  const queue = new Map(data.ready.map((q, i) => [keyOf(q.project, q.id), { place: i + 1, q }]));
  const tickets: Ticket[] = [];
  const headers = new Map<string, Header>();
  for (const p of data.projects) {
    const rows = p.rows ?? [];
    const byRowId = new Map(rows.map((r) => [r.id, r]));
    const children = new Map<string, number>();
    for (const r of rows) if (r.parent) children.set(r.parent, (children.get(r.parent) ?? 0) + 1);
    const blockersOf = (r: BacklogRow) => r.dependencies.filter((d) => d.type === 'blocks').flatMap((d) => byRowId.get(d.depends_on_id) ?? []);
    const inReview = (r: BacklogRow) => isHeld(r) && has(r, 'in-review');

    const lineOf = (r: BacklogRow): { state: BacklogState; line: string; reasons: string[] } => {
      const queued = queue.get(keyOf(p.name, r.id));
      if (isHeld(r)) return { state: 'held', line: inReview(r) ? t.backlog.inReview : t.backlog.run(stages.get(keyOf(p.name, r.id))), reasons: [] };
      if (queued) {
        const { place, q } = queued;
        return { state: 'ready', line: q.runNow && q.waitReason === 'next up' ? t.runNowNext : t.backlog.queued(place, t.wait[q.waitReason] ?? q.waitReason), reasons: [] };
      }
      if (has(r, 'ready-for-agent')) {
        const blockers = blockersOf(r);
        const open = children.get(r.id) ?? 0;
        const reasons = [
          // A lone In review blocker is no reason: the Ticket stacks on its PR.
          ...(blockers.length === 1 && inReview(blockers[0]) ? [] : blockers.map((b) => t.backlog.blockedBy(b.title))),
          ...(r.assignee && r.assignee !== YSZ ? [t.backlog.assignedTo(r.assignee)] : []),
          ...(has(r, 'orchestrator:skip') ? [t.backlog.skipped] : []),
          ...(open ? [t.backlog.openChildren(open)] : []),
        ];
        if (!reasons.length) reasons.push(r.status === 'open' ? t.backlog.notQueued : plain(r.status));
        return { state: 'marked', line: t.backlog.markedWaits(reasons.join('; ')), reasons };
      }
      if (has(r, 'needs-info')) return { state: 'needs-info', line: t.backlog.needsInfo, reasons: [] };
      return { state: 'not-ready', line: t.backlog.notReady(r.assignee && r.assignee !== YSZ ? `${plain(r.status)}, ${r.assignee}` : null), reasons: [] };
    };

    for (const r of rows) {
      if (r.issue_type === 'epic') continue;
      const q = queue.get(keyOf(p.name, r.id))?.q;
      tickets.push({ project: p.name, row: r, ...lineOf(r), canRunNow: !!q && !q.runNow && q.waitReason !== 'not onboarded' });
    }
    for (const id of children.keys()) {
      const r = byRowId.get(id);
      if (!r) continue;
      headers.set(keyOf(p.name, id), r.issue_type === 'epic' ? { row: r, state: 'epic', line: t.backlog.epicOpen(children.get(id)!), reasons: [] } : { row: r, ...lineOf(r) });
    }
  }
  return { tickets, headers, projects: data.projects.map((p) => p.name) };
}

/** What a button does: a Ticket action the server takes, or Run now. */
export type BacklogAction = TicketAction | 'run-now';

export interface Button {
  action: BacklogAction;
  label: string;
  primary: boolean;
}

/**
 * The buttons a Ticket's panel shows, in order: Mark Ready or Unmark Ready, Run now, Skip ysz or Allow ysz, Unassign. The Ticket
 * actions come from the function the server checks them with. A Ticket ysz holds gets none. Allow ysz says it returns
 * the Ticket to the queue when skipped is the only reason a Marked Ready Ticket waits.
 */
export function buttons(tk: Ticket, t: Dict): Button[] {
  const b = t.backlog.buttons;
  const allowed = allowedActions(tk.row);
  // Only an open Ticket: bd ready leaves out blocked, deferred and in_progress ones, and lineOf drops their status once skipped is a reason.
  const returns = tk.state === 'marked' && tk.row.status === 'open' && tk.reasons.length === 1 && has(tk.row, 'orchestrator:skip');
  const all: Record<BacklogAction, Button> = {
    'mark-ready': { action: 'mark-ready', label: b.markReady, primary: true },
    'unmark-ready': { action: 'unmark-ready', label: b.unmarkReady, primary: false },
    'run-now': { action: 'run-now', label: t.runNow, primary: true },
    skip: { action: 'skip', label: b.skip, primary: false },
    allow: { action: 'allow', label: returns ? b.allowReturns : b.allow, primary: false },
    unassign: { action: 'unassign', label: b.unassign, primary: false },
  };
  return (['mark-ready', 'unmark-ready', 'run-now', 'skip', 'allow', 'unassign'] as const).filter((a) => (a === 'run-now' ? tk.canRunNow : allowed.includes(a))).map((a) => all[a]);
}

export interface Search {
  types: string[];
  statuses: string[];
  priorities: number[];
  assignees: string[];
  /** The rest, lower-cased. */
  text: string;
}

/** `type:bug status:open p1 @yoss` and free text. */
export function parseSearch(query: string): Search {
  const s: Search = { types: [], statuses: [], priorities: [], assignees: [], text: '' };
  const text: string[] = [];
  for (const word of query.trim().split(/\s+/).filter(Boolean)) {
    const kv = /^(type|status):(.+)$/i.exec(word);
    if (kv) (kv[1].toLowerCase() === 'type' ? s.types : s.statuses).push(kv[2].toLowerCase());
    else if (/^p[0-4]$/i.test(word)) s.priorities.push(Number(word[1]));
    else if (/^@.+/.test(word)) s.assignees.push(word.slice(1).toLowerCase());
    else text.push(word);
  }
  s.text = text.join(' ').toLowerCase();
  return s;
}

/** Kinds combine with AND, several of one kind with OR. */
export function matches({ row }: Ticket, s: Search): boolean {
  return (
    (!s.types.length || s.types.includes(row.issue_type.toLowerCase())) &&
    (!s.statuses.length || s.statuses.includes(row.status.toLowerCase())) &&
    (!s.priorities.length || s.priorities.includes(row.priority)) &&
    (!s.assignees.length || (!!row.assignee && s.assignees.includes(row.assignee.toLowerCase()))) &&
    (!s.text || `${row.id} ${row.title}`.toLowerCase().includes(s.text))
  );
}

export interface Group {
  key: string;
  project: string;
  /** The parent, when it is in the Backlog. */
  header: Header | null;
  /** The parent's id when it is not (closed); null with no header: the Project's "No epic". */
  closedId: string | null;
  tickets: Ticket[];
}

/**
 * `tickets` under their parents. Headers are never filtered: a group exists when it holds a Ticket from `tickets`,
 * whether or not its parent is one. Projects in registry order, then priority and id; closed parents after open ones, "No epic" last.
 */
export function groupTickets(tickets: Ticket[], model: Model): Group[] {
  const groups = new Map<string, Group>();
  for (const tk of tickets) {
    const parent = tk.row.parent;
    const header = (parent && model.headers.get(keyOf(tk.project, parent))) || null;
    const key = keyOf(tk.project, header ? parent! : parent ? `closed:${parent}` : '');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, project: tk.project, header, closedId: header ? null : parent, tickets: [] }));
    g.tickets.push(tk);
  }
  // 0 for a parent in the Backlog, 1 for a closed one, 2 for none.
  const rank = (g: Group) => (g.header ? 0 : g.closedId ? 1 : 2);
  for (const g of groups.values()) g.tickets.sort((a, b) => a.row.priority - b.row.priority || byId(a.row.id, b.row.id));
  return [...groups.values()].sort(
    (a, b) =>
      model.projects.indexOf(a.project) - model.projects.indexOf(b.project) ||
      rank(a) - rank(b) ||
      (a.header && b.header ? a.header.row.priority - b.header.row.priority : 0) ||
      byId(a.header?.row.id ?? a.closedId ?? '', b.header?.row.id ?? b.closedId ?? ''),
  );
}

/** A duration in its largest short unit, as in `12s` or `4m`. */
const short = (ms: number, { units: u }: Dict) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}${u.s}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${u.m}`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}${u.h}` : `${Math.floor(h / 24)}${u.d}`;
};

/** A pill's data age, only where it parts from the strip's: "loading…" before its first poll, or "last known 4m ago" while its poll fails. */
export function ageText(p: BacklogProject, now: number, t: Dict): string | null {
  if (!p.rows) return t.backlog.loading;
  return p.error ? t.backlog.lastKnown(t.ago(short(now - (p.updatedAt ?? now), t))) : null;
}

/** The strip's one data age, "updated 12s ago": every Project polls in the same round, so the stalest healthy one speaks for all. */
export function stripAge(projects: BacklogProject[], now: number, t: Dict): string | null {
  const times = projects.filter((p) => p.rows && !p.error).map((p) => p.updatedAt ?? now);
  return times.length ? t.backlog.updated(t.ago(short(now - Math.min(...times), t))) : null;
}

/** A name as the Dashboard shows it: ysz's bd actor is ysz. */
export const who = (name: string) => (name === YSZ ? 'ysz' : name);

/** How long ago an RFC 3339 time was, as in `4m ago`. */
export const since = (iso: string, now: number, t: Dict) => t.ago(short(now - Date.parse(iso), t));

/** A Ticket a detail names: its title and status, or no title and "closed" when it is not in the rows. */
export interface Related {
  id: string;
  title: string | null;
  status: string;
}

/** A Ticket's neighbours, from the Project's rows: a blocker or parent that is not in them is closed. */
export function relations(rows: BacklogRow[], row: BacklogRow) {
  const byRowId = new Map(rows.map((r) => [r.id, r]));
  const rel = (id: string): Related => {
    const r = byRowId.get(id);
    return { id, title: r?.title ?? null, status: r?.status ?? 'closed' };
  };
  return {
    parent: row.parent ? rel(row.parent) : null,
    blockedBy: row.dependencies.filter((d) => d.type === 'blocks').map((d) => rel(d.depends_on_id)),
    blocks: rows.filter((r) => r.dependencies.some((d) => d.type === 'blocks' && d.depends_on_id === row.id)).map((r) => rel(r.id)),
    children: rows.filter((r) => r.parent === row.id).map((r) => rel(r.id)),
  };
}

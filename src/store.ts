import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type RunState =
  | 'claimed' | 'agent' | 'agent-review' | 'host' | 'needs-attention'
  | 'in-review' | 'merged' | 'pr-closed' | 'broken-down' | 'landed' | 'failed' | 'killed' | 'interrupted';

/** Only these states hold a capacity slot; needs-attention frees it. */
const SLOT_STATES = ['claimed', 'agent', 'agent-review', 'host'];
/** Runs the user can still act on: the slot holders and the ones waiting on a Retry or Kill. */
const LIVE_STATES = [...SLOT_STATES, 'needs-attention'];

/** One agent's token use: `context` is its latest main-thread context window, `tokens` everything it read and wrote. */
export interface AgentUsage {
  context: number;
  tokens: number;
}

export interface RunRow {
  id: number;
  project: string;
  ticketId: string;
  title: string;
  state: RunState;
  /** Attempts started so far: 0 until the agent starts. */
  attempt: number;
  prUrl: string | null;
  /** The branch the PR targets when it is not the Project's baseBranch: an epic branch or a stacked-on blocker's. Null otherwise, and for Runs from before it was recorded. */
  prBase: string | null;
  /** Why a Run failed. */
  note: string | null;
  startedAt: number;
  endedAt: number | null;
  /** The Run's disposable clone while it exists on disk; null once removed or before the first one. */
  cloneDir: string | null;
  /** The clone's size on disk, measured once the Run ended failed or killed; null until then. */
  cloneBytes: number | null;
  /** When the human archived the Run, hiding it from history; null while not archived. */
  archivedAt: number | null;
  /** The model the Run's agents ran on; null for Runs from before it was recorded. */
  model: string | null;
  /** Each agent's usage by its log part name (`attempt1-implement`); empty for Runs from before it was recorded. */
  usage: Record<string, AgentUsage>;
  /** When GitHub says the PR merged or closed, ending the Run's Review wait; null before then and for Runs from before it was recorded. */
  prClosedAt: number | null;
  /** What the Run's agents reported and ysz recorded as Tickets; null when nothing was. Not a live view of bd. */
  reports: Reports | null;
}

/** Follow-ups go to the Project's queue, Friction to ysz's own; `seenAgain` marks a Friction that only got a comment. */
export interface Reports {
  followUps: { id: string; title: string }[];
  friction: { id: string; title: string; seenAgain: boolean }[];
}

type RunPatch = Partial<Pick<RunRow, 'state' | 'attempt' | 'prUrl' | 'prBase' | 'note' | 'endedAt' | 'cloneDir' | 'cloneBytes' | 'archivedAt' | 'prClosedAt'>>;

const COLUMNS: Record<keyof RunPatch, string> = {
  state: 'state', attempt: 'attempt', prUrl: 'pr_url', prBase: 'pr_base', note: 'note', endedAt: 'ended_at', cloneDir: 'clone_dir', cloneBytes: 'clone_bytes', archivedAt: 'archived_at', prClosedAt: 'pr_closed_at',
};

/** A Project's Backlog and Ready Ticket counts from the poll at `at`. */
export interface BacklogPoint {
  project: string;
  at: number;
  backlog: number;
  ready: number;
}

export interface Store {
  /** Returns the new Run's id. */
  insertRun(run: { project: string; ticketId: string; title: string; state: RunState; startedAt: number; model?: string }): number;
  updateRun(id: number, patch: RunPatch): void;
  /** Project name of every Run holding a slot (one entry per Run). */
  slotProjects(): string[];
  /** Runs still open to Kill, oldest first: those holding a slot, and needs-attention ones. */
  liveRuns(): RunRow[];
  /** Runs waiting on the human's review of their PR, oldest first. */
  inReview(): RunRow[];
  /** Runs that ended or wait in review, newest first; archived ones excepted. */
  history(limit: number): RunRow[];
  /** Archived Runs, newest first. */
  archived(limit: number): RunRow[];
  /** Every Run that ended but still has its clone, archived ones too, newest first. */
  cloned(): RunRow[];
  /** Every Run, live and archived ones too, oldest first. */
  allRuns(): RunRow[];
  getRun(id: number): RunRow | undefined;
  /** Record one agent's usage so far, under its log part name. */
  setUsage(id: number, part: string, usage: AgentUsage): void;
  /** Replace what the Run reported. */
  setReports(id: number, reports: Reports): void;
  deleteRun(id: number): void;
  /** Save what a Run needs to resume its host steps after a restart (JSON; the store does not read it). */
  setHostJob(id: number, job: string): void;
  hostJob(id: number): string | null;
  /** State of the Ticket's newest Run, if it ever had one. */
  lastRunState(project: string, ticketId: string): RunState | undefined;
  /** Pause or resume a Project's picking. Survives a restart. */
  setPaused(project: string, paused: boolean): void;
  pausedProjects(): string[];
  /** Record a Project's counts from a poll, unless they equal the last ones recorded for it. */
  recordBacklog(project: string, at: number, counts: { backlog: number; ready: number }): void;
  /** Every recorded change of every Project's counts, oldest first. */
  backlogHistory(): BacklogPoint[];
}

/** `:memory:` or a file path; the parent directory is created. */
export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // The walking skeleton's runs table never held a real Run, so a pre-1 database is simply rebuilt.
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 1) {
    db.exec('DROP TABLE IF EXISTS runs; PRAGMA user_version = 1');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    pr_url TEXT,
    note TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`);
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 2) {
    db.exec('ALTER TABLE runs ADD COLUMN clone_dir TEXT; PRAGMA user_version = 2');
  }
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 3) {
    db.exec('ALTER TABLE runs ADD COLUMN host_job TEXT; PRAGMA user_version = 3');
  }
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 4) {
    db.exec('ALTER TABLE runs ADD COLUMN archived_at INTEGER; PRAGMA user_version = 4');
  }
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 5) {
    db.exec('ALTER TABLE runs ADD COLUMN model TEXT; PRAGMA user_version = 5');
  }
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 6) {
    db.exec('ALTER TABLE runs ADD COLUMN usage TEXT; PRAGMA user_version = 6');
  }
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 7) {
    db.exec('ALTER TABLE runs ADD COLUMN pr_base TEXT; PRAGMA user_version = 7');
  }
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 8) {
    db.exec('ALTER TABLE runs ADD COLUMN pr_closed_at INTEGER; PRAGMA user_version = 8');
  }
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 9) {
    db.exec('ALTER TABLE runs ADD COLUMN reports TEXT; PRAGMA user_version = 9');
  }
  if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 10) {
    db.exec('ALTER TABLE runs ADD COLUMN clone_bytes INTEGER; PRAGMA user_version = 10');
  }
  db.exec('CREATE TABLE IF NOT EXISTS paused_projects (project TEXT PRIMARY KEY)');
  db.exec(`CREATE TABLE IF NOT EXISTS backlog (project TEXT NOT NULL, at INTEGER NOT NULL, backlog INTEGER NOT NULL, ready INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS backlog_project_at ON backlog (project, at)`);
  const inStates = (states: string[]) => `state IN (${states.map(() => '?').join(',')})`;
  const insert = db.prepare('INSERT INTO runs (project, ticket_id, title, state, started_at, model) VALUES (?, ?, ?, ?, ?, ?)');
  const slotted = db.prepare(`SELECT * FROM runs WHERE ${inStates(SLOT_STATES)} ORDER BY id`);
  const live = db.prepare(`SELECT * FROM runs WHERE ${inStates(LIVE_STATES)} ORDER BY id`);
  const ended = db.prepare(`SELECT * FROM runs WHERE NOT (${inStates(LIVE_STATES)}) AND archived_at IS NULL ORDER BY id DESC LIMIT ?`);
  const shelved = db.prepare('SELECT * FROM runs WHERE archived_at IS NOT NULL ORDER BY id DESC LIMIT ?');
  const withClone = db.prepare(`SELECT * FROM runs WHERE clone_dir IS NOT NULL AND NOT (${inStates(LIVE_STATES)}) ORDER BY id DESC`);
  const reviewing = db.prepare("SELECT * FROM runs WHERE state = 'in-review' ORDER BY id");
  const byId = db.prepare('SELECT * FROM runs WHERE id = ?');
  const every = db.prepare('SELECT * FROM runs ORDER BY id');
  const setUsage = db.prepare("UPDATE runs SET usage = json_set(coalesce(usage, '{}'), ?, json(?)) WHERE id = ?");
  const pause = db.prepare('INSERT OR IGNORE INTO paused_projects (project) VALUES (?)');
  const resume = db.prepare('DELETE FROM paused_projects WHERE project = ?');
  const paused = db.prepare('SELECT project FROM paused_projects');
  const lastCounts = db.prepare('SELECT backlog, ready FROM backlog WHERE project = ? ORDER BY at DESC LIMIT 1');
  const addCounts = db.prepare('INSERT INTO backlog (project, at, backlog, ready) VALUES (?, ?, ?, ?)');
  const counts = db.prepare('SELECT project, at, backlog, ready FROM backlog ORDER BY at, rowid');
  const toRow = (r: Record<string, unknown>): RunRow => ({
    id: r.id as number,
    project: r.project as string,
    ticketId: r.ticket_id as string,
    title: r.title as string,
    state: r.state as RunState,
    attempt: r.attempt as number,
    prUrl: r.pr_url as string | null,
    prBase: r.pr_base as string | null,
    note: r.note as string | null,
    startedAt: r.started_at as number,
    endedAt: r.ended_at as number | null,
    cloneDir: r.clone_dir as string | null,
    cloneBytes: r.clone_bytes as number | null,
    archivedAt: r.archived_at as number | null,
    model: r.model as string | null,
    usage: JSON.parse((r.usage as string | null) ?? '{}'),
    prClosedAt: r.pr_closed_at as number | null,
    reports: r.reports ? JSON.parse(r.reports as string) : null,
  });
  return {
    insertRun: (r) => Number(insert.run(r.project, r.ticketId, r.title, r.state, r.startedAt, r.model ?? null).lastInsertRowid),
    updateRun(id, patch) {
      const keys = Object.keys(patch) as (keyof RunPatch)[];
      db.prepare(`UPDATE runs SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => patch[k] as string | number | null),
        id,
      );
    },
    slotProjects: () => slotted.all(...SLOT_STATES).map((row) => row.project as string),
    liveRuns: () => live.all(...LIVE_STATES).map(toRow),
    inReview: () => reviewing.all().map(toRow),
    history: (limit) => ended.all(...LIVE_STATES, limit).map(toRow),
    archived: (limit) => shelved.all(limit).map(toRow),
    cloned: () => withClone.all(...LIVE_STATES).map(toRow),
    allRuns: () => every.all().map(toRow),
    getRun: (id) => {
      const row = byId.get(id);
      return row && toRow(row);
    },
    setUsage: (id, part, usage) => void setUsage.run(`$."${part}"`, JSON.stringify(usage), id),
    setReports: (id, reports) => void db.prepare('UPDATE runs SET reports = ? WHERE id = ?').run(JSON.stringify(reports), id),
    deleteRun: (id) => void db.prepare('DELETE FROM runs WHERE id = ?').run(id),
    setHostJob: (id, job) => void db.prepare('UPDATE runs SET host_job = ? WHERE id = ?').run(job, id),
    hostJob: (id) => (db.prepare('SELECT host_job FROM runs WHERE id = ?').get(id)?.host_job as string | null | undefined) ?? null,
    lastRunState: (project, ticketId) =>
      db.prepare('SELECT state FROM runs WHERE project = ? AND ticket_id = ? ORDER BY id DESC LIMIT 1').get(project, ticketId)?.state as RunState | undefined,
    setPaused: (project, on) => void (on ? pause : resume).run(project),
    pausedProjects: () => paused.all().map((row) => row.project as string),
    recordBacklog(project, at, { backlog, ready }) {
      const last = lastCounts.get(project);
      if (last?.backlog !== backlog || last?.ready !== ready) addCounts.run(project, at, backlog, ready);
    },
    backlogHistory: () => counts.all().map((row) => ({ ...row }) as unknown as BacklogPoint),
  };
}

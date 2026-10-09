import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type RunState =
  | 'claimed' | 'agent' | 'agent-review' | 'host' | 'needs-attention'
  | 'in-review' | 'merged' | 'pr-closed' | 'failed' | 'killed' | 'interrupted';

/** Only these states hold a capacity slot; needs-attention frees it. */
const SLOT_STATES = ['claimed', 'agent', 'agent-review', 'host'];
/** Runs the user can still act on: the slot holders and the ones waiting on a Retry or Kill. */
const LIVE_STATES = [...SLOT_STATES, 'needs-attention'];

export interface RunRow {
  id: number;
  project: string;
  ticketId: string;
  title: string;
  state: RunState;
  /** Attempts started so far: 0 until the agent starts. */
  attempt: number;
  prUrl: string | null;
  /** Why a Run failed. */
  note: string | null;
  startedAt: number;
  endedAt: number | null;
  /** The Run's disposable clone while it exists on disk; null once removed or before the first one. */
  cloneDir: string | null;
}

type RunPatch = Partial<Pick<RunRow, 'state' | 'attempt' | 'prUrl' | 'note' | 'endedAt' | 'cloneDir'>>;

const COLUMNS: Record<keyof RunPatch, string> = {
  state: 'state', attempt: 'attempt', prUrl: 'pr_url', note: 'note', endedAt: 'ended_at', cloneDir: 'clone_dir',
};

export interface Store {
  /** Returns the new Run's id. */
  insertRun(run: { project: string; ticketId: string; title: string; state: RunState; startedAt: number }): number;
  updateRun(id: number, patch: RunPatch): void;
  /** Project name of every Run holding a slot (one entry per Run). */
  slotProjects(): string[];
  /** Runs still open to Kill, oldest first: those holding a slot, and needs-attention ones. */
  liveRuns(): RunRow[];
  /** Runs waiting on the human's review of their PR, oldest first. */
  inReview(): RunRow[];
  /** Runs that ended or wait in review, newest first. */
  history(limit: number): RunRow[];
  getRun(id: number): RunRow | undefined;
  /** Save what a Run needs to resume its host steps after a restart (JSON; the store does not read it). */
  setHostJob(id: number, job: string): void;
  hostJob(id: number): string | null;
  /** State of the Ticket's newest Run, if it ever had one. */
  lastRunState(project: string, ticketId: string): RunState | undefined;
  /** Pause or resume a Project's picking. Survives a restart. */
  setPaused(project: string, paused: boolean): void;
  pausedProjects(): string[];
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
  db.exec('CREATE TABLE IF NOT EXISTS paused_projects (project TEXT PRIMARY KEY)');
  const inStates = (states: string[]) => `state IN (${states.map(() => '?').join(',')})`;
  const insert = db.prepare('INSERT INTO runs (project, ticket_id, title, state, started_at) VALUES (?, ?, ?, ?, ?)');
  const slotted = db.prepare(`SELECT * FROM runs WHERE ${inStates(SLOT_STATES)} ORDER BY id`);
  const live = db.prepare(`SELECT * FROM runs WHERE ${inStates(LIVE_STATES)} ORDER BY id`);
  const ended = db.prepare(`SELECT * FROM runs WHERE NOT (${inStates(LIVE_STATES)}) ORDER BY id DESC LIMIT ?`);
  const reviewing = db.prepare("SELECT * FROM runs WHERE state = 'in-review' ORDER BY id");
  const byId = db.prepare('SELECT * FROM runs WHERE id = ?');
  const pause = db.prepare('INSERT OR IGNORE INTO paused_projects (project) VALUES (?)');
  const resume = db.prepare('DELETE FROM paused_projects WHERE project = ?');
  const paused = db.prepare('SELECT project FROM paused_projects');
  const toRow = (r: Record<string, unknown>): RunRow => ({
    id: r.id as number,
    project: r.project as string,
    ticketId: r.ticket_id as string,
    title: r.title as string,
    state: r.state as RunState,
    attempt: r.attempt as number,
    prUrl: r.pr_url as string | null,
    note: r.note as string | null,
    startedAt: r.started_at as number,
    endedAt: r.ended_at as number | null,
    cloneDir: r.clone_dir as string | null,
  });
  return {
    insertRun: (r) => Number(insert.run(r.project, r.ticketId, r.title, r.state, r.startedAt).lastInsertRowid),
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
    getRun: (id) => {
      const row = byId.get(id);
      return row && toRow(row);
    },
    setHostJob: (id, job) => void db.prepare('UPDATE runs SET host_job = ? WHERE id = ?').run(job, id),
    hostJob: (id) => (db.prepare('SELECT host_job FROM runs WHERE id = ?').get(id)?.host_job as string | null | undefined) ?? null,
    lastRunState: (project, ticketId) =>
      db.prepare('SELECT state FROM runs WHERE project = ? AND ticket_id = ? ORDER BY id DESC LIMIT 1').get(project, ticketId)?.state as RunState | undefined,
    setPaused: (project, on) => void (on ? pause : resume).run(project),
    pausedProjects: () => paused.all().map((row) => row.project as string),
  };
}

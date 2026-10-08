import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type RunState =
  | 'claimed' | 'agent' | 'host' | 'needs-attention'
  | 'in-review' | 'failed' | 'killed' | 'interrupted';

/** Only these states hold a capacity slot; needs-attention frees it. */
const SLOT_STATES = ['claimed', 'agent', 'host'];

export interface Store {
  insertRun(run: { project: string; ticketId: string; state: RunState }): void;
  /** Project name of every Run holding a slot (one entry per Run). */
  slotProjects(): string[];
}

/** `:memory:` or a file path; the parent directory is created. */
export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    state TEXT NOT NULL
  )`);
  const insert = db.prepare('INSERT INTO runs (project, ticket_id, state) VALUES (?, ?, ?)');
  const slots = db.prepare(`SELECT project FROM runs WHERE state IN (${SLOT_STATES.map(() => '?').join(',')})`);
  return {
    insertRun: (r) => void insert.run(r.project, r.ticketId, r.state),
    slotProjects: () => slots.all(...SLOT_STATES).map((row) => row.project as string),
  };
}

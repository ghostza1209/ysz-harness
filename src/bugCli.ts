// The logic of `npm run bug`. Like bug.ts it must work while ysz is down or broken: no openStore, no ysz HTTP API, and
// the Project config only through deps.loadProjects (a dynamic import), since a broken config may be the very bug.
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { generalReportLink, redactor, runExcerpt, runReportLink, type Facts } from './bugReport';
import { createRunLogs } from './logs';
import type { Project } from './projects';
import { reportable } from './reportable';
import { readRuns, type RunRow } from './store';

const PICKER_SIZE = 10;
const PROBE_TIMEOUT_MS = 1000;

export interface BugDeps {
  /** The checkout: its data/ holds the store and the Run logs. */
  root: string;
  now: number;
  facts: () => Promise<Facts>;
  loadProjects: () => Promise<readonly Project[]>;
  /** Whether anything answers on ysz's port. Called at most once, and only when a Run holds a slot. */
  yszUp: () => Promise<boolean>;
  /** Reveals `target` in the file manager when `reveal`, else opens it. A failure is not an error: the path and link are printed. */
  open: (target: string, reveal: boolean) => void;
  /** Whether stdin is a terminal. */
  interactive: boolean;
  /** One line typed by the reporter; undefined when input ended. */
  ask: (prompt: string) => Promise<string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** True when something accepts a TCP connection on 127.0.0.1:`port`; refused or silent for 1 s is false. */
export function probePort(port: number, timeout = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const ago = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m ago` : m < 24 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / (24 * 60))}d ago`;
};

/** Returns the exit code. `ticketId` is the CLI's one argument, if any. */
export async function bugCommand(ticketId: string | undefined, deps: BugDeps): Promise<number> {
  const { root, out } = deps;
  const runs = readRuns(join(root, 'data/orchestrator.db')).reverse(); // newest first
  const pool = ticketId === undefined ? runs : runs.filter((r) => r.ticketId === ticketId);

  // Runs left holding a slot are reportable only when ysz is down: it would interrupt them at its next start.
  const holding = (r: RunRow) => {
    const v = reportable(r.state);
    return !v.ok && v.kind === 'live';
  };
  const isDown = pool.some(holding) && !(await deps.yszUp());
  const candidates = pool.filter((r) => reportable(r.state).ok || (holding(r) && isDown));

  if (ticketId !== undefined && candidates.length === 0) {
    const newest = pool[0];
    deps.err(
      !newest
        ? `No Run of ${ticketId}.`
        : holding(newest)
          ? `${ticketId}'s Run is live: Kill it first (its newest Run holds a slot and ysz answers).`
          : `${ticketId}'s Run reached its goal: run npm run bug with no argument for a general report.`,
    );
    return 1;
  }

  const general = async (why?: string) => {
    if (why) out(why);
    const link = generalReportLink(await deps.facts());
    out(link);
    deps.open(link, false);
    return 0;
  };

  if (ticketId === undefined) {
    if (!deps.interactive) return general('stdin is not a terminal, so there is no Run to pick: making the general report.');
    if (candidates.length === 0) return general('No Run to report: making the general report.');
  }

  let projects: readonly Project[];
  try {
    projects = await deps.loadProjects();
  } catch (error) {
    return general(`The Project config cannot load, so a Run log cannot be redacted safely: making the general report. This error is likely the bug itself, paste it into the form:\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }

  let run = candidates[0];
  if (ticketId === undefined) {
    const shown = candidates.slice(0, PICKER_SIZE);
    shown.forEach((r, i) => out(`${i + 1}. ${r.state}  ${r.ticketId}  ${r.title}  (${ago(deps.now - (r.endedAt ?? r.startedAt))})`));
    for (;;) {
      const answer = (await deps.ask(`Run to report (1-${shown.length}), or Enter for a general report: `))?.trim();
      if (answer === undefined || answer === '') return general();
      const n = /^\d+$/.test(answer) ? Number(answer) : 0;
      if (n >= 1 && n <= shown.length) {
        run = shown[n - 1];
        break;
      }
    }
  }

  const redact = redactor(root, projects);
  const facts = await deps.facts();
  const { name, text } = await runExcerpt(run, createRunLogs(join(root, 'data/logs')), redact);
  const dir = join(root, 'data/bug-reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, text);
  const link = runReportLink(run, facts, redact);
  out(file);
  out(link);
  out("Drag the file into the form's Run log excerpt field. The issue and the file are public.");
  deps.open(file, true);
  deps.open(link, false);
  return 0;
}

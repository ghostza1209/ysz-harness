import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import type { RunLogs } from './logs';
import type { Project } from './projects';
import type { RunRow } from './store';

const execFileAsync = promisify(execFile);

/** Runs a command and returns its stdout; rejects with the spawn error (`code: 'ENOENT'` when the command does not exist). */
export type Exec = (cmd: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<string>;

const defaultExec: Exec = async (cmd, args, opts) => (await execFileAsync(cmd, args, { ...opts, killSignal: 'SIGKILL' })).stdout;

/**
 * The ids of the bug form's fields that a link fills (.github/ISSUE_TEMPLATE/bug.yml). Reporters' Clones build links
 * against master's form at any old sha, so an id is never renamed.
 */
export const FACT_IDS = ['ysz-version', 'modified', 'os', 'node', 'docker', 'bd', 'gh', 'claude'] as const;
export const FIELD_IDS = [...FACT_IDS, 'run-state', 'note'] as const;
export type Facts = Record<(typeof FACT_IDS)[number], string>;

const PROBE_TIMEOUT_MS = 5000;

/**
 * The machine's facts, probed concurrently, each with its own timeout since a broken tool may be the bug. A tool that is
 * missing reads `not found`; one that exits non-zero or hangs reads `failed`. `ysz` is the checkout's directory.
 */
export async function gatherFacts(ysz: string, exec: Exec = defaultExec, timeout = PROBE_TIMEOUT_MS): Promise<Facts> {
  const probe = async (cmd: string, args: string[]): Promise<string> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        exec(cmd, args, { cwd: ysz, timeout }),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), timeout))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const first = (out: string) => out.split('\n')[0].trim();
  const failed = (err: { code?: string }) => (err.code === 'ENOENT' ? 'not found' : 'failed');
  const line = (cmd: string, args: string[]) => probe(cmd, args).then(first, failed);

  const [yszVersion, status, ahead, docker, bd, gh, claude] = await Promise.all([
    line('git', ['rev-parse', '--short', 'HEAD']),
    probe('git', ['status', '--porcelain']).then((out) => out.trim() !== '', () => undefined),
    probe('git', ['rev-list', '--count', 'origin/master..HEAD']).then((out) => Number(out.trim()) > 0, () => undefined),
    line('docker', ['--version']),
    line('bd', ['--version']),
    line('gh', ['--version']),
    line('claude', ['--version']),
  ]);
  return {
    'ysz-version': yszVersion,
    modified: status === undefined || ahead === undefined ? 'unknown' : status || ahead ? 'yes' : 'no',
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    docker,
    bd,
    gh,
    claude,
  };
}

/** A link to the bug form with `fields` filled. No title unless given: GitHub will not submit without one, so the reporter writes it. */
export function bugLink(fields: Partial<Record<(typeof FIELD_IDS)[number], string>>, title?: string): string {
  const query = new URLSearchParams({ template: 'bug.yml' });
  if (title !== undefined) query.set('title', title);
  for (const [id, value] of Object.entries(fields)) query.set(id, value);
  return `https://github.com/ghostza1209/ysz-harness/issues/new?${query}`;
}

/** The report for a bug that is not in any Run: the machine's facts only. */
export const generalReportLink = (facts: Facts) => bugLink(facts);

const MIN_SECRET_LENGTH = 8; // shorter values (7d, true) are settings, not secrets, and would mangle the log
const EXCERPT_LINES = 50;

/**
 * Redacts the text ysz puts in a link or file: every value in ysz's own .env (`ysz` is its checkout) and in each
 * Project's copyToWorktree files becomes `[redacted:<KEY>]`, the longest value first so a secret that contains another
 * leaves no part behind; the home directory becomes `~`. The files are read per call, never cached; a missing one is skipped.
 * ponytail: dotenv files only, which every copyToWorktree file is today; a JSON secret file would need its own parser.
 */
export function redactor(ysz: string, projects: readonly Project[], home = homedir()): (text: string) => string {
  return (text) => {
    const files = [join(ysz, '.env'), ...projects.flatMap((p) => (p.copyToWorktree ?? []).map((f) => join(p.repoPath, f)))];
    const secrets = new Map<string, string>();
    for (const file of files) {
      let env: Record<string, string | undefined>;
      try {
        env = parseEnv(readFileSync(file, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const [key, value] of Object.entries(env)) if (value && value.length >= MIN_SECRET_LENGTH && !secrets.has(value)) secrets.set(value, key);
    }
    const longestFirst = [...secrets].sort((a, b) => b[0].length - a[0].length);
    return longestFirst.reduce((out, [value, key]) => out.split(value).join(`[redacted:${key}]`), text).split(home).join('~');
  };
}

/** A log's last `n` lines; a trailing newline is not a line. */
const lastLines = (text: string, n: number) => text.replace(/\n$/, '').split('\n').slice(-n).join('\n');

/**
 * The Run's Bug report file, redacted whole: its header and note, the whole host log, then the last 50 lines of each
 * agent part in stream order. Never the whole Run log: agent output is mostly the Project's private code.
 */
export async function runExcerpt(run: Pick<RunRow, 'id' | 'ticketId' | 'state' | 'note'>, logs: RunLogs, redact: (text: string) => string): Promise<{ name: string; text: string }> {
  const parts = await logs.parts(run.id);
  let offset = 0;
  const read = new Map<string, string>();
  for (const { name, size } of parts) {
    read.set(name, (await logs.slice(run.id, offset, offset + size)).toString('utf8'));
    offset += size;
  }
  const host = read.get('host');
  const sections = [
    `ysz Bug report: ${run.ticketId}, Run ${run.id}\nState: ${run.state}\nNote:\n${run.note || '(none)'}`,
    ...(host === undefined ? [] : [`--- host ---\n${host.replace(/\n$/, '')}`]),
    ...parts.filter((p) => p.name !== 'host').map((p) => `--- ${p.name} (last ${EXCERPT_LINES} lines) ---\n${lastLines(read.get(p.name)!, EXCERPT_LINES)}`),
  ];
  return { name: `${run.ticketId}-run${run.id}.log`, text: redact(`${sections.join('\n\n')}\n`) };
}

const TITLE_CODE_POINTS = 120;
const LINK_BUDGET = 2000; // chars of a whole link: the research's safe length for a prefilled issue URL
/** Where the failure notes in core.ts append their secondary failure (handBack, execute's catch, kill, recover). */
const SUFFIX = /; releasing the Ticket failed: |\nhanding the Ticket back failed: /;
const MARKER = /\[redacted:[^\]]*\]/g;

/**
 * The bug form's title for a Run, from its redacted note: the first cause, without the wording core.ts wraps it in, so
 * each note shape there is pinned by a test. A kill, or nothing left to say, gives none: only the reporter knows what
 * looked wrong. A cut never lands inside a `[redacted:KEY]`, which stays whole even when that makes the title a few code
 * points over.
 */
export function runTitle(text: string): string | undefined {
  const at = text.search(SUFFIX);
  const body = at < 0 ? text : text.slice(0, at);
  const suffix = at < 0 ? '' : text.slice(at).replace(/^[;\n]\s*/, ''); // the only ysz or bd failure when the rest is stock text
  const interrupted = body.match(/^(Interrupted by a ysz restart while [\w-]+); not counted as an Attempt\.$/);
  const killed = /^Killed from the dashboard while [\w-]+\.(?: \(PR \S+ was opened\))?$/.test(body);
  const cause = body
    .replace(/^Attempt 1 failed: ([\s\S]*?)(?:\nAttempt 2 failed: [\s\S]*)?$/, '$1')
    .replace(/^The \S+ agent needs information:\n/, '')
    .replace(/^the \S+ agent failed: /, '')
    .replace(/^(the \S+ agent stopped without signalling COMPLETE):[\s\S]*$/, '$1');
  const title = (killed || interrupted ? suffix || (interrupted?.[1] ?? '') : cause)
    .trim()
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  if (!title) return undefined;
  let end = Array.from(title).slice(0, TITLE_CODE_POINTS).join('').length;
  if (end >= title.length) return title;
  for (const m of title.matchAll(MARKER)) if (m.index < end && m.index + m[0].length > end) end = m.index + m[0].length;
  return end >= title.length ? title : `${title.slice(0, end)}…`;
}

/** The URL-encoded length of `s` as a query value. */
const encodedLength = (s: string) => new URLSearchParams({ n: s }).toString().length - 2;

/**
 * The report for a bug in a Run: the facts, the Run's state, a title and the start of its note. The note is redacted
 * and cut by code points (so no percent escape is split) to what the 2,000-char budget leaves after the rest; when
 * nothing fits there is no note. One function for the Dashboard and `npm run bug`.
 */
export function runReportLink(run: Pick<RunRow, 'state' | 'note'>, facts: Facts, redact: (text: string) => string): string {
  const note = run.note ? redact(run.note) : ''; // before any parsing or cutting, so a secret cannot be cut past its match
  const title = runTitle(note);
  const fields = { ...facts, 'run-state': run.state };
  const room = LINK_BUDGET - bugLink(fields, title).length - '&note='.length;
  if (!note || encodedLength(note) <= room) return bugLink(note ? { ...fields, note } : fields, title);
  let used = encodedLength('…');
  const kept: string[] = [];
  for (const cp of note) {
    used += encodedLength(cp);
    if (used > room) break;
    kept.push(cp);
  }
  return bugLink(kept.length ? { ...fields, note: `${kept.join('')}…` } : fields, title);
}

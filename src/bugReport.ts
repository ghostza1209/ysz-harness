import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

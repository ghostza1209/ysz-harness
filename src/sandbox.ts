import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv, promisify } from 'node:util';
import { claudeCode, createBindMountSandboxProvider, createWorktree } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import type { PlannedTicket } from './beads';
import { startCheckServer } from './checks';
import { parseStats } from './dockerStats';
import type { Prepared } from './host';
import type { Project } from './projects';
import type { AgentUsage, Footprint } from './store';

export const MODEL = 'claude-sonnet-5-5';
export const TICKET_JSON = '.orchestrator/ticket.json';

/** How an agent ended without throwing. `stopped` = no signal: it ran out of iterations or said it was blocked. */
export type AgentResult = (
  | { outcome: 'complete' }
  | { outcome: 'needs-info'; question: string }
  | { outcome: 'stopped'; tail: string }
) & { reports: AgentReports };

/** What the agent reported in its final message, whatever its outcome. */
export interface AgentReports {
  /** Work in the Project's code outside the Ticket. */
  followUps: { title: string; body: string }[];
  /** `ref` is the id of an open Friction the agent saw again; its title and body then say what happened this time. */
  friction: { title: string; body: string; ref?: string }[];
  /** Review agent only: the refs (F1...) of the Implement agent's Follow-ups it fixed with its own commits. Any text; the Orchestrator ignores a ref it did not hand out. */
  fixedFollowUps: string[];
}

/** Aborting `signal` stops the agent and tears its sandbox down: the call then rejects. */
type AgentRequest = { project: Project; runId: number; attempt: number; signal: AbortSignal; onUsage?: (usage: AgentUsage) => void;
  /** Role-relative part name ('implement', 'review', 'breakdown', and 'install' for implement's installCommand); the caller adds the Attempt. Called once per part, also when the agent failed, unless the part has no sample. */
  onFootprint?: (role: string, footprint: Footprint) => void;
} & Prepared;

export interface SandboxRunner {
  /** Whether the Project's sandbox image exists locally. Throws when docker cannot be asked, so a dead daemon is not mistaken for a missing image. */
  hasImage(project: Project): Promise<boolean>;
  /** One implement agent in a fresh sandbox on the host-prepared clone. Throws if the agent errors or idles out. */
  implement(req: AgentRequest & { previousAttemptSummary?: string }): Promise<AgentResult>;
  /** One review agent in a fresh sandbox on the same clone, after the implement agent. Throws like `implement`. */
  review(req: AgentRequest): Promise<AgentResult>;
  /**
   * One breakdown agent in a fresh sandbox on a clone of the Spec's base, with no install. `plan` is the child Tickets it
   * planned, or why its output holds no usable plan; `children` are the ids of the Spec's existing children. Throws like `implement`.
   */
  breakDown(req: AgentRequest & { previousAttemptSummary?: string; children: string[] }): Promise<AgentResult & { plan: PlannedTicket[] | string }>;
  /** Remove the Run's sandbox container now, if any is left. Throws unless it is gone afterwards: sandcastle's own teardown ignores docker errors. */
  stop(prepared: Pick<Prepared, 'dir'>): Promise<void>;
  /** Remove every leftover sandcastle container, of any Run. Throws unless none is left. */
  removeLeftovers(): Promise<void>;
}

const execFileAsync = promisify(execFile);

/**
 * Remove every container `docker ps` lists under `filter`. `docker rm -f` may lose a race with sandcastle's own removal,
 * so what counts is whether the container is gone afterwards.
 */
async function removeContainers(filter: string, dockerBin: string): Promise<void> {
  const listed = async () => (await execFileAsync(dockerBin, ['ps', '-aq', '--no-trunc', '--filter', filter], { timeout: 30_000 })).stdout.split('\n').filter(Boolean);
  const ids = await listed();
  if (!ids.length) return;
  const removal = await execFileAsync(dockerBin, ['rm', '-f', ...ids], { timeout: 60_000 }).then(() => null, (err: Error) => err);
  const left = await listed();
  if (left.length) throw new Error(`the sandbox container ${left.join(' ')} is still there${removal ? `: ${removal.message}` : ''}`);
}

/** Remove every container that mounts the Run's clone. The clone path is unique per Attempt, so this never touches another Run's or the user's own containers. */
export const stopSandbox = ({ dir }: Pick<Prepared, 'dir'>, dockerBin = 'docker') => removeContainers(`volume=${join(dir, 'repo')}`, dockerBin);

/** Remove every sandcastle container, whichever Run made it: the ones a crashed Orchestrator left behind. */
export const removeLeftoverSandboxes = (dockerBin = 'docker') => removeContainers('name=sandcastle-', dockerBin);

export async function imageExists(image: string, dockerBin = 'docker'): Promise<boolean> {
  return execFileAsync(dockerBin, ['image', 'inspect', image], { timeout: 30_000 }).then(
    () => true,
    (err: Error & { stderr?: string }) => {
      if (/No such (image|object)/i.test(err.stderr ?? '')) return false;
      throw err;
    },
  );
}

/**
 * Polls the agent's sandcastle container (the clone's `php-check-*` containers mount it too, so the name narrows it),
 * one `docker stats` in flight at a time. `readDisk()`, to be called just before teardown, ends the sampling and takes
 * the disk reading once, so du and the teardown count toward neither the time nor the CPU; `finish()` sums up, or gives
 * undefined if no sample was ever taken. None of them throws.
 * `installRan(start, end)` splits the install off: the samples inside it make `installFootprint()`, with the disk read
 * once at its end, and `finish()` keeps the rest, its network-in being what the install did not download; it gives
 * undefined if every sample fell inside the install.
 */
export function sampleFootprint(dir: string, dockerBin = 'docker', pollMs = 1000) {
  const repo = join(dir, 'repo');
  const startedAt = Date.now();
  const abort = new AbortController();
  let container = '';
  const samples: { at: number; cores: number; memory: number; rx: number }[] = [];
  const docker = (...args: string[]) => execFileAsync(dockerBin, args, { timeout: 30_000, signal: abort.signal }).then((r) => r.stdout.trim());

  const polling = (async () => {
    while (!abort.signal.aborted) {
      try {
        container ||= (await docker('ps', '-q', '--no-trunc', '--filter', 'name=sandcastle-', '--filter', `volume=${repo}`)).split('\n')[0];
        const sample = container && parseStats(await docker('stats', '--no-stream', '--format', '{{json .}}', container));
        if (sample) {
          samples.push({ at: Date.now(), ...sample });
        }
      } catch {
        // docker unreachable, or the container just went: the next poll finds out
      }
      await sleep(pollMs, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();

  // The clone with node_modules, plus the container's writable layer, where the pnpm store lives. du is slow on a big clone: once per part.
  const diskNow = () =>
    Promise.all([
      execFileAsync('du', ['-sk', repo], { timeout: 120_000 }).then((r) => Number(r.stdout.split('\t')[0]) * 1024, () => 0),
      container ? execFileAsync(dockerBin, ['inspect', '--size', '--format', '{{.SizeRw}}', container], { timeout: 30_000 }).then((r) => Number(r.stdout) || 0, () => 0) : 0,
    ]).then(([clone, layer]) => clone + layer);
  let disk: Promise<number> | undefined;
  let endedAt = 0;
  const readDisk = () => {
    if (disk) return disk;
    endedAt = Date.now();
    abort.abort();
    return (disk = diskNow());
  };

  const summarize = (part: typeof samples, from: number, ms: number, bytes: number, networkIn: number): Footprint | undefined =>
    part.length
      ? {
          startedAt: from,
          seconds: Math.round(ms / 1000),
          peakMemory: Math.max(...part.map((s) => s.memory)),
          cpuAvg: part.reduce((sum, s) => sum + s.cores, 0) / part.length,
          cpuPeak: Math.max(...part.map((s) => s.cores)),
          disk: bytes,
          networkIn,
        }
      : undefined;

  // ponytail: one install per sandbox, as the installCommand is one hook; several would need a list of windows.
  let install: { start: number; end: number; disk: Promise<number> } | undefined;
  const inInstall = (s: { at: number }) => !!install && s.at >= install.start && s.at <= install.end;
  const installFrom = () => {
    if (!install) return undefined;
    const inside = samples.filter(inInstall);
    const before = samples.filter((s) => s.at < install!.start).at(-1)?.rx ?? 0;
    return { inside, networkIn: (inside.at(-1)?.rx ?? 0) - before };
  };

  return {
    readDisk,
    /** The installCommand ran from `start` to `end`: its disk is read now, without holding the caller up. */
    installRan(start: number, end: number) {
      install = { start, end, disk: diskNow() };
    },
    async installFootprint(): Promise<Footprint | undefined> {
      await polling;
      const part = installFrom();
      return part && summarize(part.inside, install!.start, install!.end - install!.start, await install!.disk, part.networkIn);
    },
    async finish(): Promise<Footprint | undefined> {
      const bytes = await readDisk();
      await polling;
      const installed = installFrom();
      // An install window without a sample inside leaves everything, its download too, in this part.
      const split = installed?.inside.length ? installed : undefined;
      const rest = split ? samples.filter((s) => !inInstall(s)) : samples;
      const ms = endedAt - startedAt - (split ? install!.end - install!.start : 0);
      return summarize(rest, startedAt, ms, bytes, (samples.at(-1)?.rx ?? 0) - (split?.networkIn ?? 0));
    },
  };
}

const COMPLETE = '<promise>COMPLETE</promise>';
const NEEDS_INFO = '<promise>NEEDS_INFO</promise>';

const MAX_REPORTS = 3;
const MAX_TITLE = 200;
const MAX_BODY = 2000;

/** The `<tag>`s of the output, first 3 kept: the first line is the title, the rest the body. A tag opened inside another is malformed, and dropped. */
function parseTags(stdout: string, tag: string) {
  return [...stdout.matchAll(new RegExp(`<${tag}(?:\\s+ref="([^"]*)")?>((?:(?!<${tag}[\\s>])[\\s\\S])*?)</${tag}>`, 'g'))]
    .map(([, ref, text]) => {
      const [title = '', ...rest] = text.trim().split('\n');
      return { title: title.trim().slice(0, MAX_TITLE), body: rest.join('\n').trim().slice(0, MAX_BODY), ...(ref && { ref }) };
    })
    .filter((f) => f.title)
    .slice(0, MAX_REPORTS);
}

const parseReports = (stdout: string): AgentReports => ({
  followUps: parseTags(stdout, 'follow-up').map(({ title, body }) => ({ title, body })),
  friction: parseTags(stdout, 'friction'),
  fixedFollowUps: [...stdout.matchAll(/<fixed-follow-up\s+ref="([^"]*)"\s*\/>/g)].map(([, ref]) => ref),
});

const MAX_TICKETS = 30;
const MAX_TICKET_BODY = 8000;

/**
 * The `<ticket>`s of a breakdown agent's output, or why they make no plan to create. `children` are the ids of the Spec's
 * existing children (ADR 0009): a ticket may be blocked by one, and with any, a plan of no tickets says nothing is missing.
 */
export function planOf(stdout: string, children: string[]): PlannedTicket[] | string {
  const plan = [...stdout.matchAll(/<ticket\s+key="([^"]+)"(?:\s+blocked-by="([^"]*)")?\s*>([\s\S]*?)<\/ticket>/g)].map(([, key, blockedBy = '', text]) => {
    const [title = '', ...rest] = text.trim().split('\n');
    return { key, title: title.trim(), body: rest.join('\n').trim(), blockedBy: blockedBy.split(',').map((k) => k.trim()).filter(Boolean) };
  });
  if (!plan.length && !children.length) return 'it output no <ticket> tags';
  if (plan.length > MAX_TICKETS) return `it planned ${plan.length} tickets, more than ${MAX_TICKETS}`;
  const keys = new Set(plan.map((t) => t.key));
  if (keys.size < plan.length) return 'it gave two tickets the same key';
  const existing = new Set(children);
  for (const t of plan) {
    if (existing.has(t.key)) return `ticket ${t.key} has the id of an existing child as its key`;
    if (!t.title || t.title.length > MAX_TITLE) return `ticket ${t.key} has no title, or one over ${MAX_TITLE} characters`;
    if (t.body.length > MAX_TICKET_BODY) return `ticket ${t.key} has a body over ${MAX_TICKET_BODY} characters`;
    const unknown = t.blockedBy.find((k) => !keys.has(k) && !existing.has(k));
    if (unknown) return `ticket ${t.key} is blocked by ${unknown}, which is neither a ticket in the plan nor a child of the Spec`;
  }
  // bd refuses a cycle too, but finding it here lets the next Attempt hear about it.
  const byKey = new Map(plan.map((t) => [t.key, t]));
  const done = new Set<string>();
  const onPath = new Set<string>();
  const cycleAt = (key: string): string | undefined => {
    if (onPath.has(key)) return key;
    if (done.has(key) || existing.has(key)) return undefined; // nothing in the plan blocks an existing child
    onPath.add(key);
    for (const b of byKey.get(key)!.blockedBy) {
      const found = cycleAt(b);
      if (found) return found;
    }
    onPath.delete(key);
    done.add(key);
  };
  for (const t of plan) {
    const key = cycleAt(t.key);
    if (key) return `ticket ${key} is blocked by itself through its blockers`;
  }
  return plan;
}

export function agentResult({ completionSignal, stdout }: { completionSignal?: string; stdout: string }): AgentResult {
  const reports = parseReports(stdout);
  // sandcastle reports the first signal in its list that the output holds anywhere, so COMPLETE wins over a NEEDS_INFO
  // given after it. The signal the agent ended on is the one that counts.
  if (completionSignal === undefined) return { outcome: 'stopped', tail: stdout.trim().slice(-500), reports };
  if (stdout.lastIndexOf(NEEDS_INFO) > stdout.lastIndexOf(COMPLETE)) {
    const question = [...stdout.matchAll(/<question>([\s\S]*?)<\/question>/g)].at(-1)?.[1].trim();
    return { outcome: 'needs-info', question: question || 'the agent signalled NEEDS_INFO without a <question>', reports };
  }
  return { outcome: 'complete', reports };
}

type Usage = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
const input = (u: Usage) => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;

/**
 * Reads the agent's usage off its raw stream-json lines and reports each change. Claude repeats a message's usage on
 * every content block, so messages count once by id. Their output_tokens fall short, so a result's modelUsage, the
 * whole session's total with subagents, wins; a result's own usage does not add up to that, and a later one may be 0.
 */
export function usageTracker(onUsage: (usage: AgentUsage) => void): (line: string) => void {
  const messages = new Map<string, number>();
  let context = 0;
  let tokens = 0;
  return (line) => {
    if (!line.startsWith('{"type":"assistant"') && !line.includes('"type":"result"')) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const prev = `${context}/${tokens}`;
    if (event.type === 'assistant' && event.message?.usage) {
      const u: Usage = event.message.usage;
      // A subagent's messages cost tokens but live in its own context.
      if (!event.parent_tool_use_id) context = input(u);
      messages.set(event.message.id, input(u) + u.output_tokens);
      tokens = [...messages.values()].reduce((a, b) => a + b, 0);
    } else if (event.type === 'result' && event.modelUsage) {
      const models: { inputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; outputTokens: number }[] = Object.values(event.modelUsage);
      tokens = models.reduce((sum, m) => sum + m.inputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens + m.outputTokens, 0);
    }
    if (`${context}/${tokens}` !== prev) onUsage({ context, tokens });
  };
}

type CreateSandbox = Parameters<typeof createBindMountSandboxProvider>[0]['create'];
type SandboxHandle = Awaited<ReturnType<CreateSandbox>>;

/**
 * Append `command`'s output to `logPath` as it runs, each line indented so the Run log shows it under the setup step.
 * sandcastle's file log holds a hook's output back until the hook ends, so a long install looks hung.
 */
export function teeCommand(handle: SandboxHandle, command: string, logPath: string, onRan?: (startedAt: number, endedAt: number) => void): SandboxHandle {
  const write = (line: string) => appendFileSync(logPath, `  ${line}\n`);
  return {
    ...handle,
    exec: async (cmd, opts) => {
      if (cmd !== command) return handle.exec(cmd, opts);
      const startedAt = Date.now();
      const result = await handle.exec(cmd, { ...opts, onLine: write });
      onRan?.(startedAt, Date.now());
      // onLine gets stdout only: stderr comes back once the command ends.
      for (const line of result.stderr.split('\n').filter(Boolean)) write(line);
      return result;
    },
  };
}

/** `root` is the ysz-harness checkout: it holds the central .env and prompts/; logs go to `<root>/data/logs/<runId>-attempt<n>-<role>.log`. */
export function createSandboxRunner(root: string): SandboxRunner {
  async function runAgent(
    role: 'implement' | 'review' | 'breakdown',
    { project, runId, attempt, branch, dir, key, signal, onUsage, onFootprint }: AgentRequest,
    promptArgs: Record<string, string>,
  ): Promise<{ completionSignal?: string; stdout: string }> {
    signal.throwIfAborted();
    // Read per Run, so adding the token needs no restart. It reaches the sandbox only through the agent's env.
    const token = parseEnv(readFileSync(join(root, '.env'), 'utf8')).CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is missing from the ysz-harness .env');
    mkdirSync(join(root, 'data/logs'), { recursive: true });
    const logPath = join(root, 'data/logs', `${runId}-attempt${attempt}-${role}.log`);

    // sandcastle runs host git in its cwd and worktree, also after the agent has run. Give it an empty repo the
    // sandbox never sees; the sandbox mounts only the clone. Its commit count is then always 0: publish counts instead.
    const decoy = join(dir, `decoy-${role}`);
    execFileSync('git', ['init', '--quiet', decoy]);
    execFileSync('git', ['-c', 'user.name=ysz-harness', '-c', 'user.email=ysz-harness@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'decoy'], { cwd: decoy });
    const worktree = await createWorktree({ cwd: decoy, branchStrategy: { type: 'branch', branch } });

    // Review mounts the clone implement left, node_modules included. Its store died with implement's container, so
    // installing again re-downloads everything (1m48s-2m49s in Runs 12-14).
    const installCommand = role === 'implement' ? project.installCommand : undefined;
    const inner = docker({ imageName: project.image, containerUid: project.containerUid, containerGid: project.containerGid });
    // docker's provider has create() at runtime; its public type hides it.
    const create = (inner as unknown as { create: CreateSandbox }).create;
    let sampler: ReturnType<typeof sampleFootprint> | undefined;
    const sandbox = createBindMountSandboxProvider({
      ...inner,
      create: async (opts) => {
        const handle = await create({ ...opts, mounts: [{ hostPath: join(dir, 'repo'), sandboxPath: '/home/agent/workspace' }] });
        const started = sampleFootprint(dir);
        sampler = started;
        const teed = installCommand ? teeCommand(handle, installCommand, logPath, started.installRan) : handle;
        // The writable layer dies with the container, so the disk is read just before the real close.
        return {
          ...teed,
          close: async () => {
            await started.readDisk();
            return teed.close();
          },
        };
      },
    });

    // ADR 0002: the agent's only way to run PHP checks; it ends with the agent.
    const checks = project.checkContainer && role !== 'breakdown' ? await startCheckServer({ ...project.checkContainer, clone: join(dir, 'repo') }) : undefined;
    const env = { CLAUDE_CODE_OAUTH_TOKEN: token, ...(checks && { PHP_CHECK_URL: checks.url, PHP_CHECK_TOKEN: checks.token }) };

    const track = onUsage && usageTracker(onUsage);
    try {
      const result = await worktree.run({
        // No session capture: it copies a sandbox-written transcript to a host path built from the stream's session id.
        agent: claudeCode(MODEL, { effort: 'high', env, captureSessions: false }),
        // No .beads, no ssh, no push credentials, and no host git dir: the clone's .git is its own.
        sandbox,
        // sandcastle resolves promptFile against process.cwd(), so it must be absolute.
        promptFile: join(root, `prompts/${role}.md`),
        promptArgs: { CHECK_HINT: project.checkHint ?? "Run the repo's own lint and unit-test commands.", TICKET_JSON, KEY: key, ...promptArgs },
        completionSignal: [COMPLETE, NEEDS_INFO],
        idleTimeoutSeconds: 600,
        signal,
        name: `run-${runId}-attempt${attempt}-${role}`,
        logging: { type: 'file', path: logPath, onAgentStreamEvent: track && ((e) => e.type === 'raw' && track(e.line)) },
        hooks: installCommand
          ? { sandbox: { onSandboxReady: [{ command: installCommand, timeoutMs: 600_000 }] } }
          : undefined,
      });
      return result;
    } finally {
      // Also for a killed or failed agent: whatever was sampled counts.
      const footprint = await sampler?.finish();
      if (footprint) onFootprint?.(role, footprint);
      const install = await sampler?.installFootprint();
      if (install) onFootprint?.('install', install);
      await checks?.close();
      const checksFootprint = await checks?.footprint();
      if (checksFootprint) onFootprint?.(`${role}-checks`, checksFootprint);
    }
  }

  const previousAttempt = (summary?: string) =>
    summary ? `## Previous attempt\n\nAn earlier attempt at this Ticket failed, and its work is discarded. Do not repeat its mistake:\n\n${summary}\n` : '';

  return {
    hasImage: (project) => imageExists(project.image!),
    implement: async ({ previousAttemptSummary, ...req }) => agentResult(await runAgent('implement', req, { PREVIOUS_ATTEMPT: previousAttempt(previousAttemptSummary) })),
    review: async (req) => agentResult(await runAgent('review', req, { BASE: req.base })),
    breakDown: async ({ previousAttemptSummary, children, ...req }) => {
      const result = await runAgent('breakdown', req, { PREVIOUS_ATTEMPT: previousAttempt(previousAttemptSummary) });
      return { ...agentResult(result), plan: planOf(result.stdout, children) };
    },
    stop: (prepared) => stopSandbox(prepared),
    removeLeftovers: () => removeLeftoverSandboxes(),
  };
}

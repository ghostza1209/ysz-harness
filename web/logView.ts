/** One readable piece of a Run log: a separator, an orchestration step, a tool call, or the agent's own words. */
export type LogBlock =
  | { kind: 'rule'; text: string }
  /** `since` (epoch ms) is set on a setup step still running at the end of the log. */
  | { kind: 'step'; text: string; sub: string[]; since?: number }
  | { kind: 'tool'; name: string; text: string }
  | { kind: 'message'; text: string };

/** The status lines sandcastle and the host write between agent output. */
const STEP = /^(Iteration \d+\/\d+|Resuming session|Capturing session|Agent (started|stopped|idle for .*|signaled completion.*)|Reached max iterations.*|Run complete:.*|Setting up .*|PR opened: .*|Failed: .*)$/;
const RULE = /^--- (.*) ---$/;
// Claude's tool names are capitalised (Bash, Read) or mcp__…, unlike calls inside a heredoc body (open(p), feat(x):).
const TOOL = /^(mcp__[\w-]+|[A-Z]\w*)\(/;
const IDLE = /^Agent idle for \d+ minutes?$/;
const DONE =/^(.+) done \(\d+(?:\.\d+)?s\)$/;

/**
 * Splits plain log text into blocks. A block starts at a step, rule or tool-call line; lines before the first one are
 * dropped, since they are the cut-off end of a block the tail sliced through.
 */
export function parseLog(text: string): LogBlock[] {
  const lines = text.split('\n');
  // A line sandcastle later closes with "<line> done (Ns)" is a step too, whatever its wording.
  const closed = new Set(lines.flatMap((l) => DONE.exec(l)?.[1] ?? []));
  const isStep = (l: string) => STEP.test(l) || closed.has(l) || DONE.test(l);

  const blocks: LogBlock[] = [];
  let group: string[] | null = null;
  const flush = () => {
    if (group) blocks.push(...toBlocks(group));
    group = null;
  };
  // The host log, after its "--- Push & PR started" rule, holds only step lines.
  let host = false;
  for (const line of lines) {
    host ||= line.startsWith('--- Push & PR started');
    if (RULE.test(line) || isStep(line) || TOOL.test(line) || (host && line.trim())) {
      flush();
      group = [line];
    } else group?.push(line);
  }
  flush();

  // "X done (Ns)" closes the step X right before it, and an idle warning replaces the one right before it.
  const out = blocks.reduce<LogBlock[]>((acc, b) => {
    const prev = acc.at(-1);
    const merges =
      b.kind === 'step' &&
      prev?.kind === 'step' &&
      (DONE.exec(b.text)?.[1] === prev.text || (IDLE.test(b.text) && IDLE.test(prev.text)));
    if (merges) acc[acc.length - 1] = { ...prev, text: b.text, sub: [...prev.sub, ...b.sub] };
    else acc.push(b);
    return acc;
  }, []);

  const last = out.at(-1);
  if (last?.kind === 'step' && last.text.startsWith('Setting up ') && !DONE.test(last.text)) {
    // Setup begins as its agent log does, so that log's "Run started" time is when this step started.
    const started = out.findLast((b) => b.kind === 'rule' && b.text.startsWith('Run started: '));
    if (started) last.since = Date.parse(started.text.slice('Run started: '.length));
  }
  return out;
}

/** One block start line plus the lines up to the next start: indented lines right under a step belong to it, the rest is agent text. */
function toBlocks([head, ...rest]: string[]): LogBlock[] {
  const message = (ls: string[]): LogBlock[] => {
    const t = ls.join('\n').trim();
    return t ? [{ kind: 'message', text: t }] : [];
  };
  const rule = RULE.exec(head);
  if (rule) return [{ kind: 'rule', text: rule[1] }, ...message(rest)];
  const tool = TOOL.exec(head);
  if (tool) {
    // ponytail: a call ends at its last line ending in ")", so agent text that itself ends in ")" folds into the call;
    // use sandcastle's onAgentStreamEvent if that matters.
    // With no ")" yet the call is still streaming in, so all of it is the call.
    const end = rest.findLastIndex((l) => l.trimEnd().endsWith(')'));
    const n = head.trimEnd().endsWith(')') ? 0 : end >= 0 ? end + 1 : rest.length;
    return [{ kind: 'tool', name: tool[1], text: [head, ...rest.slice(0, n)].join('\n').trimEnd() }, ...message(rest.slice(n))];
  }
  const n = rest.findIndex((l) => !l.startsWith(' ') || !l.trim());
  const sub = n < 0 ? rest : rest.slice(0, n);
  return [{ kind: 'step', text: head, sub }, ...message(rest.slice(sub.length))];
}

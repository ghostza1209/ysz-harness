/** Which Runs offer a Bug report. Browser and server share this file, so it imports nothing from Node. */
import type { RunState } from './store';

/**
 * ysz never judges the cause of a Run's end: its state and note cannot tell ysz's own bug from an agent that could not
 * finish, so the reporter decides. `live`: the Run holds a slot, so the human Kills it first (Kill keeps the Run log and
 * the Clone). `goal`: the Run reached its goal, so a bug in it is a general report, even when its log shows a ysz error.
 */
export type Reportability = { ok: true } | { ok: false; kind: 'live' | 'goal' };

const REPORTABLE: readonly RunState[] = ['failed', 'killed', 'interrupted', 'needs-attention'];
const LIVE: readonly RunState[] = ['claimed', 'agent', 'agent-review', 'host'];

export function reportable(state: RunState): Reportability {
  if (REPORTABLE.includes(state)) return { ok: true };
  return { ok: false, kind: LIVE.includes(state) ? 'live' : 'goal' };
}

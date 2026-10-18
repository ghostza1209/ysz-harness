import type { RunRow, RunState } from '../src/store';

export type Cue = 'click' | 'step' | 'good' | 'bad';

const BAD: RunState[] = ['failed', 'killed', 'needs-attention', 'interrupted'];

/**
 * The Runs that changed state since the last poll, new ones included. An unseen Run older than every seen one is not new:
 * it came back into the list (unarchived, paged in by Show more, or moved up as newer rows were deleted or archived).
 */
function changed(prev: Map<number, RunState>, runs: RunRow[]): RunRow[] {
  const newest = Math.max(...prev.keys());
  return runs.filter((r) => (prev.has(r.id) ? prev.get(r.id) !== r.state : r.id > newest));
}

/** The cue for what changed since the last poll: the worst news wins, a new Run counts as a step. */
export function stageCue(prev: Map<number, RunState>, runs: RunRow[]): Cue | null {
  const moved = changed(prev, runs).map((r) => r.state);
  if (moved.some((s) => BAD.includes(s))) return 'bad';
  if (moved.includes('in-review')) return 'good';
  return moved.length ? 'step' : null;
}

/** The Runs that reached In review with a PR since the last poll, oldest first: the newest stacks last and survives a cap. */
export const openedPrs = (prev: Map<number, RunState>, runs: RunRow[]) =>
  changed(prev, runs)
    .filter((r) => r.state === 'in-review' && r.prUrl)
    .sort((a, b) => a.id - b.id);

/** Notes in Hz and how long each lasts, in seconds. */
const NOTES: Record<Cue, [number[], number]> = {
  click: [[880], 0.04],
  step: [[660, 880], 0.09],
  good: [[523, 659, 784], 0.12],
  bad: [[392, 262], 0.18],
};

let ctx: AudioContext | undefined;

/** Silent mode, remembered across visits. */
export let muted = (() => {
  try {
    return localStorage.getItem('muted') === '1';
  } catch {
    return false;
  }
})();

export function setMuted(on: boolean) {
  muted = on;
  try {
    localStorage.setItem('muted', on ? '1' : '0');
  } catch {}
}

/** Plays a cue with Web Audio. Browsers keep it silent until the first click on the page. */
export function play(cue: Cue) {
  if (muted) return;
  ctx ??= new AudioContext();
  const [freqs, len] = NOTES[cue];
  freqs.forEach((f, i) => {
    const at = ctx!.currentTime + i * len;
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.12, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + len);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(at);
    osc.stop(at + len);
  });
}

import type { RunRow, RunState } from '../src/store';

export type Cue = 'click' | 'step' | 'good' | 'bad';

const BAD: RunState[] = ['failed', 'killed', 'needs-attention', 'interrupted'];

/** The cue for what changed since the last poll: the worst news wins, a Run seen for the first time counts as a step. */
export function stageCue(prev: Map<number, RunState>, runs: RunRow[]): Cue | null {
  const moved = runs.filter((r) => prev.get(r.id) !== r.state).map((r) => r.state);
  if (moved.some((s) => BAD.includes(s))) return 'bad';
  if (moved.includes('in-review')) return 'good';
  return moved.length ? 'step' : null;
}

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

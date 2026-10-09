/// <reference types="vite/client" />
import type { State } from './App';
import type { Dict } from './i18n';

const MIN = 60_000;

/** What the Dashboard shows during the tour: one of every card and control the tour points at. Negative ids never reach the API. */
export function sampleState(now: number): State {
  const run = { prUrl: null, note: null, endedAt: null, cloneDir: null };
  return {
    slots: { used: 1, total: 2 },
    projects: [
      { name: 'shop', ready: 2, paused: false, error: null },
      { name: 'blog', ready: 0, paused: true, error: null },
    ],
    runs: {
      live: [
        { ...run, id: -1, project: 'shop', ticketId: 'shop-a1', title: 'Add a stock check before checkout', state: 'agent-review', attempt: 1, startedAt: now - 7 * MIN, cloneDir: '~/.ysz/clones/shop-a1' },
        { ...run, id: -2, project: 'blog', ticketId: 'blog-c3', title: 'Fix the broken RSS feed date', state: 'needs-attention', attempt: 1, startedAt: now - 42 * MIN, cloneDir: '~/.ysz/clones/blog-c3', note: 'git push failed: remote rejected' },
      ],
      history: [
        { ...run, id: -3, project: 'shop', ticketId: 'shop-9f', title: 'Show prices in the user’s currency', state: 'in-review', attempt: 1, startedAt: now - 180 * MIN, endedAt: now - 150 * MIN, prUrl: 'https://github.com/example/shop/pull/42' },
        { ...run, id: -4, project: 'blog', ticketId: 'blog-7b', title: 'Paginate the archive page', state: 'failed', attempt: 2, startedAt: now - 26 * 60 * MIN, endedAt: now - 25 * 60 * MIN, cloneDir: '~/.ysz/clones/blog-7b', note: 'Tests still failing after 2 Attempts' },
      ],
    },
    ready: [
      { project: 'shop', id: 'shop-b2', title: 'Email a receipt after payment', priority: 1, ageMs: 3 * 60 * MIN, waitReason: 'Project already has a Run', runNow: false },
      { project: 'shop', id: 'shop-d4', title: 'Rename the cart button', priority: 3, ageMs: 2 * 24 * 60 * MIN, waitReason: 'Project already has a Run', runNow: false },
    ],
  };
}

/** The live log tail a sample Run shows. */
export const SAMPLE_LOG = ['--- Attempt 1 started ---', 'Agent started', 'Read(src/checkout.ts)', 'Bash(npm test)', 'Added the stock check; all tests pass.'].join('\n');

/**
 * Walks the Dashboard step by step, in the language of `t`. The page underneath is inert, so neither clicks nor the keyboard
 * reach its controls. Calls `onEnd` once closed, however it closed.
 */
export async function startTour(t: Dict, onEnd: () => void) {
  const root = document.getElementById('root')!;
  // Inert before the import, so the sample cards never take a click while driver.js loads.
  root.inert = true;
  const [{ driver }] = await Promise.all([import('driver.js'), import('driver.js/dist/driver.css')]).catch((e: Error) => {
    root.inert = false;
    throw e;
  });
  const at = (tour: string) => `[data-tour="${tour}"]`;
  const steps = (['slots', 'summary', 'projects', 'live', 'ready', 'history', 'prefs'] as const).map((k) => ({
    element: at(k),
    popover: { title: t.tour[k].title, description: t.tour[k].body },
  }));
  driver({
    showProgress: true,
    progressText: t.tour.progress,
    nextBtnText: t.tour.next,
    prevBtnText: t.tour.prev,
    doneBtnText: t.tour.done,
    popoverClass: 'ysz-tour',
    onDestroyed: () => {
      root.inert = false;
      onEnd();
    },
    steps: [{ popover: { title: t.tour.intro.title, description: t.tour.intro.body } }, ...steps],
  }).drive();
}

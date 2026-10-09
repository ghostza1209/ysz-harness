import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectStatus, QueueItem } from '../src/core';
import { dicts, en, type Dict, type Lang } from './i18n';
import { parseLog, type LogBlock } from './logView';
import { muted, play, setMuted, stageCue } from './sound';
import { SAMPLE_LOG, sampleState, startTour } from './tour';
import type { RunRow, RunState } from '../src/store';

export interface State {
  slots: { used: number; total: number };
  ready: QueueItem[];
  runs: { live: RunRow[]; history: RunRow[] };
  projects: ProjectStatus[];
}

const REFRESH_MS = 5_000;

const T = createContext<Dict>(en);
const useT = () => useContext(T);

/** The language last picked here, else the browser's. */
function savedLang(): Lang {
  try {
    const l = localStorage.getItem('lang');
    if (l === 'en' || l === 'th') return l;
  } catch {}
  return navigator.language.startsWith('th') ? 'th' : 'en';
}

/** Flips light/dark and remembers it; until clicked, the OS setting decides. */
function ThemeToggle() {
  const t = useT();
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches),
  );
  const flip = () => {
    const theme = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {}
    setDark(!dark);
  };
  return (
    <button className="ghost theme" onClick={flip} aria-label={dark ? t.toLight : t.toDark} title={dark ? t.lightMode : t.darkMode}>
      {dark ? '☀' : '☾'}
    </button>
  );
}

/** Turns the click and stage sounds on or off. */
function SoundToggle() {
  const t = useT();
  const [off, setOff] = useState(muted);
  const flip = () => {
    setMuted(!off);
    setOff(!off);
  };
  return (
    <button className="ghost theme" onClick={flip} aria-pressed={off} aria-label={off ? t.soundOnLabel : t.muteLabel} title={off ? t.soundOn : t.silentMode}>
      {off ? '🔇' : '🔊'}
    </button>
  );
}

/** Longest tail kept in the browser, in characters. */
const TAIL_CHARS = 32_000;

/** Tool calls longer than this, or over one line, show folded to their first line. */
const FOLD_CHARS = 120;

/** One block of the log view. Every string goes in as a text node, never as markup. */
const Block = memo(function Block({ b, now }: { b: LogBlock; now: number }) {
  const t = useT();
  if (b.kind === 'rule') return <div className="log-rule">{b.text}</div>;
  if (b.kind === 'message') return <div className="log-msg">{b.text}</div>;
  if (b.kind === 'step')
    return (
      <div className={`log-step ${b.text.startsWith('Failed:') ? 'bad' : ''}`}>
        {b.text}
        {b.since !== undefined && (
          <>
            {' · '}
            <span className="elapsed">{span(now - b.since, t)}</span>
            <span className="waiting" />
          </>
        )}
        {b.sub.map((l, i) => (
          <div className="log-sub" key={i}>
            {l.trim()}
          </div>
        ))}
      </div>
    );
  const args = b.text.slice(b.name.length + 1).replace(/\)$/, '');
  const name = <span className="log-tool-name">{b.name}</span>;
  if (!args.includes('\n') && args.length <= FOLD_CHARS)
    return (
      <div className="log-tool">
        {name} {args}
      </div>
    );
  return (
    <details className="log-tool">
      <summary>
        {name} {args.split('\n')[0].slice(0, FOLD_CHARS)}…
      </summary>
      <pre>{args}</pre>
    </details>
  );
});

/** The live tail of one Run's log, as steps, tool calls and agent messages. */
function LogTail({ runId, now }: { runId: number; now: number }) {
  const t = useT();
  // A tour sample (negative id) shows a canned tail and never opens a stream.
  const [text, setText] = useState(runId < 0 ? SAMPLE_LOG : '');
  const blocks = useMemo(() => parseLog(text), [text]);
  const box = useRef<HTMLDivElement>(null);
  // Follow the tail only while the reader sits at the bottom; scrolling up to read stops it.
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current) box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [text]);
  useEffect(() => {
    if (runId < 0) return;
    const source = new EventSource(`/api/runs/${runId}/log/stream`);
    const data = (e: Event) => JSON.parse((e as MessageEvent<string>).data) as string;
    // A `tail` replaces the text: the stream sends one on every (re)connect.
    source.addEventListener('tail', (e) => setText(data(e)));
    source.addEventListener('log', (e) => setText((t) => (t + data(e)).slice(-TAIL_CHARS)));
    // The server closes when the Run ends; without this the browser would reconnect.
    source.addEventListener('end', () => source.close());
    return () => source.close();
  }, [runId]);
  return (
    <div
      className="log"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {blocks.length ? (
        // Only a running step reads the clock, so the per-second tick re-renders just that block.
        blocks.map((b, i) => <Block b={b} now={b.kind === 'step' && b.since !== undefined ? now : 0} key={i} />)
      ) : (
        <span className="waiting">{t.waitingForAgent}</span>
      )}
    </div>
  );
}

/** A Run's whole log in a modal: formatted like the live tail, or raw to read and copy as is. */
function LogDialog({ run, onClose }: { run: RunRow; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  // ponytail: fetches and renders the whole log at once; virtualize or page it if multi-MB logs get slow.
  const blocks = useMemo(() => (text === null ? [] : parseLog(text)), [text]);
  useEffect(() => {
    ref.current?.showModal();
    const ctl = new AbortController();
    fetch(`/api/runs/${run.id}/log`, { signal: ctl.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setText)
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message));
    return () => ctl.abort();
  }, [run.id]);
  const copy = () =>
    void navigator.clipboard.writeText(text ?? '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  return (
    <dialog className="log-dialog" ref={ref} onClose={onClose} onClick={(e) => e.target === e.currentTarget && ref.current?.close()}>
      <div className="row">
        <b>{t.log}</b>
        <code>{run.ticketId}</code>
        <span className="grow" />
        <div className="chips" role="group" aria-label={t.logView}>
          <button className={`chip ${raw ? '' : 'on'}`} aria-pressed={!raw} onClick={() => setRaw(false)}>
            {t.formatted}
          </button>
          <button className={`chip ${raw ? 'on' : ''}`} aria-pressed={raw} onClick={() => setRaw(true)}>
            {t.raw}
          </button>
        </div>
        <button className="small" onClick={copy} disabled={!text}>
          {copied ? t.copied : t.copy}
        </button>
        <a href={`/api/runs/${run.id}/log`} target="_blank" rel="noreferrer">
          {t.open}
        </a>
        <button className="ghost small" aria-label={t.close} onClick={() => ref.current?.close()}>
          ✕
        </button>
      </div>
      <div className="log">
        {error ? (
          <span className="log-step bad">{t.logFailed(error)}</span>
        ) : text === null ? (
          <span className="waiting">{t.loading}</span>
        ) : raw ? (
          text
        ) : blocks.length ? (
          blocks.map((b, i) => <Block b={b} now={0} key={i} />)
        ) : (
          <span className="waiting">{t.emptyLog}</span>
        )}
      </div>
    </dialog>
  );
}

// English keeps the browser's own clock format.
const time = (ms: number, t: Dict) => new Date(ms).toLocaleTimeString(t === en ? [] : t.locale, { hour: '2-digit', minute: '2-digit' });
const span = (ms: number, { units: u }: Dict) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}${u.s}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${u.m} ${String(s % 60).padStart(2, '0')}${u.s}`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}${u.h} ${m % 60}${u.m}` : `${Math.floor(h / 24)}${u.d} ${h % 24}${u.h}`;
};
const ago = (ms: number, t: Dict) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return t.justNow;
  if (m < 60) return t.ago(`${m}${t.units.m}`);
  const h = Math.floor(m / 60);
  return t.ago(h < 24 ? `${h}${t.units.h}` : `${Math.floor(h / 24)}${t.units.d}`);
};
/** A stage's name for the states on the stage bar, so pills and bar agree. */
const label = (state: string) => STAGE_NAMES[state as keyof typeof STAGE_NAMES] ?? state.replace('-', ' ');
const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

/** A live Run's path to a PR. needs-attention is a stuck host step. */
const STAGES = ['claimed', 'agent', 'agent-review', 'host', 'pr'] as const;
const STAGE_NAMES = { claimed: 'Claimed', agent: 'Implement', 'agent-review': 'Agent review', host: 'Push & PR', pr: 'In review' };
function Stages({ state }: { state: RunRow['state'] }) {
  const t = useT();
  const at = STAGES.indexOf(state === 'needs-attention' ? 'host' : (state as (typeof STAGES)[number]));
  return (
    <ol className="stages" aria-label={t.progress}>
      {STAGES.map((s, i) => (
        <li key={s} className={i < at ? 'done' : i === at ? (state === 'needs-attention' ? 'stuck' : 'now') : ''}>
          <span />
          {STAGE_NAMES[s]}
        </li>
      ))}
    </ol>
  );
}

function Copy({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      title={t.copyThis(text)}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      <code>{text}</code>
      <span className={`copied ${done ? 'show' : ''}`}>{done ? t.copied : '⧉'}</span>
    </button>
  );
}

function Empty({ icon, title, hint }: { icon: string; title: string; hint: string }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden>
        {icon}
      </span>
      <b>{title}</b>
      <span>{hint}</span>
    </div>
  );
}

interface Toast {
  id: number;
  text: string;
  bad: boolean;
}

const FILTERS = {
  all: () => true,
  'in-review': (s: string) => s === 'in-review',
  merged: (s: string) => s === 'merged',
  'pr-closed': (s: string) => s === 'pr-closed',
  failed: (s: string) => s === 'failed' || s === 'interrupted',
  killed: (s: string) => s === 'killed',
};

/** The error a 401 from /api/state stands for: this browser has no Dashboard cookie. */
const SIGNED_OUT = 'signed out';

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const [project, setProject] = useState('');
  const [query, setQuery] = useState('');
  const [logRun, setLogRun] = useState<RunRow | null>(null);
  const [lang, setLang] = useState(savedLang);
  // The sample state shown while the tour runs; real polling carries on underneath.
  const [demo, setDemo] = useState<State | null>(null);
  const t = dicts[lang];
  // Each Run's state at the last poll; null until the first one, so opening the page stays quiet.
  const seen = useRef<Map<number, RunState> | null>(null);

  const load = () =>
    fetch('/api/state')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.status === 401 ? SIGNED_OUT : `HTTP ${res.status}`))))
      .then((s: State) => {
        const runs = [...s.runs.live, ...s.runs.history];
        const cue = seen.current && stageCue(seen.current, runs);
        if (cue) play(cue);
        seen.current = new Map(runs.map((r) => [r.id, r.state]));
        setState(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem('lang', lang);
    } catch {}
  }, [lang]);

  // Starts once the sample state has rendered, so every step's element exists.
  useEffect(() => {
    // A failed import (e.g. a rebuilt dist) must not leave the sample state up.
    if (demo) startTour(t, () => setDemo(null)).catch(() => setDemo(null));
  }, [demo]);

  useEffect(() => {
    void load();
    const poll = setInterval(load, REFRESH_MS);
    // Drives the elapsed timers on live Runs.
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const click = (e: MouseEvent) => (e.target as Element).closest('button') && play('click');
    document.addEventListener('click', click);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener('click', click);
    };
  }, []);

  const toast = (text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 8000 : 3500);
  };

  /** A control: POST it, toast the outcome (or why the server refused), and refresh. */
  const post = async (url: string, done: string) => {
    const res = await fetch(url, { method: 'POST' }).catch((e: Error) => e);
    if (res instanceof Error) toast(res.message, true);
    else if (res.ok) toast(done);
    else toast(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`, true);
    await load();
  };
  /** Pause every picking Project, or resume all once every one is paused: one POST each, one toast. */
  const pauseAll = async (resume: boolean) => {
    const targets = state!.projects.filter((p) => p.paused === resume);
    const res = await Promise.all(targets.map((p) => fetch(`/api/projects/${encodeURIComponent(p.name)}/${resume ? 'resume' : 'pause'}`, { method: 'POST' }).catch(() => null)));
    const failed = targets.filter((_, i) => !res[i]?.ok).map((p) => p.name);
    const names = failed.join(', ');
    toast(failed.length ? (resume ? t.couldNotResume(names) : t.couldNotPause(names)) : resume ? t.resumedAll : t.pausedAll, failed.length > 0);
    await load();
  };
  const act = (r: RunRow, action: 'kill' | 'retry' | 'cleanup', done: (id: string) => string) => post(`/api/runs/${r.id}/${action}`, done(r.ticketId));
  const kill = (r: RunRow) => {
    if (window.confirm(t.killConfirm(r.ticketId))) void act(r, 'kill', t.killed);
  };
  const runNow = (q: QueueItem) => {
    if (window.confirm(t.runNowConfirm(q.id, q.project)))
      void post(`/api/projects/${encodeURIComponent(q.project)}/run-now/${encodeURIComponent(q.id)}`, t.runNowDone(q.id));
  };

  const view = demo ?? state;
  const shownError = demo ? null : error;
  const slots = view?.slots ?? { used: 0, total: 2 };
  const history = view?.runs.history ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter(
      (r) =>
        FILTERS[filter](r.state) &&
        (!project || r.project === project) &&
        (!q || r.ticketId.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)),
    );
  }, [history, filter, project, query]);
  const allPaused = !!view && view.projects.length > 0 && view.projects.every((p) => p.paused);
  const stats = view && [
    { key: 'live', n: view.runs.live.length, label: 'Running' },
    { key: 'ready', n: view.ready.length, label: 'Ready' },
    { key: 'review', n: history.filter((r) => r.state === 'in-review').length, label: 'In review' },
    { key: 'failed', n: history.filter((r) => FILTERS.failed(r.state)).length, label: 'Failed' },
  ];

  return (
    <T.Provider value={t}>
      <header className="topbar">
        <div className="brand">
          <img className={`logo ${view?.runs.live.length ? 'spin' : ''}`} src="/logo.svg" alt="" width={20} height={20} />
          ysz
        </div>
        <div className="slots" title={t.slotsTitle} data-tour="slots">
          <span className="mute">{t.slots}</span>
          {Array.from({ length: slots.total }, (_, i) => (
            <span key={i} className={`slot ${i < slots.used ? 'on' : ''}`} />
          ))}
          <b>
            {slots.used}/{slots.total}
          </b>
        </div>
        <span className="grow" />
        <div className="prefs" data-tour="prefs">
          <button className="ghost theme" onClick={() => setLang(lang === 'en' ? 'th' : 'en')} aria-label={t.switchLangLabel} title={t.switchLangLabel}>
            {t.switchLang}
          </button>
          <SoundToggle />
          <ThemeToggle />
          <button className="ghost theme" onClick={() => setDemo(sampleState(Date.now()))} aria-label={t.startTour} title={t.startTour}>
            ?
          </button>
          <span className={`conn ${shownError ? 'down' : view ? 'up' : ''}`}>
            {shownError === SIGNED_OUT ? t.signedOut : shownError ? t.unreachable : view ? t.live : t.connecting}
          </span>
        </div>
      </header>

      {view && (
        <div className="summary" data-tour="summary">
          {stats!.map((s) => (
            <span key={s.key} className={`stat ${s.key} ${s.n ? 'has' : ''}`}>
              <b key={s.n} className="num">
                {s.n}
              </b>{' '}
              {s.label}
            </span>
          ))}
          <span className="grow" />
          {view.projects.length > 1 && (
            <button className="project" onClick={() => void pauseAll(allPaused)} title={allPaused ? t.resumeAllTitle : t.pauseAllTitle}>
              {allPaused ? t.resumeAll : t.pauseAll}
            </button>
          )}
          {view.projects.map((p, i) => (
            <button
              key={p.name}
              data-tour={i === 0 ? 'projects' : undefined}
              className={`project ${p.paused ? 'paused' : ''} ${p.error ? 'error' : ''}`}
              role="switch"
              aria-checked={!p.paused}
              aria-label={p.paused ? t.resumeProject(p.name) : t.pauseProject(p.name)}
              title={`${p.error ? `${p.error}\n` : ''}${t.projectTitle(p.paused, p.ready)}`}
              onClick={() => void post(`/api/projects/${encodeURIComponent(p.name)}/${p.paused ? 'resume' : 'pause'}`, p.paused ? t.resumedProject(p.name) : t.pausedProject(p.name))}
            >
              <span className={`dot ${p.error ? 'bad' : p.paused ? 'idle' : 'ok'}`} />
              {p.name}
              <span className="mute">{p.ready}</span>
            </button>
          ))}
        </div>
      )}

      {shownError && (
        <div className="banner bad-banner" role="alert">
          {shownError === SIGNED_OUT ? t.signedOutBanner : t.unreachableBanner(shownError, REFRESH_MS / 1000)}
        </div>
      )}
      {allPaused && (
        <div className="banner info-banner">
          <span className="grow">
            <b>{t.allPausedBold}</b> {t.allPausedRest(view.ready.length)}
          </span>
        </div>
      )}

      <div className="page">
        {!view ? (
          <div className="skeleton-grid" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : (
          <>
            <div className="columns">
              <section data-tour="live">
                <h2>
                  {t.liveRuns} <span className="count">{view.runs.live.length}</span>
                </h2>
                {view.runs.live.length === 0 && <Empty icon="◇" title={t.nothingRunning} hint={allPaused ? t.nothingRunningPaused : t.nothingRunningHint} />}
                <div className="stack runs">
                  {view.runs.live.map((r) => (
                    <article className={`card live ${r.state}`} key={r.id}>
                      <div className="row">
                        <span className={`pill ${r.state}`}>{label(r.state)}</span>
                        <span className="tag">{r.project}</span>
                        <Copy text={r.ticketId} />
                        <span className="grow" />
                        <span className="mute">{r.attempt > 0 ? t.attempt(r.attempt) : t.starting}</span>
                      </div>
                      <div className="title">{r.title}</div>
                      <Stages state={r.state} />
                      <div className="row where">
                        {/* Branch name as HostSteps.prepare in host.ts makes it. */}
                        <Copy text={`agent/${r.ticketId}`} />
                        {r.cloneDir ? <Copy text={r.cloneDir} /> : <span className="mute">{t.cloning}</span>}
                      </div>
                      <div className="mute">
                        {t.started(time(r.startedAt, t))} · <span className="elapsed">{span(now - r.startedAt, t)}</span>
                      </div>
                      {r.state === 'needs-attention' ? (
                        <div className="note">{r.note}</div>
                      ) : (
                        <LogTail runId={r.id} now={now} />
                      )}
                      <div className="actions">
                        {r.attempt > 0 && (
                          <button className="link" onClick={() => setLogRun(r)}>
                            {t.fullLog}
                          </button>
                        )}
                        <span className="grow" />
                        {r.state === 'needs-attention' && (
                          <button className="primary" onClick={() => void act(r, 'retry', t.retrying)}>
                            {t.retryHostStep}
                          </button>
                        )}
                        <button className="danger" onClick={() => kill(r)}>
                          {t.kill}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section data-tour="ready">
                <h2>
                  {t.readyQueue} <span className="count">{view.ready.length}</span>
                </h2>
                {view.ready.length === 0 && <Empty icon="☰" title={t.noReady} hint={t.noReadyHint} />}
                <div className="stack">
                  {view.ready.map((q, i) => (
                    <article className="card queue" key={`${q.project}/${q.id}`}>
                      <div className="row">
                        <span className="pos">{i + 1}</span>
                        <span className="tag">{q.project}</span>
                        <span className={`tag prio p${q.priority}`}>P{q.priority}</span>
                        <Copy text={q.id} />
                        <span className="grow" />
                        <span className="mute" title={t.ageTitle}>
                          {ago(q.ageMs, t)}
                        </span>
                      </div>
                      <div className="title">{q.title}</div>
                      <div className="row">
                        <span className={`mute grow ${q.runNow ? 'next' : ''}`}>{q.runNow ? t.runNowNext : (t.wait[q.waitReason] ?? q.waitReason)}</span>
                        {!q.runNow && q.waitReason !== 'not onboarded' && (
                          <button className="small" onClick={() => runNow(q)}>
                            {t.runNow}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </div>

            <section data-tour="history">
              <div className="history-head">
                <h2>
                  {t.history} <span className="count">{history.length}</span>
                </h2>
                <span className="grow" />
                <div className="chips" role="group" aria-label={t.filterByState}>
                  {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((f) => (
                    <button key={f} className={`chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                      {f === 'all' ? t.all : label(f)}
                    </button>
                  ))}
                </div>
                <select value={project} onChange={(e) => setProject(e.target.value)} aria-label={t.filterByProject}>
                  <option value="">{t.allProjects}</option>
                  {view.projects.map((p) => (
                    <option key={p.name}>{p.name}</option>
                  ))}
                </select>
                <input type="search" placeholder={t.searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t.searchLabel} />
              </div>
              {history.length === 0 ? (
                <Empty icon="↺" title={t.noRuns} hint={t.noRunsHint} />
              ) : shown.length === 0 ? (
                <Empty icon="⌕" title={t.noMatches} hint={t.noMatchesHint} />
              ) : (
                <div className="table">
                  {shown.map((r) => (
                    <div className="tr" key={r.id}>
                      <span className={`pill ${r.state}`}>{label(r.state)}</span>
                      <div className="what">
                        <div className="row">
                          <span className="tag">{r.project}</span>
                          <Copy text={r.ticketId} />
                        </div>
                        <div className="title">{r.title}</div>
                        {r.note && <div className="note">{r.note}</div>}
                      </div>
                      <div className="when">
                        <time title={new Date(r.endedAt ?? r.startedAt).toLocaleString(t === en ? [] : t.locale)}>
                          {ago(now - (r.endedAt ?? r.startedAt), t)}
                        </time>
                        <span className="mute">
                          {r.endedAt && <span title={t.duration}>{span(r.endedAt - r.startedAt, t)} · </span>}
                          <span className={r.attempt > 1 ? 'retried' : undefined}>{t.attempts(r.attempt)}</span>
                        </span>
                      </div>
                      <div className="links">
                        {r.prUrl && (
                          <a className="act pr" href={r.prUrl} target="_blank" rel="noreferrer" aria-label={`PR #${prNumber(r.prUrl) ?? '?'}`}>
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <circle cx="4" cy="3.5" r="1.75" />
                              <circle cx="4" cy="12.5" r="1.75" />
                              <circle cx="12" cy="12.5" r="1.75" />
                              <path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5m0 0L9.5 2.5m-2 2 2 2" />
                            </svg>
                            #{prNumber(r.prUrl) ?? '?'}
                            <span className="arrow">↗</span>
                          </a>
                        )}
                        {r.attempt > 0 && (
                          <button className="act" onClick={() => setLogRun(r)}>
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M3 4.5 6.5 8 3 11.5M8.5 11.5H13" />
                            </svg>
                            {t.log}
                          </button>
                        )}
                        {(r.state === 'failed' || r.state === 'killed') && r.cloneDir && (
                          <button className="small" onClick={() => void act(r, 'cleanup', t.cleanedUp)}>
                            {t.cleanUp}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {logRun && <LogDialog run={logRun} onClose={() => setLogRun(null)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.bad ? 'bad' : ''}`} role={x.bad ? 'alert' : 'status'}>
            <span className="grow">{x.text}</span>
            <button className="ghost small" aria-label={t.dismiss} onClick={() => setToasts((all) => all.filter((y) => y.id !== x.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </T.Provider>
  );
}

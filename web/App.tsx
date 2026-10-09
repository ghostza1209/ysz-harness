import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectStatus, QueueItem } from '../src/core';
import { parseLog, type LogBlock } from './logView';
import type { RunRow } from '../src/store';

interface State {
  slots: { used: number; total: number };
  ready: QueueItem[];
  runs: { live: RunRow[]; history: RunRow[] };
  projects: ProjectStatus[];
}

const REFRESH_MS = 5_000;

/** Longest tail kept in the browser, in characters. */
const TAIL_CHARS = 32_000;

/** Tool calls longer than this, or over one line, show folded to their first line. */
const FOLD_CHARS = 120;

/** One block of the log view. Every string goes in as a text node, never as markup. */
const Block = memo(function Block({ b, now }: { b: LogBlock; now: number }) {
  if (b.kind === 'rule') return <div className="log-rule">{b.text}</div>;
  if (b.kind === 'message') return <div className="log-msg">{b.text}</div>;
  if (b.kind === 'step')
    return (
      <div className={`log-step ${b.text.startsWith('Failed:') ? 'bad' : ''}`}>
        {b.text}
        {b.since !== undefined && (
          <>
            {' · '}
            <span className="elapsed">{span(now - b.since)}</span>
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
  const [text, setText] = useState('');
  const blocks = useMemo(() => parseLog(text), [text]);
  const box = useRef<HTMLDivElement>(null);
  // Follow the tail only while the reader sits at the bottom; scrolling up to read stops it.
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current) box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [text]);
  useEffect(() => {
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
        <span className="waiting">Waiting for the agent’s first output</span>
      )}
    </div>
  );
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const span = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
/** A stage's name for the states on the stage bar, so pills and bar agree. */
const label = (state: string) => STAGE_NAMES[state as keyof typeof STAGE_NAMES] ?? state.replace('-', ' ');
const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

/** A live Run's path to a PR. needs-attention is a stuck host step. */
const STAGES = ['claimed', 'agent', 'agent-review', 'host', 'pr'] as const;
const STAGE_NAMES = { claimed: 'Claimed', agent: 'Implement', 'agent-review': 'Agent review', host: 'Push & PR', pr: 'In review' };
function Stages({ state }: { state: RunRow['state'] }) {
  const at = STAGES.indexOf(state === 'needs-attention' ? 'host' : (state as (typeof STAGES)[number]));
  return (
    <ol className="stages" aria-label="Progress">
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
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      title={`Copy ${text}`}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      <code>{text}</code>
      <span className={`copied ${done ? 'show' : ''}`}>{done ? 'Copied' : '⧉'}</span>
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

const FILTERS = { all: () => true, 'in-review': (s: string) => s === 'in-review', failed: (s: string) => s === 'failed' || s === 'interrupted', killed: (s: string) => s === 'killed' };

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const [project, setProject] = useState('');
  const [query, setQuery] = useState('');

  const load = () =>
    fetch('/api/state')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((s: State) => {
        setState(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
    const poll = setInterval(load, REFRESH_MS);
    // Drives the elapsed timers on live Runs.
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
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
  const act = (r: RunRow, action: 'kill' | 'retry' | 'cleanup', done: string) => post(`/api/runs/${r.id}/${action}`, `${done} ${r.ticketId}`);
  const kill = (r: RunRow) => {
    if (window.confirm(`Kill ${r.ticketId}? Its agent stops and the Ticket gets orchestrator:skip.`)) void act(r, 'kill', 'Killed');
  };
  const runNow = (t: QueueItem) => {
    if (window.confirm(`Run ${t.id} now? It claims the Ticket, and a finished Run pushes a branch and opens a PR on ${t.project}.`))
      void post(`/api/projects/${encodeURIComponent(t.project)}/run-now/${encodeURIComponent(t.id)}`, `${t.id} runs at the next free slot`);
  };

  const slots = state?.slots ?? { used: 0, total: 2 };
  const history = state?.runs.history ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter(
      (r) =>
        FILTERS[filter](r.state) &&
        (!project || r.project === project) &&
        (!q || r.ticketId.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)),
    );
  }, [history, filter, project, query]);
  const allPaused = !!state && state.projects.length > 0 && state.projects.every((p) => p.paused);
  const stats = state && [
    { key: 'live', n: state.runs.live.length, label: 'Running' },
    { key: 'ready', n: state.ready.length, label: 'Ready' },
    { key: 'review', n: history.filter((r) => r.state === 'in-review').length, label: 'In review' },
    { key: 'failed', n: history.filter((r) => FILTERS.failed(r.state)).length, label: 'Failed' },
  ];

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className={`logo ${state?.runs.live.length ? 'spin' : ''}`} aria-hidden>
            ◆
          </span>
          Orchestrator
        </div>
        <div className="slots" title="Concurrent Runs: max 1 per Project">
          <span className="mute">Slots</span>
          {Array.from({ length: slots.total }, (_, i) => (
            <span key={i} className={`slot ${i < slots.used ? 'on' : ''}`} />
          ))}
          <b>
            {slots.used}/{slots.total}
          </b>
        </div>
        <span className="grow" />
        <span className={`conn ${error ? 'down' : state ? 'up' : ''}`}>{error ? 'Server unreachable' : state ? 'Live' : 'Connecting…'}</span>
      </header>

      {state && (
        <div className="summary">
          {stats!.map((s) => (
            <span key={s.key} className={`stat ${s.key} ${s.n ? 'has' : ''}`}>
              <b key={s.n} className="num">
                {s.n}
              </b>{' '}
              {s.label}
            </span>
          ))}
          <span className="grow" />
          {state.projects.map((p) => (
            <button
              key={p.name}
              className={`project ${p.paused ? 'paused' : ''} ${p.error ? 'error' : ''}`}
              role="switch"
              aria-checked={!p.paused}
              aria-label={`${p.paused ? 'Resume' : 'Pause'} ${p.name}`}
              title={`${p.error ? `${p.error}\n` : ''}${p.paused ? 'Paused' : 'Picking'} · ${p.ready} ready: click to ${p.paused ? 'resume' : 'pause'}`}
              onClick={() => void post(`/api/projects/${encodeURIComponent(p.name)}/${p.paused ? 'resume' : 'pause'}`, `${p.paused ? 'Resumed' : 'Paused'} ${p.name}`)}
            >
              <span className={`dot ${p.error ? 'bad' : p.paused ? 'idle' : 'ok'}`} />
              {p.name}
              <span className="mute">{p.ready}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="banner bad-banner" role="alert">
          Can't reach the server: {error}. Retrying every {REFRESH_MS / 1000}s.
        </div>
      )}
      {allPaused && (
        <div className="banner info-banner">
          <span className="grow">
            <b>All Projects are paused.</b> Nothing will start{state.ready.length ? `, though ${state.ready.length} Ticket${state.ready.length === 1 ? ' is' : 's are'} ready` : ''}. Flip a
            Project's switch to resume it.
          </span>
        </div>
      )}

      <div className="page">
        {!state ? (
          <div className="skeleton-grid" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : (
          <>
            <div className="columns">
              <section>
                <h2>
                  Live Runs <span className="count">{state.runs.live.length}</span>
                </h2>
                {state.runs.live.length === 0 && (
                  <Empty icon="◇" title="Nothing running" hint={allPaused ? 'Resume a Project to let Runs start.' : 'A Run starts when a Ready Ticket fits a free slot.'} />
                )}
                <div className="stack">
                  {state.runs.live.map((r) => (
                    <article className={`card live ${r.state}`} key={r.id}>
                      <div className="row">
                        <span className={`pill ${r.state}`}>{label(r.state)}</span>
                        <span className="tag">{r.project}</span>
                        <Copy text={r.ticketId} />
                        <span className="grow" />
                        <span className="mute">{r.attempt > 0 ? `Attempt ${r.attempt}/2` : 'Starting'}</span>
                      </div>
                      <div className="title">{r.title}</div>
                      <Stages state={r.state} />
                      <div className="row where">
                        {/* Branch name as HostSteps.prepare in host.ts makes it. */}
                        <Copy text={`agent/${r.ticketId}`} />
                        {r.cloneDir ? <Copy text={r.cloneDir} /> : <span className="mute">cloning…</span>}
                      </div>
                      <div className="mute">
                        Started {time(r.startedAt)} · <span className="elapsed">{span(now - r.startedAt)}</span>
                      </div>
                      {r.state === 'needs-attention' ? (
                        <div className="note">{r.note}</div>
                      ) : (
                        <LogTail runId={r.id} now={now} />
                      )}
                      <div className="actions">
                        {r.attempt > 0 && (
                          <a href={`/api/runs/${r.id}/log`} target="_blank" rel="noreferrer">
                            Full log ↗
                          </a>
                        )}
                        <span className="grow" />
                        {r.state === 'needs-attention' && (
                          <button className="primary" onClick={() => void act(r, 'retry', 'Retrying host step for')}>
                            Retry host step
                          </button>
                        )}
                        <button className="danger" onClick={() => kill(r)}>
                          Kill
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section>
                <h2>
                  Ready queue <span className="count">{state.ready.length}</span>
                </h2>
                {state.ready.length === 0 && <Empty icon="☰" title="No Ready Tickets" hint="Label an open bead ready-for-agent in a Project's repo to queue it." />}
                <div className="stack">
                  {state.ready.map((t, i) => (
                    <article className="card queue" key={`${t.project}/${t.id}`}>
                      <div className="row">
                        <span className="pos">{i + 1}</span>
                        <span className="tag">{t.project}</span>
                        <span className={`tag prio p${t.priority}`}>P{t.priority}</span>
                        <Copy text={t.id} />
                        <span className="grow" />
                        <span className="mute" title="Time since the Ticket was created">
                          {ago(t.ageMs)}
                        </span>
                      </div>
                      <div className="title">{t.title}</div>
                      <div className="row">
                        <span className={`mute grow ${t.runNow ? 'next' : ''}`}>{t.runNow ? '⚡ Run now: next free slot' : t.waitReason}</span>
                        {!t.runNow && t.waitReason !== 'not onboarded' && (
                          <button className="small" onClick={() => runNow(t)}>
                            Run now
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </div>

            <section>
              <div className="history-head">
                <h2>
                  History <span className="count">{history.length}</span>
                </h2>
                <span className="grow" />
                <div className="chips" role="group" aria-label="Filter by state">
                  {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((f) => (
                    <button key={f} className={`chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                      {f === 'all' ? 'All' : label(f)}
                    </button>
                  ))}
                </div>
                <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by Project">
                  <option value="">All Projects</option>
                  {state.projects.map((p) => (
                    <option key={p.name}>{p.name}</option>
                  ))}
                </select>
                <input type="search" placeholder="Search Ticket or title" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search history" />
              </div>
              {history.length === 0 ? (
                <Empty icon="↺" title="No Runs yet" hint="Finished Runs show up here with their PR and log." />
              ) : shown.length === 0 ? (
                <Empty icon="⌕" title="No matches" hint="Try another filter or search." />
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
                      <div className="mute when" title={new Date(r.startedAt).toLocaleString()}>
                        {ago(now - (r.endedAt ?? r.startedAt))}
                        {r.endedAt ? ` · took ${span(r.endedAt - r.startedAt)}` : ''}
                        <br />
                        {r.attempt} Attempt{r.attempt === 1 ? '' : 's'}
                      </div>
                      <div className="links">
                        {r.prUrl && (
                          <a className="pr" href={r.prUrl} target="_blank" rel="noreferrer">
                            PR #{prNumber(r.prUrl) ?? '?'} ↗
                          </a>
                        )}
                        {r.attempt > 0 && (
                          <a href={`/api/runs/${r.id}/log`} target="_blank" rel="noreferrer">
                            Log ↗
                          </a>
                        )}
                        {(r.state === 'failed' || r.state === 'killed') && r.cloneDir && (
                          <button className="small" onClick={() => void act(r, 'cleanup', 'Cleaned up')}>
                            Clean up
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

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`} role={t.bad ? 'alert' : 'status'}>
            <span className="grow">{t.text}</span>
            <button className="ghost small" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

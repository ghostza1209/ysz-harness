import { useEffect, useRef, useState } from 'react';
import type { ProjectStatus, QueueItem } from '../src/core';
import type { RunRow } from '../src/store';

interface State {
  slots: { used: number; total: number };
  ready: QueueItem[];
  runs: { live: RunRow[]; history: RunRow[] };
  projects: ProjectStatus[];
}

const REFRESH_MS = 5_000;

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Longest tail kept in the browser, in characters. */
const TAIL_CHARS = 32_000;

/** The live tail of one Run's log. React renders the text as text, so agent output can't inject markup. */
function LogTail({ runId }: { runId: number }) {
  const [text, setText] = useState('');
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
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
  return <pre className="log" ref={box}>{text || 'Waiting for the agent’s first output…'}</pre>;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const duration = (from: number, to: number) => {
  const minutes = Math.round((to - from) / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const label = (state: string) => state.replace('-', ' ');
const prNumber = (url: string) => url.match(/\/pull\/(\d+)/)?.[1];

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty">
      <b>{title}</b>
      <span>{hint}</span>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  /** A control: POST it, show why the server refused, and refresh. */
  const post = async (url: string) => {
    const res = await fetch(url, { method: 'POST' }).catch((e: Error) => e);
    if (res instanceof Error) setActionError(res.message);
    else setActionError(res.ok ? null : ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    await load();
  };
  const act = (runId: number, action: 'kill' | 'retry' | 'cleanup') => post(`/api/runs/${runId}/${action}`);
  const kill = (r: RunRow) => {
    if (window.confirm(`Kill ${r.ticketId}? Its agent stops and the Ticket gets orchestrator:skip.`)) void act(r.id, 'kill');
  };
  const runNow = (t: QueueItem) => {
    if (window.confirm(`Run ${t.id} now? It claims the Ticket, and a finished Run pushes a branch and opens a PR on ${t.project}.`))
      void post(`/api/projects/${encodeURIComponent(t.project)}/run-now/${encodeURIComponent(t.id)}`);
  };

  const slots = state?.slots ?? { used: 0, total: 2 };

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
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

      {(error || actionError) && (
        <div className="banner" role="alert">
          <span className="grow">{error ? `Can't reach the server: ${error}` : actionError}</span>
          {actionError && (
            <button className="ghost" onClick={() => setActionError(null)}>
              Dismiss
            </button>
          )}
        </div>
      )}

      <div className="page">
        <section className="projects">
          {state?.projects.map((p) => (
            <div className={`project ${p.paused ? 'paused' : ''} ${p.error ? 'error' : ''}`} key={p.name}>
              <div className="row">
                <span className={`dot ${p.error ? 'bad' : p.paused ? 'idle' : 'ok'}`} />
                <b className="grow">{p.name}</b>
                <button
                  className={`toggle ${p.paused ? '' : 'on'}`}
                  role="switch"
                  aria-checked={!p.paused}
                  aria-label={`${p.paused ? 'Resume' : 'Pause'} ${p.name}`}
                  title={p.paused ? 'Paused: click to resume' : 'Active: click to pause'}
                  onClick={() => void post(`/api/projects/${encodeURIComponent(p.name)}/${p.paused ? 'resume' : 'pause'}`)}
                >
                  <span />
                </button>
              </div>
              <div className="mute">
                {p.paused ? 'Paused' : 'Active'} · {p.ready} ready
              </div>
              {p.error && <div className="bad">{p.error}</div>}
            </div>
          ))}
        </section>

        <div className="columns">
          <section>
            <h2>
              Live Runs <span className="count">{state?.runs.live.length ?? 0}</span>
            </h2>
            {state?.runs.live.length === 0 && <Empty title="Nothing running" hint="A Run starts when a Ready Ticket fits a free slot." />}
            <div className="stack">
              {state?.runs.live.map((r) => (
                <article className={`card live ${r.state}`} key={r.id}>
                  <div className="row">
                    <span className={`pill ${r.state}`}>{label(r.state)}</span>
                    <span className="tag">{r.project}</span>
                    <code className="grow">{r.ticketId}</code>
                    <span className="mute">{r.attempt > 0 ? `Attempt ${r.attempt}/2` : 'Starting'}</span>
                  </div>
                  <div className="title">{r.title}</div>
                  <div className="mute">Started {time(r.startedAt)}</div>
                  {r.state === 'needs-attention' ? (
                    <>
                      <div className="note">{r.note}</div>
                      <a href={`/api/runs/${r.id}/log`} target="_blank" rel="noreferrer">
                        Open full log ↗
                      </a>
                    </>
                  ) : (
                    <LogTail runId={r.id} />
                  )}
                  <div className="actions">
                    {r.state === 'needs-attention' && (
                      <button className="primary" onClick={() => void act(r.id, 'retry')}>
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
              Ready queue <span className="count">{state?.ready.length ?? 0}</span>
            </h2>
            {state?.ready.length === 0 && <Empty title="No Ready Tickets" hint="Label an open bead ready-for-agent in a Project's repo to queue it." />}
            <div className="stack">
              {state?.ready.map((t, i) => (
                <article className="card queue" key={`${t.project}/${t.id}`}>
                  <div className="row">
                    <span className="pos">{i + 1}</span>
                    <span className="tag">{t.project}</span>
                    <span className={`tag prio p${t.priority}`}>P{t.priority}</span>
                    <code className="grow">{t.id}</code>
                    <span className="mute">{age(t.ageMs)}</span>
                  </div>
                  <div className="title">{t.title}</div>
                  <div className="row">
                    <span className="mute grow">{t.runNow ? 'Run now: next free slot' : t.waitReason}</span>
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
          <h2>
            History <span className="count">{state?.runs.history.length ?? 0}</span>
          </h2>
          {state?.runs.history.length === 0 ? (
            <Empty title="No Runs yet" hint="Finished Runs show up here with their PR and log." />
          ) : (
            <div className="table">
              {state?.runs.history.map((r) => (
                <div className="tr" key={r.id}>
                  <span className={`pill ${r.state}`}>{label(r.state)}</span>
                  <div className="what">
                    <div className="row">
                      <span className="tag">{r.project}</span>
                      <code>{r.ticketId}</code>
                    </div>
                    <div className="title">{r.title}</div>
                    {r.note && <div className="note">{r.note}</div>}
                  </div>
                  <div className="mute when">
                    {time(r.startedAt)}
                    {r.endedAt ? ` · ${duration(r.startedAt, r.endedAt)}` : ''}
                    <br />
                    {r.attempt} Attempt{r.attempt === 1 ? '' : 's'}
                  </div>
                  <div className="links">
                    {r.prUrl && (
                      <a href={r.prUrl} target="_blank" rel="noreferrer">
                        PR #{prNumber(r.prUrl) ?? '?'} ↗
                      </a>
                    )}
                    {r.attempt > 0 && (
                      <a href={`/api/runs/${r.id}/log`} target="_blank" rel="noreferrer">
                        Log ↗
                      </a>
                    )}
                    {(r.state === 'failed' || r.state === 'killed') && r.cloneDir && (
                      <button className="small" onClick={() => void act(r.id, 'cleanup')}>
                        Clean up
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

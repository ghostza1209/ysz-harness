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
  return <pre className="log" ref={box}>{text || 'No log output yet.'}</pre>;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

  /** A Run control: POST it, show why the server refused, and refresh. */
  const act = async (runId: number, action: 'kill' | 'retry' | 'cleanup') => {
    const res = await fetch(`/api/runs/${runId}/${action}`, { method: 'POST' }).catch((e: Error) => e);
    if (res instanceof Error) setActionError(res.message);
    else setActionError(res.ok ? null : ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    await load();
  };
  const kill = (r: RunRow) => {
    if (window.confirm(`Kill ${r.ticketId}? Its agent stops and the Ticket gets orchestrator:skip.`)) void act(r.id, 'kill');
  };

  return (
    <>
      <header>
        <b>Orchestrator</b>
        <span>{state ? `slots ${state.slots.used}/${state.slots.total} · max 1 per Project` : ''}</span>
        <span className="grow" />
        {error && <span className="bad">server unreachable: {error}</span>}
        {actionError && <span className="bad">{actionError}</span>}
      </header>
      <main>
        <section>
          <h2>Ready queue (all Projects)</h2>
          <div className="stack">
            {state?.ready.length === 0 && <p className="mute">No Ready Tickets.</p>}
            {state?.ready.map((t) => (
              <div className="card" key={`${t.project}/${t.id}`}>
                <div className="row">
                  <span className="tag">{t.project}</span>
                  <span className="tag">P{t.priority}</span>
                  <span className="mute">
                    {t.id} · {age(t.ageMs)}
                  </span>
                </div>
                <div>{t.title}</div>
                <div className="mute">{t.waitReason}</div>
              </div>
            ))}
          </div>
        </section>
        <section>
          <h2>Live Runs</h2>
          {state?.runs.live.length === 0 && <p className="mute">No live Runs.</p>}
          <div className="stack">
            {state?.runs.live.map((r) => (
              <div className="card" key={r.id}>
                <div className="row">
                  <span className={`pill ${r.state}`}>{r.state}</span>
                  <b className="grow">{r.ticketId}</b>
                  <span className="mute">{r.attempt > 0 ? `Attempt ${r.attempt}/2` : 'starting'}</span>
                </div>
                <div>{r.title}</div>
                <div className="mute">
                  {r.project} · started {time(r.startedAt)}
                </div>
                {r.state === 'needs-attention' ? (
                  <>
                    <div className="bad">{r.note}</div>
                    <a href={`/api/runs/${r.id}/log`} target="_blank" rel="noreferrer">
                      Full log
                    </a>
                  </>
                ) : (
                  <LogTail runId={r.id} />
                )}
                <div className="row">
                  {r.state === 'needs-attention' && <button onClick={() => void act(r.id, 'retry')}>Retry host step</button>}
                  <button className="danger" onClick={() => kill(r)}>
                    Kill
                  </button>
                </div>
              </div>
            ))}
          </div>
          <h2 className="gap">Projects</h2>
          <div className="card">
            {state?.projects.map((p) => (
              <div className="project" key={p.name}>
                <div className="row">
                  <b className="grow">{p.name}</b>
                  <span className="mute">{p.ready} ready</span>
                </div>
                {p.error && <div className="bad">{p.error}</div>}
              </div>
            ))}
          </div>
        </section>
        <section>
          <h2>Run history</h2>
          {state?.runs.history.length === 0 && <p className="mute">No Runs yet.</p>}
          <div className="stack">
            {state?.runs.history.map((r) => (
              <div className="card" key={r.id}>
                <div className="row">
                  <span className={`pill ${r.state}`}>{r.state}</span>
                  <span className="tag">{r.project}</span>
                  <b className="grow">{r.ticketId}</b>
                </div>
                <div>{r.title}</div>
                <div className="mute">
                  {r.attempt} Attempt{r.attempt === 1 ? '' : 's'} used · {time(r.startedAt)} to {r.endedAt ? time(r.endedAt) : '?'}
                </div>
                {r.attempt > 0 && (
                  <a href={`/api/runs/${r.id}/log`} target="_blank" rel="noreferrer">
                    Full log
                  </a>
                )}
                {r.prUrl && (
                  <a href={r.prUrl} target="_blank" rel="noreferrer">
                    {r.prUrl}
                  </a>
                )}
                {r.note && <div className="bad">{r.note}</div>}
                {(r.state === 'failed' || r.state === 'killed') && r.cloneDir && (
                  <div className="row">
                    <button onClick={() => void act(r.id, 'cleanup')}>Clean up</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}

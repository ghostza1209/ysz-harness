import { useEffect, useState } from 'react';
import type { ProjectStatus, QueueItem } from '../src/core';

interface State {
  slots: { used: number; total: number };
  ready: QueueItem[];
  projects: ProjectStatus[];
}

const REFRESH_MS = 5_000;

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch('/api/state')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((s: State) => {
          setState(s);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <header>
        <b>Orchestrator</b>
        <span>{state ? `slots ${state.slots.used}/${state.slots.total} · max 1 per Project` : ''}</span>
        <span className="grow" />
        {error && <span className="bad">server unreachable: {error}</span>}
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
          <p className="mute">No live Runs.</p>
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
          <p className="mute">No Runs yet.</p>
        </section>
      </main>
    </>
  );
}

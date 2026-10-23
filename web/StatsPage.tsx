import { memo, useEffect, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { StatsRun } from '../src/core';
import type { BacklogPoint } from '../src/store';
import { span, type Dict } from './i18n';
import { agentTimes, backlogOverTime, daysOf, firstAttemptPass, FOOTPRINT_FIGURES, footprintByRole, mergeRate, OUTCOMES, reviewWaits, runsPerDay, tokensPerDay, waitingNow, type FootprintFigure, type Outcome, type Range } from './stats';

/** The History pills' colours, so a state reads the same on both pages. Names stay English, as pills do. */
const OUTCOME_STYLE: Record<Outcome, { name: string; color: string }> = {
  merged: { name: 'Merged', color: 'var(--violet)' },
  'in-review': { name: 'In review', color: 'var(--ok)' },
  'pr-closed': { name: 'PR closed', color: 'var(--mute)' },
  'broken-down': { name: 'Broken down', color: 'var(--ink)' },
  failed: { name: 'Failed', color: 'var(--bad)' },
  killed: { name: 'Killed', color: 'var(--warn)' },
  running: { name: 'Running', color: 'var(--accent)' },
};
const AXIS = { stroke: 'var(--line)', tick: { fill: 'var(--mute)', fontSize: 12 } };
const TIP = { contentStyle: { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13 }, itemStyle: { color: 'var(--ink)' }, cursor: { fill: 'var(--soft)' } };
/** In series order, with text in ink: a series colour on text fails contrast. */
const LEGEND = { itemSorter: null, wrapperStyle: { fontSize: 12 }, formatter: (name: string) => <span style={{ color: 'var(--ink)' }}>{name}</span> };
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Docker's own units: 1.2 GB. */
const bytes = (n: number) => {
  const i = n >= 1 ? Math.min(Math.floor(Math.log10(n) / 3), 4) : 0;
  return `${+(n / 1000 ** i).toFixed(i ? 1 : 0)} ${['B', 'kB', 'MB', 'GB', 'TB'][i]}`;
};

const FIGURE_LABEL = { seconds: 'time', peakMemory: 'memory', cpuAvg: 'cpuAvg', cpuPeak: 'cpuPeak', disk: 'disk', networkIn: 'network' } as const;
const figure = (f: FootprintFigure, n: number, t: Dict) =>
  f === 'seconds' ? span(n * 1000, t) : f === 'cpuAvg' || f === 'cpuPeak' ? n.toFixed(2) : bytes(n);

function Panel({ title, hint, wide, children }: { title: string; hint: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`card chart ${wide ? 'wide' : ''}`}>
      <h3>{title}</h3>
      <p className="mute">{hint}</p>
      {children}
    </section>
  );
}

function Rate({ title, hint, n, of, t }: { title: string; hint: string; n: number; of: number; t: Dict }) {
  return (
    <section className="card rate">
      <h3>{title}</h3>
      <b className="num">{of ? `${Math.round((n / of) * 100)}%` : '–'}</b>
      <span className="mute">{t.outOf(n, of)}</span>
      <p className="mute">{hint}</p>
    </section>
  );
}

/** The Stats page: graphs of every Run (archived too) started in `range`, of `project` or of all when it is ''. */
function Stats(props: { t: Dict; projects: string[]; project: string; setProject: (p: string) => void; range: Range; setRange: (r: Range) => void }) {
  const { t, project, range } = props;
  const [data, setData] = useState<{ runs: StatsRun[]; backlog: BacklogPoint[]; now: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/stats')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d) => setData({ ...d, now: Date.now() }), (e: Error) => setError(e.message));
  }, []);

  const head = (
    <div className="history-head">
      <h2>{t.stats}</h2>
      <span className="grow" />
      <div className="chips" role="group" aria-label={t.statsRange}>
        {(['7', '30', 'all'] as const).map((r) => (
          <button key={r} className={`chip ${range === r ? 'on' : ''}`} aria-pressed={range === r} onClick={() => props.setRange(r)}>
            {r === 'all' ? t.allTime : t.lastDays(Number(r))}
          </button>
        ))}
      </div>
      <select value={project} onChange={(e) => props.setProject(e.target.value)} aria-label={t.filterByProject}>
        <option value="">{t.allProjects}</option>
        {props.projects.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </div>
  );
  if (error) return <section>{head}<div className="banner bad-banner">{t.statsFailed(error)}</div></section>;
  if (!data) return <section aria-busy>{head}<div className="skeleton" /></section>;

  const { now } = data;
  const ofProject = data.runs.filter((r) => !project || r.project === project);
  const days = daysOf(range, now, Math.min(...ofProject.map((r) => r.startedAt)));
  const runs = ofProject.filter((r) => r.startedAt >= days[0]);
  const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(t.locale, { day: 'numeric', month: 'short' });
  const merge = mergeRate(runs);
  const pass = firstAttemptPass(runs);
  const times = agentTimes(runs);
  // By when the Run reached In review, so a wait shows up once its Run has one.
  const waits = reviewWaits(ofProject.filter((r) => r.endedAt !== null && r.endedAt >= days[0]));
  const waiting = waitingNow(ofProject, now);
  const footprints = footprintByRole(runs);
  const backlog = backlogOverTime(data.backlog, project, days[0], now);
  const timeAxis = { type: 'number', dataKey: 'at', domain: [days[0], now], scale: 'time', tickFormatter: dayLabel, ...AXIS } as const;
  const dateTime = (ms: number) => new Date(ms).toLocaleString(t.locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  return (
    <section>
      {head}
      {/* Only the charts by start date empty out: In review now, Review wait and the Backlog go by their own dates. */}
      {runs.length === 0 && <p className="mute">{t.noStats}</p>}
      <div className="stats-grid">
        <Panel title={t.runsPerDay} hint={t.runsPerDayHint}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={runsPerDay(runs, days)}>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis dataKey="day" tickFormatter={dayLabel} {...AXIS} />
              <YAxis allowDecimals={false} width={32} {...AXIS} />
              <Tooltip {...TIP} labelFormatter={(d) => dayLabel(Number(d))} />
              <Legend {...LEGEND} />
              {OUTCOMES.map((o) => (
                <Bar key={o} dataKey={o} name={OUTCOME_STYLE[o].name} stackId="runs" fill={OUTCOME_STYLE[o].color} maxBarSize={24} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <div className="rates">
          <Rate title={t.mergeRate} hint={t.mergeRateHint} n={merge.merged} of={merge.of} t={t} />
          <Rate title={t.firstAttemptPass} hint={t.firstAttemptPassHint} n={pass.passed} of={pass.of} t={t} />
        </div>
        <Panel title={t.tokensPerDay} hint={t.tokensPerDayHint}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={tokensPerDay(runs, days)}>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis dataKey="day" tickFormatter={dayLabel} {...AXIS} />
              <YAxis tickFormatter={(v: number) => compact.format(v)} width={40} {...AXIS} />
              <Tooltip {...TIP} labelFormatter={(d) => dayLabel(Number(d))} formatter={(v) => compact.format(Number(v))} />
              <Legend {...LEGEND} />
              <Bar dataKey="implement" name="Implement agent" stackId="tokens" fill="var(--accent)" maxBarSize={24} />
              <Bar dataKey="review" name="Review agent" stackId="tokens" fill="var(--violet)" maxBarSize={24} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title={t.agentTime} hint={t.agentTimeHint}>
          <ResponsiveContainer width="100%" height={240}>
            <ScatterChart>
              <CartesianGrid stroke="var(--line)" />
              <XAxis {...timeAxis} />
              <YAxis type="number" dataKey="minutes" unit={t.units.m} width={48} {...AXIS} />
              <Tooltip
                {...TIP}
                content={({ active, payload }) => {
                  const p = active && (payload?.[0]?.payload as (typeof times)[number] | undefined);
                  return p ? <div className="chart-tip">{p.ticketId} · {Math.round(p.minutes)}{t.units.m}</div> : null;
                }}
              />
              <Legend {...LEGEND} />
              {OUTCOMES.map((o) => {
                const dots = times.filter((x) => x.outcome === o);
                return dots.length ? <Scatter key={o} name={OUTCOME_STYLE[o].name} data={dots} fill={OUTCOME_STYLE[o].color} /> : null;
              })}
            </ScatterChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title={t.reviewWait} hint={t.reviewWaitHint}>
          {waits.length === 0 ? (
            <p className="mute">{t.noReviewWait}</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <ScatterChart>
                <CartesianGrid stroke="var(--line)" />
                <XAxis {...timeAxis} />
                <YAxis type="number" dataKey="hours" unit={t.units.h} width={48} {...AXIS} />
                <Tooltip
                  {...TIP}
                  content={({ active, payload }) => {
                    const p = active && (payload?.[0]?.payload as (typeof waits)[number] | undefined);
                    return p ? <div className="chart-tip">{p.ticketId} · {span(p.hours * 3_600_000, t)}</div> : null;
                  }}
                />
                <Legend {...LEGEND} />
                {(['merged', 'pr-closed'] as const).map((o) => (
                  <Scatter key={o} name={OUTCOME_STYLE[o].name} data={waits.filter((w) => w.outcome === o)} fill={OUTCOME_STYLE[o].color} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </Panel>
        <Panel title={t.inReviewNow} hint={t.inReviewNowHint}>
          {waiting.length === 0 ? (
            <p className="mute">{t.nothingInReview}</p>
          ) : (
            <ol className="waiting">
              {waiting.map(({ run, ms }) => (
                <li key={run.id}>
                  <span className="tag">{run.project}</span>
                  {run.prUrl ? (
                    <a href={run.prUrl} target="_blank" rel="noreferrer">
                      {run.ticketId}
                    </a>
                  ) : (
                    run.ticketId
                  )}
                  <span className="title" title={run.title}>
                    {run.title}
                  </span>
                  <span className="bar">
                    <span style={{ width: `${(ms / waiting[0].ms) * 100}%` }} />
                  </span>
                  <span className="mute">{span(ms, t)}</span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title={t.footprint} hint={t.footprintHint} wide>
          {footprints.length === 0 ? (
            <p className="mute">{t.noFootprint}</p>
          ) : (
            footprints.map(({ project: name, roles }) => (
              <div key={name} className="footprint">
                <table>
                  <caption>{name}</caption>
                  <thead>
                    <tr>
                      <th rowSpan={2}>{t.footprintFigures.role}</th>
                      <th rowSpan={2}>{t.footprintFigures.parts}</th>
                      {FOOTPRINT_FIGURES.map((f) => (
                        <th key={f} colSpan={2}>{t.footprintFigures[FIGURE_LABEL[f]]}</th>
                      ))}
                    </tr>
                    <tr>
                      {FOOTPRINT_FIGURES.flatMap((f) => [<th key={`${f}-median`}>{t.footprintFigures.median}</th>, <th key={`${f}-max`}>{t.footprintFigures.max}</th>])}
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((row) => (
                      <tr key={row.role}>
                        <th>{row.role}</th>
                        <td>{row.parts}</td>
                        {FOOTPRINT_FIGURES.flatMap((f) => [
                          <td key={`${f}-median`}>{figure(f, row.median[f], t)}</td>,
                          <td key={`${f}-max`}>{figure(f, row.max[f], t)}</td>,
                        ])}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </Panel>
        <Panel title={t.backlogOverTime} hint={t.backlogOverTimeHint} wide>
          {backlog.length === 0 ? (
            <p className="mute">{t.noBacklogYet}</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={backlog}>
                <CartesianGrid vertical={false} stroke="var(--line)" />
                <XAxis {...timeAxis} />
                <YAxis allowDecimals={false} width={32} {...AXIS} />
                <Tooltip {...TIP} cursor={{ stroke: 'var(--line)' }} labelFormatter={(at) => dateTime(Number(at))} />
                <Legend {...LEGEND} />
                <Line type="stepAfter" dataKey="backlog" name="Backlog" stroke="var(--accent)" strokeWidth={2} dot={false} />
                <Line type="stepAfter" dataKey="ready" name="Ready" stroke="var(--ok)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>
    </section>
  );
}

// The overview's clock re-renders App every second; the charts only change with their props.
export default memo(Stats);

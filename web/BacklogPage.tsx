import { memo, useEffect, useMemo, useState } from 'react';
import type { Dict } from './i18n';
import { ageText, build, groupTickets, matches, parseSearch, STATES, type BacklogData, type Header } from './backlog';

const TABS = [...STATES, 'all'] as const;
type Tab = (typeof TABS)[number];

/** Re-renders once a second, so the data ages tick. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** One pill per Project, toggling it in the filter, and a banner for each failed Project. Alone in ticking, so the rows stay put. */
function Strip({ t, data, picked, toggle }: { t: Dict; data: BacklogData; picked: ReadonlySet<string>; toggle: (name: string) => void }) {
  const now = useNow();
  return (
    <>
      <div className="bl-strip" role="group" aria-label={t.backlog.projectsLabel}>
        {data.projects.map((p) => (
          <button key={p.name} className={`bl-pill ${picked.has(p.name) ? 'on' : ''} ${p.error ? 'err' : ''}`} aria-pressed={picked.has(p.name)} onClick={() => toggle(p.name)} title={p.error ?? undefined}>
            <span className={`dot ${p.error ? 'bad' : p.rows ? 'ok' : 'idle'}`} />
            <b>{p.name}</b>
            {p.rows && <span>{p.rows.filter((r) => r.issue_type !== 'epic').length}</span>}
            <span className="mute">{ageText(p, now, t)}</span>
            {p.error && <span className="bl-failed">{t.backlog.pollFailed}</span>}
          </button>
        ))}
      </div>
      {data.projects
        .filter((p) => p.error)
        .map((p) => (
          <div key={p.name} className="banner bad-banner" role="alert">
            {t.backlog.pollFailedBanner(p.name, p.error!, !!p.rows)}
          </div>
        ))}
    </>
  );
}

function GroupHead({ t, project, header, closedId, count }: { t: Dict; project: string; header: Header | null; closedId: string | null; count: number }) {
  return (
    <div className="bl-ghead">
      <span className="tag">{project}</span>
      {header ? (
        <>
          <span className="tag">{header.row.issue_type}</span>
          <b>{header.row.title}</b>
          <code className="mute">{header.row.id}</code>
          <span className={`bl-line ${header.state}`}>{header.line}</span>
        </>
      ) : (
        <b>{closedId ? t.backlog.closedEpic(closedId) : t.backlog.noEpic}</b>
      )}
      <span className="count">{count}</span>
    </div>
  );
}

/** The Backlog page: every Project's unclosed Tickets by Backlog state, grouped under their parents. `stages` maps a held Ticket's `project/id` to its Run's stage. */
function Backlog({ t, stages, refreshMs }: { t: Dict; stages: ReadonlyMap<string, string>; refreshMs: number }) {
  const [data, setData] = useState<BacklogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  // Only while the page is open.
  useEffect(() => {
    let open = true;
    const load = () =>
      fetch('/api/backlog')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then(
          (d: BacklogData) => open && (setData(d), setError(null)),
          (e: Error) => open && setError(e.message),
        );
    void load();
    const id = setInterval(load, refreshMs);
    return () => {
      open = false;
      clearInterval(id);
    };
  }, [refreshMs]);

  const model = useMemo(() => data && build(data, stages, t), [data, stages, t]);
  const shown = useMemo(() => {
    if (!model) return [];
    const search = parseSearch(query);
    return model.tickets.filter((tk) => (!picked.size || picked.has(tk.project)) && matches(tk, search));
  }, [model, query, picked]);
  const count = (state: Tab) => (state === 'all' ? shown.length : shown.filter((tk) => tk.state === state).length);
  const groups = useMemo(() => model && groupTickets(tab === 'all' ? shown : shown.filter((tk) => tk.state === tab), model), [model, shown, tab]);

  const toggle = (name: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <section className="bl">
      {error && (
        <div className="banner bad-banner" role="alert">
          {t.backlog.loadFailed(error)}
        </div>
      )}
      {!data || !model || !groups ? (
        !error && <div className="skeleton" />
      ) : (
        <>
          <Strip t={t} data={data} picked={picked} toggle={toggle} />
          <div className="bl-toolbar">
            <div className="bl-tabs" role="group" aria-label={t.backlog.tabsLabel}>
              {TABS.map((s) => (
                <button key={s} className={`bl-tab ${tab === s ? 'on' : ''}`} aria-pressed={tab === s} onClick={() => setTab(s)}>
                  {t.backlog.tabs[s]} <span className="count">{count(s)}</span>
                </button>
              ))}
            </div>
            <span className="grow" />
            <input type="search" className="bl-q" aria-label={t.backlog.searchLabel} placeholder={t.backlog.searchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {groups.length === 0 && (
            <div className="empty">
              <b>{t.backlog.emptyTitle}</b>
              <span>{t.backlog.emptyHint}</span>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.key} className="bl-group">
              <GroupHead t={t} project={g.project} header={g.header} closedId={g.closedId} count={g.tickets.length} />
              {g.tickets.map((tk) => (
                <div key={tk.row.id} className="bl-row">
                  <span className={`tag prio p${tk.row.priority}`}>P{tk.row.priority}</span>
                  <code className="bl-id">{tk.row.id}</code>
                  <span className="bl-title" title={tk.row.title}>
                    {tk.row.title}
                  </span>
                  <span className={`bl-line ${tk.state}`}>{tk.line}</span>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

// The overview's clock re-renders App every second; the page changes only with its props and polls.
export default memo(Backlog);

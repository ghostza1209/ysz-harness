import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BacklogRow, TicketDetail } from '../src/beads';
import { Copy } from './App';
import type { Dict } from './i18n';
import { ageText, build, groupTickets, keyOf, matches, parseSearch, relations, since, STATES, who, type BacklogData, type Header, type Related } from './backlog';

/** An open panel: loading, its detail, or why the detail failed. */
type Entry = { loading: true } | { detail: TicketDetail } | { error: string };

/** Makes a div act as a button: focusable, Enter and Space press it. */
const press = (fn: () => void) => ({
  role: 'button',
  tabIndex: 0,
  onClick: fn,
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  },
});

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

function Relation({ t, heading, items, go }: { t: Dict; heading: string; items: Related[]; go: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="bl-sec">
      <h4>{heading}</h4>
      {items.map((r) =>
        r.title === null ? (
          <div key={r.id} className="bl-dep">
            <code>{r.id}</code> <span className="mute">{t.backlog.closed}</span>
          </div>
        ) : (
          <button key={r.id} className="bl-dep link" onClick={() => go(r.id)}>
            <code>{r.id}</code> {r.title} <span className="mute">{r.status.replace('_', ' ')}</span>
          </button>
        ),
      )}
    </div>
  );
}

/** A Ticket's opened panel. Description and comments are agent-written: they are text nodes, with line breaks kept by CSS, never HTML or Markdown. */
function Detail({ t, project, row, state, line, reasons, rows, entry, now, go }: { t: Dict; project: string; row: BacklogRow; state: string; line: string; reasons: string[]; rows: BacklogRow[]; entry: Entry; now: number; go: (project: string, id: string) => void }) {
  const rel = relations(rows, row);
  const goHere = (id: string) => go(project, id);
  const loaded = 'detail' in entry ? entry.detail : null;
  const section = (heading: string, body: ReactNode) => (
    <div className="bl-sec">
      <h4>{heading}</h4>
      {body}
    </div>
  );
  return (
    <div className="bl-detail">
      <div className="bl-left">
        <div className="bl-meta">
          <span className="tag">{project}</span>
          <Copy text={row.id} />
          <span className="tag">{row.issue_type}</span>
          <span className={`tag prio p${row.priority}`}>P{row.priority}</span>
          <span className="tag">{row.status.replace('_', ' ')}</span>
          {row.assignee && <span className="tag">@{who(row.assignee)}</span>}
        </div>
        <h3 className="bl-dtitle">{row.title}</h3>
        <div className={`bl-state ${state}`}>
          {reasons.length ? (
            <>
              <b>{t.backlog.markedHead}</b>
              {reasons.map((r) => (
                <div key={r}>{r}</div>
              ))}
            </>
          ) : (
            line
          )}
        </div>
        {row.labels.length > 0 && (
          <div className="bl-labels" aria-label={t.backlog.labelsHeading}>
            {row.labels.map((l) => (
              <span key={l} className="tag">
                {l}
              </span>
            ))}
          </div>
        )}
        {section(
          t.backlog.descriptionHeading,
          'loading' in entry ? (
            <span className="mute">{t.backlog.loading}</span>
          ) : 'error' in entry ? (
            <div className="banner bad-banner" role="alert">
              {t.backlog.detailFailed(entry.error)}
            </div>
          ) : (
            <div className="bl-text">{entry.detail.description || t.backlog.noDescription}</div>
          ),
        )}
        {rel.parent && <Relation t={t} heading={t.backlog.parentHeading} items={[rel.parent]} go={goHere} />}
        <Relation t={t} heading={t.backlog.blockedByHeading} items={rel.blockedBy} go={goHere} />
        <Relation t={t} heading={t.backlog.blocksHeading} items={rel.blocks} go={goHere} />
        <Relation t={t} heading={t.backlog.childrenHeading} items={rel.children} go={goHere} />
        {loaded &&
          section(
            t.backlog.commentsHeading,
            loaded.comments.length ? (
              loaded.comments.map((c, i) => (
                <div key={i} className="bl-comment">
                  <div className="mute">
                    <b>{who(c.author)}</b> · {since(c.createdAt, now, t)}
                  </div>
                  <div className="bl-text">{c.text}</div>
                </div>
              ))
            ) : (
              <span className="mute">{t.backlog.noComments}</span>
            ),
          )}
      </div>
      {state === 'held' && <aside className="bl-actions">{t.backlog.heldActions}</aside>}
    </div>
  );
}

function GroupHead({ t, project, header, closedId, count, toggle }: { t: Dict; project: string; header: Header | null; closedId: string | null; count: number; toggle: (() => void) | null }) {
  return (
    <div className={`bl-ghead ${toggle ? 'bl-click' : ''}`} {...(toggle ? press(toggle) : {})}>
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
  const [opened, setOpened] = useState<Record<string, Entry>>({});

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

  // Epic headers can open too: a Ticket's parent is one.
  const shownKeys = useMemo(() => new Set(groups?.flatMap((g) => [...g.tickets.map((tk) => keyOf(tk.project, tk.row.id)), ...(g.header?.row.issue_type === 'epic' ? [keyOf(g.project, g.header.row.id)] : [])])), [groups]);

  /** Opens a Ticket's panel and reads its detail once: fresh as of now. */
  const expand = (project: string, id: string) => {
    const key = keyOf(project, id);
    if (opened[key]) return;
    const mine: Entry = { loading: true };
    const settle = (e: Entry) => setOpened((o) => (o[key] === mine ? { ...o, [key]: e } : o));
    setOpened((o) => ({ ...o, [key]: mine }));
    fetch(`/api/projects/${encodeURIComponent(project)}/tickets/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body as TicketDetail;
      })
      .then(
        (detail) => settle({ detail }),
        (e: Error) => settle({ error: e.message }),
      );
  };
  const flip = (project: string, id: string) => {
    const key = keyOf(project, id);
    if (opened[key]) setOpened(({ [key]: _gone, ...rest }) => rest);
    else expand(project, id);
  };
  /** A dependency was clicked: open it, after clearing whatever filter hides it. */
  const go = (project: string, id: string) => {
    if (!shownKeys.has(keyOf(project, id))) {
      setTab('all');
      setQuery('');
      setPicked(new Set());
    }
    expand(project, id);
  };
  const now = Date.now();
  const detail = (project: string, h: { row: BacklogRow; state: string; line: string; reasons: string[] }) => {
    const entry = opened[keyOf(project, h.row.id)];
    return entry && <Detail t={t} project={project} row={h.row} state={h.state} line={h.line} reasons={h.reasons} rows={data?.projects.find((p) => p.name === project)?.rows ?? []} entry={entry} now={now} go={go} />;
  };

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
              <GroupHead t={t} project={g.project} header={g.header} closedId={g.closedId} count={g.tickets.length} toggle={g.header?.row.issue_type === 'epic' ? () => flip(g.project, g.header!.row.id) : null} />
              {g.header?.row.issue_type === 'epic' && opened[keyOf(g.project, g.header.row.id)] && <div className="bl-item">{detail(g.project, g.header)}</div>}
              {g.tickets.map((tk) => (
                <div key={tk.row.id} className="bl-item">
                  <div className="bl-row bl-click" aria-expanded={!!opened[keyOf(tk.project, tk.row.id)]} {...press(() => flip(tk.project, tk.row.id))}>
                    <span className={`tag prio p${tk.row.priority}`}>P{tk.row.priority}</span>
                    <code className="bl-id">{tk.row.id}</code>
                    <span className="bl-title" title={tk.row.title}>
                      {tk.row.title}
                    </span>
                    <span className={`bl-line ${tk.state}`}>{tk.line}</span>
                  </div>
                  {detail(tk.project, tk)}
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

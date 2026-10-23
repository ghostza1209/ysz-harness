import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BacklogRow, TicketDetail } from '../src/beads';
import { Copy } from './App';
import type { Dict } from './i18n';
import { Md } from './Md';
import { ageText, build, stripAge, buttons, groupTickets, keyOf, matches, parseSearch, relations, since, STATES, who, type BacklogAction, type BacklogData, type Button, type Header, type Related, type Ticket } from './backlog';

/** The open Ticket's detail: loading, loaded, or why it failed. */
type Entry = { loading: true } | { detail: TicketDetail } | { error: string };
/** The Ticket in the drawer. */
type Open = { project: string; id: string; entry: Entry };

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
  const age = stripAge(data.projects, now, t);
  return (
    <>
      <div className="bl-strip" role="group" aria-label={t.backlog.projectsLabel}>
        {data.projects.map((p) => (
          <button key={p.name} className={`bl-pill ${picked.has(p.name) ? 'on' : ''} ${p.error ? 'err' : ''}`} aria-pressed={picked.has(p.name)} onClick={() => toggle(p.name)} title={p.error ?? undefined}>
            <span className={`dot ${p.error ? 'bad' : p.rows ? 'ok' : 'idle'}`} />
            <b>{p.name}</b>
            {p.rows && <span>{p.rows.filter((r) => r.issue_type !== 'epic').length}</span>}
            {ageText(p, now, t) && <span className="mute">{ageText(p, now, t)}</span>}
            {p.error && <span className="bl-failed">{t.backlog.pollFailed}</span>}
          </button>
        ))}
        {age && <span className="mute">{age}</span>}
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

/** The drawer beside the list, showing one Ticket. Description and comments are agent-written Markdown, rendered by `Md`. */
function Detail({ t, project, row, state, line, reasons, buttons, busy, act, rows, entry, now, go, close }: { t: Dict; project: string; row: BacklogRow; state: string; line: string; reasons: string[]; buttons: Button[]; busy: boolean; act: (action: BacklogAction) => void; rows: BacklogRow[]; entry: Entry; now: number; go: (project: string, id: string) => void; close: () => void }) {
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
    <aside className="bl-detail" aria-label={row.title}>
      <div className="bl-meta">
        <span className="tag">{project}</span>
        <Copy text={row.id} />
        <span className="tag">{row.issue_type}</span>
        <span className={`tag prio p${row.priority}`}>P{row.priority}</span>
        <span className="tag">{row.status.replace('_', ' ')}</span>
        {row.assignee && <span className="tag">@{who(row.assignee)}</span>}
        <span className="grow" />
        <button className="ghost small" aria-label={t.close} onClick={close}>
          ✕
        </button>
      </div>
      <h3 className="bl-dtitle">{row.title}</h3>
      <div className={`bl-state ${state} ${busy ? 'bl-busy' : ''}`}>
        {reasons.length ? (
          <>
            <b>{t.backlog.markedHead}</b>
            {reasons.map((r, i) => (
              // Two blockers can share a title.
              <div key={i}>{r}</div>
            ))}
          </>
        ) : (
          line
        )}
      </div>
      {state === 'held' && <div className="bl-actions">{t.backlog.heldActions}</div>}
      {buttons.length > 0 && (
        <div className="bl-buttons">
          {buttons.map((b) => (
            <button key={b.action} className={b.primary ? 'primary' : ''} disabled={busy} onClick={() => act(b.action)}>
              {b.label}
            </button>
          ))}
        </div>
      )}
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
        ) : entry.detail.description ? (
          <Md text={entry.detail.description} />
        ) : (
          <span className="mute">{t.backlog.noDescription}</span>
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
                <Md text={c.text} />
              </div>
            ))
          ) : (
            <span className="mute">{t.backlog.noComments}</span>
          ),
        )}
    </aside>
  );
}

/** Where the drawer's width is remembered, in px as last set here. */
const WIDTH_KEY = 'backlogDrawer';
const saveWidth = (px: number) => {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(px)));
  } catch {}
};

/** The drawer's left edge: drag it, or focus it and press ← →, to set the drawer's width. Its right edge stays put; the CSS bounds the width. */
function Grip({ t, setWidth }: { t: Dict; setWidth: (px: number) => void }) {
  const drawer = (e: { currentTarget: HTMLElement }) => e.currentTarget.parentElement!.getBoundingClientRect();
  return (
    <div
      className="bl-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={t.backlog.resizeDrawer}
      tabIndex={0}
      onPointerDown={(e) => {
        // No text selection while dragging.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && setWidth(Math.round(drawer(e).right - e.clientX))}
      // Saved once the drag ends, as it rendered.
      onLostPointerCapture={(e) => saveWidth(drawer(e).width)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const px = Math.round(drawer(e).width) + (e.key === 'ArrowLeft' ? 32 : -32);
        setWidth(px);
        saveWidth(px);
      }}
    />
  );
}

function GroupHead({ t, project, header, closedId, count, toggle, open }: { t: Dict; project: string; header: Header | null; closedId: string | null; count: number; toggle: (() => void) | null; open: boolean }) {
  return (
    <div className={`bl-ghead ${toggle ? 'bl-click' : ''}`} {...(toggle ? { ...press(toggle), 'aria-expanded': open } : {})}>
      <span className="tag bl-proj">{project}</span>
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
function Backlog({ t, stages, refreshMs, post }: { t: Dict; stages: ReadonlyMap<string, string>; refreshMs: number; post: (url: string, done: string) => Promise<void> }) {
  const [data, setData] = useState<BacklogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<Open | null>(null);
  const openKey = open && keyOf(open.project, open.id);
  // null keeps the CSS default width.
  const [width, setWidth] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || null;
    } catch {
      return null;
    }
  });
  // The Tickets with an action in flight, by `project/id`.
  const [flying, setFlying] = useState<Record<string, BacklogAction>>({});

  const load = useCallback(
    () =>
      fetch('/api/backlog')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then(
          (d: BacklogData) => (setData(d), setError(null)),
          (e: Error) => setError(e.message),
        ),
    [],
  );
  // Only while the page is open.
  useEffect(() => {
    void load();
    const id = setInterval(load, refreshMs);
    return () => clearInterval(id);
  }, [load, refreshMs]);

  /** POST a button's action: the row reads in flight, `post` toasts the outcome (or the server's refusal) and refreshes the Dashboard, then the tab refreshes too. */
  const act = async (tk: Ticket, action: BacklogAction) => {
    // The Ready queue's Run now asks first: it claims the Ticket and opens a PR.
    if (action === 'run-now' && !window.confirm(t.runNowConfirm(tk.row.id, tk.project))) return;
    const key = keyOf(tk.project, tk.row.id);
    const base = `/api/projects/${encodeURIComponent(tk.project)}`;
    const id = encodeURIComponent(tk.row.id);
    setFlying((f) => ({ ...f, [key]: action }));
    await post(action === 'run-now' ? `${base}/run-now/${id}` : `${base}/tickets/${id}/${action}`, action === 'run-now' ? t.runNowDone(tk.row.id) : t.backlog.done[action](tk.row.id));
    await load();
    setFlying(({ [key]: _gone, ...rest }) => rest);
  };

  const model = useMemo(() => data && build(data, stages, t), [data, stages, t]);
  const shown = useMemo(() => {
    if (!model) return [];
    const search = parseSearch(query);
    return model.tickets.filter((tk) => (!picked.size || picked.has(tk.project)) && matches(tk, search));
  }, [model, query, picked]);
  const count = (state: Tab) => (state === 'all' ? shown.length : shown.filter((tk) => tk.state === state).length);
  const groups = useMemo(() => model && groupTickets(tab === 'all' ? shown : shown.filter((tk) => tk.state === tab), model), [model, shown, tab]);

  /** Opens a Ticket in the drawer and reads its detail once: fresh as of now. */
  const expand = (project: string, id: string) => {
    if (openKey === keyOf(project, id)) return;
    const mine: Open = { project, id, entry: { loading: true } };
    // A slower fetch for a Ticket opened before must not land in this one's drawer.
    const settle = (entry: Entry) => setOpen((o) => (o === mine ? { ...mine, entry } : o));
    setOpen(mine);
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
  const flip = (project: string, id: string) => (openKey === keyOf(project, id) ? setOpen(null) : expand(project, id));

  // Esc closes the drawer.
  useEffect(() => {
    if (!openKey) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openKey]);

  // From every Ticket, not just the shown ones: a dependency link can open one the filters hide. An epic is only a header.
  // Neither has it once it closes, so the drawer goes too.
  const openTk = openKey ? model?.tickets.find((tk) => keyOf(tk.project, tk.row.id) === openKey) : undefined;
  const openRow = openTk ?? (openKey ? model?.headers.get(openKey) : undefined);
  const openDoing = openKey ? flying[openKey] : undefined;

  const toggle = (name: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <div className={openRow ? 'bl-split' : undefined} style={width ? ({ '--drawer': `${width}px` } as React.CSSProperties) : undefined}>
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
                <GroupHead t={t} project={g.project} header={g.header} closedId={g.closedId} count={g.tickets.length} toggle={g.header?.row.issue_type === 'epic' ? () => flip(g.project, g.header!.row.id) : null} open={!!g.header && openKey === keyOf(g.project, g.header.row.id)} />
                {g.tickets.map((tk) => {
                  const doing = flying[keyOf(tk.project, tk.row.id)];
                  return (
                    <div key={tk.row.id} className="bl-item">
                      <div className="bl-row bl-click" aria-expanded={openKey === keyOf(tk.project, tk.row.id)} {...press(() => flip(tk.project, tk.row.id))}>
                        <span className={`tag prio p${tk.row.priority}`}>P{tk.row.priority}</span>
                        <code className="bl-id">{tk.row.id}</code>
                        <span className="bl-title" title={tk.row.title}>
                          {tk.row.title}
                        </span>
                        <span className={`bl-line ${tk.state} ${doing ? 'bl-busy' : ''}`}>{doing ? t.backlog.inFlight[doing] : tk.line}</span>
                      </div>
                      {doing && <div className="bl-bar" />}
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </section>
      {open && openRow && (
        <div className="bl-drawer">
          <Grip t={t} setWidth={setWidth} />
          <Detail key={openKey} t={t} project={open.project} row={openRow.row} state={openRow.state} line={openDoing ? t.backlog.inFlight[openDoing] : openRow.line} reasons={openDoing ? [] : openRow.reasons} buttons={openTk ? buttons(openTk, t) : []} busy={!!openDoing} act={(a) => openTk && void act(openTk, a)} rows={data?.projects.find((p) => p.name === open.project)?.rows ?? []} entry={open.entry} now={Date.now()} go={expand} close={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

// The overview's clock re-renders App every second; the page changes only with its props and polls.
export default memo(Backlog);

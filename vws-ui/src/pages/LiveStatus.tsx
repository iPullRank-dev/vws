import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle, ChevronDown, ChevronRight, Download, ExternalLink, Info, MinusCircle, Search, XCircle } from 'lucide-react';
import Plot from 'react-plotly.js';
import { API_BASE } from '../config';
import { csvCell, downloadText, fmt, shortUrl } from '../lib/vws';
import './LiveStatus.css';

type RowStatus = 'embedded' | 'warning' | 'skipped' | 'error';

interface Issue { level: 'error' | 'skip' | 'warn' | 'info'; code: string; text: string }

interface CrawlEvent {
  seq: number;
  index?: number;
  t?: number;
  url: string;
  title?: string;
  status?: RowStatus;           // missing on events from an older backend
  issues?: Issue[];
  status_code: number | null;
  response_time_ms?: number;
  load_ms?: number;
  ttfb_ms?: number | null;
  dns_ms?: number | null;
  connect_ms?: number | null;
  tls_ms?: number | null;
  final_url?: string;
  redirects?: { url: string; status: number | null }[];
  content_type?: string | null;
  html_bytes?: number | null;
  transfer_bytes?: number | null;
  server?: string | null;
  cache_control?: string | null;
  cache_status?: string | null;
  age?: string | null;
  tokens?: number | null;
  embedded_tokens?: number | null;
  truncated?: boolean;
  embed_ms?: number | null;
  embed_queue_ms?: number | null;
  device?: string | null;
  center_sim?: number | null;
  closest_url?: string | null;
  closest_sim?: number | null;
  near_duplicate?: boolean;
  far_from_core?: boolean;
  core_fence_sim?: number | null;
  compared_with?: number;
  embedding_3d: [number, number, number];
}

interface StartEvent { total: number; concurrency: number; model: string; dim: number; dup_threshold: number; max_tokens: number; timeout_s: number }

const STATUS_META: Record<RowStatus, { label: string; color: string; Icon: typeof CheckCircle; help: string }> = {
  embedded: { label: 'Embedded', color: 'var(--good)', Icon: CheckCircle, help: 'Fetched, extracted and embedded with nothing to flag.' },
  warning: { label: 'Warning', color: 'var(--warn)', Icon: AlertTriangle, help: 'Embedded, but something needs a look: redirect, noindex, cut off, or near-duplicate.' },
  skipped: { label: 'Skipped', color: 'var(--text-muted)', Icon: MinusCircle, help: 'Fetched but not embedded: not HTML, or no main content to embed.' },
  error: { label: 'Error', color: 'var(--bad)', Icon: XCircle, help: 'Could not be fetched or embedded: timeout, network error, 4xx/5xx.' },
};
const STATUS_ORDER: RowStatus[] = ['embedded', 'warning', 'skipped', 'error'];
const STATUS_RANK: Record<RowStatus, number> = { error: 0, skipped: 1, warning: 2, embedded: 3 };
const SLOW_TTFB_MS = 800;

// Short flags shown in the table; the full sentence lives in the row detail.
const FLAG_LABEL: Record<string, string> = {
  redirect: 'redirect', same_final_url: 'same final URL', noindex: 'noindex', truncated: 'cut off',
  near_duplicate: 'near-dup', far_from_core: 'far from core', slow: 'slow TTFB',
};

const rowStatus = (e: CrawlEvent): RowStatus =>
  e.status || (e.status_code && e.status_code >= 200 && e.status_code < 400 ? 'embedded' : 'error');
const loadMs = (e: CrawlEvent) => e.load_ms ?? e.response_time_ms ?? null;
const pathOf = (u: string) => shortUrl(u) || u;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ms = (v: number | null | undefined) => (typeof v === 'number' ? `${Math.round(v).toLocaleString()}` : '—');
const kb = (v: number | null | undefined) => (typeof v === 'number' ? (v >= 1024 * 1024 ? `${(v / 1048576).toFixed(1)} MB` : `${(v / 1024).toFixed(1)} KB`) : '—');

function flagsOf(e: CrawlEvent): string[] {
  const codes = (e.issues || []).filter(i => i.level === 'warn' || i.level === 'info').map(i => i.code);
  if (typeof e.ttfb_ms === 'number' && e.ttfb_ms > SLOW_TTFB_MS) codes.push('slow');
  return codes.filter(c => FLAG_LABEL[c]);
}

type SortKey = 'seq' | 'status' | 'path' | 'code' | 'ttfb' | 'load' | 'size' | 'tokens' | 'embed' | 'center' | 'closest';
const SORTERS: Record<SortKey, (e: CrawlEvent) => number | string | null> = {
  seq: e => e.seq,
  status: e => STATUS_RANK[rowStatus(e)],
  path: e => pathOf(e.url),
  code: e => e.status_code ?? -1,
  ttfb: e => e.ttfb_ms ?? null,
  load: e => loadMs(e),
  size: e => e.html_bytes ?? null,
  tokens: e => e.tokens ?? null,
  embed: e => e.embed_ms ?? null,
  center: e => e.center_sim ?? null,
  closest: e => e.closest_sim ?? null,
};

export default function LiveStatus() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [statusMsg, setStatusMsg] = useState('Connecting to crawler...');
  const [isComplete, setIsComplete] = useState(false);
  const [events, setEvents] = useState<CrawlEvent[]>([]);
  const [start, setStart] = useState<StartEvent | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<RowStatus[]>([]);
  const [flagFilter, setFlagFilter] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'seq', dir: -1 });
  const [open, setOpen] = useState<number | null>(null);
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    let sse: EventSource | null = null;
    let canceled = false;
    seen.current = new Set();
    setEvents([]);

    const ingest = (list: any[]) => {
      const fresh: CrawlEvent[] = [];
      for (const d of list) {
        if (typeof d.seq === 'number') {
          if (seen.current.has(d.seq)) continue;
          seen.current.add(d.seq);
        }
        if (d.type === 'start') setStart(d);
        else if (d.type === 'status') setStatusMsg(d.message);
        else if (d.type === 'page_crawled') fresh.push(d);
        else if (d.type === 'complete') {
          setStatusMsg(d.message);
          setElapsed(d.elapsed_s ?? null);
          setIsComplete(true);
        }
      }
      if (fresh.length) setEvents(prev => [...prev, ...fresh]);
    };

    const reconcile = () =>
      fetch(`${API_BASE}/api/projects/${projectId}/crawl-log`).then(r => r.json()).then(d => { if (!canceled) ingest(d.events || []); }).catch(() => {});

    // The log is persisted server-side, so a refresh rebuilds the table and only
    // streams what's still to come.
    fetch(`${API_BASE}/api/projects/${projectId}/crawl-log`)
      .then(r => (r.ok ? r.json() : { events: [], complete: false }))
      .catch(() => ({ events: [], complete: false }))
      .then(d => {
        if (canceled) return;
        ingest(d.events || []);
        if (d.complete) return;
        sse = new EventSource(`${API_BASE}/api/projects/${projectId}/stream`);
        sse.onmessage = (e) => {
          const data = JSON.parse(e.data);
          ingest([data]);
          if (data.type === 'complete') { sse?.close(); reconcile(); }
        };
        sse.onerror = () => {
          sse?.close();
          reconcile().then(() => setStatusMsg(m => (m.includes('Finished') ? m : 'Stream ended. Showing the saved crawl log.')));
        };
      });

    return () => { canceled = true; sse?.close(); };
  }, [projectId]);

  // --- summary -------------------------------------------------------------
  const counts = useMemo(() => {
    const c: Record<RowStatus, number> = { embedded: 0, warning: 0, skipped: 0, error: 0 };
    events.forEach(e => { c[rowStatus(e)] += 1; });
    return c;
  }, [events]);
  const flagCounts = useMemo(() => {
    const c: Record<string, number> = {};
    events.forEach(e => flagsOf(e).forEach(f => { c[f] = (c[f] || 0) + 1; }));
    return c;
  }, [events]);
  const stats = useMemo(() => {
    const nums = (f: (e: CrawlEvent) => number | null | undefined) =>
      events.map(f).filter((v): v is number => typeof v === 'number');
    return {
      ttfb: median(nums(e => e.ttfb_ms)),
      load: median(nums(e => (e.status_code ? loadMs(e) : null))),
      embed: median(nums(e => e.embed_ms)),
      queue: median(nums(e => e.embed_queue_ms)),
      device: events.find(e => e.device)?.device || null,
    };
  }, [events]);
  const total = start?.total ?? null;
  const lastT = events.reduce((m, e) => Math.max(m, e.t || 0), 0);
  const perMin = lastT > 0 ? (events.length / lastT) * 60 : null;

  // --- table -----------------------------------------------------------------
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const r = events.filter(e =>
      (!statusFilter.length || statusFilter.includes(rowStatus(e))) &&
      (!flagFilter || flagsOf(e).includes(flagFilter)) &&
      (!s || `${e.url} ${e.title || ''} ${(e.issues || []).map(i => i.text).join(' ')}`.toLowerCase().includes(s)));
    const get = SORTERS[sort.key];
    return r.sort((a, b) => {
      const x = get(a), y = get(b);
      if (x === null && y === null) return a.seq - b.seq;
      if (x === null) return 1;      // blanks always last
      if (y === null) return -1;
      if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * sort.dir;
      return ((x as number) - (y as number)) * sort.dir || a.seq - b.seq;
    });
  }, [events, statusFilter, flagFilter, q, sort]);

  const sortBy = (key: SortKey) =>
    setSort(s => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === 'path' || key === 'status' ? 1 : -1 }));
  const Th = ({ k, children, num, title }: { k: SortKey; children: React.ReactNode; num?: boolean; title?: string }) => (
    <th className={num ? 'num' : ''} onClick={() => sortBy(k)} title={title} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      {children}{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const exportCsv = () => {
    const head = ['#', 'Status', 'URL', 'Final URL', 'Title', 'HTTP', 'Redirect hops', 'TTFB ms', 'Load ms', 'DNS ms', 'Connect ms', 'TLS ms',
      'HTML bytes', 'Transfer bytes', 'Content type', 'Server', 'Cache-Control', 'Cache status', 'Age',
      'Tokens', 'Embedded tokens', 'Cut off', 'Embed ms', 'Embed queue ms', 'Similarity to center', 'Closest page', 'Closest similarity',
      'Near-duplicate', 'Far from core', 'Issues'];
    const lines = rows.map(e => [e.index ?? e.seq, STATUS_META[rowStatus(e)].label, e.url, e.final_url || '', e.title || '', e.status_code ?? '',
      e.redirects?.length ?? 0, e.ttfb_ms ?? '', loadMs(e) ?? '', e.dns_ms ?? '', e.connect_ms ?? '', e.tls_ms ?? '',
      e.html_bytes ?? '', e.transfer_bytes ?? '', e.content_type || '', e.server || '', e.cache_control || '', e.cache_status || '', e.age || '',
      e.tokens ?? '', e.embedded_tokens ?? '', e.truncated ? 'yes' : '', e.embed_ms ?? '', e.embed_queue_ms ?? '',
      e.center_sim ?? '', e.closest_url || '', e.closest_sim ?? '', e.near_duplicate ? 'yes' : '', e.far_from_core ? 'yes' : '',
      (e.issues || []).map(i => i.text).join(' | ')].map(csvCell).join(','));
    downloadText(`project_${projectId}_crawl_log.csv`, [head.join(','), ...lines].join('\n'), 'text/csv');
  };

  // --- charts ----------------------------------------------------------------
  const ordered = useMemo(() => [...events].sort((a, b) => a.seq - b.seq), [events]);
  const barColor: Record<RowStatus, string> = { embedded: '#10b981', warning: '#f59e0b', skipped: '#64748b', error: '#ef4444' };
  const embedded = ordered.filter(e => typeof e.tokens === 'number' || (!e.status && e.embedding_3d.some(v => v !== 0)));

  return (
    <div className="live-status-container">
      <header className="ls-header">
        <button onClick={() => navigate('/')} className="btn-back">
          <ArrowLeft size={16} /> Dashboard
        </button>
        <div className="status-indicator">
          Project #{projectId} - <span className={isComplete ? 'complete-text' : 'pulsing-text'}>
            {!isComplete && events.length ? `Crawling… ${events.length}${total !== null ? ` of ${total}` : ''} pages` : statusMsg}
          </span>
        </div>
        <button onClick={() => navigate(`/project/${projectId}`)} className="btn-primary" disabled={!isComplete}>
          View Analysis Workspace
          {isComplete && <CheckCircle size={16} style={{ marginLeft: '0.5rem' }} />}
        </button>
      </header>

      <main className="ls-dashboard">
        <div className="chart-panel">
          <h3>Load time (ms) per page, by status</h3>
          <div className="plot-container">
            <Plot
              // One trace per status so the legend names the colors. Pages with no
              // response (timeouts, DNS errors) have no load time and are left out.
              data={STATUS_ORDER.map(s => {
                const list = ordered.filter(e => rowStatus(e) === s && e.status_code);
                return {
                  name: STATUS_META[s].label,
                  x: list.map(e => e.index ?? e.seq),
                  y: list.map(e => loadMs(e) ?? 0),
                  type: 'bar',
                  marker: { color: barColor[s] },
                  text: list.map(e => `${pathOf(e.url)}<br>${STATUS_META[s].label} · HTTP ${e.status_code} · TTFB ${ms(e.ttfb_ms)} ms`),
                  hovertemplate: '%{text}<br>Load %{y:,} ms<extra></extra>',
                  textposition: 'none',
                } as any;
              })}
              layout={{
                autosize: true,
                paper_bgcolor: 'transparent',
                plot_bgcolor: 'transparent',
                font: { color: '#94a3b8' },
                margin: { l: 50, r: 16, t: 24, b: 36 },
                barmode: 'overlay',
                bargap: 0.15,
                showlegend: true,
                legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 11 } },
                xaxis: { title: { text: 'Page # (crawl order)' }, gridcolor: '#1e293b' },
                yaxis: { gridcolor: '#273449', zerolinecolor: '#334155' },
                hoverlabel: { bgcolor: '#0b1220', bordercolor: '#334155', font: { color: '#e2e8f0' } },
              }}
              useResizeHandler
              style={{ width: '100%', height: '100%' }}
            />
          </div>
        </div>

        <div className="chart-panel">
          <h3>Live Embeddings Plot <span className="ll-sub">first 3 vector dimensions · hover for the page</span></h3>
          <div className="plot-container">
            <Plot
              data={[{
                x: embedded.map(e => e.embedding_3d[0]),
                y: embedded.map(e => e.embedding_3d[1]),
                z: embedded.map(e => e.embedding_3d[2]),
                text: embedded.map(e => pathOf(e.url)),
                hovertemplate: '%{text}<extra></extra>',
                mode: 'markers',
                type: 'scatter3d',
                marker: { size: 5, color: '#3b82f6', opacity: 0.85 },
              } as any]}
              layout={{
                autosize: true,
                paper_bgcolor: 'transparent',
                plot_bgcolor: 'transparent',
                font: { color: '#94a3b8' },
                margin: { l: 0, r: 0, t: 0, b: 0 },
                hoverlabel: { bgcolor: '#0b1220', bordercolor: '#334155', font: { color: '#e2e8f0' } },
                scene: {
                  xaxis: { visible: false },
                  yaxis: { visible: false },
                  zaxis: { visible: false },
                },
              }}
              useResizeHandler
              style={{ width: '100%', height: '100%' }}
            />
          </div>
        </div>
      </main>

      <section className="event-log">
        <div className="ll-head">
          <h3>Live Log</h3>
          <span className="ll-sub">
            {total !== null ? `${events.length} of ${total} pages` : `${events.length} pages`}
            {perMin ? ` · ${perMin.toFixed(0)} pages/min` : ''}
            {elapsed !== null ? ` · finished in ${elapsed}s` : ''}
            {start ? ` · ${start.concurrency} at a time · ${start.timeout_s}s timeout` : ''}
          </span>
        </div>
        {total ? (
          <div className="ll-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={events.length}>
            {STATUS_ORDER.map(s => counts[s] > 0 && (
              <span key={s} style={{ width: `${(counts[s] / total) * 100}%`, background: STATUS_META[s].color }} title={`${STATUS_META[s].label}: ${counts[s]}`} />
            ))}
          </div>
        ) : null}

        <div className="ll-tiles">
          <div className="ll-tile" title="Median time to first byte of the final response (after redirects)">
            <span>Median TTFB</span><strong>{ms(stats.ttfb)}<small> ms</small></strong>
            <em>{flagCounts.slow ? `${flagCounts.slow} over ${SLOW_TTFB_MS} ms` : 'none slow'}</em>
          </div>
          <div className="ll-tile" title="Median time from request to DOMContentLoaded, including redirects">
            <span>Median load</span><strong>{ms(stats.load)}<small> ms</small></strong>
            <em>to DOMContentLoaded</em>
          </div>
          <div className="ll-tile" title="Median model time per page, excluding time spent waiting for other pages to finish embedding">
            <span>Median embed</span><strong>{ms(stats.embed)}<small> ms</small></strong>
            <em>{stats.device ? `on ${stats.device.toUpperCase()}` : '—'}{stats.queue ? ` · waits ${ms(stats.queue)} ms` : ''}</em>
          </div>
          <button className={`ll-tile ${flagFilter === 'truncated' ? 'on' : ''}`} onClick={() => setFlagFilter(f => (f === 'truncated' ? null : 'truncated'))}
            title="Pages longer than the embedding window: only the start of the page is in the vector">
            <span>Cut off</span><strong>{flagCounts.truncated || 0}</strong>
            <em>{start ? `over ${start.max_tokens.toLocaleString()} tokens` : 'over the token limit'}</em>
          </button>
          <button className={`ll-tile ${flagFilter === 'near_duplicate' ? 'on' : ''}`} onClick={() => setFlagFilter(f => (f === 'near_duplicate' ? null : 'near_duplicate'))}
            title="Pages whose vector is at or above the near-duplicate threshold against a page crawled earlier">
            <span>Near-duplicates</span><strong>{flagCounts.near_duplicate || 0}</strong>
            <em>{start ? `similarity ≥ ${start.dup_threshold}` : '—'}</em>
          </button>
          <button className={`ll-tile ${flagFilter === 'far_from_core' ? 'on' : ''}`} onClick={() => setFlagFilter(f => (f === 'far_from_core' ? null : 'far_from_core'))}
            title="Beyond the outlier fence (Q3 + 1.5 x IQR of distance to the center) of the pages crawled so far, same rule as Site Focus' Peripheral zone. Needs 20+ pages.">
            <span>Far from core</span><strong>{flagCounts.far_from_core || 0}</strong>
            <em>vs pages crawled so far</em>
          </button>
        </div>

        <div className="ll-bar">
          <div className="ll-chips">
            {STATUS_ORDER.map(s => {
              const M = STATUS_META[s];
              const on = statusFilter.includes(s);
              return (
                <button key={s} className={`ll-chip ${on ? 'on' : ''}`} title={M.help}
                  onClick={() => setStatusFilter(f => (f.includes(s) ? f.filter(x => x !== s) : [...f, s]))}>
                  <M.Icon size={13} style={{ color: M.color }} />{M.label}<span>{counts[s]}</span>
                </button>
              );
            })}
            {flagFilter && (
              <button className="ll-chip on" onClick={() => setFlagFilter(null)} title="Clear this filter">
                {FLAG_LABEL[flagFilter]} ✕
              </button>
            )}
          </div>
          <div className="ll-search"><Search size={13} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter URL, title or issue…" /></div>
          <button className="btn-secondary ll-csv" onClick={exportCsv} disabled={!rows.length}><Download size={13} /> CSV</button>
        </div>

        <div className="ll-table-wrap">
          <table className="ll-table">
            <thead>
              <tr>
                <th style={{ width: 22 }} />
                <Th k="seq" num>#</Th>
                <Th k="status">Status</Th>
                <Th k="path">Page</Th>
                <Th k="code" num>HTTP</Th>
                <Th k="ttfb" num title="Time to first byte of the final response">TTFB</Th>
                <Th k="load" num title="Request to DOMContentLoaded, including redirects">Load</Th>
                <Th k="size" num title="HTML size as served (uncompressed)">Size</Th>
                <Th k="tokens" num title="Tokens in the page text sent to the model; a red mark means it was cut off">Tokens</Th>
                <Th k="embed" num title="Model time for this page (not counting the wait for other pages)">Embed</Th>
                <Th k="center" num title="Cosine similarity to the average of the pages crawled before it">vs center</Th>
                <Th k="closest" num title="Most similar page crawled before it">Closest page</Th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(e => {
                const st = rowStatus(e);
                const M = STATUS_META[st];
                const isOpen = open === e.seq;
                const flags = flagsOf(e);
                const firstProblem = (e.issues || []).find(i => i.level === 'error' || i.level === 'skip');
                return (
                  <Fragment key={e.seq}>
                    <tr className={`ll-row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : e.seq)}>
                      <td className="ll-caret">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                      <td className="num muted">{e.index ?? e.seq}</td>
                      <td><span className="ll-status"><M.Icon size={13} style={{ color: M.color }} />{M.label}</span></td>
                      <td className="ll-page" title={e.url}>
                        <div className="ll-path">{pathOf(e.url)}</div>
                        <div className="muted ll-path">{firstProblem ? firstProblem.text : e.title}</div>
                      </td>
                      <td className="num">{e.status_code ?? '—'}</td>
                      <td className="num">{ms(e.ttfb_ms)}</td>
                      <td className="num">{e.status_code ? ms(loadMs(e)) : '—'}</td>
                      <td className="num">{kb(e.html_bytes)}</td>
                      <td className="num">{typeof e.tokens === 'number'
                        ? <>{e.tokens.toLocaleString()}{e.truncated && <span className="ll-cut" title={`Only the first ${e.embedded_tokens?.toLocaleString()} were embedded`}> ✂</span>}</>
                        : '—'}</td>
                      <td className="num">{ms(e.embed_ms)}</td>
                      <td className="num">{fmt(e.center_sim)}</td>
                      <td className="ll-closest" title={e.closest_url || ''}>
                        {e.closest_url ? <><span className="ll-path">{pathOf(e.closest_url)}</span><span className="num muted"> {fmt(e.closest_sim)}</span></> : <span className="muted">—</span>}
                      </td>
                      <td>{flags.map(f => <span key={f} className={`ll-flag ll-flag-${f}`}>{FLAG_LABEL[f]}</span>)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="ll-detail-row">
                        <td colSpan={13}>
                          <Detail e={e} start={start} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <p className="muted ll-empty">{events.length ? 'No pages match these filters.' : 'Waiting for the first page…'}</p>}
        </div>
      </section>
    </div>
  );
}

function Detail({ e, start }: { e: CrawlEvent; start: StartEvent | null }) {
  const issues = e.issues || [];
  const levelIcon = (lv: Issue['level']) =>
    lv === 'error' ? <XCircle size={13} style={{ color: 'var(--bad)' }} />
      : lv === 'skip' ? <MinusCircle size={13} style={{ color: 'var(--text-muted)' }} />
        : lv === 'warn' ? <AlertTriangle size={13} style={{ color: 'var(--warn)' }} />
          : <Info size={13} style={{ color: 'var(--accent)' }} />;
  return (
    <div className="ll-detail">
      <div className="ll-detail-issues">
        {issues.length
          ? issues.map((i, k) => <div key={k} className="ll-issue">{levelIcon(i.level)}<span>{i.text}</span></div>)
          : <div className="ll-issue"><CheckCircle size={13} style={{ color: 'var(--good)' }} /><span>No issues.</span></div>}
      </div>
      <div className="ll-detail-grid">
        <div>
          <h4>Fetch</h4>
          <dl>
            <dt>Requested</dt><dd><a href={e.url} target="_blank" rel="noreferrer">{e.url} <ExternalLink size={11} /></a></dd>
            {e.final_url && e.final_url !== e.url && <><dt>Final URL</dt><dd>{e.final_url}</dd></>}
            {e.redirects && e.redirects.length > 0 && <><dt>Redirects</dt><dd>{e.redirects.map((r, k) => <div key={k}>{r.status ?? '3xx'} {pathOf(r.url)}</div>)}</dd></>}
            <dt>HTTP</dt><dd>{e.status_code ?? 'no response'}</dd>
            <dt>Content type</dt><dd>{e.content_type || '—'}</dd>
            <dt>Title</dt><dd>{e.title || '—'}</dd>
          </dl>
        </div>
        <div>
          <h4>Performance</h4>
          <dl>
            <dt>TTFB</dt><dd>{ms(e.ttfb_ms)} ms</dd>
            <dt>Load</dt><dd>{ms(loadMs(e))} ms <span className="muted">to DOMContentLoaded</span></dd>
            <dt>DNS · connect · TLS</dt><dd>{ms(e.dns_ms)} · {ms(e.connect_ms)} · {ms(e.tls_ms)} ms</dd>
            <dt>HTML size</dt><dd>{kb(e.html_bytes)}{typeof e.transfer_bytes === 'number' && e.transfer_bytes !== e.html_bytes ? ` (${kb(e.transfer_bytes)} transferred)` : ''}</dd>
            <dt>Server</dt><dd>{e.server || '—'}</dd>
            <dt>Cache-Control</dt><dd>{e.cache_control || '—'}</dd>
            <dt>Cache status</dt><dd>{e.cache_status || '—'}{e.age ? ` · age ${e.age}s` : ''}</dd>
          </dl>
        </div>
        <div>
          <h4>Vector</h4>
          <dl>
            <dt>Tokens</dt><dd>{typeof e.tokens === 'number' ? `${e.embedded_tokens?.toLocaleString()} of ${e.tokens.toLocaleString()} embedded` : '—'}{start && typeof e.tokens === 'number' ? <span className="muted"> · limit {start.max_tokens.toLocaleString()}</span> : null}</dd>
            <dt>Embed time</dt><dd>{ms(e.embed_ms)} ms{typeof e.embed_queue_ms === 'number' ? <span className="muted"> + {ms(e.embed_queue_ms)} ms waiting</span> : null}{e.device ? <span className="muted"> · {e.device.toUpperCase()}</span> : null}</dd>
            <dt>vs center</dt><dd>{fmt(e.center_sim)}{typeof e.compared_with === 'number' && e.compared_with > 0 ? <span className="muted"> · center of {e.compared_with} earlier pages</span> : null}{typeof e.core_fence_sim === 'number' ? <span className="muted"> · outlier below {fmt(e.core_fence_sim)}</span> : null}</dd>
            <dt>Closest page</dt><dd>{e.closest_url ? <>{pathOf(e.closest_url)} <span className="muted">· {fmt(e.closest_sim)}{start ? ` (near-dup ≥ ${start.dup_threshold})` : ''}</span></> : '—'}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

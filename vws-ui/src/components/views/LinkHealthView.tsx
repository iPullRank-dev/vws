import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { ChevronDown, ChevronRight, Download, Loader2, MapPin, Search } from 'lucide-react';
import { API_BASE } from '../../config';
import { SEVERITY_COLOR, csvCell, downloadText, fmt, shortUrl } from '../../lib/vws';

interface LinkRow { source_url: string; anchor: string; relevance: number | null }
interface PageRow {
  url: string; title: string; inbound: number; sources: number; avg_relevance: number | null; weak: number; relevant: number;
  queries: number; partial_queries: number; top_anchors: { anchor: string; count: number }[];
  status: string; severity: 'high' | 'medium' | 'low' | 'none'; text: string;
  links: LinkRow[]; suggested_sources: { source_url: string; title: string; similarity: number }[];
}
export interface Health {
  kind: string; message?: string; weak_cut?: number; good_cut?: number;
  summary: { links: number; scored?: number; targets?: number; avg_relevance?: number; status_counts?: Record<string, number> };
  pages: PageRow[];
}

interface Props {
  projectId: string;
  kind: 'internal' | 'external';
  refreshKey: number;
  onSelect: (url: string) => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onLoaded?: (d: Health | null) => void;
}

export default function LinkHealthView({ projectId, kind, refreshKey, onSelect, notify, onLoaded }: Props) {
  const [data, setData] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('needs');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(60);
  const [placing, setPlacing] = useState<string | null>(null);
  const [placements, setPlacements] = useState<Record<string, any>>({});

  useEffect(() => {
    setLoading(true);
    axios.get(`${API_BASE}/api/projects/${projectId}/link-health`, { params: { kind } })
      .then(r => { setData(r.data); onLoaded?.(r.data); }).catch(() => { setData(null); onLoaded?.(null); }).finally(() => setLoading(false));
  }, [projectId, kind, refreshKey]);

  const rows = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return data.pages.filter(p => (status === 'all' || (status === 'needs' ? p.severity !== 'none' : p.status === status))
      && (!s || `${p.url} ${p.title}`.toLowerCase().includes(s)));
  }, [data, status, q]);

  const place = async (target: string, source: string, anchor: string) => {
    const key = `${source}→${target}`;
    setPlacing(key);
    try {
      const r = await axios.post(`${API_BASE}/api/projects/${projectId}/link-placement`, { source_url: source, target_url: target, anchor }, { timeout: 300000 });
      if (r.data.error) notify(r.data.error, 'error'); else setPlacements(p => ({ ...p, [key]: r.data }));
    } catch (e: any) {
      notify(e?.response?.data?.detail || e?.message || 'Placement failed.', 'error');
    } finally { setPlacing(null); }
  };

  const exportCsv = () => {
    const head = ['Page', 'Status', 'Inbound', 'Sources', 'Relevant', 'Weak', 'Avg relevance', 'Queries', 'Action', 'Suggested sources'];
    const lines = rows.map(p => [p.url, p.status, p.inbound, p.sources, p.relevant, p.weak, p.avg_relevance ?? '', p.queries, p.text,
      p.suggested_sources.map(s => s.source_url).join(' ')].map(csvCell).join(','));
    downloadText(`${kind}_link_health.csv`, [head.join(','), ...lines].join('\n'), 'text/csv');
  };

  if (loading) return <div className="act-loading"><Loader2 className="spinner" size={22} /> Scoring links…</div>;
  if (!data || !data.pages.length) return (
    <div className="view">
      <Explain kind={kind} />
      <div className="lab-empty muted">{data?.message || 'No link data yet.'}</div>
    </div>
  );

  const statuses = Object.entries(data.summary.status_counts || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="view">
      <Explain kind={kind} weak={data.weak_cut} good={data.good_cut} />
      <div className="act-filters">
        <div className="chips">
          <button className={status === 'needs' ? 'chip on' : 'chip'} onClick={() => setStatus('needs')}>Needs action <span>{data.pages.filter(p => p.severity !== 'none').length}</span></button>
          {statuses.map(([s, n]) => <button key={s} className={status === s ? 'chip on' : 'chip'} onClick={() => setStatus(s)}>{s} <span>{n}</span></button>)}
          <button className={status === 'all' ? 'chip on' : 'chip'} onClick={() => setStatus('all')}>All <span>{data.pages.length}</span></button>
        </div>
        <div className="act-filter-row">
          <div className="act-search"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter pages…" /></div>
          <span className="muted small">{data.summary.links.toLocaleString()} links · average relevance {fmt(data.summary.avg_relevance)}</span>
          <button className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={exportCsv}><Download size={13} /> CSV</button>
        </div>
      </div>

      <div className="act-list">
        {rows.slice(0, limit).map(p => {
          const isOpen = open === p.url;
          return (
            <div key={p.url} className={`act-row ${isOpen ? 'open' : ''}`}>
              <div className="lh-main" onClick={() => setOpen(isOpen ? null : p.url)}>
                <span className="act-type" style={{ color: SEVERITY_COLOR[p.severity], background: `${SEVERITY_COLOR[p.severity]}1f`, borderColor: `${SEVERITY_COLOR[p.severity]}55` }}>{p.status}</span>
                <div className="act-text">
                  <div className="act-title">{p.title} <span className="muted small">{shortUrl(p.url)}</span></div>
                  <div className="act-why">{p.text}</div>
                </div>
                <div className="lh-nums">
                  <span><strong>{p.sources}</strong> {kind === 'internal' ? 'linking pages' : 'referring pages'}</span>
                  <span>{p.relevant} relevant · {p.weak} weak</span>
                </div>
                {isOpen ? <ChevronDown size={16} className="chev" /> : <ChevronRight size={16} className="chev" />}
              </div>
              {isOpen && (
                <div className="act-detail">
                  <div className="act-detail-cols">
                    <div>
                      {kind === 'internal' && p.suggested_sources.length > 0 && (
                        <>
                          <h4>Add links from these related pages</h4>
                          <table className="mini">
                            <tbody>
                              {p.suggested_sources.map(s => {
                                const key = `${s.source_url}→${p.url}`;
                                const pl = placements[key];
                                return (
                                  <tr key={s.source_url}>
                                    <td className="url" title={s.source_url}>{shortUrl(s.source_url)}{pl && <div className="placement"><b>{pl.advice}</b><div>“{pl.sentence}”</div></div>}</td>
                                    <td className="num">{fmt(s.similarity)}</td>
                                    <td><button className="link-btn" disabled={placing === key} onClick={() => place(p.url, s.source_url, p.top_anchors[0]?.anchor || p.title)}>
                                      {placing === key ? <Loader2 size={11} className="spinner" /> : <MapPin size={11} />} where?</button></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </>
                      )}
                      {p.top_anchors.length > 0 && (
                        <>
                          <h4>Most-used anchors</h4>
                          <div className="tagwrap">{p.top_anchors.map(a => <span key={a.anchor} className="tag">{a.anchor} <span className="muted">×{a.count}</span></span>)}</div>
                        </>
                      )}
                      <div className="act-buttons" style={{ marginTop: '0.6rem' }}>
                        <button className="btn-secondary" onClick={() => onSelect(p.url)}>Inspect page</button>
                      </div>
                    </div>
                    <div>
                      <h4>{kind === 'internal' ? 'Inbound links' : 'Backlinks'} <span className="muted">(least relevant first)</span></h4>
                      {p.links.length === 0 ? <p className="muted small">None.</p> : (
                        <table className="mini">
                          <thead><tr><th>From</th><th>Anchor</th><th className="num">Relevance</th></tr></thead>
                          <tbody>
                            {p.links.map((l, i) => (
                              <tr key={i}>
                                <td className="url" title={l.source_url}>{kind === 'internal' ? shortUrl(l.source_url) : l.source_url.replace(/^https?:\/\//, '')}</td>
                                <td>{l.anchor || '—'}</td>
                                <td className="num" style={{ color: l.relevance !== null && data.weak_cut !== undefined && l.relevance < data.weak_cut ? 'var(--bad)' : undefined }}>{fmt(l.relevance)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {rows.length > limit && <button className="btn-secondary act-more" onClick={() => setLimit(l => l + 60)}>Show more ({rows.length - limit} left)</button>}
        {rows.length === 0 && <div className="muted act-empty">Nothing in this filter.</div>}
      </div>
    </div>
  );
}

function Explain({ kind, weak, good }: { kind: string; weak?: number; good?: number }) {
  return kind === 'internal' ? (
    <div className="howto">
      <strong>How to read this.</strong> Every internal link is scored by how similar the linking page is to the page it points at. Links between
      related pages pass topical relevance; links between unrelated pages mostly don't. Pages are grouped by what they need:
      <b> Orphan</b> (nothing links in), <b>Under-linked</b> (the best page for target queries, but few related pages link to it),
      <b> Diluted</b> (most inbound links come from unrelated pages) and <b>Missing related links</b>.
      {weak !== undefined && <> A link counts as relevant at ≥ {fmt(good)} and weak below {fmt(weak)} (this site's own percentiles). </>}
      Open a page to see its inbound links and the related pages that should link to it; <i>where?</i> finds the passage on the source page to put the link.
    </div>
  ) : (
    <div className="howto">
      <strong>How to read this.</strong> Each backlink is scored by how similar the referring page is to your page it points at. Relevant
      backlinks reinforce the target page's topic; off-topic ones don't, though they aren't harmful on their own. The priority list is
      pages that are the best match for target queries yet have no topically close backlinks: aim outreach at sites covering those topics.
      {weak !== undefined && <> Relevant ≥ {fmt(good)}, off-topic &lt; {fmt(weak)} (percentiles of your backlink profile).</>}
    </div>
  );
}

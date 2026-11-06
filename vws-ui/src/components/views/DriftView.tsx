import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, Download, FlaskConical, Loader2, Search } from 'lucide-react';
import { API_BASE } from '../../config';
import { csvCell, downloadText, fmt, shortUrl } from '../../lib/vws';
import type { LabPayload } from '../../lib/vws';

type VerdictKey = 'off_title' | 'off_site' | 'off_topic' | 'secondary' | 'on_topic';

interface DriftPage {
  page_id: number; url: string; title: string; zone: string; distance: number;
  cluster: number; cluster_label: string; hub_url: string;
  topic_fit: number; topic_floor: number; better_topic: string | null; group: string | null;
  title_sim: number | null; anchor: string | null; anchor_kind: 'title' | 'url' | null;
  queries: string[]; query_counts: { strong: number; partial: number };
  nearest: { url: string; title: string; similarity: number } | null;
  verdict: VerdictKey; label: string; severity: string; text: string;
}
export interface DriftData {
  error?: string;
  dim: number;
  pages: DriftPage[];
  counts: Record<VerdictKey, number>;
  labels: Record<VerdictKey, string>;
  on_topic_share: number;
  drift_share: number;
  cutoffs: { title_floor: number; q3: number; outlier: number; fit_floor_global: number; strong: number; gap: number };
  title_available: boolean;
  title_note: string | null;
}

// Fixed order + colors (from the validated categorical palette; "On topic" is recessive).
const ORDER: VerdictKey[] = ['off_title', 'off_site', 'off_topic', 'secondary', 'on_topic'];
const COLOR: Record<VerdictKey, string> = {
  off_title: '#c98500', off_site: '#d95926', off_topic: '#9085e9', secondary: '#3987e5', on_topic: '#64748b',
};
const HELP: Record<VerdictKey, string> = {
  off_title: "The page doesn't read as an answer to its own title. Rewrite the opening or retitle it.",
  off_site: 'Far from the site with no similar pages around it. Merge, refocus or noindex.',
  off_topic: 'Sits at the edge of its topic, or fits another topic better. Re-link or move it.',
  secondary: 'Part of a group of similar pages outside the core (case studies, a tool). Fine if deliberate.',
  on_topic: 'Delivers on its title, fits its topic and sits in the core range.',
};

interface Props {
  projectId: string;
  refreshKey: number;
  selectedUrl: string | null;
  onSelect: (url: string) => void;
  onOpenLab: (p: LabPayload) => void;
  onLoaded?: (d: DriftData | null) => void;
}

export default function DriftView({ projectId, refreshKey, selectedUrl, onSelect, onOpenLab, onLoaded }: Props) {
  const [data, setData] = useState<DriftData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<VerdictKey[]>(['off_title', 'off_site', 'off_topic']);
  const [q, setQ] = useState('');
  const [hover, setHover] = useState<{ p: DriftPage; x: number; y: number } | null>(null);
  const [limit, setLimit] = useState(60);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    axios.get(`${API_BASE}/api/projects/${projectId}/drift`, { timeout: 600000 })
      .then(r => { if (!live) return; if (r.data.error) { setError(r.data.error); setData(null); onLoaded?.(null); } else { setData(r.data); onLoaded?.(r.data); } })
      .catch(e => { if (live) setError(e?.response?.data?.detail || e?.message || 'Drift failed.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshKey]);

  const rows = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return data.pages.filter(p => (!filter.length || filter.includes(p.verdict)) &&
      (!s || `${p.url} ${p.title} ${p.cluster_label} ${p.text}`.toLowerCase().includes(s)));
  }, [data, filter, q]);

  if (loading) return <div className="act-loading"><Loader2 className="spinner" size={22} /> Checking every page against its site, its topic and its own title… (the first run embeds each title)</div>;
  if (error) return <div className="act-error">{error}</div>;
  if (!data) return null;

  const n = data.pages.length;
  const driftN = data.counts.off_title + data.counts.off_site + data.counts.off_topic;

  // --- scatter geometry ---------------------------------------------------------
  const W = 760, H = 380, L = 54, R = 16, T = 18, B = 62;
  const xs = data.pages.map(p => p.distance);
  const x0 = Math.min(...xs) * 0.97, x1 = Math.max(...xs, data.cutoffs.outlier) * 1.02;
  const ys = data.pages.map(p => p.title_sim).filter((v): v is number => v !== null);
  const y0 = Math.min(...ys, data.cutoffs.title_floor) - 0.01, y1 = Math.max(...ys, data.cutoffs.title_floor) + 0.01;
  const stripY = H - B + 30;   // pages with no usable title sit on a strip below the axis
  const sx = (v: number) => L + ((v - x0) / Math.max(1e-6, x1 - x0)) * (W - L - R);
  const sy = (v: number | null) => (v === null ? stripY : T + (1 - (v - y0) / Math.max(1e-6, y1 - y0)) * (H - T - B));
  const ticks = (a: number, b: number, k: number) => Array.from({ length: k + 1 }, (_, i) => a + ((b - a) * i) / k);
  const visible = new Set(rows.map(r => r.url));

  const exportCsv = () => {
    const head = ['URL', 'Title', 'Verdict', 'Zone', 'Distance from center', 'Topic', 'Topic fit', 'Topic floor', 'Fits better in',
      'Group', 'Title used', 'Title source', 'Title match', 'Title floor', 'Queries (clear)', 'Queries (partial)', 'Recommendation'];
    const lines = rows.map(p => [p.url, p.title, p.label, p.zone, p.distance, p.cluster_label, p.topic_fit, p.topic_floor, p.better_topic || '',
      p.group || '', p.anchor || '', p.anchor_kind || '', p.title_sim ?? '', data.cutoffs.title_floor, p.query_counts.strong, p.query_counts.partial,
      p.text].map(csvCell).join(','));
    downloadText(`project_${projectId}_semantic_drift.csv`, [head.join(','), ...lines].join('\n'), 'text/csv');
  };

  return (
    <div className="view">
      <div className="howto">
        <strong>How to read this.</strong> Drift is a page wandering off its subject. Each page is checked three ways, against this
        project's own spread (not fixed numbers): <b>site</b>, how far it sits from the site's center (Site Focus zones); <b>topic</b>,
        whether it still fits its topic cluster or fits another one better; and <b>title</b>, whether the page reads as an answer to its own
        title (the title is embedded as a search query and scored against the page). Far pages that have a group of similar pages around them
        are a <i>secondary topic</i> (case studies, a tool) rather than drift.
      </div>

      {data.title_note && <div className="act-banner warn"><AlertTriangle size={15} /><span>{data.title_note}</span></div>}

      <div className="drift-tiles">
        <div className="drift-score">
          <span>Stays on subject</span>
          <strong>{Math.round(data.on_topic_share * 100)}%</strong>
          <em>{n - driftN - data.counts.secondary} of {n} pages · {driftN} drifting · {data.counts.secondary} in secondary topics</em>
        </div>
        {ORDER.map(k => (
          <button key={k} className={`drift-tile ${filter.includes(k) ? 'on' : ''}`} title={HELP[k]}
            onClick={() => setFilter(f => (f.includes(k) ? f.filter(x => x !== k) : [...f, k]))}>
            <span><i style={{ background: COLOR[k] }} />{data.labels[k]}</span>
            <strong>{data.counts[k]}</strong>
            <em>{HELP[k]}</em>
          </button>
        ))}
      </div>

      <div className="view-plot drift-plot">
        <div className="drift-plot-head">
          <span>Each dot is a page · right = further from the site's center · lower = weaker match to its own title</span>
          <span className="muted">Click a dot for the page's details</span>
        </div>
        <div className="polar-wrap" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Drift scatter: distance from site center vs title match">
            {/* zones of the plot */}
            <rect x={sx(data.cutoffs.outlier)} y={T} width={Math.max(0, W - R - sx(data.cutoffs.outlier))} height={H - T - B} fill="rgba(217, 89, 38, 0.06)" />
            <rect x={L} y={sy(data.cutoffs.title_floor)} width={W - L - R} height={Math.max(0, H - B - sy(data.cutoffs.title_floor))} fill="rgba(201, 133, 0, 0.06)" />
            {ticks(y0, y1, 4).map((v, i) => (
              <g key={`y${i}`}>
                <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="#273449" strokeWidth={1} />
                <text x={L - 6} y={sy(v) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)">{v.toFixed(2)}</text>
              </g>
            ))}
            {ticks(x0, x1, 5).map((v, i) => (
              <text key={`x${i}`} x={sx(v)} y={H - B + 14} textAnchor="middle" fontSize={10} fill="var(--text-muted)">{v.toFixed(2)}</text>
            ))}
            <line x1={sx(data.cutoffs.q3)} x2={sx(data.cutoffs.q3)} y1={T} y2={H - B} stroke="#94a3b8" strokeDasharray="3 4" strokeWidth={1} />
            <text x={sx(data.cutoffs.q3) + 4} y={T + 10} fontSize={10} fill="var(--text-muted)">Q3</text>
            <line x1={sx(data.cutoffs.outlier)} x2={sx(data.cutoffs.outlier)} y1={T} y2={H - B} stroke="#d95926" strokeDasharray="4 3" strokeWidth={1.2} />
            <text x={sx(data.cutoffs.outlier) + 4} y={T + 10} fontSize={10} fill="#f0a07c">outlier fence</text>
            {data.title_available && <>
              <line x1={L} x2={W - R} y1={sy(data.cutoffs.title_floor)} y2={sy(data.cutoffs.title_floor)} stroke="#c98500" strokeDasharray="4 3" strokeWidth={1.2} />
              <text x={W - R - 4} y={sy(data.cutoffs.title_floor) - 5} textAnchor="end" fontSize={10} fill="#e3b341">title-match floor {data.cutoffs.title_floor.toFixed(3)}</text>
            </>}
            <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="#334155" />
            <text x={(L + W - R) / 2} y={H - B + 30 + 18} textAnchor="middle" fontSize={11} fill="var(--text-muted)">Distance from the site's center (cosine)</text>
            <text x={14} y={(T + H - B) / 2} textAnchor="middle" fontSize={11} fill="var(--text-muted)" transform={`rotate(-90 14 ${(T + H - B) / 2})`}>Match to its own title</text>
            <text x={L - 6} y={stripY + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">no title</text>
            {/* dots: recessive "on topic" first so problems draw on top */}
            {[...data.pages].sort((a, b) => ORDER.indexOf(b.verdict) - ORDER.indexOf(a.verdict)).map(p => {
              const on = visible.has(p.url);
              const sel = p.url === selectedUrl;
              return (
                <circle key={p.url} cx={sx(p.distance)} cy={sy(p.title_sim)} r={sel ? 7 : 5}
                  fill={COLOR[p.verdict]} fillOpacity={on ? (p.verdict === 'on_topic' ? 0.55 : 0.9) : 0.12}
                  stroke={sel ? '#f8fafc' : 'var(--bg-card)'} strokeWidth={sel ? 2 : 1.5} style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHover({ p, x: sx(p.distance), y: sy(p.title_sim) })}
                  onClick={() => onSelect(p.url)} />
              );
            })}
          </svg>
          {hover && (
            <div className="polar-tip" style={{ left: `${Math.min(70, (hover.x / W) * 100)}%`, top: `${(hover.y / H) * 100}%`, transform: 'translate(10px, -50%)' }}>
              <strong>{hover.p.title || shortUrl(hover.p.url)}</strong>
              <div>{shortUrl(hover.p.url)}</div>
              <div style={{ color: COLOR[hover.p.verdict] }}>{hover.p.label}</div>
              <div>Distance {fmt(hover.p.distance)} · {hover.p.zone}</div>
              <div>Title match {hover.p.title_sim !== null ? fmt(hover.p.title_sim) : 'n/a (no usable title)'}</div>
              <div>Topic fit {fmt(hover.p.topic_fit)} in "{hover.p.cluster_label}"</div>
            </div>
          )}
        </div>
        <div className="legend-row">
          {ORDER.map(k => <span key={k}><i style={{ background: COLOR[k] }} />{data.labels[k]} ({data.counts[k]})</span>)}
        </div>
      </div>

      <div className="ptable">
        <div className="ptable-bar">
          <h3>{filter.length ? filter.map(k => data.labels[k]).join(' + ') : 'All pages'}</h3>
          <div className="act-search" style={{ maxWidth: 280 }}><Search size={13} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter pages…" /></div>
          <button className="btn-secondary" onClick={() => setFilter([])}>Show all</button>
          <button className="btn-secondary" onClick={exportCsv}><Download size={13} /> CSV</button>
        </div>
        <table className="mini ptable-t" style={{ tableLayout: 'fixed' }}>
          <colgroup><col style={{ width: '24%' }} /><col style={{ width: '13%' }} /><col style={{ width: '9%' }} /><col style={{ width: '9%' }} /><col style={{ width: '9%' }} /><col style={{ width: '36%' }} /></colgroup>
          <thead><tr><th>Page</th><th>Verdict</th><th className="num">From center</th><th className="num">Topic fit</th><th className="num">Title match</th><th>What to do</th></tr></thead>
          <tbody>
            {rows.slice(0, limit).map(p => (
              <tr key={p.url} className={p.url === selectedUrl ? 'active' : ''} onClick={() => onSelect(p.url)}>
                <td className="url" title={p.url}>
                  <div className="ellip" style={{ color: 'var(--text-main)' }}>{p.title}</div>
                  <div className="muted ellip">{shortUrl(p.url)}</div>
                </td>
                <td><span className="drift-verdict"><i style={{ background: COLOR[p.verdict] }} />{p.label}</span>
                  {p.group && <div className="muted small ellip">group: {p.group}</div>}</td>
                <td className="num">{fmt(p.distance)}<div className="muted">{p.zone}</div></td>
                <td className="num">{fmt(p.topic_fit)}<div className="muted" title={`Floor for this topic: ${fmt(p.topic_floor)}`}>{p.topic_fit < p.topic_floor ? `< ${fmt(p.topic_floor)}` : 'ok'}</div></td>
                <td className="num" title={p.anchor ? `Scored against "${p.anchor}" (${p.anchor_kind === 'url' ? 'words from the URL' : 'page title'})` : 'No usable title'}>
                  {p.title_sim !== null ? fmt(p.title_sim) : '—'}
                  <div className="muted">{p.title_sim === null ? 'no title' : p.title_sim < data.cutoffs.title_floor ? `< ${fmt(data.cutoffs.title_floor)}` : 'ok'}</div>
                </td>
                <td className="rec">
                  <div className="muted">{p.text}</div>
                  {p.verdict !== 'on_topic' && (
                    <div className="drift-actions">
                      <button className="link-btn" onClick={e => {
                        e.stopPropagation();
                        const qs = [p.anchor, ...p.queries].filter(Boolean) as string[];
                        onOpenLab({ queries: qs.length ? qs.slice(0, 6) : [p.cluster_label], url: p.url, autoRun: true });
                      }}><FlaskConical size={12} /> See where it drifts (Lab)</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > limit && <button className="btn-secondary act-more" onClick={() => setLimit(l => l + 60)}>Show more ({rows.length - limit} left)</button>}
        {rows.length === 0 && <p className="muted small" style={{ padding: '0.75rem' }}>No pages match.</p>}
      </div>
    </div>
  );
}

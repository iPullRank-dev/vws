import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Crosshair, FlaskConical, Loader2, Sparkles } from 'lucide-react';
import { API_BASE } from '../../config';
import PolarTarget from './PolarTarget';
import type { PolarPoint } from './PolarTarget';
import { BAND_COLOR, fmt, shortUrl, verdictOf } from '../../lib/vws';
import type { LabPayload, Structure } from '../../lib/vws';

interface TargetPoint { page_id: number; url: string; title: string; source_type: string; dataset: string; similarity: number }
interface TargetResult {
  error?: string;
  mode: 'query' | 'page';
  label: string;
  thresholds: { strong: number; gap: number; dup: number; link_min: number; cannibal_margin: number };
  rings: { label: string; similarity: number; kind: string }[];
  verdict: any;
  points: TargetPoint[];
}

export interface BullseyeCenter { query?: string; pageId?: number; nonce: number }

interface Props {
  projectId: string;
  structure: Structure | null;
  suggestions: { keyword: string; band: string; volume?: number | null }[];
  center: BullseyeCenter | null;
  selectedUrl: string | null;
  onSelect: (url: string) => void;
  onOpenLab: (p: LabPayload) => void;
  onBrief: (keyword: string, url: string) => void;
}

const STATUS_COLOR: Record<string, string> = { covered: BAND_COLOR.strong, contested: '#fb923c', partial: BAND_COLOR.partial, gap: BAND_COLOR.gap, page: '#60a5fa' };

export default function QueryBullseyeView({ projectId, structure, suggestions, center, selectedUrl, onSelect, onOpenLab, onBrief }: Props) {
  const [q, setQ] = useState('');
  const [pageQ, setPageQ] = useState('');
  const [res, setRes] = useState<TargetResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const pages = structure?.pages || [];
  const angleOf = useMemo(() => Object.fromEntries(pages.map(p => [p.url, p.angle])), [pages]);
  const topicOf = useMemo(() => Object.fromEntries(pages.map(p => [p.url, p.cluster_label])), [pages]);

  const run = async (params: { q?: string; page_id?: number }) => {
    setLoading(true); setErr('');
    try {
      const r = await axios.get(`${API_BASE}/api/projects/${projectId}/target`, { params });
      if (r.data.error) { setErr(r.data.error); setRes(null); } else setRes(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || 'Failed.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!center) return;
    if (center.query) { setQ(center.query); run({ q: center.query }); }
    else if (center.pageId) run({ page_id: center.pageId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.nonce]);

  const submitPage = () => {
    const hit = pages.find(p => p.url === pageQ.trim() || p.title === pageQ.trim());
    if (hit) run({ page_id: hit.page_id }); else setErr('Pick a page from the list.');
  };

  const points: PolarPoint[] = useMemo(() => {
    if (!res) return [];
    const sims = res.points.map(p => p.similarity);
    const top = Math.max(...sims, res.rings[0]?.similarity ?? 0.8);
    const floor = Math.min(...sims.slice(0, 400), (res.rings[res.rings.length - 1]?.similarity ?? 0.6) - 0.08);
    const span = Math.max(1e-6, top + 0.02 - floor);
    return res.points.map((p, i) => {
      const own = p.source_type !== 'competitor';
      const v = res.mode === 'query' ? verdictOf(p.similarity, res.thresholds) : (p.similarity >= res.thresholds.dup ? 'missing' : p.similarity >= res.thresholds.link_min ? 'covered' : 'partial');
      return {
        id: p.url,
        r: (top + 0.02 - p.similarity) / span,
        angle: own ? (angleOf[p.url] ?? (i * 137.5) % 360) : (i * 137.5) % 360,
        color: own ? (res.mode === 'query' ? BAND_COLOR[v] : (v === 'missing' ? '#fb923c' : v === 'covered' ? '#60a5fa' : '#475569')) : '#f472b6',
        shape: own ? 'circle' : 'diamond',
        size: own ? 5 : 5.5,
        label: p.title || shortUrl(p.url),
        sub: `${own ? topicOf[p.url] || p.dataset : `Competitor · ${p.dataset}`} · similarity ${fmt(p.similarity)}`,
      } as PolarPoint;
    });
  }, [res, angleOf, topicOf]);

  const ringR = (s: number) => {
    if (!res) return 0;
    const sims = res.points.map(p => p.similarity);
    const top = Math.max(...sims, res.rings[0]?.similarity ?? 0.8);
    const floor = Math.min(...sims.slice(0, 400), (res.rings[res.rings.length - 1]?.similarity ?? 0.6) - 0.08);
    return (top + 0.02 - s) / Math.max(1e-6, top + 0.02 - floor);
  };

  const v = res?.verdict;
  const ownTop = res ? res.points.filter(p => p.source_type !== 'competitor').slice(0, 12) : [];

  return (
    <div className="view">
      <div className="howto">
        <strong>How to read this.</strong> Put a <b>query</b> (or one of your pages) in the center. Every page is then placed by how close it is
        to that target: the closer to the center, the more relevant. Rings are the calibrated lines for this vector size:
        inside the green ring a page <i>clearly targets</i> the query; outside the red ring nothing really answers it. Direction is still topic
        (the same slices as Site Focus), so you can see which part of the site owns the query. Competitor pages show as pink diamonds.
      </div>

      <div className="target-bar">
        <div className="target-field">
          <label>Query</label>
          <input list="bull-kws" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && q.trim()) run({ q: q.trim() }); }} placeholder="Type a query or pick a target keyword" />
          <datalist id="bull-kws">{suggestions.slice(0, 2000).map(s => <option key={s.keyword} value={s.keyword} />)}</datalist>
          <button className="btn-primary" disabled={!q.trim() || loading} onClick={() => run({ q: q.trim() })}><Crosshair size={13} /> Target query</button>
        </div>
        <div className="target-field">
          <label>or a page</label>
          <input list="bull-pages" value={pageQ} onChange={e => setPageQ(e.target.value)} placeholder="Pick a page" />
          <datalist id="bull-pages">{pages.map(p => <option key={p.url} value={p.url}>{p.title}</option>)}</datalist>
          <button className="btn-secondary" disabled={!pageQ.trim() || loading} onClick={submitPage}>Target page</button>
        </div>
        {loading && <Loader2 size={16} className="spinner" />}
      </div>
      {err && <div className="act-error">{err}</div>}

      {!res && !loading && (
        <div className="target-suggest">
          <span className="muted small">Start with a query that matters:</span>
          {suggestions.filter(s => s.band !== 'strong').slice(0, 8).map(s => (
            <button key={s.keyword} className="chip" onClick={() => { setQ(s.keyword); run({ q: s.keyword }); }}>
              <i style={{ background: BAND_COLOR[s.band] || '#64748b' }} />{s.keyword}
            </button>
          ))}
        </div>
      )}

      {res && v && (
        <>
          <div className="verdict-card" style={{ borderLeftColor: STATUS_COLOR[v.status] || '#64748b' }}>
            <div className="verdict-head" style={{ color: STATUS_COLOR[v.status] }}>{v.headline}</div>
            <p>{v.text}</p>
            <div className="act-buttons">
              {res.mode === 'query' && v.best_url && (
                <>
                  <button className="btn-primary" onClick={() => onOpenLab({ queries: [res.label], url: v.best_url, compare_urls: v.competitor ? [v.competitor.url] : (v.contenders || []).slice(1, 2).map((c: any) => c.url), autoRun: true })}>
                    <FlaskConical size={13} /> Lab: {shortUrl(v.best_url)}
                  </button>
                  <button className="btn-secondary" onClick={() => onBrief(res.label, v.best_url)}><Sparkles size={13} /> AI brief</button>
                  <button className="btn-secondary" onClick={() => onSelect(v.best_url)}>Inspect best page</button>
                </>
              )}
            </div>
            {res.mode === 'page' && (v.duplicates?.length > 0 || v.link_candidates?.length > 0) && (
              <table className="mini" style={{ marginTop: '0.5rem' }}>
                <thead><tr><th>Page</th><th className="num">Similarity</th><th>Status</th></tr></thead>
                <tbody>
                  {(v.duplicates || []).map((d: any) => <tr key={d.url} onClick={() => onSelect(d.url)}><td className="url">{shortUrl(d.url)}</td><td className="num">{fmt(d.similarity)}</td><td style={{ color: '#fb923c' }}>near-duplicate: consolidate</td></tr>)}
                  {(v.link_candidates || []).map((d: any) => (
                    <tr key={d.url} onClick={() => onSelect(d.url)}>
                      <td className="url">{shortUrl(d.url)}</td><td className="num">{fmt(d.similarity)}</td>
                      <td className={d.linked_out || d.linked_in ? 'muted' : ''}>{d.linked_out && d.linked_in ? 'linked both ways' : d.linked_out ? 'linked from center page' : d.linked_in ? 'links to center page' : 'not linked: add a link'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="view-split">
            <div className="view-plot">
              <PolarTarget points={points} selectedId={selectedUrl} onSelect={id => { const u = String(id); if (pages.some(p => p.url === u)) onSelect(u); }}
                centerLabel={res.mode === 'query' ? `"${res.label}"` : res.label}
                rings={res.rings.map(r => ({ r: ringR(r.similarity), label: r.label, color: r.kind === 'strong' ? BAND_COLOR.strong : r.kind === 'gap' ? BAND_COLOR.gap : r.kind === 'dup' ? '#fb923c' : '#60a5fa' }))}
                sectors={(structure?.clusters || []).map(c => ({ start: c.angle_start, end: c.angle_end, label: c.label }))} />
              <div className="legend-row">
                {res.mode === 'query'
                  ? <><span><i style={{ background: BAND_COLOR.strong }} />clearly targets</span><span><i style={{ background: BAND_COLOR.partial }} />related</span><span><i style={{ background: BAND_COLOR.gap }} />doesn't answer</span></>
                  : <><span><i style={{ background: '#fb923c' }} />near-duplicate</span><span><i style={{ background: '#60a5fa' }} />should link</span><span><i style={{ background: '#475569' }} />further away</span></>}
                <span><i style={{ background: '#f472b6' }} />competitor</span>
              </div>
            </div>
            <div className="rank-list">
              <h4>Closest pages</h4>
              {ownTop.map((p, i) => {
                const band = res.mode === 'query' ? verdictOf(p.similarity, res.thresholds) : null;
                return (
                  <div key={p.url} className={`rank-item ${p.url === selectedUrl ? 'active' : ''}`} onClick={() => onSelect(p.url)}>
                    <span className="mono muted">{i + 1}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="rank-title">{p.title || shortUrl(p.url)}</div>
                      <div className="muted small">{shortUrl(p.url)} · {topicOf[p.url] || ''}</div>
                    </div>
                    <span className="mono" style={{ color: band ? BAND_COLOR[band] : 'var(--text-main)' }}>{fmt(p.similarity)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Crosshair, Download, FlaskConical, Loader2, Sparkles } from 'lucide-react';
import { BAND_COLOR, SEVERITY_COLOR, csvCell, downloadText, fmt, shortUrl } from '../../lib/vws';
import type { ClusterDiag, LabPayload, Structure } from '../../lib/vws';

interface Props {
  structure: Structure;
  selectedUrl: string | null;
  onSelect: (url: string) => void;
  onOpenLab: (p: LabPayload) => void;
  onCenterPage: (pageId: number) => void;
  onArchitecture: (clusters: string[]) => Promise<void>;
}

export default function TopicClustersView({ structure, onSelect, onOpenLab, onCenterPage, onArchitecture }: Props) {
  const { clusters, pages } = structure;
  const [sel, setSel] = useState<number | null>(clusters[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const cur = clusters.find(c => c.id === sel) || null;
  const pageByUrl = useMemo(() => Object.fromEntries(pages.map(p => [p.url, p])), [pages]);

  // Bubble layout: cluster centroids in PCA space, scaled to the box.
  const W = 680, H = 440, pad = 46;
  const xs = clusters.map(c => c.x), ys = clusters.map(c => c.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => pad + ((x - x0) / Math.max(1e-6, x1 - x0)) * (W - 2 * pad);
  const sy = (y: number) => H - pad - ((y - y0) / Math.max(1e-6, y1 - y0)) * (H - 2 * pad);
  const maxSize = Math.max(...clusters.map(c => c.size), 1);
  const rad = (c: ClusterDiag) => 10 + 30 * Math.sqrt(c.size / maxSize);

  // Start from the PCA positions, then push overlapping bubbles apart so every
  // topic and its label stays readable (positions are approximate by design).
  const pos = useMemo(() => {
    const n = clusters.map(c => ({ id: c.id, x: sx(c.x), y: sy(c.y), r: rad(c) }));
    for (let it = 0; it < 240; it++) {
      let moved = false;
      for (let i = 0; i < n.length; i++) {
        for (let j = i + 1; j < n.length; j++) {
          const a = n[i], b = n[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d < 1e-3) { dx = 1; dy = 0; d = 1; }
          const min = a.r + b.r + 22;
          if (d < min) {
            const push = (min - d) / 2;
            a.x -= (dx / d) * push; a.y -= (dy / d) * push;
            b.x += (dx / d) * push; b.y += (dy / d) * push;
            moved = true;
          }
        }
      }
      n.forEach(c => { c.x = Math.min(W - c.r - 8, Math.max(c.r + 8, c.x)); c.y = Math.min(H - c.r - 18, Math.max(c.r + 8, c.y)); });
      if (!moved) break;
    }
    return Object.fromEntries(n.map(c => [c.id, c]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusters]);

  const exportCsv = () => {
    const head = ['Topic', 'Pages', 'Hub', 'Clearly targeted queries', 'Partly targeted', 'Uncovered queries nearby', 'Link density', 'Spokes linking to hub', 'Recommendation', 'Detail', 'Pages'];
    const rows = clusters.map(c => [c.label, c.size, c.hub_url, c.queries.strong, c.queries.partial, c.gap_queries.count,
      c.links.density, `${c.links.spokes_to_hub}/${c.links.spokes}`, c.recommendation.verdict, c.recommendation.text, c.pages.join(' ')].map(csvCell).join(','));
    downloadText('topic_clusters.csv', [head.join(','), ...rows].join('\n'), 'text/csv');
  };

  const arch = async () => {
    setBusy(true);
    try {
      await onArchitecture(clusters.map(c => `${c.label} — ${c.size} pages, hub ${shortUrl(c.hub_url)}; pages: ${c.pages.slice(0, 8).map(shortUrl).join(', ')}`));
    } finally { setBusy(false); }
  };

  return (
    <div className="view">
      <div className="howto">
        <strong>How to read this.</strong> Your pages are grouped into topics by their vectors (Ward clustering). Each bubble is a topic, sized by
        page count and placed by where its pages sit in vector space, so overlapping bubbles share territory. The color is the recommendation's
        urgency. For each topic you get its <b>hub</b> (the most central page), how many target queries it serves, how many <i>uncovered</i>{' '}
        queries sit closest to it (where to expand), and whether its pages actually link to the hub.
      </div>

      <div className="view-split">
        <div className="view-plot">
          <svg viewBox={`0 0 ${W} ${H}`} className="bubbles" role="img" aria-label="Topic clusters">
            {clusters.map(c => (
              <g key={c.id} onClick={() => setSel(c.id)} style={{ cursor: 'pointer' }}>
                <circle cx={pos[c.id].x} cy={pos[c.id].y} r={rad(c)} fill={SEVERITY_COLOR[c.recommendation.severity]} fillOpacity={c.id === sel ? 0.55 : 0.28}
                  stroke={c.id === sel ? '#f8fafc' : SEVERITY_COLOR[c.recommendation.severity]} strokeWidth={c.id === sel ? 2 : 1} />
                <title>{`${c.label} — ${c.size} pages · ${c.recommendation.verdict}`}</title>
                <text x={pos[c.id].x} y={pos[c.id].y + rad(c) + 13} textAnchor="middle" fontSize={10.5} fill={c.id === sel ? 'var(--text-main)' : 'var(--text-muted)'}>
                  {c.label.length > 26 ? c.label.slice(0, 25) + '…' : c.label}
                </text>
                <text x={pos[c.id].x} y={pos[c.id].y + 4} textAnchor="middle" fontSize={11} fill="var(--text-main)" fontWeight={600}>{c.size}</text>
              </g>
            ))}
          </svg>
          <div className="legend-row">
            <span><i style={{ background: SEVERITY_COLOR.medium }} />needs work</span>
            <span><i style={{ background: SEVERITY_COLOR.low }} />worth a look</span>
            <span><i style={{ background: SEVERITY_COLOR.none }} />healthy</span>
            <span className="muted">number = pages</span>
          </div>
        </div>

        <div className="cluster-detail">
          {cur ? (
            <>
              <h3>{cur.label}</h3>
              <div className="drawer-rec" style={{ borderColor: `${SEVERITY_COLOR[cur.recommendation.severity]}88` }}>
                <div className="drawer-rec-head" style={{ color: SEVERITY_COLOR[cur.recommendation.severity] }}>{cur.recommendation.verdict}</div>
                <p>{cur.recommendation.text}</p>
              </div>
              <div className="act-buttons">
                <button className="btn-primary" onClick={() => onOpenLab({ queries: cur.queries.top.map(q => q.keyword).slice(0, 8).concat(cur.queries.top.length ? [] : [cur.label]), url: cur.hub_url, autoRun: true })}><FlaskConical size={13} /> Lab on hub</button>
                {pageByUrl[cur.hub_url] && <button className="btn-secondary" onClick={() => onCenterPage(pageByUrl[cur.hub_url].page_id)}><Crosshair size={13} /> Bullseye on hub</button>}
              </div>
              <div className="kv">
                <span>Hub</span><button className="link-btn" onClick={() => onSelect(cur.hub_url)}>{shortUrl(cur.hub_url)}</button>
                <span>Pages</span><strong>{cur.size}</strong>
                <span>Cohesion</span><span className="mono">{fmt(cur.cohesion)}</span>
                <span>Queries</span><span>{cur.queries.strong} clearly · {cur.queries.partial} partly</span>
                <span>Uncovered nearby</span><span>{cur.gap_queries.count}{cur.gap_queries.volume ? ` (${Math.round(cur.gap_queries.volume).toLocaleString()} searches)` : ''}</span>
                {structure.link_graph_loaded && <><span>Spokes → hub</span><span>{cur.links.spokes_to_hub}/{cur.links.spokes} · hub → spokes {cur.links.hub_to_spokes}/{cur.links.spokes}</span></>}
              </div>
              {cur.queries.top.length > 0 && (
                <>
                  <h4>Queries this topic serves</h4>
                  <div className="tagwrap">{cur.queries.top.map(q => <span key={q.keyword} className="tag"><i style={{ background: BAND_COLOR[q.band] }} />{q.keyword}</span>)}</div>
                </>
              )}
              {cur.gap_queries.top.length > 0 && (
                <>
                  <h4>Uncovered queries closest to this topic</h4>
                  <div className="tagwrap">{cur.gap_queries.top.map(q => <span key={q} className="tag"><i style={{ background: BAND_COLOR.gap }} />{q}</span>)}</div>
                </>
              )}
              <h4>Pages (most central first)</h4>
              <ul className="drawer-list">
                {cur.pages.slice(0, 30).map(u => {
                  const p = pageByUrl[u];
                  return <li key={u}><button className="link-btn" onClick={() => onSelect(u)}>{shortUrl(u)}</button>
                    {p && <span className="small" style={{ color: SEVERITY_COLOR[p.recommendation.severity] }}>{p.recommendation.verdict}</span>}</li>;
                })}
              </ul>
            </>
          ) : <p className="muted">Pick a topic.</p>}
        </div>
      </div>

      <div className="ptable">
        <div className="ptable-bar">
          <h3>All topics</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
            <button className="btn-secondary" onClick={arch} disabled={busy}>{busy ? <Loader2 size={13} className="spinner" /> : <Sparkles size={13} />} Propose architecture (local LLM)</button>
            <button className="btn-secondary" onClick={exportCsv}><Download size={13} /> CSV</button>
          </div>
        </div>
        <table className="mini ptable-t">
          <thead><tr><th>Topic</th><th className="num">Pages</th><th>Hub</th><th className="num">Queries</th><th className="num">Uncovered nearby</th>{structure.link_graph_loaded && <th className="num">Spokes → hub</th>}<th>Recommendation</th></tr></thead>
          <tbody>
            {clusters.map(c => (
              <tr key={c.id} className={c.id === sel ? 'active' : ''} onClick={() => setSel(c.id)}>
                <td>{c.label}</td>
                <td className="num">{c.size}</td>
                <td className="url"><div className="ellip" style={{ maxWidth: 240 }} title={c.hub_url}>{shortUrl(c.hub_url)}</div></td>
                <td className="num">{c.queries.strong}<span className="muted"> / {c.queries.partial}</span></td>
                <td className="num">{c.gap_queries.count || '—'}</td>
                {structure.link_graph_loaded && <td className="num">{c.links.spokes ? `${c.links.spokes_to_hub}/${c.links.spokes}` : '—'}</td>}
                <td className="rec"><span className="rec-verdict" style={{ color: SEVERITY_COLOR[c.recommendation.severity] }}>{c.recommendation.verdict}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

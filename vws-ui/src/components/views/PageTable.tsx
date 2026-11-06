import { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { SEVERITY_COLOR, ZONE_COLOR, csvCell, downloadText, fmt, shortUrl } from '../../lib/vws';
import type { PageDiag } from '../../lib/vws';

interface Props {
  pages: PageDiag[];
  zones?: string[];                 // initial zone filter (empty = all)
  sort?: 'priority' | 'distance';
  selectedUrl?: string | null;
  onSelect: (url: string) => void;
  filename: string;
  title?: string;
}

const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
const ALL_ZONES = ['Core', 'Focus', 'Expansion', 'Peripheral'];

export default function PageTable({ pages, zones = [], sort = 'priority', selectedUrl, onSelect, filename, title }: Props) {
  const [zf, setZf] = useState<string[]>(zones);
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState(sort);
  const [limit, setLimit] = useState(50);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const r = pages.filter(p => (!zf.length || zf.includes(p.zone)) &&
      (!s || `${p.url} ${p.title} ${p.cluster_label} ${p.recommendation.verdict}`.toLowerCase().includes(s)));
    r.sort(sortBy === 'distance'
      ? (a, b) => b.distance - a.distance
      : (a, b) => SEV_RANK[a.recommendation.severity] - SEV_RANK[b.recommendation.severity] || b.distance - a.distance);
    return r;
  }, [pages, zf, q, sortBy]);

  const exportCsv = () => {
    const head = ['URL', 'Title', 'Zone', 'Distance', 'Percentile', 'Topic', 'Hub', 'Queries (clearly)', 'Queries (partly)', 'Inbound links', 'Recommendation', 'Detail', 'Use this page'];
    const lines = rows.map(p => [p.url, p.title, p.zone, p.distance, p.percentile, p.cluster_label, p.is_hub ? 'yes' : p.hub_url,
      p.query_counts.strong, p.query_counts.partial, p.links.inbound, p.recommendation.verdict, p.recommendation.text,
      p.recommendation.target_url || ''].map(csvCell).join(','));
    downloadText(filename, [head.join(','), ...lines].join('\n'), 'text/csv');
  };

  return (
    <div className="ptable">
      <div className="ptable-bar">
        {title && <h3>{title}</h3>}
        <div className="chips">
          {ALL_ZONES.map(z => (
            <button key={z} className={zf.includes(z) ? 'chip on' : 'chip'} onClick={() => setZf(f => f.includes(z) ? f.filter(x => x !== z) : [...f, z])}>
              <i style={{ background: ZONE_COLOR[z] }} />{z} <span>{pages.filter(p => p.zone === z).length}</span>
            </button>
          ))}
        </div>
        <div className="act-search" style={{ maxWidth: 280 }}><Search size={13} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter pages…" /></div>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className="ptable-sel">
          <option value="priority">Sort: needs attention</option>
          <option value="distance">Sort: farthest out</option>
        </select>
        <button className="btn-secondary" onClick={exportCsv}><Download size={13} /> CSV</button>
      </div>
      <table className="mini ptable-t" style={{ tableLayout: 'fixed' }}>
        <colgroup><col style={{ width: '27%' }} /><col style={{ width: '11%' }} /><col style={{ width: '15%' }} /><col style={{ width: '8%' }} /><col style={{ width: '39%' }} /></colgroup>
        <thead><tr><th>Page</th><th>Zone</th><th>Topic</th><th className="num">Queries</th><th>Recommendation</th></tr></thead>
        <tbody>
          {rows.slice(0, limit).map(p => (
            <tr key={p.url} className={p.url === selectedUrl ? 'active' : ''} onClick={() => onSelect(p.url)}>
              <td className="url" title={p.url}><div className="ellip" style={{ color: 'var(--text-main)' }}>{p.title}</div><div className="muted ellip">{shortUrl(p.url)}</div></td>
              <td><div className="ellip"><span className="zone-dot" style={{ background: ZONE_COLOR[p.zone] }} />{p.zone}</div><div className="muted mono">{fmt(p.distance)}</div></td>
              <td className="topic"><div className="ellip" title={p.cluster_label}>{p.cluster_label}</div>{p.is_hub && <span className="hub-badge" style={{ marginLeft: 0 }}>hub</span>}</td>
              <td className="num">{p.query_counts.strong + p.query_counts.partial || '—'}{p.query_counts.partial > 0 && <div className="muted">{p.query_counts.partial} partly</div>}</td>
              <td className="rec">
                <span className="rec-verdict" style={{ color: SEVERITY_COLOR[p.recommendation.severity] }}>{p.recommendation.verdict}</span>
                <div className="muted">{p.recommendation.text}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <button className="btn-secondary act-more" onClick={() => setLimit(l => l + 50)}>Show more ({rows.length - limit} left)</button>}
      {rows.length === 0 && <p className="muted small" style={{ padding: '0.75rem' }}>No pages match.</p>}
    </div>
  );
}

import { useMemo, useState } from 'react';
import PolarTarget from './PolarTarget';
import type { PolarPoint } from './PolarTarget';
import PageTable from './PageTable';
import { ZONE_COLOR, ZONE_HELP, fmt } from '../../lib/vws';
import type { Structure } from '../../lib/vws';

interface Props {
  structure: Structure;
  selectedUrl: string | null;
  onSelect: (url: string) => void;
}

const ZONES = ['Core', 'Focus', 'Expansion', 'Peripheral'] as const;

export default function SiteFocusView({ structure, selectedUrl, onSelect }: Props) {
  const [hl, setHl] = useState<string | null>(null);
  const { pages, clusters, fences } = structure;
  // Radial scale starts just inside the closest page so the plot uses its full area;
  // the center label says where the scale starts.
  const maxR = Math.max(fences.outlier * 1.2, ...pages.map(p => p.distance)) || 1;
  const minD = Math.min(...pages.map(p => p.distance));
  const floor = Math.max(0, minD - (maxR - minD) * 0.12);
  const rad = (d: number) => (d - floor) / Math.max(1e-6, maxR - floor);

  const points: PolarPoint[] = useMemo(() => pages.map(p => ({
    id: p.url,
    r: rad(p.distance),
    angle: p.angle,
    color: ZONE_COLOR[p.zone],
    size: 4 + Math.min(4, Math.sqrt(p.query_counts.strong + p.query_counts.partial)),
    label: p.title,
    sub: `${p.zone} · ${p.cluster_label}${p.is_hub ? ' (hub)' : ''} · distance ${fmt(p.distance)} · ${p.recommendation.verdict}`,
    dim: !!hl && p.zone !== hl,
  })), [pages, maxR, hl]);

  const total = pages.length || 1;
  return (
    <div className="view">
      <div className="howto">
        <strong>How to read this.</strong> Each dot is one of your pages. <b>Distance from the center</b> is how far the page is from the site's
        overall subject (cosine distance to the average of all page vectors). <b>Direction</b> is topic: each slice is a topic cluster, labeled
        around the edge, so dots in the same slice cover the same ground. The <b>rings</b> are the quartile fences of this site's own distribution{' '}
        (Q1 {fmt(fences.q1)}, Q3 {fmt(fences.q3)}, outlier fence {fmt(fences.outlier)}), so they adapt to any site and any vector size.
        Bigger dots are the best page for more target queries. Click any dot for its diagnosis and the action to take.
      </div>

      <div className="zone-cards">
        {ZONES.map(z => {
          const n = structure.zone_counts[z] || 0;
          return (
            <button key={z} className={`zone-card ${hl === z ? 'on' : ''}`} style={{ borderLeftColor: ZONE_COLOR[z] }}
              onClick={() => setHl(h => h === z ? null : z)} title="Highlight this zone">
              <div className="zone-card-head"><span style={{ color: ZONE_COLOR[z] }}>{z}</span><strong>{n}</strong><span className="muted">{Math.round((n / total) * 100)}%</span></div>
              <div className="muted small">{ZONE_HELP[z].what}</div>
              <div className="small">{ZONE_HELP[z].todo}</div>
            </button>
          );
        })}
      </div>

      <div className="view-plot">
        <PolarTarget points={points} selectedId={selectedUrl} onSelect={id => onSelect(String(id))}
          centerLabel={`Site center (scale starts at ${fmt(floor)})`}
          rings={[{ r: rad(fences.q1), label: `Q1 ${fmt(fences.q1)}`, color: ZONE_COLOR.Core },
                  { r: rad(fences.q3), label: `Q3 ${fmt(fences.q3)}`, color: ZONE_COLOR.Focus },
                  { r: rad(fences.outlier), label: `Outlier fence ${fmt(fences.outlier)}`, color: ZONE_COLOR.Expansion }]}
          sectors={clusters.map(c => ({ start: c.angle_start, end: c.angle_end, label: `${c.label} (${c.size})` }))} />
        <div className="legend-row">
          {ZONES.map(z => <span key={z}><i style={{ background: ZONE_COLOR[z] }} />{z}</span>)}
          <span className="muted">Slices = topics · size = queries served</span>
        </div>
      </div>

      <PageTable pages={pages} zones={['Expansion', 'Peripheral']} selectedUrl={selectedUrl} onSelect={onSelect}
        filename="site_focus_pages.csv" title="Pages and what to do with them" />
    </div>
  );
}

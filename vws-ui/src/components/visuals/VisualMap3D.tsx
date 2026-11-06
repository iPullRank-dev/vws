import Plot from 'react-plotly.js';
import { ZONE_COLOR, clusterColor } from '../../lib/vws';
import type { Structure } from '../../lib/vws';

export interface GhostPoint {
  x: number;
  y: number;
  z: number;
  label: string;
}

interface VisualMapProps {
  data: any[];
  ghostPoint?: GhostPoint | null;
  colorBy?: 'dataset' | 'topic' | 'zone';
  structure?: Structure | null;
  onPointClick?: (node: any) => void;
}

const DATASET_COLORS = ['#3987e5', '#199e70', '#c98500', '#d55181', '#9085e9'];
const QUERY_COLOR = '#475569';
const COMP_COLOR = '#f472b6';

export default function VisualMap3D({ data, ghostPoint, colorBy = 'dataset', structure, onPointClick }: VisualMapProps) {
  if (!data || data.length === 0) return <div>No data available</div>;

  const pageInfo: Record<string, { topic: string; zone: string; rank: number }> = {};
  if (structure && !structure.error) {
    const rank: Record<number, number> = {};
    [...structure.clusters].sort((a, b) => b.size - a.size).forEach((c, i) => { rank[c.id] = i; });
    structure.pages.forEach(p => { pageInfo[p.url] = { topic: p.cluster_label, zone: p.zone, rank: rank[p.cluster] ?? 99 }; });
  }

  const groupOf = (d: any): { key: string; color: string; order: number } => {
    if (colorBy === 'dataset' || !structure) {
      return { key: d.category, color: '', order: 0 };
    }
    if (d.source_type === 'keyword') return { key: 'Target queries', color: QUERY_COLOR, order: 90 };
    if (d.source_type === 'competitor') return { key: `Competitor: ${d.category}`, color: COMP_COLOR, order: 91 };
    const info = pageInfo[d.raw_url];
    if (!info) return { key: 'Other', color: '#334155', order: 95 };
    if (colorBy === 'zone') return { key: info.zone, color: ZONE_COLOR[info.zone], order: ['Core', 'Focus', 'Expansion', 'Peripheral'].indexOf(info.zone) };
    return info.rank < 7 ? { key: info.topic, color: clusterColor(info.rank), order: info.rank } : { key: 'Other topics', color: '#64748b', order: 80 };
  };

  const groups: Record<string, { color: string; order: number; nodes: any[] }> = {};
  data.forEach(d => {
    const g = groupOf(d);
    (groups[g.key] ||= { color: g.color, order: g.order, nodes: [] }).nodes.push(d);
  });

  const traces: any[] = Object.entries(groups).sort((a, b) => a[1].order - b[1].order).map(([key, g], i) => ({
    x: g.nodes.map(d => d.x),
    y: g.nodes.map(d => d.y),
    z: g.nodes.map(d => d.z),
    mode: 'markers',
    type: 'scatter3d',
    name: key.length > 40 ? key.slice(0, 39) + '…' : key,
    text: g.nodes.map(d => d.url),
    hoverinfo: 'text',
    customdata: g.nodes,
    marker: {
      size: key === 'Target queries' ? 3 : 5,
      color: g.color || DATASET_COLORS[i % DATASET_COLORS.length],
      opacity: key === 'Target queries' ? 0.45 : 0.85,
    },
  }));

  if (ghostPoint) {
    // A real query embedding (EmbeddingGemma 2, search-query prompt) projected
    // with the same PCA basis as the pages above.
    traces.push({
      x: [ghostPoint.x],
      y: [ghostPoint.y],
      z: [ghostPoint.z],
      mode: 'markers+text',
      type: 'scatter3d',
      name: 'Query',
      text: [ghostPoint.label],
      customdata: [{ url: `QUERY: ${ghostPoint.label}`, category: 'QUERY' }],
      marker: { size: 12, color: '#f8fafc', symbol: 'diamond', opacity: 1, line: { color: '#ef4444', width: 2 } },
    });
  }

  return (
    <Plot
      data={traces as any}
      layout={{
        autosize: true,
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: '#94a3b8' },
        margin: { l: 0, r: 0, t: 0, b: 0 },
        scene: {
          xaxis: { title: 'PC 1', showgrid: false },
          yaxis: { title: 'PC 2', showgrid: false },
          zaxis: { title: 'PC 3', showgrid: false },
        },
        legend: { orientation: 'h', y: 1.1 },
      } as any}
      useResizeHandler
      onClick={(event: any) => {
        const p = event?.points?.[0];
        if (p && onPointClick) onPointClick(p.data.customdata[p.pointNumber]);
      }}
      style={{ width: '100%', height: '100%' }}
    />
  );
}

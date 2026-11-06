import { useState } from 'react';
import Plot from 'react-plotly.js';

interface IQRBullseyeProps {
  data: {
    stats: any;
    thresholds: any;
    nodes: any[];
  },
  global?: any
}

export default function IQRBullseyePlot({ data, global }: IQRBullseyeProps) {
  if (!data || !data.nodes || data.nodes.length === 0) return <div>No data available</div>;

  const { stats, thresholds, nodes } = data;
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  
  // Custom colors for zones
  const colorMap: Record<string, string> = {
    "Core": "#10b981",       // green
    "Focus": "#3b82f6",      // blue
    "Expansion": "#f59e0b",  // orange
    "Peripheral": "#ef4444"  // red
  };

  const bgMap: Record<string, string> = {
    "Core": "rgba(16, 185, 129, 0.1)",
    "Focus": "rgba(59, 130, 246, 0.1)",
    "Expansion": "rgba(245, 158, 11, 0.1)",
    "Peripheral": "rgba(239, 68, 68, 0.1)"
  };

  const borderMap: Record<string, string> = {
    "Core": "rgba(16, 185, 129, 0.4)",
    "Focus": "rgba(59, 130, 246, 0.4)",
    "Expansion": "rgba(245, 158, 11, 0.4)",
    "Peripheral": "rgba(239, 68, 68, 0.4)"
  };

  // Build the scatter nodes mapped by zones
  const scatterTraces = ["Core", "Focus", "Expansion", "Peripheral"].map(zone => {
    const subset = nodes.filter(n => n.zone === zone);
    const hoverText = subset.map(d => 
      `<b>${d.title || d.url}</b><br/>Distance: ${d.distance.toFixed(3)}<br/>Zone: ${zone}`
    );
    
    return {
      type: 'scatterpolar',
      mode: 'markers',
      name: zone + " Pages",
      r: subset.map(d => d.distance),
      theta: subset.map(d => d.angle),
      customdata: subset,
      text: hoverText,
      hoverinfo: 'none', // Handle custom hover manually
      marker: {
        color: colorMap[zone],
        size: 8,
        line: { color: 'white', width: 0.5 },
        opacity: 0.9
      }
    };
  });

  // Build thresholds circles (Q1, Q3, Outlier) 
  const circleTheta = Array.from({length: 361}, (_, i) => i);
  const ringTraces = [
    { r: thresholds.q1, name: 'Core Boundary', color: colorMap["Core"] },
    { r: thresholds.q3, name: 'Focus Boundary', color: colorMap["Focus"] },
    { r: thresholds.outlier, name: 'Expansion Boundary', color: colorMap["Expansion"] }
  ].map(ring => ({
    type: 'scatterpolar',
    mode: 'lines',
    name: ring.name,
    r: Array(361).fill(ring.r),
    theta: circleTheta,
    hoverinfo: 'none',
    line: {
      color: ring.color,
      dash: 'dash',
      width: 2
    },
    showlegend: false
  }));

  const centerStar = {
    type: 'scatterpolar',
    mode: 'markers+text',
    r: [0],
    theta: [0],
    text: ['★ Site Center'],
    textposition: 'bottom center',
    hoverinfo: 'none',
    marker: {
      color: '#334155',
      symbol: 'star',
      size: 16
    },
    showlegend: false
  };

  const allTraces = [centerStar, ...ringTraces, ...scatterTraces] as any[];

  const handleExportCSV = () => {
    const csvContent = "data:text/csv;charset=utf-8," 
      + "URL,Category,Distance,Zone\n"
      + nodes.map(n => `"${n.url}","${n.category}",${n.distance},"${n.zone}"`).join("\n");
      
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "iqr_bullseye_export.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Defensive UI parsing
  const focusScoreRaw = global?.focus_score;
  const focusScore = typeof focusScoreRaw === 'number' ? focusScoreRaw.toFixed(1) : '0.0';
  const corePct = stats?.core?.pct || 0;
  const focusPct = stats?.focus?.pct || 0;
  const radiusScore = Math.min(100, corePct + focusPct).toFixed(1);
  const driftRaw = global?.semantic_drift;
  const driftScore = typeof driftRaw === 'number' ? driftRaw.toFixed(1) : '0.0';
  const totalPages = stats?.total || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', padding: '1rem', boxSizing: 'border-box' }}>
      
      {/* Overview Analytics Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', padding: '0.5rem 1rem', background: 'var(--bg-card)', borderRadius: '8px' }}>
        <div style={{ display: 'flex', gap: '2rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            <span><strong>Focus:</strong> {focusScore}</span>
            <span><strong>Radius:</strong> {radiusScore}</span>
            <span><strong>Drift:</strong> {driftScore}</span>
            <span><strong>Pages:</strong> {totalPages}</span>
        </div>
        <button onClick={handleExportCSV} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '0.25rem 0.75rem', borderRadius: '4px', cursor: 'pointer' }}>
            📥 Export CSV
        </button>
      </div>
      
      {/* Top Stats Boxes */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
        {[
          { label: "Core", stat: stats?.core || {count: 0, pct: 0}, range: `0.0 - ${(thresholds?.q1 || 0).toFixed(2)}` },
          { label: "Focus", stat: stats?.focus || {count: 0, pct: 0}, range: `${(thresholds?.q1 || 0).toFixed(2)} - ${(thresholds?.q3 || 0).toFixed(2)}` },
          { label: "Expansion", stat: stats?.expansion || {count: 0, pct: 0}, range: `${(thresholds?.q3 || 0).toFixed(2)} - ${(thresholds?.outlier || 0).toFixed(2)}` },
          { label: "Peripheral", stat: stats?.peripheral || {count: 0, pct: 0}, range: `> ${(thresholds?.outlier || 0).toFixed(2)}` }
        ].map(b => (
          <div key={b.label} style={{ 
            flex: 1, 
            padding: '1rem', 
            borderRadius: '8px', 
            backgroundColor: bgMap[b.label], 
            border: `1px solid ${borderMap[b.label]}` 
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ color: colorMap[b.label], fontWeight: 600, fontSize: '0.9rem' }}>{b.label}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{b.range}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ color: colorMap[b.label], fontSize: '1.5rem', fontWeight: 'bold' }}>{b.stat?.count || 0}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{b.stat?.pct || 0}%</span>
            </div>
          </div>
        ))}
      </div>

      {/* Plotly Chart */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Plot
          data={allTraces}
          onHover={(e) => {
            if (e.points && e.points[0]?.customdata) {
                setHoveredNode(e.points[0].customdata);
            } else {
                setHoveredNode(null);
            }
          }}
          onUnhover={() => setHoveredNode(null)}
          layout={{
            font: { family: 'inherit', color: '#94a3b8' },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            margin: { t: 20, r: 20, l: 20, b: 20 },
            polar: {
              bgcolor: 'transparent',
              angularaxis: { showgrid: false, showline: false, showticklabels: false },
              radialaxis: { 
                showgrid: false, 
                showline: false,
                showticklabels: false,
                range: [0, (thresholds.outlier * 1.25) || 1.0]
              }
            },
            showlegend: false
          }}
          useResizeHandler={true}
          style={{ width: '100%', height: '100%' }}
          config={{ displayModeBar: false, responsive: true }}
        />
        
        {/* Hover State Capsule */}
        {hoveredNode && (
            <div style={{
                position: 'absolute',
                bottom: '20px',
                left: '20px',
                background: '#e2e8f0',
                color: '#0f172a',
                padding: '12px 20px',
                borderRadius: '12px',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                zIndex: 50,
                minWidth: '350px'
            }}>
                <div style={{ fontWeight: 'bold', fontSize: '0.9rem', marginBottom: '8px', wordBreak: 'break-all' }}>
                    {hoveredNode.url}
                </div>
                <div style={{ display: 'flex', gap: '2rem', fontSize: '0.8rem', color: '#475569' }}>
                    <span><strong>Distance:</strong> {hoveredNode.distance?.toFixed(4)}</span>
                    <span style={{ color: colorMap[hoveredNode.zone] }}><strong>Zone:</strong> {hoveredNode.zone}</span>
                </div>
            </div>
        )}
      </div>

    </div>
  );
}

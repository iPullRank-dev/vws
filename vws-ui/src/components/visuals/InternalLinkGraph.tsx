import { useRef } from 'react';
import ForceGraph3D from 'react-force-graph-3d';

interface NetworkProps {
  data: {
    nodes: any[];
    links: any[];
  }
}

export default function InternalLinkGraph({ data }: NetworkProps) {
  const fgRef = useRef<any>();

  if (!data || !data.nodes || data.nodes.length === 0 || !data.links || data.links.length === 0) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>No Link Topography Available. Please upload a Links CSV to map connections.</div>;

  // Map groups to colors
  const colorMap = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
  const nodeColor = (node: any) => colorMap[node.group % colorMap.length] || '#94a3b8';
  
  const linkColor = (link: any) => {
      if (link.relevance_score > 0.8) return '#10b981'; // Green
      if (link.relevance_score > 0.6) return '#facc15'; // Yellow
      return '#ef4444'; // Red
  };

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ForceGraph3D
        ref={fgRef}
        graphData={data}
        nodeLabel="name"
        nodeColor={nodeColor}
        nodeRelSize={6}
        linkWidth={1.5}
        linkOpacity={0.6}
        linkColor={linkColor}
        backgroundColor="rgba(0,0,0,0)"
        showNavInfo={false}
      />
    </div>
  );
}

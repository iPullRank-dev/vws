
import ReactECharts from 'echarts-for-react';

interface BullseyeProps {
  data: any[];
  onSelected?: (nodes: any[]) => void;
}

export default function BullseyePlot({ data, onSelected }: BullseyeProps) {
  if (!data || data.length === 0) return <div>No data available</div>;

  const categories = [...new Set(data.map(d => d.category))];
  
  const series = categories.map(cat => {
    const subset = data.filter(d => d.category === cat);
    return {
      name: cat,
      type: 'scatter',
      coordinateSystem: 'polar',
      data: subset.map(d => [d.distance, d.angle, d.url]),
      symbolSize: 10,
    };
  });

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      formatter: (params: any) => {
        const dist = params.value[0];
        let actionStr = "";
        let colorStr = "";
        
        if (dist > 0.8) {
            actionStr = "⚠️ ALIENATED NODE: Prune, 301 Redirect, or Rewrite immediately.";
            colorStr = "#ef4444";
        } else if (dist > 0.4) {
            actionStr = "💡 WEAK LINK: Build 3-4 internal backlinks from site core.";
            colorStr = "#f59e0b";
        } else {
            actionStr = "✅ CORE ASSET: Strong Semantic Alignment.";
            colorStr = "#10b981";
        }
        
        return `<div style="max-width: 250px; white-space: normal;">
                  <strong style="color: ${params.color}">${params.seriesName}</strong><br/>
                  <span style="font-size: 0.8rem; color: #94a3b8">URL: ${params.value[2]}</span><br/>
                  <span style="font-size: 0.8rem; color: #94a3b8">Centroid Distance: ${dist.toFixed(3)}</span><br/><br/>
                  <strong style="color: ${colorStr}">${actionStr}</strong>
                </div>`;
      }
    },
    legend: {
      data: categories,
      textStyle: { color: '#94a3b8' },
      bottom: '0%'
    },
    toolbox: {
      feature: {
        brush: {
          type: ['rect', 'polygon', 'clear']
        }
      }
    },
    brush: {},
    polar: {},
    angleAxis: {
      type: 'value',
      startAngle: 0,
      show: false
    },
    radiusAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: '#334155' } },
      axisLabel: { color: '#94a3b8' },
      splitLine: { lineStyle: { color: '#334155', type: 'dashed' } }
    },
    series: series
  };

  const handleBrushEnd = (params: any) => {
      if (!onSelected) return;
      const selectedNodes = [];
      if (params.areas && params.areas.length > 0) {
          // Simply grabbing a placeholder for now since recovering the exact points from polar brush is complex in basic mode
          selectedNodes.push({ url: "Polar Region Segment Created" });
      }
      onSelected(selectedNodes);
  };

  const onEvents = {
      'brushEnd': handleBrushEnd
  };

  return <ReactECharts option={option} onEvents={onEvents} style={{ height: '100%', width: '100%' }} />;
}

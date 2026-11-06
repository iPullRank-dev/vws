import { useRef, useState } from 'react';
import type { MouseEvent } from 'react';

export interface PolarPoint {
  id: string | number;
  r: number;          // 0 = center, 1 = outer edge
  angle: number;      // degrees, 0 = top, clockwise
  color: string;
  label: string;
  sub?: string;
  size?: number;
  shape?: 'circle' | 'diamond';
  dim?: boolean;
}
export interface PolarRing { r: number; label: string; color: string }
export interface PolarSector { start: number; end: number; label: string }

interface Props {
  points: PolarPoint[];
  rings?: PolarRing[];
  sectors?: PolarSector[];
  centerLabel?: string;
  selectedId?: string | number | null;
  onSelect?: (id: string | number) => void;
  height?: number;
}

const VW = 780, VH = 640, CX = 390, CY = 320, R = 250;

function xy(r: number, angle: number) {
  const t = (angle * Math.PI) / 180;
  return [CX + r * R * Math.sin(t), CY - r * R * Math.cos(t)];
}

export default function PolarTarget({ points, rings = [], sectors = [], centerLabel, selectedId, onSelect, height = 560 }: Props) {
  const [hover, setHover] = useState<{ p: PolarPoint; x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const onMove = (p: PolarPoint, e: MouseEvent) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    setHover({ p, x: e.clientX - box.left, y: e.clientY - box.top });
  };

  const sorted = [...points].sort((a, b) => Number(!!b.dim) - Number(!!a.dim) || (a.id === selectedId ? 1 : 0) - (b.id === selectedId ? 1 : 0));

  return (
    <div ref={wrap} className="polar-wrap" style={{ height }}>
      <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Polar relevance plot">
        <circle cx={CX} cy={CY} r={R} fill="rgba(15,23,42,0.35)" stroke="var(--border)" />
        {sectors.length > 1 && sectors.map((s, i) => {
          const [x1, y1] = xy(1, s.start);
          const [lx, ly] = xy(1.1, (s.start + s.end) / 2);
          const mid = (s.start + s.end) / 2;
          const anchor = mid > 10 && mid < 170 ? 'start' : mid > 190 && mid < 350 ? 'end' : 'middle';
          const span = s.end - s.start;
          return (
            <g key={i}>
              <line x1={CX} y1={CY} x2={x1} y2={y1} stroke="var(--border)" strokeWidth={1} opacity={0.6} />
              {span >= 9 && (
                <text x={lx} y={ly} fontSize={11} fill="var(--text-muted)" textAnchor={anchor} dominantBaseline="middle">
                  {s.label.length > 26 ? s.label.slice(0, 25) + '…' : s.label}
                </text>
              )}
            </g>
          );
        })}
        {rings.map((rg, i) => (
          <g key={i}>
            <circle cx={CX} cy={CY} r={Math.max(2, rg.r * R)} fill="none" stroke={rg.color} strokeDasharray="5 4" strokeWidth={1.5} opacity={0.85} />
            <text x={CX + 4} y={CY - rg.r * R - 5} fontSize={10.5} fill={rg.color}>{rg.label}</text>
          </g>
        ))}
        <circle cx={CX} cy={CY} r={5} fill="var(--text-main)" />
        {centerLabel && <text x={CX} y={CY + 18} fontSize={11} fill="var(--text-main)" textAnchor="middle">{centerLabel.length > 40 ? centerLabel.slice(0, 39) + '…' : centerLabel}</text>}
        {sorted.map(p => {
          const [x, y] = xy(Math.min(1, Math.max(0, p.r)), p.angle);
          const sel = p.id === selectedId;
          const s = (p.size ?? 5) + (sel ? 3 : 0);
          return (
            <g key={p.id} style={{ cursor: onSelect ? 'pointer' : 'default' }} opacity={p.dim ? 0.25 : 1}
              onMouseMove={e => onMove(p, e)} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(p.id)}>
              <circle cx={x} cy={y} r={Math.max(9, s + 4)} fill="transparent" />
              {p.shape === 'diamond'
                ? <rect x={x - s} y={y - s} width={s * 2} height={s * 2} transform={`rotate(45 ${x} ${y})`} fill={p.color} stroke="var(--bg-card)" strokeWidth={1.5} />
                : <circle cx={x} cy={y} r={s} fill={p.color} stroke={sel ? '#f8fafc' : 'var(--bg-card)'} strokeWidth={sel ? 2.5 : 1.5} />}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="polar-tip" style={{ left: Math.min(hover.x + 14, (wrap.current?.clientWidth || 600) - 280), top: hover.y + 12 }}>
          <strong>{hover.p.label}</strong>
          {hover.p.sub && <div>{hover.p.sub}</div>}
        </div>
      )}
    </div>
  );
}

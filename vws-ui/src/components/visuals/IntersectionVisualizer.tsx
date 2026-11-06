import { useEffect, useRef } from 'react';

interface Entity {
    id: number;
    url: string;
    title: string;
    source_type: string;
}

interface CompareData {
    distance: number;
    entity_a: Entity;
    entity_b: Entity;
    neighbors_a: Entity[];
    neighbors_b: Entity[];
    error?: string;
}

interface Props {
    data: CompareData | null;
}

export default function IntersectionVisualizer({ data }: Props) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!data || !canvasRef.current || data.error) return;
        const ctx = canvasRef.current.getContext('2d');
        if (!ctx) return;

        const w = canvasRef.current.width;
        const h = canvasRef.current.height;
        ctx.clearRect(0, 0, w, h);

        const dist = data.distance; // cosine distance logic
        
        // Base distance calculation: map math distance to physical pixels
        // A cosine distance usually ranges from 0 to 2.
        const maxDistPixels = w * 0.45;
        const mappedDist = Math.max(0, Math.min(1.5, dist)) / 1.5; // normalize a bit
        
        const currentSpread = maxDistPixels * mappedDist;
        
        const centerX = w / 2;
        const centerY = h / 2;
        
        const rMain = 60; // Radius of the main entities
        const xA = centerX - currentSpread / 2;
        const xB = centerX + currentSpread / 2;
        
        // Context glow
        ctx.shadowBlur = 20;
        
        // Draw Entity A
        ctx.shadowColor = '#38bdf8';
        ctx.beginPath();
        ctx.arc(xA, centerY, rMain, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)'; 
        ctx.fill();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3;
        ctx.stroke();

        // Draw Entity B
        ctx.shadowColor = '#ef4444';
        ctx.beginPath();
        ctx.arc(xB, centerY, rMain, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.2)'; 
        ctx.fill();
        ctx.strokeStyle = '#ef4444';
        ctx.stroke();
        
        // Reset shadow for text
        ctx.shadowBlur = 0;
        
        ctx.fillStyle = 'white';
        ctx.font = 'bold 12px Inter, sans-serif';
        ctx.textAlign = 'center';
        
        // truncate strings safely
        const titleA = data.entity_a.title || data.entity_a.url || "Node A";
        const titleB = data.entity_b.title || data.entity_b.url || "Node B";
        
        ctx.fillText(titleA.substring(0, 25), xA, centerY + rMain + 25);
        ctx.fillText(`ID: ${data.entity_a.id}`, xA, centerY + rMain + 40);
        
        ctx.fillText(titleB.substring(0, 25), xB, centerY + rMain + 25);
        ctx.fillText(`ID: ${data.entity_b.id}`, xB, centerY + rMain + 40);
        
        // Draw Distance Math
        ctx.font = '16px Inter, sans-serif';
        ctx.fillStyle = '#10b981';
        ctx.fillText(`Distance: ${dist.toFixed(4)}`, centerX, 40);
        
        // Draw connection line if not perfectly overlapping
        if (currentSpread > rMain) {
             ctx.beginPath();
             ctx.moveTo(xA + rMain + 5, centerY);
             ctx.lineTo(xB - rMain - 5, centerY);
             ctx.strokeStyle = 'rgba(255,255,255,0.3)';
             ctx.setLineDash([5, 5]);
             ctx.stroke();
             ctx.setLineDash([]);
        }

        // Draw Orbiting Neighbors A
        data.neighbors_a.forEach((n, i) => {
            const angle = (i / data.neighbors_a.length) * Math.PI * 2 + Math.PI; // Orbit angle
            const orbitR = rMain + 40 + (i * 8);
            const nX = xA + Math.cos(angle) * orbitR;
            const nY = centerY + Math.sin(angle) * orbitR;
            
            ctx.beginPath();
            ctx.moveTo(xA, centerY);
            ctx.lineTo(nX, nY);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.15)';
            ctx.stroke();
            
            ctx.beginPath();
            ctx.arc(nX, nY, 8, 0, 2 * Math.PI);
            ctx.fillStyle = '#38bdf8';
            ctx.fill();
            
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '10px Inter, sans-serif';
            ctx.fillText((n.title || n.url).substring(0, 15), nX, nY + 20);
        });

        // Draw Orbiting Neighbors B
        data.neighbors_b.forEach((n, i) => {
            const angle = (i / data.neighbors_b.length) * Math.PI * 2;
            const orbitR = rMain + 40 + (i * 8);
            const nX = xB + Math.cos(angle) * orbitR;
            const nY = centerY + Math.sin(angle) * orbitR;
            
            ctx.beginPath();
            ctx.moveTo(xB, centerY);
            ctx.lineTo(nX, nY);
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.15)';
            ctx.stroke();
            
            ctx.beginPath();
            ctx.arc(nX, nY, 8, 0, 2 * Math.PI);
            ctx.fillStyle = '#ef4444';
            ctx.fill();
            
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '10px Inter, sans-serif';
            ctx.fillText((n.title || n.url).substring(0, 15), nX, nY + 20);
        });

    }, [data]);

    if (!data) return <div className="placeholder-viz">Awaiting Selection...</div>;
    if (data.error) return <div className="placeholder-viz" style={{ color: '#ef4444' }}>{data.error}</div>;

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'radial-gradient(circle at center, #1e293b 0%, #0f172a 100%)', padding: '2rem', boxSizing: 'border-box' }}>
            <h3 style={{ margin: '0 0 1rem 0', color: 'white', fontWeight: 'normal' }}>Gravitational Intersection View</h3>
            <canvas ref={canvasRef} width={800} height={500} style={{ border: '1px solid var(--border)', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', background: '#020617' }} />
        </div>
    );
}

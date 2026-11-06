import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, CheckCircle, Clock, Download, FileText, Link2, Loader2, RefreshCw, Search, Trash2, Users } from 'lucide-react';
import { API_BASE } from '../config';

export interface PendingUpload { key: string; filename: string; kind: string; pct: number; error?: string }

interface UploadRow {
  id: number | null;
  kind: string;
  kind_label: string;
  source_name: string;
  filename: string;
  bytes?: number;
  status: 'queued' | 'processing' | 'done' | 'failed' | 'interrupted';
  message: string;
  created_at?: string;
  finished_at?: string | null;
  file_kept: boolean;
  counts: { pages: number; keywords: number; links: number; vectors: number };
  legacy: boolean;
  remove_key?: string;
  progress?: { phase: string; current: number; total: number; estimated_time_remaining: number; embedded?: number; embed_total?: number } | null;
  stats?: { referring_domains?: number; [k: string]: unknown } | null;
}

interface Props {
  projectId: string;
  refreshKey: number;
  pending: PendingUpload[];
  onChanged: () => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const KIND_ICON: Record<string, typeof FileText> = { keyword: Search, internal: Link2, external: Link2, competitor: Users, base: FileText };

const n = (v: number) => v.toLocaleString();
function countsText(r: UploadRow): string {
  const c = r.counts;
  const parts: string[] = [];
  if (r.kind === 'keyword') parts.push(`${n(c.keywords)} keywords`);
  else if (r.kind === 'external') {
    parts.push(`${n(c.links)} backlinks`);
    if (c.pages) parts.push(`${n(c.pages)} referring pages`);
    if (r.stats?.referring_domains) parts.push(`${n(r.stats.referring_domains)} domains`);
  } else if (r.kind === 'internal') {
    parts.push(`${n(c.links)} links`);
    if (c.pages) parts.push(`${n(c.pages)} new pages`);
  } else parts.push(`${n(c.pages)} pages`);
  const rows = r.kind === 'keyword' ? c.keywords : c.pages;
  if (!r.legacy && rows > 0 && c.vectors < rows) parts.push(`${n(rows - c.vectors)} without vectors yet`);
  return parts.join(' · ');
}
function when(ts?: string | null) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z'));
  return isNaN(d.getTime()) ? ts : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function eta(s: number) {
  if (!s || !isFinite(s)) return '';
  return s > 90 ? `~${Math.round(s / 60)} min left` : `~${Math.max(1, Math.round(s))}s left`;
}

export default function UploadsPanel({ projectId, refreshKey, pending, onChanged, notify }: Props) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [legacy, setLegacy] = useState<UploadRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const prevStatus = useRef<Record<number, string>>({});

  const load = async () => {
    try {
      const r = await axios.get(`${API_BASE}/api/projects/${projectId}/uploads`);
      const ups: UploadRow[] = r.data.uploads || [];
      // Tell the user (and refresh the analysis) when an import finishes.
      let finished = false;
      ups.forEach(u => {
        const before = u.id !== null ? prevStatus.current[u.id] : undefined;
        if (before && (before === 'queued' || before === 'processing') && (u.status === 'done' || u.status === 'failed')) {
          finished = true;
          if (u.status === 'done') notify(`${u.filename} loaded: ${countsText(u)}.`, 'success');
          else notify(`${u.filename} failed: ${u.message}`, 'error');
        }
        if (u.id !== null) prevStatus.current[u.id] = u.status;
      });
      setRows(ups);
      setLegacy(r.data.legacy || []);
      setLoaded(true);
      if (finished) onChanged();
    } catch {
      setLoaded(true);
    }
  };

  useEffect(() => { prevStatus.current = {}; load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId, refreshKey]);

  const active = pending.length > 0 || rows.some(r => r.status === 'queued' || r.status === 'processing');
  useEffect(() => {
    if (!active) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId]);

  const remove = async (r: UploadRow) => {
    const key = r.id !== null ? `u${r.id}` : `l${r.remove_key}`;
    setBusy(key); setConfirm(null);
    try {
      if (r.id !== null) await axios.delete(`${API_BASE}/api/projects/${projectId}/uploads/${r.id}`);
      else await axios.delete(`${API_BASE}/api/projects/${projectId}/data/${encodeURIComponent(r.remove_key || r.source_name)}`);
      notify(`Removed ${r.filename} and its data.`, 'info');
      await load();
      onChanged();
    } catch (e: any) {
      notify(e?.response?.data?.detail || 'Could not remove it.', 'error');
    } finally { setBusy(null); }
  };
  const reimport = async (r: UploadRow) => {
    if (r.id === null) return;
    setBusy(`u${r.id}`);
    try {
      await axios.post(`${API_BASE}/api/projects/${projectId}/uploads/${r.id}/reimport`);
      prevStatus.current[r.id] = 'queued';
      await load();
    } catch (e: any) {
      notify(e?.response?.data?.detail || 'Could not re-import it.', 'error');
    } finally { setBusy(null); }
  };

  const nothing = loaded && !rows.length && !legacy.length && !pending.length;

  return (
    <div className="up-panel">
      <h4>Uploaded files</h4>
      {!loaded && <div className="up-empty"><Loader2 size={12} className="spinner" /> Loading…</div>}
      {nothing && <div className="up-empty">No files uploaded yet. Files you add below stay listed here, with their status, after a reload.</div>}

      {pending.map(p => (
        <div key={p.key} className="up-row">
          <div className="up-name"><FileText size={13} /><span title={p.filename}>{p.filename}</span></div>
          {p.error
            ? <div className="up-status failed"><AlertTriangle size={12} /> Upload failed: {p.error}</div>
            : <>
              <div className="up-status processing"><Loader2 size={12} className="spinner" /> Uploading file… {p.pct}%</div>
              <div className="up-bar"><i style={{ width: `${p.pct}%` }} /></div>
            </>}
        </div>
      ))}

      {[...rows].reverse().map(r => {
        const Icon = KIND_ICON[r.kind] || FileText;
        const key = `u${r.id}`;
        const prog = r.progress;
        const pct = prog && prog.total ? Math.round((prog.current / prog.total) * 100) : null;
        return (
          <div key={key} className={`up-row ${r.status}`}>
            <div className="up-name"><Icon size={13} /><span title={`${r.filename}\n${r.kind_label}`}>{r.filename}</span></div>
            <div className="up-meta">{r.kind_label}{r.kind === 'competitor' ? ` (${r.source_name})` : ''} · {when(r.created_at)}</div>

            {r.status === 'queued' && <div className="up-status queued"><Clock size={12} /> Queued{r.message ? `: ${r.message}` : ''}</div>}
            {r.status === 'processing' && <>
              <div className="up-status processing"><Loader2 size={12} className="spinner" /> Processing{prog ? `: ${prog.phase}` : '…'}{prog && prog.total > 1 ? ` (${n(prog.current)} of ${n(prog.total)})` : ''}</div>
              <div className={`up-bar ${pct === null ? 'indeterminate' : ''}`}><i style={{ width: pct === null ? '35%' : `${pct}%` }} /></div>
              {prog && <div className="up-meta">
                {[prog.embedded && prog.embed_total && prog.embedded < prog.embed_total ? `${n(prog.embedded)} of ${n(prog.embed_total)} embedded so far` : '',
                  eta(prog.estimated_time_remaining)].filter(Boolean).join(' · ')}
              </div>}
            </>}
            {r.status === 'done' && <div className="up-status done"><CheckCircle size={12} /> Loaded · {countsText(r)}</div>}
            {r.status === 'done' && r.message && <div className="up-meta">{r.message}</div>}
            {r.status === 'failed' && <div className="up-status failed"><AlertTriangle size={12} /> Failed: {r.message}</div>}
            {r.status === 'interrupted' && <div className="up-status interrupted"><AlertTriangle size={12} /> Interrupted: {r.message}</div>}

            <div className="up-actions">
              {r.file_kept && (r.status === 'failed' || r.status === 'interrupted' || r.status === 'done') && (
                <button onClick={() => reimport(r)} disabled={busy === key} title="Clear this file's data and import the saved copy again"><RefreshCw size={11} /> Re-import</button>
              )}
              {r.file_kept && <a href={`${API_BASE}/api/projects/${projectId}/uploads/${r.id}/file`} title="Download the saved file"><Download size={11} /> File</a>}
              {r.kind !== 'base' && (r.status !== 'processing' && r.status !== 'queued') && (
                confirm === key
                  ? <span className="up-confirm">Remove it and its data? <button className="danger" onClick={() => remove(r)}>Yes</button><button onClick={() => setConfirm(null)}>No</button></span>
                  : <button className="danger" onClick={() => setConfirm(key)} disabled={busy === key}><Trash2 size={11} /> Remove</button>
              )}
            </div>
          </div>
        );
      })}

      {legacy.map(r => {
        const key = `l${r.remove_key}`;
        const Icon = KIND_ICON[r.kind] || FileText;
        return (
          <div key={key} className="up-row legacy">
            <div className="up-name"><Icon size={13} /><span title={r.source_name}>{r.filename}</span></div>
            <div className="up-meta">{r.kind_label} · imported before file tracking (no saved copy)</div>
            <div className="up-status done"><CheckCircle size={12} /> Loaded · {countsText(r)}</div>
            <div className="up-actions">
              {confirm === key
                ? <span className="up-confirm">Remove this data? <button className="danger" onClick={() => remove(r)}>Yes</button><button onClick={() => setConfirm(null)}>No</button></span>
                : <button className="danger" onClick={() => setConfirm(key)} disabled={busy === key}><Trash2 size={11} /> Remove</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

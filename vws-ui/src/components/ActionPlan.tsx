import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Download, FlaskConical, Loader2, MapPin,
  RefreshCw, RotateCcw, Search, SkipForward, Sparkles, Zap,
} from 'lucide-react';
import { API_BASE } from '../config';
import {
  BAND_COLOR, TYPE_COLOR, TYPE_NAME, TYPE_ORDER, actionToMarkdown, copyText, csvCell, downloadText,
  fmt, fmtInt, shortUrl,
} from '../lib/vws';
import type { ActionPlanData, ActionStatus, LabPayload, PlanAction, Thresholds } from '../lib/vws';
import './act.css';

interface IngestJob {
  upload_id?: number | null; label?: string; phase?: string; current: number; total: number;
  estimated_time_remaining: number; embedded?: number; embed_total?: number;
}
// Several files can import at once; `jobs` lists each one, the top-level fields
// mirror the one with the most work left.
interface IngestProgress extends IngestJob { jobs?: IngestJob[] }

const minsLeft = (s: number) => (s > 90 ? `about ${Math.round(s / 60)} min left` : s > 0 ? `about ${Math.max(1, Math.round(s))}s left` : '');

interface Props {
  projectId: string;
  projectName: string;
  refreshKey: number;
  ingestProgress: IngestProgress | null;
  onOpenLab: (p: LabPayload) => void;
  onGenerateBrief: (keyword: string, url: string) => void;
  onReembed: (fetchMissing: boolean) => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
  lockedTypes?: string[];          // show only these action types (Gaps / Link views)
  compact?: boolean;               // hide the coverage/progress/threshold cards
  initialSearch?: { text: string; nonce: number } | null;
}

type Overrides = Partial<Pick<Thresholds, 'gap' | 'strong' | 'cannibal_margin' | 'link_min'>>;
const PAGE = 40;

export default function ActionPlan({ projectId, projectName, refreshKey, ingestProgress, onOpenLab, onGenerateBrief, onReembed, notify, lockedTypes, compact, initialSearch }: Props) {
  const [plan, setPlan] = useState<ActionPlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [overrides, setOverrides] = useState<Overrides>({});
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'active' | ActionStatus | 'all'>('active');
  const [quickOnly, setQuickOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [histMode, setHistMode] = useState<'count' | 'volume'>('count');
  const [fetchMissing, setFetchMissing] = useState(true);
  const reqId = useRef(0);
  const allowed = (t: string) => !lockedTypes || lockedTypes.includes(t);

  useEffect(() => {
    if (initialSearch?.text) { setSearch(initialSearch.text); setStatusFilter('all'); setTypeFilter('all'); }
  }, [initialSearch?.nonce]);

  const load = useCallback(async (ov: Overrides) => {
    const id = ++reqId.current;
    setLoading(true);
    setError('');
    try {
      const params: Record<string, number> = {};
      Object.entries(ov).forEach(([k, v]) => { if (typeof v === 'number') params[k] = v; });
      const res = await axios.get(`${API_BASE}/api/projects/${projectId}/actions`, { params });
      if (id === reqId.current) setPlan(res.data);
    } catch (e: any) {
      if (id === reqId.current) setError(e?.response?.data?.detail || e?.message || 'Failed to build the action plan.');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [projectId]);

  // Debounce threshold edits so dragging a slider doesn't flood the backend.
  useEffect(() => {
    const t = setTimeout(() => load(overrides), Object.keys(overrides).length ? 350 : 0);
    return () => clearTimeout(t);
  }, [overrides, refreshKey, load]);

  const setStatus = async (a: PlanAction, status: ActionStatus) => {
    setPlan(p => p ? { ...p, actions: p.actions.map(x => x.key === a.key ? { ...x, status } : x) } : p);
    try {
      await axios.post(`${API_BASE}/api/projects/${projectId}/actions/state`, { key: a.key, status });
    } catch {
      notify('Could not save status.', 'error');
    }
  };

  const saveNote = async (a: PlanAction, note: string) => {
    if (note === a.note) return;
    setPlan(p => p ? { ...p, actions: p.actions.map(x => x.key === a.key ? { ...x, note } : x) } : p);
    try {
      await axios.post(`${API_BASE}/api/projects/${projectId}/actions/state`, { key: a.key, status: a.status, note });
    } catch {
      notify('Could not save note.', 'error');
    }
  };

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = {};
    plan?.actions.forEach(a => {
      if (!allowed(a.type)) return;
      if (statusFilter === 'all' || (statusFilter === 'active' ? (a.status === 'open' || a.status === 'doing') : a.status === statusFilter)) {
        c[a.type] = (c[a.type] || 0) + 1;
      }
    });
    return c;
  }, [plan, statusFilter]);

  const visible = useMemo(() => {
    if (!plan) return [];
    const q = search.trim().toLowerCase();
    return plan.actions.filter(a => {
      if (!allowed(a.type)) return false;
      if (typeFilter !== 'all' && a.type !== typeFilter) return false;
      if (statusFilter === 'active' && !(a.status === 'open' || a.status === 'doing')) return false;
      if (statusFilter !== 'active' && statusFilter !== 'all' && a.status !== statusFilter) return false;
      if (quickOnly && !a.quick_win) return false;
      if (q) {
        const hay = `${a.title} ${a.why} ${a.urls.join(' ')} ${a.keywords.map(k => k.keyword).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [plan, typeFilter, statusFilter, quickOnly, search]);

  useEffect(() => setLimit(PAGE), [typeFilter, statusFilter, quickOnly, search]);

  const toggle = (key: string) => setExpanded(prev => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const exportCsv = () => {
    const header = ['Rank', 'Type', 'Title', 'Status', 'Impact', 'Effort', 'Primary URL', 'Why', 'Steps', 'Queries', 'Links', 'Note'];
    const rows = visible.map(a => [
      a.rank, a.type_label, a.title, a.status, `${a.impact_label} (${a.impact})`, a.effort, a.primary_url || '', a.why,
      a.steps.map((s, i) => `${i + 1}. ${s}`).join(' | '),
      a.keywords.slice(0, 15).map(k => `${k.keyword} (${fmt(k.similarity)})`).join('; '),
      a.links.map(l => `${l.source_url} -> ${l.target_url} [${l.anchor}]`).join('; '),
      a.note,
    ].map(csvCell).join(','));
    downloadText(`project_${projectId}_action_plan.csv`, [header.join(','), ...rows].join('\n'), 'text/csv');
  };

  const exportMd = () => {
    if (!plan) return;
    const th = plan.thresholds;
    const head = [
      `# Action Plan: ${projectName || `Project ${projectId}`}`,
      '',
      `Generated ${new Date().toLocaleString()} · vectors: ${plan.vector_health.active_model} · thresholds: strong ≥ ${fmt(th.strong, 2)}, gap < ${fmt(th.gap, 2)} (${th.basis})`,
      '',
    ];
    downloadText(`project_${projectId}_action_plan.md`, head.concat(visible.map((a, i) => actionToMarkdown(a, i + 1) + '\n')).join('\n'), 'text/markdown');
  };

  if (!plan && loading) {
    return <div className="act-loading"><Loader2 className="spinner" size={28} /> Building the action plan…</div>;
  }
  if (!plan) {
    return <div className="act-error"><AlertTriangle size={16} /> {error || 'No plan available.'} <button className="btn-secondary" onClick={() => load(overrides)}>Retry</button></div>;
  }

  const th = plan.thresholds;
  const cov = plan.summary.coverage;
  const useVol = histMode === 'volume' && plan.summary.has_volume;
  const covTotal = cov ? (useVol ? cov.strong.volume + cov.partial.volume + cov.gap.volume : cov.strong.count + cov.partial.count + cov.gap.count) : 0;

  return (
    <div className="act">
      {(plan.blockers.length > 0 || ingestProgress) && (
        <div className={`act-banner ${ingestProgress ? 'info' : 'warn'}`}>
          {ingestProgress ? <Loader2 size={16} className="spinner" /> : <AlertTriangle size={16} />}
          <div className="act-banner-body">
            {ingestProgress ? (
              <>
                {(ingestProgress.jobs && ingestProgress.jobs.length ? ingestProgress.jobs : [ingestProgress]).map((j, i) => (
                  <div key={j.upload_id ?? `p${i}`} className="act-job">
                    <strong>{j.label ? <span className="act-job-file">{j.label}</span> : null}{j.phase || 'Processing'}</strong>
                    <div className="act-progress"><div style={{ width: `${Math.min(100, (j.current / Math.max(1, j.total)) * 100)}%` }} /></div>
                    <small>
                      {j.current.toLocaleString()} / {j.total.toLocaleString()}
                      {j.embedded && j.embed_total && j.embedded < j.embed_total ? ` · ${j.embedded.toLocaleString()} of ${j.embed_total.toLocaleString()} pages embedded so far` : ''}
                      {minsLeft(j.estimated_time_remaining) ? ` · ${minsLeft(j.estimated_time_remaining)}` : ''}
                    </small>
                  </div>
                ))}
                {(ingestProgress.jobs || [ingestProgress]).some(j => (j.embedded || 0) > 0 && (j.embedded || 0) < (j.embed_total || 0)) && (
                  <div className="act-banner-actions">
                    <button className="btn-secondary" onClick={() => load(overrides)} disabled={loading}>
                      <RefreshCw size={13} /> Refresh the plan with the pages embedded so far
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                {plan.blockers.map((b, i) => <p key={i}>{b}</p>)}
                {(plan.vector_health.needs_reembed || plan.vector_health.foreign) && (
                  <div className="act-banner-actions">
                    <button className="btn-primary" onClick={() => onReembed(fetchMissing)}><RefreshCw size={14} /> Re-embed with EmbeddingGemma 2</button>
                    <label><input type="checkbox" checked={fetchMissing} onChange={e => setFetchMissing(e.target.checked)} /> Fetch page text where missing</label>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!compact && <div className="act-top">
        <section className="act-card">
          <header>
            <h3>Query coverage</h3>
            {plan.summary.has_volume && (
              <div className="seg">
                <button className={histMode === 'count' ? 'on' : ''} onClick={() => setHistMode('count')}>Queries</button>
                <button className={histMode === 'volume' ? 'on' : ''} onClick={() => setHistMode('volume')}>Volume</button>
              </div>
            )}
          </header>
          {cov && covTotal > 0 ? (
            <>
              <div className="cov-bar" role="img" aria-label="Share of queries by coverage band">
                {(['strong', 'partial', 'gap'] as const).map(b => {
                  const v = useVol ? cov[b].volume : cov[b].count;
                  return v > 0 ? <div key={b} style={{ flex: v, background: BAND_COLOR[b] }} title={`${b}: ${fmtInt(v)}`} /> : null;
                })}
              </div>
              <div className="cov-legend">
                {([['strong', 'Clearly targeted'], ['partial', 'Under-optimized'], ['gap', 'Not covered']] as const).map(([b, label]) => {
                  const v = useVol ? cov[b].volume : cov[b].count;
                  return (
                    <div key={b}>
                      <span className="dot" style={{ background: BAND_COLOR[b] }} />
                      <span className="lbl">{label}</span>
                      <strong>{fmtInt(v)}</strong>
                      <span className="pct">{covTotal ? Math.round((v / covTotal) * 100) : 0}%</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="muted">Upload a keyword CSV to see which queries the site answers, half-answers, or misses.</p>
          )}
        </section>

        <section className="act-card">
          <header><h3>Progress</h3></header>
          <div className="act-stats">
            <div><strong>{plan.summary.open}</strong><span>open</span></div>
            <div><strong>{plan.summary.done}</strong><span>done</span></div>
            <div><strong>{plan.summary.quick_wins}</strong><span>quick wins</span></div>
          </div>
          <p className="muted small">{plan.summary.pages} pages · {plan.summary.keywords} queries · {plan.summary.competitor_pages} competitor pages{!plan.link_graph_loaded ? ' · no internal link export loaded' : ''}</p>
        </section>

        <section className="act-card act-thresholds">
          <header>
            <h3>Thresholds</h3>
            {Object.keys(overrides).length > 0 && (
              <button className="link-btn" onClick={() => setOverrides({})}><RotateCcw size={12} /> Reset</button>
            )}
          </header>
          {plan.histogram && <Histogram hist={plan.histogram} th={th} mode={useVol ? 'volume' : 'count'} />}
          <div className="th-grid">
            <ThresholdInput label="Gap below" value={th.gap} onChange={v => setOverrides(o => ({ ...o, gap: v }))} color={BAND_COLOR.gap} />
            <ThresholdInput label="Strong at" value={th.strong} onChange={v => setOverrides(o => ({ ...o, strong: v }))} color={BAND_COLOR.strong} />
            <ThresholdInput label="Cannibal margin" value={th.cannibal_margin} step={0.001} onChange={v => setOverrides(o => ({ ...o, cannibal_margin: v }))} />
            <ThresholdInput label="Link similarity" value={th.link_min} onChange={v => setOverrides(o => ({ ...o, link_min: v }))} />
          </div>
          <p className="muted small">{th.basis}</p>
        </section>
      </div>}

      <div className="act-filters">
        <div className="chips">
          <button className={typeFilter === 'all' ? 'chip on' : 'chip'} onClick={() => setTypeFilter('all')}>All <span>{Object.values(typeCounts).reduce((s, n) => s + n, 0)}</span></button>
          {TYPE_ORDER.filter(t => typeCounts[t]).map(t => (
            <button key={t} className={typeFilter === t ? 'chip on' : 'chip'} onClick={() => setTypeFilter(t)}>
              <i style={{ background: TYPE_COLOR[t] }} />{TYPE_NAME[t]} <span>{typeCounts[t]}</span>
            </button>
          ))}
        </div>
        <div className="act-filter-row">
          <div className="act-search"><Search size={14} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter by URL, query or text…" /></div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}>
            <option value="active">Open + in progress</option>
            <option value="done">Done</option>
            <option value="skipped">Skipped</option>
            <option value="all">All statuses</option>
          </select>
          <label className="act-toggle"><input type="checkbox" checked={quickOnly} onChange={e => setQuickOnly(e.target.checked)} /> <Zap size={13} /> Quick wins</label>
          {loading && <Loader2 size={14} className="spinner" />}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
            <button className="btn-secondary" onClick={exportCsv} disabled={!visible.length}><Download size={13} /> CSV</button>
            <button className="btn-secondary" onClick={exportMd} disabled={!visible.length}><Download size={13} /> Markdown</button>
          </div>
        </div>
      </div>

      <div className="act-list">
        {visible.length === 0 && <div className="muted act-empty">No actions match these filters.</div>}
        {visible.slice(0, limit).map(a => (
          <ActionRow key={a.key} a={a} projectId={projectId} open={expanded.has(a.key)} onToggle={() => toggle(a.key)}
            onStatus={s => setStatus(a, s)} onNote={n => saveNote(a, n)} onOpenLab={onOpenLab}
            onBrief={onGenerateBrief} notify={notify} />
        ))}
        {visible.length > limit && (
          <button className="btn-secondary act-more" onClick={() => setLimit(l => l + PAGE)}>Show {Math.min(PAGE, visible.length - limit)} more of {visible.length - limit}</button>
        )}
      </div>
    </div>
  );
}

function ThresholdInput({ label, value, onChange, step = 0.005, color }: { label: string; value: number; onChange: (v: number) => void; step?: number; color?: string }) {
  return (
    <label className="th-input">
      <span>{color && <i style={{ background: color }} />}{label}</span>
      <input type="number" step={step} min={-1} max={1} value={Number(value.toFixed(3))}
        onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(v); }} />
    </label>
  );
}

function Histogram({ hist, th, mode }: { hist: NonNullable<ActionPlanData['histogram']>; th: Thresholds; mode: 'count' | 'volume' }) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = mode === 'volume' ? hist.volume : hist.counts;
  const max = Math.max(1, ...vals);
  const W = 300, H = 70, n = vals.length;
  const lo = hist.edges[0], hi = hist.edges[hist.edges.length - 1];
  const x = (v: number) => ((v - lo) / (hi - lo)) * W;
  const bw = W / n;
  return (
    <div className="hist">
      <svg viewBox={`0 0 ${W} ${H + 14}`} preserveAspectRatio="none" role="img" aria-label="Distribution of each query's best-page similarity">
        {vals.map((v, i) => {
          const mid = (hist.edges[i] + hist.edges[i + 1]) / 2;
          const band = mid >= th.strong ? 'strong' : mid >= th.gap ? 'partial' : 'gap';
          const h = (v / max) * H;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {v > 0 && <rect x={i * bw + 1} y={H - h} width={Math.max(1, bw - 2)} height={h} rx={1.5}
                fill={BAND_COLOR[band]} opacity={hover === null || hover === i ? 0.9 : 0.45} />}
            </g>
          );
        })}
        {[th.gap, th.strong].map((t, i) => (
          <line key={i} x1={x(t)} x2={x(t)} y1={0} y2={H} stroke="var(--text-main)" strokeWidth={1} strokeDasharray="3 2" opacity={0.85} />
        ))}
        <text x={x(th.gap) - 2} y={H + 11} fontSize={8} fill="var(--text-muted)" textAnchor="end">gap {th.gap.toFixed(2)}</text>
        <text x={x(th.strong) + 2} y={H + 11} fontSize={8} fill="var(--text-muted)">strong {th.strong.toFixed(2)}</text>

      </svg>
      <div className="hist-tip">
        {hover !== null
          ? <>{fmt(hist.edges[hover], 3)}–{fmt(hist.edges[hover + 1], 3)}: <strong>{fmtInt(vals[hover])}</strong> {mode === 'volume' ? 'searches' : 'queries'}</>
          : <>Each query's best-page similarity. Dashed lines: gap and strong.</>}
      </div>
    </div>
  );
}

function ActionRow({ a, projectId, open, onToggle, onStatus, onNote, onOpenLab, onBrief, notify }: {
  a: PlanAction; projectId: string; open: boolean; onToggle: () => void; onStatus: (s: ActionStatus) => void; onNote: (n: string) => void;
  onOpenLab: (p: LabPayload) => void; onBrief: (k: string, u: string) => void; notify: Props['notify'];
}) {
  const [note, setNote] = useState(a.note);
  useEffect(() => setNote(a.note), [a.note]);
  const [placing, setPlacing] = useState<string | null>(null);
  const [placements, setPlacements] = useState<Record<string, any>>({});
  const place = async (source: string, target: string, anchor: string) => {
    const k = `${source}→${target}`;
    setPlacing(k);
    try {
      const r = await axios.post(`${API_BASE}/api/projects/${projectId}/link-placement`, { source_url: source, target_url: target, anchor }, { timeout: 300000 });
      if (r.data.error) notify(r.data.error, 'error'); else setPlacements(p => ({ ...p, [k]: r.data }));
    } catch (e: any) {
      notify(e?.response?.data?.detail || e?.message || 'Placement failed.', 'error');
    } finally { setPlacing(null); }
  };
  const color = TYPE_COLOR[a.variant || a.type] || '#94a3b8';
  const canLab = a.lab && (a.lab.url || (a.lab.compare_urls && a.lab.compare_urls.length) || a.lab.queries.length);
  const briefKw = a.keywords[0]?.keyword;
  const briefUrl = a.primary_url && !a.primary_url.startsWith('http') ? '' : a.primary_url;
  return (
    <div className={`act-row ${open ? 'open' : ''} st-${a.status}`}>
      <div className="act-row-main" onClick={onToggle}>
        <span className="act-rank">{a.rank}</span>
        <span className="act-type" style={{ color, background: `${color}1f`, borderColor: `${color}55` }}>{a.type_label}</span>
        <div className="act-text">
          <div className="act-title">{a.title}{a.quick_win && <span className="qw" title="High impact, low effort"><Zap size={11} /> quick win</span>}</div>
          <div className="act-why">{a.why}</div>
        </div>
        <div className="act-meta">
          <div className="impact" title={`Impact ${a.impact}/100`}>
            <div className="impact-bar"><div style={{ width: `${a.impact}%` }} /></div>
            <span>{a.impact_label}</span>
          </div>
          <span className={`effort e-${a.effort}`}>{a.effort} effort</span>
        </div>
        <div className="act-status" onClick={e => e.stopPropagation()}>
          {a.status === 'done' || a.status === 'skipped' ? (
            <button className="icon-btn" title="Reopen" onClick={() => onStatus('open')}><RotateCcw size={14} /></button>
          ) : (
            <>
              <button className={`icon-btn ${a.status === 'doing' ? 'on' : ''}`} title={a.status === 'doing' ? 'In progress' : 'Mark in progress'} onClick={() => onStatus(a.status === 'doing' ? 'open' : 'doing')}><Loader2 size={14} /></button>
              <button className="icon-btn good" title="Mark done" onClick={() => onStatus('done')}><Check size={14} /></button>
              <button className="icon-btn" title="Skip" onClick={() => onStatus('skipped')}><SkipForward size={14} /></button>
            </>
          )}
        </div>
        {open ? <ChevronDown size={16} className="chev" /> : <ChevronRight size={16} className="chev" />}
      </div>

      {open && (
        <div className="act-detail">
          <div className="act-detail-cols">
            <div>
              <h4>Do this</h4>
              <ol className="act-steps">{a.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              <div className="act-buttons">
                {canLab ? <button className="btn-primary" onClick={() => onOpenLab({ ...a.lab, autoRun: true })}><FlaskConical size={14} /> Open in Relevance Lab</button> : null}
                {briefKw && briefUrl && (a.type === 'optimize' || a.type === 'create' || a.type === 'cannibalization') && (
                  <button className="btn-secondary" onClick={() => onBrief(briefKw, briefUrl)}><Sparkles size={14} /> AI rewrite brief</button>
                )}
                <button className="btn-secondary" onClick={async () => notify((await copyText(actionToMarkdown(a))) ? 'Copied as a ticket (Markdown).' : 'Copy failed.', 'info')}><Copy size={14} /> Copy as ticket</button>
              </div>
              <label className="act-note">
                <span>Note</span>
                <textarea value={note} placeholder="Owner, ticket link, decision…" onChange={e => setNote(e.target.value)} onBlur={() => onNote(note)} rows={2} />
              </label>
            </div>
            <div className="act-evidence">
              {a.keywords.length > 0 && (() => {
                const hasVol = a.keywords.some(k => k.volume !== null && k.volume !== undefined);
                const hasComp = a.keywords.some(k => k.competitor);
                const total = (a.metrics.queries as number | null) ?? a.keywords.length;
                return (
                  <>
                    <h4>Queries <span className="muted">({total})</span></h4>
                    <table className="mini">
                      <thead><tr><th>Query</th><th>Best page</th><th className="num">Sim.</th>{hasVol && <th className="num">Vol.</th>}{hasComp && <th>Best competitor</th>}</tr></thead>
                      <tbody>
                        {a.keywords.slice(0, 25).map((k, i) => (
                          <tr key={i}>
                            <td>{k.keyword}</td>
                            <td className="url" title={k.best_url}>{shortUrl(k.best_url)}{k.runner_up_url ? <span className="muted"> vs {shortUrl(k.runner_up_url)}</span> : null}</td>
                            <td className="num"><span className="band-dot" style={{ background: BAND_COLOR[k.band] }} title={k.band} />{fmt(k.similarity)}</td>
                            {hasVol && <td className="num">{k.volume ?? '—'}</td>}
                            {hasComp && <td className="url" title={k.competitor?.url}>{k.competitor ? <>{fmt(k.competitor.similarity)} <span className="muted">{shortUrl(k.competitor.url)}</span></> : '—'}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {total > 25 && <p className="muted small">Showing 25 of {total}. The Markdown export lists {Math.min(total, a.keywords.length)}.</p>}
                  </>
                );
              })()}
              {a.links.length > 0 && (
                <>
                  <h4>Links</h4>
                  <table className="mini">
                    <thead><tr><th>From</th><th>To</th><th>Anchor</th><th className="num">Sim.</th>{a.type === 'internal_link' && <th></th>}</tr></thead>
                    <tbody>
                      {a.links.map((l, i) => {
                        const k = `${l.source_url}→${l.target_url}`;
                        const pl = placements[k];
                        return (
                          <tr key={i}>
                            <td className="url" title={l.source_url}>{shortUrl(l.source_url)}{pl && <div className="placement"><b>{pl.advice}</b><div>“{pl.sentence}”</div></div>}</td>
                            <td className="url" title={l.target_url}>{shortUrl(l.target_url)}</td>
                            <td>{l.anchor || '—'}</td>
                            <td className="num">{fmt(l.similarity)}</td>
                            {a.type === 'internal_link' && (
                              <td><button className="link-btn" disabled={placing === k} onClick={() => place(l.source_url, l.target_url, l.anchor)} title="Find the passage on the source page where this link belongs">
                                {placing === k ? <Loader2 size={11} className="spinner" /> : <MapPin size={11} />} where?</button></td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
              {!a.keywords.length && !a.links.length && a.urls.length > 0 && (
                <>
                  <h4>Pages</h4>
                  <ul className="act-urls">{a.urls.map(u => <li key={u}><a href={u} target="_blank" rel="noreferrer">{u}</a></li>)}</ul>
                </>
              )}
              {Object.keys(a.metrics).length > 0 && (
                <div className="act-metrics">
                  {Object.entries(a.metrics).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => (
                    <span key={k}>{k.replace(/_/g, ' ')}: <strong>{typeof v === 'number' && !Number.isInteger(v) ? fmt(v) : fmtInt(v as number)}</strong></span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Shared types + small helpers for the Action Plan and Relevance Lab.

export interface LabPayload {
  queries: string[];
  url?: string | null;
  compare_urls?: string[];
  autoRun?: boolean;
}

export interface KwEntry {
  keyword: string;
  similarity: number;
  volume: number | null;
  band: 'strong' | 'partial' | 'gap';
  best_url: string;
  competitor?: { url: string; name: string; similarity: number } | null;
  runner_up_url?: string;
  margin?: number;
}

export interface LinkEntry {
  source_url: string;
  source_title?: string;
  target_url: string;
  anchor: string;
  similarity: number;
}

export type ActionStatus = 'open' | 'doing' | 'done' | 'skipped';

export interface PlanAction {
  key: string;
  rank: number;
  type: string;
  variant?: string;
  type_label: string;
  title: string;
  why: string;
  steps: string[];
  impact: number;
  impact_label: 'high' | 'medium' | 'low';
  effort: 'low' | 'medium' | 'high';
  score: number;
  quick_win: boolean;
  status: ActionStatus;
  note: string;
  primary_url?: string;
  urls: string[];
  keywords: KwEntry[];
  links: LinkEntry[];
  metrics: Record<string, number | null>;
  lab: LabPayload;
}

export interface Thresholds {
  strong: number;
  gap: number;
  cannibal_margin: number;
  dup: number;
  cluster: number;
  link_min: number;
  weak_link: number;
  basis?: string;
}

export interface VectorHealth {
  source: string;
  models: Record<string, number>;
  active_model: string;
  legacy: boolean;
  mixed: boolean;
  foreign: boolean;
  needs_reembed: boolean;
  pages_without_vectors: number;
  message: string;
}

export interface ActionPlanData {
  thresholds: Thresholds;
  defaults: Thresholds;
  vector_health: VectorHealth;
  link_graph_loaded: boolean;
  blockers: string[];
  summary: {
    pages: number;
    keywords: number;
    competitor_pages: number;
    has_volume: boolean;
    coverage: Record<'strong' | 'partial' | 'gap', { count: number; volume: number }> | null;
    by_type: Record<string, Record<ActionStatus, number>>;
    open: number;
    done: number;
    quick_wins: number;
  };
  histogram: { edges: number[]; counts: number[]; volume: number[] } | null;
  actions: PlanAction[];
}

export const BAND_COLOR: Record<string, string> = {
  strong: '#10b981',
  partial: '#f59e0b',
  gap: '#ef4444',
  covered: '#10b981',
  missing: '#ef4444',
};

export const TYPE_COLOR: Record<string, string> = {
  create: '#a78bfa',
  expand: '#a78bfa',
  optimize: '#60a5fa',
  cannibalization: '#fb923c',
  consolidate: '#fb923c',
  internal_link: '#34d399',
  weak_link: '#34d399',
  prune: '#94a3b8',
  competitor_gap: '#f472b6',
};

export const TYPE_ORDER = ['create', 'optimize', 'cannibalization', 'consolidate', 'internal_link', 'weak_link', 'prune', 'competitor_gap'];
export const TYPE_NAME: Record<string, string> = {
  create: 'Create / expand',
  optimize: 'Optimize',
  cannibalization: 'De-cannibalize',
  consolidate: 'Consolidate',
  internal_link: 'Internal links',
  weak_link: 'Fix links',
  prune: 'Prune / refocus',
  competitor_gap: 'Competitor gaps',
};

export function shortUrl(u?: string | null): string {
  if (!u) return '';
  try {
    const p = new URL(u);
    return (p.pathname || '/') + (p.search || '');
  } catch {
    return u;
  }
}

export const fmt = (n: number | null | undefined, d = 3) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—';

export const fmtInt = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString() : '—';

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Sequential scale for similarity heat cells: slate -> sky.
export function heatColor(score: number, lo: number, hi: number): string {
  const t = Math.max(0, Math.min(1, (score - lo) / Math.max(1e-6, hi - lo)));
  const from = [30, 41, 59];
  const to = [56, 189, 248];
  const c = from.map((f, i) => Math.round(f + (to[i] - f) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function verdictOf(score: number, th: { strong: number; gap: number }): 'covered' | 'partial' | 'missing' {
  return score >= th.strong ? 'covered' : score >= th.gap ? 'partial' : 'missing';
}

export function actionToMarkdown(a: PlanAction, i?: number): string {
  const lines: string[] = [];
  lines.push(`## ${i !== undefined ? `${i}. ` : ''}${a.title}`);
  lines.push('');
  lines.push(`**Type:** ${a.type_label} · **Impact:** ${a.impact_label} (${a.impact}) · **Effort:** ${a.effort} · **Status:** ${a.status}`);
  if (a.primary_url) lines.push(`**Page:** ${a.primary_url}`);
  lines.push('');
  lines.push(a.why);
  lines.push('');
  lines.push('**Steps**');
  a.steps.forEach((s, n) => lines.push(`${n + 1}. ${s}`));
  if (a.keywords.length) {
    lines.push('');
    lines.push('| Query | Similarity | Volume | Best page |');
    lines.push('|---|---|---|---|');
    a.keywords.forEach(k => lines.push(`| ${k.keyword} | ${fmt(k.similarity)} | ${k.volume ?? ''} | ${shortUrl(k.best_url)} |`));
  }
  if (a.links.length) {
    lines.push('');
    lines.push('| From | To | Anchor | Similarity |');
    lines.push('|---|---|---|---|');
    a.links.forEach(l => lines.push(`| ${l.source_url} | ${l.target_url} | ${l.anchor} | ${fmt(l.similarity)} |`));
  }
  if (a.note) {
    lines.push('');
    lines.push(`**Note:** ${a.note}`);
  }
  return lines.join('\n');
}

// Minimal CSV record reader for previewing uploads (handles quoted fields
// with commas/newlines, which Screaming Frog uses for embedding columns).
export function readCsvRecords(text: string, maxRecords = 2): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      out.push(row); row = [];
      if (out.length >= maxRecords) return out;
    } else field += ch;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out;
}

export function countVectorDims(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.replace(/[[\]()]/g, '').split(/[\s,;|]+/).filter(Boolean);
  return parts.every(p => !Number.isNaN(Number(p))) ? parts.length : 0;
}

// ---- Site structure (topic clusters + per-page diagnosis) -------------------
export interface Recommendation {
  verdict: string;
  severity: 'high' | 'medium' | 'low' | 'none';
  text: string;
  target_url?: string | null;
  action?: string;
}

export interface PageDiag {
  page_id: number;
  url: string;
  title: string;
  source_type: string;
  zone: 'Core' | 'Focus' | 'Expansion' | 'Peripheral';
  distance: number;
  percentile: number;
  cluster: number;
  cluster_label: string;
  is_hub: boolean;
  hub_url: string;
  fit: number;
  angle: number;
  x: number;
  y: number;
  neighbors: { url: string; title: string; similarity: number }[];
  queries: { keyword: string; similarity: number; band: 'strong' | 'partial' | 'gap'; volume: number | null }[];
  query_counts: { strong: number; partial: number };
  links: { inbound: number; outbound: number; inbound_avg_relevance: number | null; links_to_hub: boolean | null };
  recommendation: Recommendation;
}

export interface ClusterDiag {
  id: number;
  label: string;
  size: number;
  hub_url: string;
  hub_title: string;
  cohesion: number;
  x: number;
  y: number;
  angle_start: number;
  angle_end: number;
  angle_mid: number;
  zones: Record<string, number>;
  queries: { strong: number; partial: number; top: { keyword: string; similarity: number; band: string }[] };
  gap_queries: { count: number; volume: number; top: string[] };
  links: { within: number; density: number; spokes: number; spokes_to_hub: number; hub_to_spokes: number };
  pages: string[];
  recommendation: Recommendation;
}

export interface Structure {
  error?: string;
  dim: number;
  health: VectorHealth;
  thresholds: Thresholds;
  link_graph_loaded: boolean;
  fences: { q1: number; q2: number; q3: number; outlier: number };
  zone_counts: Record<string, number>;
  pages: PageDiag[];
  clusters: ClusterDiag[];
  summary: { pages: number; clusters: number; keywords: number; gap_queries: number };
}

export const ZONE_COLOR: Record<string, string> = {
  Core: '#10b981',
  Focus: '#3b82f6',
  Expansion: '#f59e0b',
  Peripheral: '#ef4444',
};

export const ZONE_HELP: Record<string, { what: string; todo: string }> = {
  Core: {
    what: 'Closest 25% of pages to the site\'s center of gravity.',
    todo: 'Your strongest topical assets. Keep them current and use them as link sources for weaker pages in the same topic.',
  },
  Focus: {
    what: 'The middle 50%: on-topic, supporting pages.',
    todo: 'Fine as they are. Work any Optimize actions and make sure each links to its topic hub.',
  },
  Expansion: {
    what: 'Beyond the 75th percentile but inside the outlier fence.',
    todo: 'Drifting. Pull them in with links from core pages in the same topic, or tighten them around the queries they serve.',
  },
  Peripheral: {
    what: 'Past the IQR outlier fence (Q3 + 1.5 × IQR).',
    todo: 'Off the site\'s main topics. Decide per page: support it (if it serves queries), merge it into a neighbor, or prune it.',
  },
};

export const SEVERITY_COLOR: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#60a5fa', none: '#64748b' };

// Categorical palette for topic identity (validated dark-mode reference order).
// Only the 7 largest topics get a hue; the rest fold into neutral "Other" so no
// generated hues appear. Identity is also carried by labels/legends, never color alone.
export const CLUSTER_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'];
export const clusterColor = (rank: number) => (rank < CLUSTER_COLORS.length ? CLUSTER_COLORS[rank] : '#64748b');

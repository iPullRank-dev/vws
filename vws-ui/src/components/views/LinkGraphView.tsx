import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import ForceGraph2D from 'react-force-graph-2d';
import { Download, Loader2, MapPin, Search, X } from 'lucide-react';
import { API_BASE } from '../../config';
import { csvCell, downloadText, fmt, shortUrl } from '../../lib/vws';

type Band = 'relevant' | 'weak' | 'off_topic';
type Kind = 'editorial' | 'template' | 'sitewide';

interface GNode {
  id: number; url: string; path: string; title: string; cluster: number; cluster_label: string; zone: string;
  x: number; y: number; pr: number; pr_rank: number; in_ctx: number; out_ctx: number; in_sitewide: number; in_template: number;
  archive: boolean; in_bands: Record<Band, number>; relevant_equity_share: number | null; sitewide_target: boolean; queries: number;
  backlinks?: number; backlink_domains?: number; backlinks_relevant?: number;
  backlink_value?: number; backlink_sim?: number | null; backlink_band?: Band | null;
  link_score?: { score: number | null; in: number | null; out: number | null; backlinks: number | null };
}
interface GEdge { s: number; t: number; sim: number; band: Band; kind: Kind; anchor: string; flow: number }
interface ExtLink {
  source: string; target: string; domain: string; anchor: string; sim: number | null; band: Band | null;
  dr?: number | null; nofollow?: boolean | null; spam?: boolean | null; in_content?: boolean | null; basis?: 'page' | 'context' | null;
  rd?: number | null; traffic?: number | null; kw?: number | null; vis?: 'traffic' | 'ranks' | 'none' | null;
  auth?: number; qual?: number | null; w?: number; better?: { url: string; sim: number } | null;
}
interface ExtDomain {
  domain: string; dr: number; links: number; followed?: number; spam?: number; auth?: number; qual?: number | null; value?: number;
  sim?: number | null; band?: Band | null; targets_total?: number; rd?: number | null; traffic?: number | null; kw?: number | null;
  targets: { t: number; sim: number | null; band: Band | null; links?: number; value?: number }[];
}
interface GraphData {
  error?: string;
  dim: number; own_host: string;
  nodes: GNode[]; edges: GEdge[];
  external: {
    inbound: ExtLink[]; outbound: ExtLink[]; inbound_summary: ExtSummary; outbound_summary: ExtSummary;
    by_target?: Record<string, ExtLink[]>; domains?: ExtDomain[];
    uncrawled?: { url: string; backlinks: number; domains: number }[]; uncrawled_summary?: { targets: number; backlinks: number };
  };
  cutoffs: { relevant: number; off_topic: number; baseline: number };
  score: {
    value: number | null; weighted_sim: number | null; ideal_sim: number | null; baseline_sim: number;
    internal_value?: number | null;
    backlinks?: { value: number | null; weighted_sim?: number; baseline_sim?: number; ideal_sim?: number; links: number; domains?: number };
    links: number; sitewide_links: number; template_links: number; sitewide_targets: number;
    band_counts: Record<Band, number>; band_equity: Record<Band, number>; pages_without_relevant_inlinks: number; content_pages: number;
  };
  off_topic_links: { source: string; target: string | null; anchor?: string; sim: number; equity: number; block: number; targets?: string[]; anchors?: string[]; instead: { url: string; sim: number } | null }[];
  starved_pages: { url: string; title: string; in_ctx: number; relevant_in: number; relevant_equity_share: number | null; queries: number; pr_rank: number; sources: { url: string; sim: number }[] }[];
  topics: { id: number; label: string; size: number; links: number; within_topic: number; mean_sim: number; relevant: number }[];
  has_links: boolean;
}
interface ExtSummary {
  count: number; scored: number; domains: number; bands: Record<Band, number>; mean_sim: number | null;
  referring_pages?: number; dofollow?: number; spam?: number; basis?: { page: number; context: number }; relevant_authority_share?: number | null;
  relevant_value_share?: number | null; off_topic_value_share?: number | null; with_better_match?: number;
  visibility?: { traffic: number; ranks: number; none: number };
}

const BAND_LABEL: Record<Band, string> = { relevant: 'Relevant', weak: 'Weak', off_topic: 'Off-topic' };
const BAND_COLOR: Record<Band, string> = { relevant: '#38bdf8', weak: '#94a3b8', off_topic: '#f43f5e' };
const TOPIC_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'];
const SHARE_COLOR = { none: '#d95926', some: '#c98500', most: '#199e70', na: '#475569' };
const SCORE_COLOR = { high: '#199e70', mid: '#c98500', low: '#d95926', na: '#475569' };
const scoreKey = (v: number | null | undefined) => (v === null || v === undefined ? 'na' : v >= 60 ? 'high' : v >= 30 ? 'mid' : 'low');
function scoreLine(ls: GNode['link_score']) {
  if (!ls || ls.score === null) return 'Link relevance score: n/a (no scored links)';
  const parts = [ls.in != null ? `links in ${Math.round(ls.in)}` : null, ls.out != null ? `links out ${Math.round(ls.out)}` : null,
    ls.backlinks != null ? `backlinks ${Math.round(ls.backlinks)}` : null].filter(Boolean);
  return `<b>Link relevance score ${Math.round(ls.score)}/100</b> (${parts.join(' · ')})`;
}
const EXT_COLOR = '#cbd5e1';
// Diamond fill = search visibility of the domain's best linking page (traffic + keywords).
const QUAL_STOPS = ['#334155', '#64748b', '#a3a3a3', '#fde68a', '#fbbf24'];
function qualColor(q: number | null | undefined) {
  if (q === null || q === undefined) return EXT_COLOR;
  return QUAL_STOPS[Math.min(QUAL_STOPS.length - 1, Math.floor(Math.max(0, q) * QUAL_STOPS.length))];
}
function hashAngle(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h >>> 0) % 6283) / 1000;
}
const n0 = (v: number | null | undefined) => (v ? Math.round(v).toLocaleString() : '0');

interface Props {
  projectId: string;
  refreshKey: number;
  onSelect: (url: string) => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onLoaded?: (d: GraphData | null) => void;
}
export type { GraphData as LinkGraphData };

export default function LinkGraphView({ projectId, refreshKey, onSelect, notify, onLoaded }: Props) {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bands, setBands] = useState<Band[]>(['relevant', 'weak', 'off_topic']);
  const [kinds, setKinds] = useState<Kind[]>(['editorial']);
  const [showExt, setShowExt] = useState(true);
  const [colorBy, setColorBy] = useState<'topic' | 'share' | 'score'>('score');
  const [topic, setTopic] = useState<number | 'all'>('all');
  const [find, setFind] = useState('');
  const [sel, setSel] = useState<number | string | null>(null);
  const [hover, setHover] = useState<number | string | null>(null);
  const [placements, setPlacements] = useState<Record<string, any>>({});
  const [size, setSize] = useState({ w: 800, h: 620 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<any>(null);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    axios.get(`${API_BASE}/api/projects/${projectId}/link-graph`, { timeout: 600000 })
      .then(r => { if (!live) return; if (r.data.error) { setError(r.data.error); onLoaded?.(null); } else { setData(r.data); onLoaded?.(r.data); } })
      .catch(e => { if (live) setError(e?.response?.data?.detail || e?.message || 'Link graph failed.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, refreshKey]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: Math.max(480, Math.min(720, window.innerHeight - 260)) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  // Topic colors: the 7 biggest topics get a hue, the rest fold into grey.
  const topicColor = useMemo(() => {
    const m: Record<number, string> = {};
    if (!data) return m;
    const sizes = new Map<number, number>();
    data.nodes.forEach(n => sizes.set(n.cluster, (sizes.get(n.cluster) || 0) + 1));
    [...sizes.entries()].sort((a, b) => b[1] - a[1]).forEach(([c], i) => { m[c] = TOPIC_COLORS[i] || '#64748b'; });
    return m;
  }, [data]);

  // Nodes are created once per load so positions survive filter changes.
  const nodes = useMemo(() => {
    if (!data) return [] as any[];
    const xs = data.nodes.map(n => n.x), ys = data.nodes.map(n => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const own = data.nodes.map(n => {
      const ax = ((n.x - x0) / Math.max(1e-6, x1 - x0) - 0.5) * 900, ay = ((n.y - y0) / Math.max(1e-6, y1 - y0) - 0.5) * 600;
      return { ...n, kind: 'own', x: ax, y: ay, ax, ay };
    });
    // Each linking domain sits beside the page it links to most (by link value),
    // farther out the less related it is: relevant links stay short, off-topic ones long.
    const lo = data.cutoffs.off_topic, hi = data.cutoffs.relevant;
    const rel01 = (sim: number | null | undefined) => (sim === null || sim === undefined ? 0.5 : Math.max(0, Math.min(1, (sim - lo) / Math.max(1e-6, hi - lo))));
    const ext = new Map<string, any>();
    (data.external.domains || []).forEach(d => {
      const tg = d.targets[0];
      const home = tg ? own[tg.t] : null;
      const hx = home?.ax ?? 0, hy = home?.ay ?? 0;
      const len = Math.hypot(hx, hy);
      const ang = (len > 40 ? Math.atan2(hy, hx) : hashAngle(d.domain)) + (hashAngle(d.domain + '#') - Math.PI) * 0.35;
      const dist = 45 + 200 * (1 - rel01(tg?.sim ?? d.sim));
      const ax = hx + Math.cos(ang) * dist, ay = hy + Math.sin(ang) * dist;
      ext.set(d.domain, { id: `in:${d.domain}`, kind: 'ext_in', url: `https://${d.domain}`, path: d.domain, domain: d.domain, title: d.domain,
        dr: d.dr, links: d.links, auth: d.auth ?? (d.dr || 0) / 100, qual: d.qual, sim: d.sim, band: d.band, value: d.value,
        targets_total: d.targets_total, x: ax, y: ay, ax, ay });
    });
    const outDom = new Map<string, any>();
    data.external.outbound.forEach(l => { if (!outDom.has(l.domain)) outDom.set(l.domain, { id: `out:${l.domain}`, kind: 'ext_out', url: `https://${l.domain}`, path: l.domain, domain: l.domain, title: l.domain, ax: -520, ay: -340 + (outDom.size % 30) * 23 }); });
    return [...own, ...ext.values(), ...outDom.values()];
  }, [data]);
  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const graph = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const inTopic = (j: number) => topic === 'all' || data.nodes[j].cluster === topic;
    const links: any[] = data.edges
      .filter(e => kinds.includes(e.kind) && bands.includes(e.band) && (inTopic(e.s) || inTopic(e.t)))
      .map(e => ({ source: e.s, target: e.t, sim: e.sim, band: e.band, kind: e.kind, anchor: e.anchor }));
    if (showExt) {
      (data.external.domains || []).forEach(d => d.targets.slice(0, 8).forEach(tg => {
        if (inTopic(tg.t) && (!tg.band || bands.includes(tg.band))) links.push({ source: `in:${d.domain}`, target: tg.t, sim: tg.sim, band: tg.band, kind: 'ext_in', anchor: '', n: tg.links ?? 1 });
      }));
      data.external.outbound.forEach(l => {
        const s = data.nodes.findIndex(n => n.url === l.source);
        if (s >= 0 && inTopic(s)) links.push({ source: s, target: `out:${l.domain}`, sim: l.sim, band: l.band, kind: 'ext_out', anchor: l.anchor });
      });
    }
    const used = new Set<any>();
    links.forEach(l => { used.add(typeof l.source === 'object' ? l.source.id : l.source); used.add(typeof l.target === 'object' ? l.target.id : l.target); });
    const ns = nodes.filter(n => n.kind === 'own' ? (topic === 'all' || n.cluster === topic || used.has(n.id)) : used.has(n.id));
    return { nodes: ns, links };
  }, [data, nodes, bands, kinds, showExt, topic]);

  // Links touching the hovered / selected node stay bright; the rest dim.
  const focus = hover ?? sel;
  const linkTouches = (l: any, id: any) => (l.source?.id ?? l.source) === id || (l.target?.id ?? l.target) === id;
  const focusSet = useMemo(() => {
    if (focus === null) return null;
    const set = new Set<any>([focus]);
    graph.links.forEach((l: any) => {
      const a = l.source?.id ?? l.source, b = l.target?.id ?? l.target;
      if (a === focus) set.add(b);
      if (b === focus) set.add(a);
    });
    return set;
  }, [focus, graph]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force('charge')?.strength(-14).distanceMax(160);
    fg.d3Force('center', null);
    // Pull every page back toward its topic position (Topic Clusters layout); links only nudge it.
    let anchored: any[] = [];
    const anchor = (alpha: number) => {
      for (const n of anchored) {
        if (n.ax === undefined) continue;
        n.vx += (n.ax - n.x) * 0.09 * alpha;
        n.vy += (n.ay - n.y) * 0.09 * alpha;
      }
    };
    (anchor as any).initialize = (ns: any[]) => { anchored = ns; };
    fg.d3Force('anchor', anchor);
    fg.d3Force('link')?.distance((l: any) => (l.kind === 'editorial' ? 40 + 120 * (1 - (l.sim ?? 0.6)) : 120))
      .strength((l: any) => (l.kind === 'editorial' ? 0.06 : l.kind === 'template' ? 0.01 : l.kind === 'sitewide' || l.kind === 'ext_in' ? 0 : 0.03));
    fg.d3ReheatSimulation?.();
  }, [graph]);

  const placeLink = async (source: string, target: string, anchor = '') => {
    const key = `${source}→${target}`;
    setPlacements(p => ({ ...p, [key]: { loading: true } }));
    try {
      const r = await axios.post(`${API_BASE}/api/projects/${projectId}/link-placement`, { source_url: source, target_url: target, anchor }, { timeout: 300000 });
      setPlacements(p => ({ ...p, [key]: r.data }));
    } catch (e: any) {
      setPlacements(p => ({ ...p, [key]: { error: e?.message || 'Failed.' } }));
      notify('Could not find a placement.', 'error');
    }
  };
  const Placement = ({ source, target }: { source: string; target: string }) => {
    const pl = placements[`${source}→${target}`];
    if (!pl) return <button className="link-btn" onClick={e => { e.stopPropagation(); placeLink(source, target); }}><MapPin size={12} /> where?</button>;
    if (pl.loading) return <span className="muted small"><Loader2 size={12} className="spinner" /> finding the passage…</span>;
    if (pl.error) return <span className="neg small">{pl.error}</span>;
    return <div className="placement"><b>{pl.advice}</b>{pl.sentence && <div>“{pl.sentence}”</div>}</div>;
  };

  if (loading) return <div className="act-loading"><Loader2 className="spinner" size={22} /> Scoring every link…</div>;
  if (error) return <div className="act-error">{error}</div>;
  if (!data) return null;
  if (!data.has_links && !data.external.inbound.length) {
    return <div className="act-banner info"><span>No links loaded yet. Upload a Screaming Frog <b>All Inlinks</b> export (internal links) and, optionally, a backlinks export (external links) in Data Ingestion, then come back.</span></div>;
  }

  const sc = data.score;
  const selNode = sel !== null ? nodeById.get(sel) : null;
  const selOwn = selNode && selNode.kind === 'own' ? (selNode as GNode) : null;
  const selIn = selOwn ? data.edges.filter(e => e.t === selOwn.id && e.kind === 'editorial').sort((a, b) => b.sim - a.sim) : [];
  const selOut = selOwn ? data.edges.filter(e => e.s === selOwn.id && e.kind === 'editorial').sort((a, b) => a.sim - b.sim) : [];
  const selExtIn = selOwn ? (data.external.by_target?.[selOwn.url] || data.external.inbound.filter(l => l.target === selOwn.url)) : [];
  const selDomain = selNode && selNode.kind === 'ext_in' ? (data.external.domains || []).find(d => d.domain === selNode.domain) : null;
  const starvedSel = selOwn ? data.starved_pages.find(s => s.url === selOwn.url) : null;
  const maxPr = Math.max(...data.nodes.map(n => n.pr), 1e-9);
  const radius = (n: any) => (n.kind === 'own' ? 5 + 13 * Math.sqrt(n.pr / maxPr) : n.kind === 'ext_in' ? 2.5 + 7 * (n.auth ?? 0.3) : 4.5);
  const domainTip = (n: any) => {
    const d = (data.external.domains || []).find(x => x.domain === n.domain);
    if (!d) return '';
    const vis = d.traffic == null && d.kw == null ? '' : `<br/>Best linking page: ${n0(d.rd)} referring domains · ${n0(d.traffic)} visits/mo · ${n0(d.kw)} keywords`;
    return `DR ${Math.round(d.dr)}${vis}<br/>${d.links.toLocaleString()} backlink${d.links === 1 ? '' : 's'} to crawled pages (${d.followed ?? 0} followed${d.spam ? `, ${d.spam} spam` : ''}) → ${d.targets_total ?? d.targets.length} page${(d.targets_total ?? d.targets.length) === 1 ? '' : 's'}`
      + `<br/>Relevance to the pages it links to: ${d.sim != null ? `${d.sim.toFixed(3)} · ${BAND_LABEL[d.band as Band]}` : 'not scored'}`;
  };
  const shareKey = (n: any) => (n.relevant_equity_share === null ? 'na' : n.in_bands.relevant === 0 ? 'none' : n.relevant_equity_share < 0.5 ? 'some' : 'most');
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const extIn = data.external.inbound_summary, extOut = data.external.outbound_summary;

  const exportCsv = () => {
    const head = ['Type', 'Source', 'Target', 'Anchor', 'Similarity', 'Relevance', 'Equity share %'];
    const flowTotal = data.edges.filter(e => e.kind === 'editorial').reduce((s, e) => s + e.flow, 0) || 1;
    const lines = [
      ...data.edges.map(e => [e.kind, data.nodes[e.s].url, data.nodes[e.t].url, e.anchor, e.sim, BAND_LABEL[e.band], e.kind === 'editorial' ? ((e.flow * 100) / flowTotal).toFixed(3) : '']),
      ...data.external.inbound.map(l => [`backlink${l.dr != null ? ` (DR ${Math.round(l.dr)}, ${n0(l.rd)} ref. domains, ${n0(l.traffic)} visits, ${n0(l.kw)} keywords${l.nofollow ? ', nofollow' : ''}${l.spam ? ', spam' : ''}, value ${l.w ?? ''}, scored from ${l.basis === 'page' ? 'page' : 'title + context'}${l.better ? `, closer to ${l.better.url}` : ''})` : ''}`, l.source, l.target, l.anchor, l.sim ?? '', l.band ? BAND_LABEL[l.band] : 'not scored', '']),
      ...data.external.outbound.map(l => ['outbound', l.source, l.target, l.anchor, l.sim ?? '', l.band ? BAND_LABEL[l.band] : 'not scored', '']),
    ].map(r => r.map(csvCell).join(','));
    downloadText(`project_${projectId}_link_graph.csv`, [head.join(','), ...lines].join('\n'), 'text/csv');
  };

  return (
    <div className="view">
      <div className="howto">
        <strong>How to read this.</strong> Every link is scored by how related its two pages are (cosine similarity of their vectors), then
        banded against this site's own page pairs: <b style={{ color: BAND_COLOR.relevant }}>relevant</b> links connect pages more similar than
        85% of page pairs (≥ {fmt(data.cutoffs.relevant)}); <b style={{ color: BAND_COLOR.off_topic }}>off-topic</b> links connect pages less similar
        than a typical pair (&lt; {fmt(data.cutoffs.off_topic)}). Only <b>editorial</b> links are scored: nav/footer links ({sc.sitewide_links.toLocaleString()} links to {sc.sitewide_targets} pages)
        and template links from archives, bylines and category tags ({sc.template_links.toLocaleString()}) don't express topical choices.
        Link equity is PageRank over all internal links.
        {extIn.count > 0 && <> <b>Backlinks</b> are scored the same way: the similarity of the linking page to the page of yours it links to, banded with the same
          cut-offs. Each one also gets a <b>value</b> from the export: authority (the linking page's referring domains and its site's DR), quality (its search
          traffic and ranking keywords) and follow status; spam counts zero, and a domain counts once, at its strongest link.</>}
      </div>

      <div className="lg-tiles">
        <div className="lg-score">
          <span>Link relevance score</span>
          <strong>{sc.value === null ? '—' : Math.round(sc.value)}<small>/100</small></strong>
          <div className="lg-meter"><i style={{ width: `${sc.value ?? 0}%` }} /></div>
          {sc.backlinks?.value != null && sc.internal_value != null ? <>
            <div className="lg-sub">
              <span>Internal links</span><div className="lg-meter sm"><i style={{ width: `${sc.internal_value}%` }} /></div><b>{Math.round(sc.internal_value)}</b>
            </div>
            <div className="lg-sub">
              <span>Backlinks</span><div className="lg-meter sm"><i style={{ width: `${sc.backlinks.value}%` }} /></div><b>{Math.round(sc.backlinks.value)}</b>
            </div>
            <em>
              The average of the two. Internal: editorial links average <b>{fmt(sc.weighted_sim)}</b> similarity (weighted by equity) vs {fmt(sc.baseline_sim)} for
              random links and {fmt(sc.ideal_sim)} for each page's closest pages. Backlinks: linking pages average <b>{fmt(sc.backlinks.weighted_sim ?? null)}</b> similarity
              to the page they link to (weighted by link value, {sc.backlinks.domains?.toLocaleString()} domains) vs {fmt(sc.backlinks.baseline_sim ?? null)} if they linked
              a random page of yours and {fmt(sc.backlinks.ideal_sim ?? null)} if each linked its most related page. 0 = no better than random, 100 = ideal.
            </em>
          </> : <em>
            Editorial links average <b>{fmt(sc.weighted_sim)}</b> similarity (weighted by equity). Random linking would give {fmt(sc.baseline_sim)};
            linking each page to its closest pages would give {fmt(sc.ideal_sim)}. 0 = no better than random, 100 = every link goes to the most related pages.
            {extIn.count === 0 ? ' Load a backlinks export to add backlinks to the score.' : ''}
          </em>}
        </div>
        <div className="lg-tile">
          <span>{sc.links.toLocaleString()} editorial links</span>
          <div className="lg-bar">{(['relevant', 'weak', 'off_topic'] as Band[]).map(b => sc.band_counts[b] > 0 &&
            <i key={b} style={{ width: `${(sc.band_counts[b] / Math.max(1, sc.links)) * 100}%`, background: BAND_COLOR[b] }} title={`${BAND_LABEL[b]}: ${sc.band_counts[b]}`} />)}</div>
          <em>{(['relevant', 'weak', 'off_topic'] as Band[]).map(b => `${BAND_LABEL[b]} ${sc.band_counts[b]}`).join(' · ')}</em>
          <span style={{ marginTop: '0.35rem' }}>Equity they carry</span>
          <div className="lg-bar">{(['relevant', 'weak', 'off_topic'] as Band[]).map(b => sc.band_equity[b] > 0 &&
            <i key={b} style={{ width: `${sc.band_equity[b] * 100}%`, background: BAND_COLOR[b] }} title={`${BAND_LABEL[b]}: ${pct(sc.band_equity[b])}`} />)}</div>
          <em>{(['relevant', 'weak', 'off_topic'] as Band[]).map(b => `${BAND_LABEL[b]} ${pct(sc.band_equity[b])}`).join(' · ')}</em>
        </div>
        <div className="lg-tile">
          <span>Content pages with no relevant editorial link in</span>
          <strong>{sc.pages_without_relevant_inlinks}<small> of {sc.content_pages}</small></strong>
          <em>They only get equity through nav, templates or unrelated pages. The list below starts with the ones that matter most.</em>
        </div>
        <div className="lg-tile">
          <span>Backlinks</span>
          {extIn.count || data.external.uncrawled_summary?.backlinks ? <>
            <strong>{extIn.count.toLocaleString()}<small> to crawled pages · {extIn.domains.toLocaleString()} domains</small></strong>
            {typeof extIn.relevant_value_share === 'number' && <>
              <div className="lg-bar">
                <i style={{ width: `${extIn.relevant_value_share * 100}%`, background: BAND_COLOR.relevant }} title={`Relevant: ${pct(extIn.relevant_value_share)} of value`} />
                <i style={{ width: `${Math.max(0, 1 - extIn.relevant_value_share - (extIn.off_topic_value_share ?? 0)) * 100}%`, background: BAND_COLOR.weak }} />
                <i style={{ width: `${(extIn.off_topic_value_share ?? 0) * 100}%`, background: BAND_COLOR.off_topic }} title={`Off-topic: ${pct(extIn.off_topic_value_share ?? 0)} of value`} />
              </div>
              <em><b>{pct(extIn.relevant_value_share)}</b> of backlink value comes from relevant pages · {pct(extIn.off_topic_value_share ?? 0)} from off-topic ones
                ({extIn.scored ? `by count: ${pct(extIn.bands.relevant / extIn.scored)} relevant` : 'none scored yet'})</em>
            </>}
            {extIn.visibility && <em>Linking pages with search traffic: {extIn.visibility.traffic.toLocaleString()} · ranking without traffic: {extIn.visibility.ranks.toLocaleString()} · no visibility: {extIn.visibility.none.toLocaleString()}</em>}
            {data.external.uncrawled_summary?.backlinks ? <em className="lg-warn">{data.external.uncrawled_summary.backlinks.toLocaleString()} more point to {data.external.uncrawled_summary.targets.toLocaleString()} of your URLs that aren't in this crawl (list below).</em> : null}
          </> : <em>None loaded. Upload a backlinks export (Ahrefs, Semrush, GSC) under Data Ingestion to score them here.</em>}
          {extOut.count > 0 && <em>Outbound: {extOut.count.toLocaleString()} links to {extOut.domains} domains</em>}
        </div>
      </div>

      <div className="lg-main">
        <div className="view-plot lg-graph" ref={wrapRef}>
          <div className="lg-controls">
            <div className="chips">
              {(['relevant', 'weak', 'off_topic'] as Band[]).map(b => (
                <button key={b} className={`chip ${bands.includes(b) ? 'on' : ''}`} onClick={() => setBands(x => x.includes(b) ? x.filter(y => y !== b) : [...x, b])}>
                  <i className="lg-line" style={{ background: BAND_COLOR[b] }} />{BAND_LABEL[b]}
                </button>
              ))}
              <span className="lg-sep" />
              {(['template', 'sitewide'] as Kind[]).map(k => (
                <button key={k} className={`chip ${kinds.includes(k) ? 'on' : ''}`} onClick={() => setKinds(x => x.includes(k) ? x.filter(y => y !== k) : [...x, k])}
                  title={k === 'sitewide' ? 'Nav and footer links: hidden by default' : 'Links from archives, bylines and category tags: hidden by default'}>
                  {k === 'sitewide' ? 'Nav/footer' : 'Template'}
                </button>
              ))}
              {(extIn.count > 0 || extOut.count > 0) && (
                <button className={`chip ${showExt ? 'on' : ''}`} onClick={() => setShowExt(v => !v)}>External</button>
              )}
            </div>
            <select className="ptable-sel" value={colorBy} onChange={e => setColorBy(e.target.value as any)}>
              <option value="score">Color pages by: link relevance score</option>
              <option value="share">Color pages by: relevant links in</option>
              <option value="topic">Color pages by: topic</option>
            </select>
            <select className="ptable-sel" value={String(topic)} onChange={e => setTopic(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">All topics</option>
              {[...new Map(data.nodes.map(n => [n.cluster, n.cluster_label])).entries()].map(([c, l]) => <option key={c} value={c}>{l}</option>)}
            </select>
            <div className="act-search lg-find"><Search size={13} />
              <input value={find} onChange={e => setFind(e.target.value)} placeholder="Find a page…" list="lg-pages"
                onKeyDown={e => {
                  if (e.key !== 'Enter') return;
                  const q = find.trim().toLowerCase();
                  const n = nodes.find(x => x.kind === 'own' && (x.path.toLowerCase().includes(q) || (x.title || '').toLowerCase().includes(q)));
                  if (n) { setSel(n.id); fgRef.current?.centerAt(n.x, n.y, 600); fgRef.current?.zoom(3, 600); }
                }} />
              <datalist id="lg-pages">{data.nodes.slice(0, 1500).map(n => <option key={n.id} value={n.path} />)}</datalist>
            </div>
          </div>
          <ForceGraph2D
            ref={fgRef}
            width={size.w - 2}
            height={size.h}
            graphData={graph}
            backgroundColor="rgba(0,0,0,0)"
            cooldownTicks={180}
            onEngineStop={() => { if (!(fgRef.current as any)?.__fitted) { fgRef.current?.zoomToFit(400, 40); (fgRef.current as any).__fitted = true; } }}
            nodeRelSize={4}
            nodeLabel={(n: any) => n.kind === 'own'
              ? `<div class="lg-tip"><b>${escapeHtml(n.title || n.path)}</b><br/>${escapeHtml(n.path)}<br/>${scoreLine(n.link_score)}<br/>${escapeHtml(n.cluster_label)} · ${n.zone}<br/>PageRank #${n.pr_rank} · editorial links in ${n.in_ctx} (${n.in_bands.relevant} relevant) · out ${n.out_ctx}${n.relevant_equity_share !== null ? `<br/>${Math.round(n.relevant_equity_share * 100)}% of editorial equity in comes over relevant links` : ''}${n.backlinks ? `<br/>${n.backlinks.toLocaleString()} backlinks from ${n.backlink_domains} domains · relevance to this page ${n.backlink_sim != null ? `${Number(n.backlink_sim).toFixed(3)} (${BAND_LABEL[n.backlink_band as Band] ?? '—'})` : 'n/a'}` : ''}</div>`
              : `<div class="lg-tip"><b>${escapeHtml(n.domain)}</b><br/>${n.kind === 'ext_in' ? domainTip(n) : 'outbound links to this domain'}</div>`}
            nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, scale: number) => {
              const r = radius(n);
              const dim = focusSet !== null && !focusSet.has(n.id);
              ctx.globalAlpha = dim ? 0.25 : 1;
              if (n.kind === 'own') {
                ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = colorBy === 'topic' ? (topicColor[n.cluster] || '#64748b') : colorBy === 'score' ? SCORE_COLOR[scoreKey(n.link_score?.score)]
                  : SHARE_COLOR[shareKey(n) as keyof typeof SHARE_COLOR];
                ctx.fill();
                ctx.lineWidth = n.id === sel ? 2.5 / scale + 1 : 0.8; ctx.strokeStyle = n.id === sel ? '#f8fafc' : '#0f172a'; ctx.stroke();
              } else {
                ctx.beginPath(); ctx.moveTo(n.x, n.y - r); ctx.lineTo(n.x + r, n.y); ctx.lineTo(n.x, n.y + r); ctx.lineTo(n.x - r, n.y); ctx.closePath();
                ctx.fillStyle = n.kind === 'ext_in' ? qualColor(n.qual) : EXT_COLOR; ctx.fill();
                if (n.kind === 'ext_in') {
                  ctx.lineWidth = n.id === sel ? 2.5 / scale + 1 : 1.3;
                  ctx.strokeStyle = n.id === sel ? '#f8fafc' : n.band ? BAND_COLOR[n.band as Band] : '#475569'; ctx.stroke();
                }
              }
              ctx.globalAlpha = 1;
            }}
            nodePointerAreaPaint={(n: any, color: string, ctx: CanvasRenderingContext2D) => {
              const r = radius(n) + 2;
              ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fill();
            }}
            linkColor={(l: any) => {
              const base = l.band ? BAND_COLOR[l.band as Band] : '#94a3b8';
              const a = focus !== null ? (linkTouches(l, focus) ? 0.95 : 0.04) : l.kind === 'editorial' || l.kind === 'ext_in' ? 0.5 : l.kind === 'template' ? 0.16 : 0.06;
              return hexA(base, a);
            }}
            linkWidth={(l: any) => (focus !== null && linkTouches(l, focus) ? 1.8 : l.kind === 'editorial' ? 0.9 : 0.5)}
            linkLineDash={(l: any) => (l.kind === 'ext_in' || l.kind === 'ext_out' ? [3, 2] : null)}
            linkDirectionalArrowLength={(l: any) => (focus !== null && linkTouches(l, focus) ? 4 : 0)}
            linkDirectionalArrowRelPos={0.92}
            linkLabel={(l: any) => `<div class="lg-tip">${escapeHtml(l.source?.path || '')} → ${escapeHtml(l.target?.path || '')}<br/>${l.kind}${l.sim !== null && l.sim !== undefined ? ` · similarity ${Number(l.sim).toFixed(3)} · ${BAND_LABEL[l.band as Band]}` : ' · not scored'}${l.anchor ? `<br/>anchor: “${escapeHtml(l.anchor)}”` : ''}</div>`}
            onRenderFramePost={(ctx: CanvasRenderingContext2D, scale: number) => {
              // Labels last, so no dot covers them.
              const fs = Math.max(2.5, 11 / scale);
              ctx.font = `${fs}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center';
              for (const n of graph.nodes as any[]) {
                if (n.x === undefined) continue;
                const show = n.id === sel || n.id === hover || (n.kind === 'own' && n.pr_rank <= 6) || scale > 3.2;
                if (!show || (focusSet !== null && !focusSet.has(n.id) && scale <= 3.2)) continue;
                const label = n.kind === 'own' ? n.path : n.domain;
                const y = n.y + radius(n) + fs + 1;
                ctx.lineWidth = 3 / scale; ctx.strokeStyle = 'rgba(15, 23, 42, 0.9)'; ctx.strokeText(label, n.x, y);
                ctx.fillStyle = n.id === sel || n.id === hover ? '#f8fafc' : '#cbd5e1'; ctx.fillText(label, n.x, y);
              }
            }}
            onNodeHover={(n: any) => setHover(n ? n.id : null)}
            onNodeClick={(n: any) => setSel(n.id)}
            onBackgroundClick={() => setSel(null)}
          />
          <div className="legend-row">
            {colorBy === 'score' ? <>
              <span><i style={{ background: SCORE_COLOR.high }} />Link relevance score 60+</span>
              <span><i style={{ background: SCORE_COLOR.mid }} />30-59</span>
              <span><i style={{ background: SCORE_COLOR.low }} />Under 30</span>
              <span><i style={{ background: SCORE_COLOR.na }} />No scored links</span>
            </> : colorBy === 'share' ? <>
              <span><i style={{ background: SHARE_COLOR.most }} />Most equity in comes over relevant links</span>
              <span><i style={{ background: SHARE_COLOR.some }} />Some</span>
              <span><i style={{ background: SHARE_COLOR.none }} />No relevant editorial link in</span>
              <span><i style={{ background: SHARE_COLOR.na }} />No editorial links in</span>
            </> : <span className="muted">Pages colored by topic (7 largest; the rest grey)</span>}
            {extOut.count > 0 && extIn.count === 0 && <span><i style={{ background: EXT_COLOR, borderRadius: 1, transform: 'rotate(45deg)' }} />External domain</span>}
            <span className="muted">Size = PageRank · lines = links, colored by relevance</span>
          </div>
          {extIn.count > 0 && <div className="legend-row">
            <span>◆ Linking domain, placed beside the page it links to most (farther out = less related) · size = authority · outline = relevance to the pages it links to · fill = search visibility of its best linking page:</span>
            <span><i className="lg-q" style={{ background: QUAL_STOPS[0] }} />none</span>
            <span><i className="lg-q" style={{ background: QUAL_STOPS[2] }} />some</span>
            <span><i className="lg-q" style={{ background: QUAL_STOPS[4] }} />strong traffic + keywords</span>
          </div>}
        </div>

        <div className="cluster-detail lg-side">
          {selOwn ? (
            <>
              <div className="lg-side-head">
                <h3>{selOwn.title || selOwn.path}</h3>
                <button className="icon-btn" onClick={() => setSel(null)} title="Close"><X size={13} /></button>
              </div>
              <div className="muted small">{selOwn.path}</div>
              <div className="kv" style={{ marginTop: '0.5rem' }}>
                <span>Link relevance score</span><span>{selOwn.link_score?.score != null
                  ? <><b>{Math.round(selOwn.link_score.score)}</b>/100 <span className="muted">({[selOwn.link_score.in != null ? `in ${Math.round(selOwn.link_score.in)}` : null,
                    selOwn.link_score.out != null ? `out ${Math.round(selOwn.link_score.out)}` : null,
                    selOwn.link_score.backlinks != null ? `backlinks ${Math.round(selOwn.link_score.backlinks)}` : null].filter(Boolean).join(' · ')})</span></> : '—'}</span>
                <span>Topic</span><span>{selOwn.cluster_label}</span>
                <span>PageRank</span><span>#{selOwn.pr_rank} of {data.nodes.length}</span>
                <span>Editorial links in</span><span>{selOwn.in_ctx} · {selOwn.in_bands.relevant} relevant, {selOwn.in_bands.weak} weak, {selOwn.in_bands.off_topic} off-topic</span>
                <span>Relevant equity in</span><span>{selOwn.relevant_equity_share === null ? '—' : pct(selOwn.relevant_equity_share)}</span>
                <span>Other links in</span><span>{selOwn.in_sitewide} nav/footer · {selOwn.in_template} template</span>
                {!!selOwn.backlinks && <>
                  <span>Backlinks in</span><span>{selOwn.backlinks.toLocaleString()} from {selOwn.backlink_domains} domains</span>
                  <span>Backlink relevance</span><span style={{ color: selOwn.backlink_band ? BAND_COLOR[selOwn.backlink_band] : undefined }}>
                    {selOwn.backlink_sim != null ? `${fmt(selOwn.backlink_sim)} · ${BAND_LABEL[selOwn.backlink_band as Band]}` : '—'}</span>
                </>}
              </div>
              {!!selOwn.backlinks && <div className="muted small">Backlink relevance: how similar the linking pages are to this page, weighted by each link's value.</div>}
              <div className="act-buttons"><button className="btn-secondary" onClick={() => onSelect(selOwn.url)}>Page details</button></div>
              {starvedSel && starvedSel.sources.length > 0 && <>
                <h4>Add links from (most related pages not linking here)</h4>
                <ul className="drawer-list">{starvedSel.sources.map(s => (
                  <li key={s.url} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}><span className="ellip">{shortUrl(s.url)}</span><span className="mono muted">{fmt(s.sim)}</span></div>
                    <Placement source={s.url} target={selOwn.url} />
                  </li>))}</ul>
              </>}
              <h4>Editorial links in ({selIn.length})</h4>
              <ul className="drawer-list">{selIn.slice(0, 25).map((e, i) => (
                <li key={i}><button className="link-btn" onClick={() => setSel(e.s)}>{data.nodes[e.s].path}</button><span className="mono" style={{ color: BAND_COLOR[e.band] }}>{fmt(e.sim)}</span></li>))}
                {!selIn.length && <li className="muted">None</li>}</ul>
              <h4>Editorial links out ({selOut.length}) · least related first</h4>
              <ul className="drawer-list">{selOut.slice(0, 25).map((e, i) => (
                <li key={i}><button className="link-btn" onClick={() => setSel(e.t)}>{data.nodes[e.t].path}</button><span className="mono" style={{ color: BAND_COLOR[e.band] }}>{fmt(e.sim)}</span></li>))}
                {!selOut.length && <li className="muted">None</li>}</ul>
              {selExtIn.length > 0 && <>
                <h4>Backlinks · most valuable first · relevance to this page</h4>
                <ul className="drawer-list">{selExtIn.slice(0, 25).map((l, i) => (
                  <li key={i} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <span className="ellip" title={`${l.source}${l.anchor ? `\n“${l.anchor}”` : ''}`}><i className="lg-q" style={{ background: qualColor(l.qual) }} />{l.dr != null && <span className="lg-dr">DR {Math.round(l.dr)}</span>}{l.domain}{shortUrl(l.source)}</span>
                      <span className="mono" style={{ color: l.band ? BAND_COLOR[l.band] : undefined }}>{l.sim !== null ? fmt(l.sim) : '—'}</span>
                    </div>
                    {l.better && <div className="muted lg-better">Closer to <button className="link-btn" onClick={() => { const j = data.nodes.findIndex(n => n.url === l.better!.url); if (j >= 0) setSel(j); }}>{shortUrl(l.better.url)}</button> ({fmt(l.better.sim)})</div>}
                  </li>))}</ul>
              </>}
            </>
          ) : selNode ? (
            <>
              <div className="lg-side-head"><h3>{selNode.domain}</h3><button className="icon-btn" onClick={() => setSel(null)}><X size={13} /></button></div>
              {selNode.kind !== 'ext_in' && <div className="muted small">Outbound links to this domain</div>}
              {selDomain && <>
                <div className="kv" style={{ marginTop: '0.5rem' }}>
                  <span>Domain rating</span><span>{Math.round(selDomain.dr)}</span>
                  <span>Best linking page</span><span>{n0(selDomain.rd)} referring domains · {n0(selDomain.traffic)} visits/mo · {n0(selDomain.kw)} keywords</span>
                  <span>Authority · quality</span><span>{Math.round((selDomain.auth ?? 0) * 100)} · {selDomain.qual == null ? '—' : Math.round(selDomain.qual * 100)} (of 100)</span>
                  <span>Backlinks</span><span>{selDomain.links.toLocaleString()} ({selDomain.followed ?? 0} followed{selDomain.spam ? `, ${selDomain.spam} spam` : ''})</span>
                  <span>Relevance</span><span style={{ color: selDomain.band ? BAND_COLOR[selDomain.band] : undefined }}>{selDomain.sim != null ? `${fmt(selDomain.sim)} · ${BAND_LABEL[selDomain.band as Band]}` : 'not scored'}</span>
                </div>
                <h4>Links to{(selDomain.targets_total ?? 0) > selDomain.targets.length ? ` (top ${selDomain.targets.length} of ${selDomain.targets_total})` : ''} · relevance to each page</h4>
                <ul className="drawer-list">{selDomain.targets.map(tg => (
                  <li key={tg.t}><button className="link-btn" onClick={() => setSel(tg.t)}>{data.nodes[tg.t].path}</button>
                    <span className="mono" style={{ color: tg.band ? BAND_COLOR[tg.band] : undefined }}>{(tg.links ?? 1) > 1 ? <span className="muted">{tg.links}× </span> : null}{tg.sim !== null ? fmt(tg.sim) : '—'}</span></li>))}</ul>
              </>}
            </>
          ) : (
            <div className="muted small">
              <p><b>Click a page</b> to see its links in and out with their relevance, and the most related pages that don't link to it yet.</p>
              <p>Hover a dot or a line for details. Each page shows its own <b>link relevance score</b> on the same 0-100 scale as the site: the average of its links in, its links out and its backlinks, each compared with random pages (0) and its most related pages (100).</p>
              <p>Drag to pan, scroll to zoom.</p>
            </div>
          )}
        </div>
      </div>

      <div className="ptable">
        <div className="ptable-bar">
          <h3>Off-topic links carrying the most equity</h3>
          <span className="muted small">Swap these for links to related pages: same source, a more relevant target.</span>
          <button className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={exportCsv}><Download size={13} /> All links CSV</button>
        </div>
        <table className="mini ptable-t" style={{ tableLayout: 'fixed' }}>
          <colgroup><col style={{ width: '25%' }} /><col style={{ width: '25%' }} /><col style={{ width: '8%' }} /><col style={{ width: '8%' }} /><col style={{ width: '34%' }} /></colgroup>
          <thead><tr><th>From</th><th>To</th><th className="num">Similarity</th><th className="num">Equity</th><th>Link this instead</th></tr></thead>
          <tbody>
            {data.off_topic_links.slice(0, 25).map((o, i) => (
              o.block ? (
                <tr key={i} onClick={() => setSel(data.nodes.findIndex(n => n.url === o.source))}>
                  <td className="url" title={o.source}><div className="ellip">{shortUrl(o.source)}</div></td>
                  <td><b>{o.block} off-topic links</b><div className="muted ellip" title={(o.targets || []).join('\n')}>{(o.anchors?.length ? o.anchors : (o.targets || []).map(shortUrl)).slice(0, 6).map(a => `“${a}”`).join(', ')}{o.block > 6 ? '…' : ''}</div></td>
                  <td className="num" style={{ color: BAND_COLOR.off_topic }}>{fmt(o.sim)}<div className="muted">avg</div></td>
                  <td className="num">{o.equity.toFixed(2)}%</td>
                  <td className="muted small">Looks like a menu or template block on this page. Fix the block once: trim it to the related pages, or move it out of the content area.</td>
                </tr>
              ) : (
                <tr key={i} onClick={() => setSel(data.nodes.findIndex(n => n.url === o.source))}>
                  <td className="url" title={o.source}><div className="ellip">{shortUrl(o.source)}</div>{o.anchor && <div className="muted ellip">“{o.anchor}”</div>}</td>
                  <td className="url" title={o.target || ''}><div className="ellip">{shortUrl(o.target)}</div></td>
                  <td className="num" style={{ color: BAND_COLOR.off_topic }}>{fmt(o.sim)}</td>
                  <td className="num">{o.equity.toFixed(2)}%</td>
                  <td>{o.instead ? <><span className="ellip">{shortUrl(o.instead.url)}</span> <span className="mono muted">{fmt(o.instead.sim)}</span><div><Placement source={o.source} target={o.instead.url} /></div></> : '—'}</td>
                </tr>
              )
            ))}
          </tbody>
        </table>
        {!data.off_topic_links.length && <p className="muted small" style={{ padding: '0.75rem' }}>No off-topic editorial links. Nice.</p>}
      </div>

      <div className="ptable">
        <div className="ptable-bar">
          <h3>Pages that need relevant links</h3>
          <span className="muted small">Pages that win queries or sit in your core, but get no (or little) equity over relevant editorial links.</span>
        </div>
        <table className="mini ptable-t" style={{ tableLayout: 'fixed' }}>
          <colgroup><col style={{ width: '30%' }} /><col style={{ width: '8%' }} /><col style={{ width: '12%' }} /><col style={{ width: '50%' }} /></colgroup>
          <thead><tr><th>Page</th><th className="num">Queries</th><th className="num">Relevant in</th><th>Add links from</th></tr></thead>
          <tbody>
            {data.starved_pages.slice(0, 25).map(p => (
              <tr key={p.url} onClick={() => setSel(data.nodes.findIndex(n => n.url === p.url))}>
                <td className="url" title={p.url}><div className="ellip" style={{ color: 'var(--text-main)' }}>{p.title}</div><div className="muted ellip">{shortUrl(p.url)}</div></td>
                <td className="num">{p.queries}</td>
                <td className="num">{p.relevant_in} of {p.in_ctx}<div className="muted">{p.relevant_equity_share === null ? 'no links' : `${pct(p.relevant_equity_share)} equity`}</div></td>
                <td>{p.sources.map(s => <div key={s.url} className="lg-src"><span className="ellip">{shortUrl(s.url)}</span> <span className="mono muted">{fmt(s.sim)}</span> <Placement source={s.url} target={p.url} /></div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.topics.length > 0 && (
        <div className="ptable">
          <div className="ptable-bar"><h3>Topics by link relevance</h3><span className="muted small">Editorial links out of each topic: how many stay inside it, and how many are relevant.</span></div>
          <table className="mini ptable-t">
            <thead><tr><th>Topic</th><th className="num">Pages</th><th className="num">Links out</th><th className="num">Stay in topic</th><th className="num">Relevant</th><th className="num">Mean similarity</th></tr></thead>
            <tbody>{data.topics.map(t => (
              <tr key={t.id} onClick={() => setTopic(t.id)}><td>{t.label}</td><td className="num">{t.size}</td><td className="num">{t.links}</td>
                <td className="num">{pct(t.within_topic)}</td><td className="num">{pct(t.relevant)}</td><td className="num">{fmt(t.mean_sim)}</td></tr>))}</tbody>
          </table>
        </div>
      )}

      {(data.external.uncrawled?.length ?? 0) > 0 && (
        <div className="ptable">
          <div className="ptable-bar">
            <h3>Your most-linked URLs that aren't in this crawl</h3>
            <span className="muted small">Backlinks point here, but the crawl didn't include these URLs, so they can't be scored or linked into the graph. Add them to the crawl (or raise the URL limit); if one is retired, 301 it to the closest live page.</span>
          </div>
          <table className="mini ptable-t" style={{ tableLayout: 'fixed' }}>
            <colgroup><col style={{ width: '70%' }} /><col style={{ width: '15%' }} /><col style={{ width: '15%' }} /></colgroup>
            <thead><tr><th>URL</th><th className="num">Referring domains</th><th className="num">Backlinks</th></tr></thead>
            <tbody>{data.external.uncrawled!.slice(0, 25).map(u => (
              <tr key={u.url}><td className="url"><div className="ellip" title={u.url}>{u.url}</div></td>
                <td className="num">{u.domains.toLocaleString()}</td><td className="num">{u.backlinks.toLocaleString()}</td></tr>))}</tbody>
          </table>
        </div>
      )}

      {extIn.count > 0 && <BacklinksTable rows={data.external.inbound} total={extIn.count} onPick={url => setSel(data.nodes.findIndex(n => n.url === url))} />}
    </div>
  );
}

function BacklinksTable({ rows, total, onPick }: { rows: ExtLink[]; total: number; onPick: (url: string) => void }) {
  const [bandF, setBandF] = useState<Band | 'all'>('all');
  const [follow, setFollow] = useState(false);
  const [visible, setVisible] = useState(false);
  const [better, setBetter] = useState(false);
  const [sort, setSort] = useState<'value' | 'rel' | 'rel_asc' | 'dr'>('value');
  const [limit, setLimit] = useState(60);
  const shown = useMemo(() => {
    const f = rows.filter(l => (bandF === 'all' || l.band === bandF) && (!follow || (l.nofollow === false && !l.spam))
      && (!visible || (l.vis && l.vis !== 'none')) && (!better || !!l.better));
    const key = (l: ExtLink) => sort === 'value' ? -(l.w ?? 0) : sort === 'rel' ? -(l.sim ?? -1) : sort === 'rel_asc' ? (l.sim ?? 9) : -(l.dr ?? 0);
    return [...f].sort((x, y) => key(x) - key(y));
  }, [rows, bandF, follow, visible, better, sort]);
  return (
    <div className="ptable">
      <div className="ptable-bar">
        <h3>Backlinks: value and relevance to the page they link to</h3>
        <span className="muted small">Relevance = similarity of the linking page to <b>your page it links to</b>. Value = authority × quality × follow{rows.length < total ? ` · top ${rows.length.toLocaleString()} of ${total.toLocaleString()} by value` : ''}.</span>
        <div className="chips" style={{ marginLeft: 'auto' }}>
          {(['all', 'relevant', 'weak', 'off_topic'] as const).map(b => (
            <button key={b} className={`chip ${bandF === b ? 'on' : ''}`} onClick={() => setBandF(b)}>
              {b === 'all' ? 'All' : <><i className="lg-line" style={{ background: BAND_COLOR[b] }} />{BAND_LABEL[b]}</>}
            </button>))}
          <button className={`chip ${follow ? 'on' : ''}`} onClick={() => setFollow(f => !f)} title="Followed links that the export doesn't flag as spam">Followed, not spam</button>
          <button className={`chip ${visible ? 'on' : ''}`} onClick={() => setVisible(f => !f)} title="Linking page has search traffic or ranking keywords">Has search visibility</button>
          <button className={`chip ${better ? 'on' : ''}`} onClick={() => setBetter(f => !f)} title="The linking page is closer to another page of yours">Better page exists</button>
          <select className="ptable-sel" value={sort} onChange={e => setSort(e.target.value as any)}>
            <option value="value">Sort: value</option>
            <option value="rel">Sort: most relevant</option>
            <option value="rel_asc">Sort: least relevant</option>
            <option value="dr">Sort: DR</option>
          </select>
        </div>
      </div>
      <table className="mini ptable-t" style={{ tableLayout: 'fixed' }}>
        <colgroup><col style={{ width: '27%' }} /><col style={{ width: '17%' }} /><col style={{ width: '11%' }} /><col style={{ width: '11%' }} /><col style={{ width: '7%' }} /><col style={{ width: '10%' }} /><col style={{ width: '17%' }} /></colgroup>
        <thead><tr>
          <th>From</th><th>To</th>
          <th title="Referring domains of the linking page and its site's DR">Authority</th>
          <th title="Search traffic and ranking keywords of the linking page">Quality</th>
          <th>Link</th>
          <th title="Similarity of the linking page to the page it links to">Relevance to target</th>
          <th title="Another page of yours the linking page is closer to">Better match</th>
        </tr></thead>
        <tbody>{shown.slice(0, limit).map((l, i) => (
          <tr key={i} onClick={() => onPick(l.target)}>
            <td className="url" title={l.source}><div className="ellip">{l.domain}{shortUrl(l.source)}</div>{l.anchor && <div className="muted ellip">“{l.anchor}”</div>}</td>
            <td className="url"><div className="ellip" title={l.target}>{shortUrl(l.target)}</div></td>
            <td className="small"><div>DR {l.dr != null ? Math.round(l.dr) : '—'}</div><div className="muted">{n0(l.rd)} ref. domains</div></td>
            <td className="small"><div><i className="lg-q" style={{ background: qualColor(l.qual) }} />{l.vis === 'traffic' ? `${n0(l.traffic)} visits` : l.vis === 'ranks' ? 'ranks, no traffic' : l.vis === 'none' ? 'no visibility' : '—'}</div>
              {l.vis && l.vis !== 'none' && <div className="muted">{n0(l.kw)} keywords</div>}</td>
            <td className="small">{l.spam ? <span className="neg">spam</span> : l.nofollow ? 'nofollow' : l.nofollow === false ? 'follow' : '—'}</td>
            <td><span className="mono">{l.sim !== null ? fmt(l.sim) : '—'}</span>{' '}
              {l.band ? <span style={{ color: BAND_COLOR[l.band] }}>{BAND_LABEL[l.band]}</span> : <span className="muted">not scored</span>}
              <div className="muted small" title={l.basis === 'context' ? 'Scored from the page title and the text around the link (not fetched)' : 'Scored from the fetched page'}>{l.basis === 'page' ? 'from page' : l.basis === 'context' ? 'from title + context' : ''}</div></td>
            <td className="url small">{l.better ? <><div className="ellip" title={l.better.url}>{shortUrl(l.better.url)}</div><div className="muted">{fmt(l.better.sim)}</div></> : <span className="muted">—</span>}</td>
          </tr>))}</tbody>
      </table>
      {shown.length > limit && <button className="btn-secondary act-more" onClick={() => setLimit(x => x + 100)}>Show more ({(shown.length - limit).toLocaleString()} left)</button>}
      {!shown.length && <p className="muted small" style={{ padding: '0.75rem' }}>No backlinks match.</p>}
    </div>
  );
}

function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function escapeHtml(s: string) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

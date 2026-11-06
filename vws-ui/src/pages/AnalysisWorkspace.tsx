import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, Upload, Loader2, Sparkles, FileDown, FileText, AlertTriangle, CheckCircle, TrendingUp, Target, Crosshair, FlaskConical, ListChecks, RefreshCw, Network } from 'lucide-react';
import { API_BASE } from '../config';
import { useToast } from '../hooks/useToast';
import './AnalysisWorkspace.css';

// Import visual components
import VisualMap3D from '../components/visuals/VisualMap3D';
import SiteFocusView from '../components/views/SiteFocusView';
import QueryBullseyeView from '../components/views/QueryBullseyeView';
import type { BullseyeCenter } from '../components/views/QueryBullseyeView';
import TopicClustersView from '../components/views/TopicClustersView';
import LinkHealthView from '../components/views/LinkHealthView';
import type { Health } from '../components/views/LinkHealthView';
import IntersectionView from '../components/views/IntersectionView';
import DriftView from '../components/views/DriftView';
import UploadsPanel from '../components/UploadsPanel';
import type { PendingUpload } from '../components/UploadsPanel';
import LinkGraphView from '../components/views/LinkGraphView';
import type { LinkGraphData } from '../components/views/LinkGraphView';
import type { DriftData } from '../components/views/DriftView';
import PageDrawer from '../components/views/PageDrawer';
import '../components/views/views.css';
import type { GhostPoint } from '../components/visuals/VisualMap3D';
import ActionPlan from '../components/ActionPlan';
import RelevanceLab from '../components/RelevanceLab';
import VectorSourcePicker, { DEFAULT_VECTOR_SOURCE, isVectorSourceValid } from '../components/VectorSourcePicker';
import type { VectorSourceValue } from '../components/VectorSourcePicker';
import type { LabPayload, PlanAction, Structure } from '../lib/vws';
import { shortUrl } from '../lib/vws';
import '../components/act.css';

// ---------------------------------------------------------------------------
// SEO-friendly view descriptions — tells users what each view means and what
// to look for, so they don't need to be data scientists to use the tool.
// ---------------------------------------------------------------------------
const VIEW_INFO: Record<string, { title: string; description: string }> = {
  actions: {
    title: 'Action Plan',
    description: 'Every finding from the vector analysis as a ranked task: what to create, which page to optimize for which queries, which pages cannibalize each other, which links to add (with anchors), and what to prune. Each task carries its evidence and opens in the Relevance Lab. Tune the thresholds against the histogram; status and notes are saved per project.',
  },
  lab: {
    title: 'Relevance Lab',
    description: 'Score a page passage by passage against a head query and its fan-out sub-queries with EmbeddingGemma 2. See which passages carry each query, which sub-queries nothing answers, and how a competitor compares. Edit a passage and re-score to test a rewrite before it ships.',
  },
  '3dmap': {
    title: '3D Topical Map',
    description: 'Every page, query and competitor page projected into three dimensions (PCA of the vectors). Color by topic, zone or dataset; click a page for its diagnosis. Type a query in "Locate a query" to drop its real embedding into the map and list the closest pages.',
  },
  bullseye: { title: 'Query Bullseye', description: '' },
  iqr_bullseye: { title: 'Site Focus', description: '' },
  external_links: { title: 'Backlink Relevance', description: '' },
  internal_matrix: { title: 'Internal Link Health', description: '' },
  link_graph: { title: 'Link Graph', description: '' },
  link_opportunities: {
    title: 'Link Opportunities',
    description: 'Internal links to add, grouped by the page that should receive them, with the anchor to use. Pages are prioritized when they are the best page for target queries that they don\'t yet clearly win. Expand a task and click "where?" on a link to find the passage on the source page where it belongs. Weak existing links are listed too.',
  },
  topic_map: { title: 'Topic Clusters', description: '' },
  topical_gaps: {
    title: 'Content Gaps',
    description: 'Target queries that no page on the site answers (best-page similarity below the gap line), grouped into topics so one page can cover several. "Expand" means the closest page is near enough to take a new section; "Create" means it needs its own page. Competitor pages with no counterpart on your site appear here too.',
  },
  intersection: { title: 'Intersection', description: '' },
  semantic_drift: { title: 'Semantic Drift', description: 'Pages wandering off their subject: checked against the site\'s center, their own topic and their own title. Separates drift you should fix from deliberate secondary topics.' },
};

// Matryoshka sizes: what changes vs 768-d on 1,000 iPR queries x 156 pages (Oct 2026 eval).
const DIM_TIP = 'Vectors are stored at 768 dims; smaller sizes keep the leading dims (Matryoshka) and re-normalize, so switching is instant. '
  + 'Measured against 768 on real iPR data — same best page: 512 86%, 256 68%, 128 49%; same Lab passage: 512 80%, 256 59%, 128 34%. '
  + 'Smaller sizes only pay off on very large sites.';
const DIM_NOTE: Record<number, string> = {
  512: 'Near-lossless for clear-cut decisions; changes 14% of near-tie best pages and 20% of Lab passage picks.',
  256: 'Lossy here: changes 32% of best pages (mostly near-ties) and 41% of Lab passage picks.',
  128: 'Very lossy: half of best-page decisions change. Only for exploratory views of huge sites.',
};

// Views that render their own "How to read this" panel.
const OWN_HOWTO = new Set(['bullseye', 'iqr_bullseye', 'topic_map', 'internal_matrix', 'external_links', 'intersection', 'semantic_drift', 'link_graph']);

// ---------------------------------------------------------------------------
// Helper: interpret a focus score for non-technical users
// ---------------------------------------------------------------------------
function interpretFocusScore(score: number): { label: string; color: string; advice: string } {
  if (score >= 0.85) return { label: 'Excellent', color: '#10b981', advice: 'Your content is tightly focused around core topics. Maintain this with strategic expansion.' };
  if (score >= 0.7) return { label: 'Good', color: '#10b981', advice: 'Solid topical focus. Look for peripheral pages that could be pruned or rewritten to tighten further.' };
  if (score >= 0.5) return { label: 'Moderate', color: '#f59e0b', advice: 'Your content is spreading across too many topics. Identify off-topic pages in the Semantic Drift view and consolidate.' };
  return { label: 'Fragmented', color: '#ef4444', advice: 'Your site lacks topical cohesion. Prioritize pruning drifted content and building internal links between related pages.' };
}

// ---------------------------------------------------------------------------
// Helper: interpret a match score (1 - distance) into plain-English priority.
// Higher = better match. Displayed as a percentage so SEOs think "coverage".
// ---------------------------------------------------------------------------
function matchPriority(matchScore: number): { label: string; color: string; action: string } {
  if (matchScore >= 0.8) return { label: 'Strong', color: '#10b981', action: 'Well-aligned — no action needed' };
  if (matchScore >= 0.6) return { label: 'Good', color: '#10b981', action: 'Minor optimization opportunity' };
  if (matchScore >= 0.4) return { label: 'Weak', color: '#f59e0b', action: 'Add internal links from core pages' };
  if (matchScore >= 0.2) return { label: 'Poor', color: '#ef4444', action: 'Needs content optimization' };
  return { label: 'No Match', color: '#ef4444', action: 'Create new content for this keyword' };
}

// --- Lightweight markdown renderer for AI Insights output -------------------
// Handles the subset of markdown Gemma produces: paragraphs, bullets (* or -),
// bold (**x**), italics (*x*), inline code (`x`), and ATX headings (# .. ######).
// Intentionally tiny so we don't pull in a markdown dependency.
function renderInlineMarkdown(text: string): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    // Order matters: match URL (bare or backticked) first so they get pill styling,
    // then `code`, then **bold**, then *italic* (single-asterisk must not be
    // followed by another asterisk so we don't gobble bold tokens).
    const URL_RE_SRC = "https?:\\/\\/[^\\s`)]+";
    const regex = new RegExp(
        `(\`${URL_RE_SRC}\`|${URL_RE_SRC}|\`[^\`\\n]+\`|\\*\\*[^*\\n]+\\*\\*|\\*(?!\\*)[^*\\n]+\\*)`,
        'g'
    );
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    const renderUrl = (url: string, k: number) => {
        // Trim trailing punctuation that's almost never part of the URL.
        const trimmed = url.replace(/[.,;:!?]+$/, '');
        const tail = url.slice(trimmed.length);
        return (
            <React.Fragment key={`u-${k}`}>
                <a
                    href={trimmed}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                        // Electron: prefer shell.openExternal via the renderer if wired up,
                        // otherwise let the default <a target=_blank> handler take over.
                        const anyWin = window as any;
                        if (anyWin.electron?.openExternal) {
                            e.preventDefault();
                            anyWin.electron.openExternal(trimmed);
                        }
                    }}
                    title={trimmed}
                    style={{
                        display: 'inline-block',
                        maxWidth: '100%',
                        verticalAlign: 'baseline',
                        background: 'rgba(56, 189, 248, 0.12)',
                        border: '1px solid rgba(56, 189, 248, 0.35)',
                        color: '#7dd3fc',
                        padding: '0.05rem 0.4rem',
                        borderRadius: '4px',
                        fontSize: '0.82em',
                        fontFamily: 'ui-monospace, Consolas, monospace',
                        textDecoration: 'none',
                        wordBreak: 'break-all',
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.22)';
                        e.currentTarget.style.color = '#bae6fd';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.12)';
                        e.currentTarget.style.color = '#7dd3fc';
                    }}
                >
                    {trimmed}
                </a>
                {tail}
            </React.Fragment>
        );
    };

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
        const tok = match[0];

        // `https://...`  → strip backticks, render as URL pill
        if (/^`https?:\/\//.test(tok) && tok.endsWith('`')) {
            nodes.push(renderUrl(tok.slice(1, -1), key++));
        } else if (/^https?:\/\//.test(tok)) {
            nodes.push(renderUrl(tok, key++));
        } else if (tok.startsWith('**')) {
            nodes.push(<strong key={`b-${key++}`}>{tok.slice(2, -2)}</strong>);
        } else if (tok.startsWith('`')) {
            nodes.push(
                <code
                    key={`c-${key++}`}
                    style={{
                        background: 'rgba(148, 163, 184, 0.18)',
                        padding: '0.1rem 0.35rem',
                        borderRadius: '4px',
                        fontSize: '0.85em',
                        fontFamily: 'ui-monospace, Consolas, monospace',
                    }}
                >
                    {tok.slice(1, -1)}
                </code>
            );
        } else {
            nodes.push(<em key={`i-${key++}`}>{tok.slice(1, -1)}</em>);
        }
        lastIndex = match.index + tok.length;
    }
    if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
    return nodes;
}

function renderMarkdown(text: string): React.ReactNode {
    // Gemma loves to wrap numbers in LaTeX math mode ($0.5985$, $$0.3$$, \( … \)).
    // None of that renders here, and it pollutes plain decimals. Strip the
    // delimiters but keep their contents.
    text = text
        .replace(/\$\$([^$\n]+?)\$\$/g, '$1')
        .replace(/\$([^$\n]+?)\$/g, '$1')
        .replace(/\\\((.+?)\\\)/g, '$1')
        .replace(/\\\[(.+?)\\\]/g, '$1');
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const blocks: React.ReactNode[] = [];
    let i = 0;
    let key = 0;
    const isBullet = (s: string) => /^[*\-]\s+/.test(s);
    const isHeading = (s: string) => /^#{1,6}\s+/.test(s);

    while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (!trimmed) { i++; continue; }

        if (isBullet(trimmed)) {
            const items: string[] = [];
            while (i < lines.length && isBullet(lines[i].trim())) {
                items.push(lines[i].trim().replace(/^[*\-]\s+/, ''));
                i++;
            }
            blocks.push(
                <ul
                    key={`ul-${key++}`}
                    style={{ margin: '0.4rem 0 0.6rem', paddingLeft: '1.1rem', listStyle: 'disc' }}
                >
                    {items.map((item, j) => {
                        // Split out "**Action:** …" (or "**Action**:") onto its own indented line
                        // with a lightning-bolt accent, so the recommendation reads as a distinct step.
                        const actionRe = /\s*\*\*Action\*\*:\s*|\s*\*\*Action:\*\*\s*/i;
                        const m = actionRe.exec(item);
                        if (m) {
                            const claim = item.slice(0, m.index).trim().replace(/[.;:]\s*$/, '');
                            const action = item.slice(m.index + m[0].length).trim();
                            return (
                                <li
                                    key={j}
                                    style={{
                                        marginBottom: '0.6rem',
                                        lineHeight: '1.5',
                                    }}
                                >
                                    <div>{renderInlineMarkdown(claim)}</div>
                                    <div
                                        style={{
                                            marginTop: '0.3rem',
                                            paddingLeft: '0.6rem',
                                            borderLeft: '2px solid rgba(56, 189, 248, 0.5)',
                                            color: '#cbd5e1',
                                            display: 'flex',
                                            alignItems: 'flex-start',
                                            gap: '0.4rem',
                                        }}
                                    >
                                        <span aria-hidden style={{ color: 'var(--accent)', flexShrink: 0 }}>⚡</span>
                                        <span>
                                            <strong style={{ color: 'var(--accent)' }}>Action: </strong>
                                            {renderInlineMarkdown(action)}
                                        </span>
                                    </div>
                                </li>
                            );
                        }
                        return (
                            <li key={j} style={{ marginBottom: '0.4rem', lineHeight: '1.5' }}>
                                {renderInlineMarkdown(item)}
                            </li>
                        );
                    })}
                </ul>
            );
            continue;
        }

        const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (h) {
            const level = h[1].length;
            const fontSize = level <= 2 ? '1.05rem' : '0.95rem';
            blocks.push(
                <div
                    key={`h-${key++}`}
                    style={{
                        fontSize,
                        fontWeight: 600,
                        margin: '0.75rem 0 0.35rem',
                        color: 'var(--accent)',
                    }}
                >
                    {renderInlineMarkdown(h[2])}
                </div>
            );
            i++;
            continue;
        }

        const para: string[] = [];
        while (
            i < lines.length &&
            lines[i].trim() &&
            !isBullet(lines[i].trim()) &&
            !isHeading(lines[i].trim())
        ) {
            para.push(lines[i].trim());
            i++;
        }
        blocks.push(
            <p key={`p-${key++}`} style={{ margin: '0.4rem 0', lineHeight: '1.55' }}>
                {renderInlineMarkdown(para.join(' '))}
            </p>
        );
    }
    return <>{blocks}</>;
}

// --- Markdown → HTML, used by the Word/Google-Doc exports -------------------
// Produces clean HTML mirroring what the in-app renderer shows. Kept separate
// from renderMarkdown() because the export needs plain HTML strings, not React.
function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function inlineMarkdownToHtml(text: string): string {
    const escaped = escapeHtml(text);
    return escaped
        // strip latex math wrappers
        .replace(/\$\$([^$\n]+?)\$\$/g, '$1')
        .replace(/\$([^$\n]+?)\$/g, '$1')
        // backtick URL → link
        .replace(/`(https?:\/\/[^\s`]+)`/g, '<a href="$1">$1</a>')
        // bare URL → link
        .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2">$2</a>')
        // bold
        .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
        // italic
        .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
        // inline code
        .replace(/`([^`\n]+?)`/g, '<code>$1</code>');
}

function markdownToHtml(text: string): string {
    // Strip LaTeX dollar wrappers at the source so they don't leak into bullets.
    text = text
        .replace(/\$\$([^$\n]+?)\$\$/g, '$1')
        .replace(/\$([^$\n]+?)\$/g, '$1')
        .replace(/\\\((.+?)\\\)/g, '$1')
        .replace(/\\\[(.+?)\\\]/g, '$1');

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];
    let i = 0;
    const isBullet = (s: string) => /^[*\-]\s+/.test(s);
    const isHeading = (s: string) => /^#{1,6}\s+/.test(s);

    while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (!trimmed) { i++; continue; }

        if (isBullet(trimmed)) {
            const items: string[] = [];
            while (i < lines.length && isBullet(lines[i].trim())) {
                items.push(lines[i].trim().replace(/^[*\-]\s+/, ''));
                i++;
            }
            out.push('<ul>' + items.map(it => `<li>${inlineMarkdownToHtml(it)}</li>`).join('') + '</ul>');
            continue;
        }

        const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (h) {
            const level = Math.min(h[1].length, 6);
            out.push(`<h${level}>${inlineMarkdownToHtml(h[2])}</h${level}>`);
            i++;
            continue;
        }

        const para: string[] = [];
        while (i < lines.length && lines[i].trim() && !isBullet(lines[i].trim()) && !isHeading(lines[i].trim())) {
            para.push(lines[i].trim());
            i++;
        }
        out.push(`<p>${inlineMarkdownToHtml(para.join(' '))}</p>`);
    }
    return out.join('\n');
}

// Build a Word-compatible .doc payload. Word opens HTML with the office
// namespaces natively — no python-docx, no node deps, no install step.
function buildWordHtml(title: string, bodyHtml: string): string {
    const safeTitle = escapeHtml(title);
    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<!--[if gte mso 9]>
<xml>
  <w:WordDocument>
    <w:View>Print</w:View>
    <w:Zoom>100</w:Zoom>
    <w:DoNotOptimizeForBrowser/>
  </w:WordDocument>
</xml>
<![endif]-->
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1f2937; max-width: 7in; }
  h1 { font-size: 18pt; color: #1d4ed8; margin: 18pt 0 6pt; }
  h2 { font-size: 14pt; color: #1d4ed8; margin: 14pt 0 4pt; }
  h3 { font-size: 12pt; color: #1d4ed8; margin: 10pt 0 4pt; }
  p { margin: 6pt 0; line-height: 1.4; }
  ul { margin: 6pt 0 6pt 18pt; }
  li { margin: 3pt 0; line-height: 1.4; }
  code { background: #f1f5f9; padding: 1pt 4pt; border: 1px solid #e2e8f0; font-family: Consolas, monospace; font-size: 10pt; }
  a { color: #1d4ed8; text-decoration: underline; }
  strong { color: #111827; }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
${bodyHtml}
</body>
</html>`;
}

function downloadDocFile(filename: string, html: string) {
    // application/msword on a .doc filename is the most reliable combo —
    // Word, LibreOffice, and Google Docs all import this without a fight.
    const blob = new Blob(['﻿', html], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyHtmlAndMarkdown(html: string, markdown: string): Promise<boolean> {
    try {
        // Prefer the rich Clipboard API so Google Docs receives styled HTML.
        const w = window as any;
        if (w.ClipboardItem && navigator.clipboard?.write) {
            await navigator.clipboard.write([
                new w.ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([markdown], { type: 'text/plain' }),
                }),
            ]);
            return true;
        }
        await navigator.clipboard.writeText(markdown);
        return true;
    } catch (e) {
        console.error('Clipboard write failed:', e);
        return false;
    }
}

const META_LABEL: Record<string, string> = {
  base: 'Your pages (crawl)', keyword: 'Keywords', competitor: 'Competitor pages',
  internal_link: 'Linked pages not in the crawl', external_link: 'Backlink referring pages', realtime: 'Pages fetched on demand',
};
function metaAdded(u: any): string {
  const c = u.counts || {};
  const f = (v: number) => Number(v || 0).toLocaleString();
  if (u.kind === 'keyword') return `${f(c.keywords)} keywords`;
  if (u.kind === 'external') return `${f(c.links)} backlinks · ${f(c.pages)} referring pages`;
  if (u.kind === 'internal') return `${f(c.links)} links${c.pages ? ` · ${f(c.pages)} new pages` : ''}`;
  return `${f(c.pages)} pages`;
}

export default function AnalysisWorkspace() {
  const { projectId } = useParams();
  const { addToast, ToastContainer } = useToast();
  const [activeTab, setActiveTab] = useState('actions');
  const [labInit, setLabInit] = useState<(LabPayload & { nonce: number }) | null>(null);
  const [planRefresh, setPlanRefresh] = useState(0);
  const [embedStatus, setEmbedStatus] = useState<any>(null);
  const [ghostPoint, setGhostPoint] = useState<GhostPoint | null>(null);
  const [ghostMatches, setGhostMatches] = useState<{ url: string; title: string; similarity: number }[]>([]);
  const [locating, setLocating] = useState(false);
  const [compVectorSource, setCompVectorSource] = useState<VectorSourceValue>(DEFAULT_VECTOR_SOURCE);

  useEffect(() => {
    axios.get(`${API_BASE}/api/embedder/status`).then(r => setEmbedStatus(r.data)).catch(() => {});
  }, []);

  const openLab = (payload: LabPayload) => {
    setLabInit({ ...payload, nonce: Date.now() });
    setActiveTab('lab');
  };

  // ---- shared structure (topics + per-page diagnosis) used by most views ----
  const [structure, setStructure] = useState<Structure | null>(null);
  const [structureLoading, setStructureLoading] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [drawerActions, setDrawerActions] = useState<PlanAction[]>([]);
  const [bullseyeCenter, setBullseyeCenter] = useState<BullseyeCenter | null>(null);
  const [actionSearch, setActionSearch] = useState<{ text: string; nonce: number } | null>(null);
  const [mapColorBy, setMapColorBy] = useState<'dataset' | 'topic' | 'zone'>('topic');
  const [analysisDim, setAnalysisDim] = useState<number | null>(null);
  const [linkRefresh, setLinkRefresh] = useState(0);
  const driftRef = useRef<DriftData | null>(null);
  const [uploadsRefresh, setUploadsRefresh] = useState(0);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const linkGraphRef = useRef<LinkGraphData | null>(null);
  const linkHealthRef = useRef<Health | null>(null);

  const fetchStructure = async () => {
    setStructureLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/api/projects/${projectId}/structure`);
      setStructure(res.data);
    } catch (e) {
      console.error('structure failed', e);
    } finally {
      setStructureLoading(false);
    }
  };

  useEffect(() => {
    if (!projectId) return;
    fetchStructure();
    axios.get(`${API_BASE}/api/projects/${projectId}/settings`).then(r => setAnalysisDim(r.data.analysis_dim)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selectPage = (url: string) => {
    setSelectedUrl(url);
    axios.get(`${API_BASE}/api/projects/${projectId}/actions`).then(r => setDrawerActions(r.data.actions || [])).catch(() => {});
  };
  const selectedPage = structure?.pages?.find(p => p.url === selectedUrl) || null;
  // The page drawer is contextual: close it when moving to another view.
  useEffect(() => { setSelectedUrl(null); }, [activeTab]);

  const centerBullseye = (pageId: number) => {
    setBullseyeCenter({ pageId, nonce: Date.now() });
    setActiveTab('bullseye');
  };
  const openActionsFor = (url: string) => {
    setActionSearch({ text: url, nonce: Date.now() });
    setActiveTab('actions');
  };

  const changeDim = async (dim: number) => {
    try {
      await axios.post(`${API_BASE}/api/projects/${projectId}/settings`, { analysis_dim: dim });
      setAnalysisDim(dim);
      addToast(`Analyzing at ${dim} dimensions.`, 'success');
      fetchAnalysis(distanceMetric);
      fetchStructure();
      setPlanRefresh(k => k + 1);
      setLinkRefresh(k => k + 1);
    } catch {
      addToast('Could not change the vector size.', 'error');
    }
  };

  const runArchitecture = async (clusters: string[]) => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/generate-architecture`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clusters }),
      });
      const data = await res.json();
      setViewInsights(prev => ({ ...prev, topic_map: '## Proposed Site Architecture\n\n' + data.architecture }));
      addToast('Architecture generated — see the panel above.', 'success');
    } catch {
      addToast('Architecture generation failed. Check that the local LLM is loaded.', 'error');
    }
  };
  const [distanceMetric, setDistanceMetric] = useState('cosine');
  const [analysisData, setAnalysisData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [ingestProgress, setIngestProgress] = useState<any>(null);

  // Project info
  const [projectName, setProjectName] = useState('');
  const [projectDomain, setProjectDomain] = useState('');

  useEffect(() => {
    axios.get(`${API_BASE}/api/projects`).then(res => {
      const proj = res.data.projects?.find((p: any) => p.id === Number(projectId));
      if (proj) {
        setProjectName(proj.name);
        setProjectDomain(proj.domain);
      }
    }).catch(() => {});
  }, [projectId]);

  // New Actionable State
  const [ghostKeyword, setGhostKeyword] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [isolateOpportunities, setIsolateOpportunities] = useState(false);
  
  // AI Rewrite State
  const [rewriteModalOpen, setRewriteModalOpen] = useState(false);
  const [rewriteBrief, setRewriteBrief] = useState("");
  const [isGeneratingRewrite, setIsGeneratingRewrite] = useState(false);
  const [activeRewriteTarget, setActiveRewriteTarget] = useState({keyword: "", url: ""});
  const [rewriteElapsed, setRewriteElapsed] = useState(0);
  const rewriteAbortRef = React.useRef<AbortController | null>(null);

  // Set of "{keyword}|||{url}" strings that already have a saved brief on the
  // backend. Used to badge rows in the keyword table and switch the action
  // button from "Generate" to "View".
  const [savedBriefKeys, setSavedBriefKeys] = useState<Set<string>>(new Set());
  const briefKey = (keyword: string, url: string) => `${keyword}|||${url}`;

  const fetchSavedBriefs = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/projects/${projectId}/rewrite-briefs`);
      const list: Array<{ keyword: string; url: string }> = res.data?.briefs || [];
      setSavedBriefKeys(new Set(list.map(b => briefKey(b.keyword, b.url))));
    } catch (e) {
      console.error('Failed to fetch saved briefs:', e);
    }
  };

  useEffect(() => {
    if (projectId) fetchSavedBriefs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Tick an elapsed-second counter while a rewrite is generating, so the modal
  // doesn't look frozen during a slow local-LLM generation.
  useEffect(() => {
    if (!isGeneratingRewrite) {
      setRewriteElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setRewriteElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isGeneratingRewrite]);
  
  // CSV Upload States
  const [compFile, setCompFile] = useState<File | null>(null);
  const [compHeaders, setCompHeaders] = useState<string[]>([]);
  const [compName, setCompName] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  // Intersection Compare State
  const [entities, setEntities] = useState<any[]>([]);
  
  // Project Metadata State
  const [metadataModalOpen, setMetadataModalOpen] = useState(false);
  const [projectMetadata, setProjectMetadata] = useState<any>(null);

  // Keyword Mapping Table — sort/filter state
  type KwSortKey = 'keyword' | 'closest_url' | 'dataset' | 'distance';
  const [kwSortKey, setKwSortKey] = useState<KwSortKey>('distance');
  const [kwSortDir, setKwSortDir] = useState<'asc' | 'desc'>('asc');
  const [kwFilterKeyword, setKwFilterKeyword] = useState('');
  const [kwFilterUrl, setKwFilterUrl] = useState('');
  const [kwFilterDataset, setKwFilterDataset] = useState('');
  const [kwFilterMinDist, setKwFilterMinDist] = useState('');
  const [kwFilterMaxDist, setKwFilterMaxDist] = useState('');
  const [kwFilterRiskOnly, setKwFilterRiskOnly] = useState(false);

  const handleKwSort = (key: KwSortKey) => {
    if (kwSortKey === key) {
      setKwSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setKwSortKey(key);
      setKwSortDir(key === 'distance' ? 'asc' : 'asc');
    }
  };

  const kwDatasets: string[] = useMemo(() => {
    if (!analysisData?.keyword_mappings) return [];
    const set = new Set<string>();
    analysisData.keyword_mappings.forEach((km: any) => { if (km.dataset) set.add(km.dataset); });
    return Array.from(set).sort();
  }, [analysisData]);

  const filteredKeywordMappings = useMemo(() => {
    if (!analysisData?.keyword_mappings) return [];
    const kwF = kwFilterKeyword.trim().toLowerCase();
    const urlF = kwFilterUrl.trim().toLowerCase();
    const dsF = kwFilterDataset;
    const minD = kwFilterMinDist === '' ? -Infinity : parseFloat(kwFilterMinDist);
    const maxD = kwFilterMaxDist === '' ? Infinity : parseFloat(kwFilterMaxDist);

    const filtered = analysisData.keyword_mappings.filter((km: any) => {
      if (kwF && !(km.keyword || '').toLowerCase().includes(kwF)) return false;
      if (urlF && !(km.closest_url || '').toLowerCase().includes(urlF)) return false;
      if (dsF && km.dataset !== dsF) return false;
      const d = typeof km.distance === 'number' ? km.distance : parseFloat(km.distance);
      if (!isNaN(minD) && d < minD) return false;
      if (!isNaN(maxD) && d > maxD) return false;
      if (kwFilterRiskOnly && !km.cannibalization_risk) return false;
      return true;
    });

    const dir = kwSortDir === 'asc' ? 1 : -1;
    filtered.sort((a: any, b: any) => {
      const av = a[kwSortKey];
      const bv = b[kwSortKey];
      if (kwSortKey === 'distance') {
        const an = typeof av === 'number' ? av : parseFloat(av);
        const bn = typeof bv === 'number' ? bv : parseFloat(bv);
        return (an - bn) * dir;
      }
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
    return filtered;
  }, [analysisData, kwSortKey, kwSortDir, kwFilterKeyword, kwFilterUrl, kwFilterDataset, kwFilterMinDist, kwFilterMaxDist, kwFilterRiskOnly]);

  const fetchMetadata = async () => {
      try {
          const res = await axios.get(`${API_BASE}/api/projects/${projectId}/metadata`);
          setProjectMetadata(res.data);
          setMetadataModalOpen(true);
      } catch (err) {
          console.error(err);
          addToast("Failed to load project metadata.", 'error');
      }
  };



  // AI View Summary State
  const [insightLoading, setInsightLoading] = useState(false);
  const [viewInsights, setViewInsights] = useState<Record<string, string>>({});
  
  // Build a tab-specific payload with concrete numbers + real examples so the LLM
  // grounds its insights in actual data instead of speculating. The goal: every
  // bullet Gemma writes should be defensible from one of the lines we feed in here.
  const buildInsightPayload = (): string => {
      if (!analysisData) return '';
      const round = (n: number, p = 4) => Number.isFinite(n) ? Number(n).toFixed(p) : 'n/a';
      const lines: string[] = [];
      lines.push(`Distance Metric: ${distanceMetric}`);
      lines.push(`Focus Score: ${round(analysisData.focus_score, 3)} (0=fragmented, 1=tight)`);

      if (activeTab === '3dmap') {
          const umap: any[] = analysisData.umap || [];
          const bullseye: any[] = analysisData.bullseye || [];
          const kw: any[] = analysisData.keyword_mappings || [];

          // Category distribution
          const byCat: Record<string, number> = {};
          umap.forEach(n => { byCat[n.category] = (byCat[n.category] || 0) + 1; });
          lines.push(`Total nodes plotted: ${umap.length}`);
          lines.push(`Category distribution: ${JSON.stringify(byCat)}`);

          // Centroid + outliers from bullseye (already carries distance-from-centroid)
          if (bullseye.length > 0) {
              const sorted = [...bullseye].sort((a, b) => b.distance - a.distance);
              const top5Drift = sorted.slice(0, 5).map(n => `${n.url} (d=${round(n.distance)})`);
              const top5Core = sorted.slice(-5).reverse().map(n => `${n.url} (d=${round(n.distance)})`);
              const mean = bullseye.reduce((s, n) => s + n.distance, 0) / bullseye.length;
              lines.push(`Mean distance from centroid: ${round(mean)}`);
              lines.push(`5 most drifted (highest distance from centroid):\n  - ${top5Drift.join('\n  - ')}`);
              lines.push(`5 most core (closest to centroid):\n  - ${top5Core.join('\n  - ')}`);
          }

          // Keyword mappings + cannibalization
          if (kw.length > 0) {
              const sortedKw = [...kw].sort((a, b) => a.distance - b.distance);
              const cannibal = kw.filter(k => k.cannibalization_risk);
              const ghostGaps = kw.filter(k => k.distance > 0.3);
              lines.push(`Keyword mappings: ${kw.length} total, ${cannibal.length} flagged cannibalization risk, ${ghostGaps.length} ghost gaps (dist > 0.3)`);
              const bestMatches = sortedKw.slice(0, 5).map(k => `"${k.keyword}" → ${k.closest_url} (d=${round(k.distance)})`);
              const worstMatches = [...sortedKw].slice(-5).reverse().map(k => `"${k.keyword}" → ${k.closest_url} (d=${round(k.distance)})`);
              lines.push(`5 tightest keyword matches:\n  - ${bestMatches.join('\n  - ')}`);
              lines.push(`5 worst keyword matches (largest gap):\n  - ${worstMatches.join('\n  - ')}`);
              if (cannibal.length > 0) {
                  lines.push(`Cannibalization examples: ${cannibal.slice(0, 5).map(k => `"${k.keyword}" (closest: ${k.closest_url})`).join('; ')}`);
              }
          }
          return lines.join('\n');
      }

      if (activeTab === 'semantic_drift') {
          const d = driftRef.current;
          if (!d) { lines.push('Drift has not been computed yet.'); return lines.join('\n'); }
          lines.push(`Pages checked: ${d.pages.length}. Stays on subject: ${Math.round(d.on_topic_share * 100)}%.`);
          lines.push(`Verdicts: ${Object.entries(d.counts).map(([k, v]) => `${d.labels[k as keyof typeof d.labels]} ${v}`).join(', ')}.`);
          lines.push(`Cut-offs (project-relative): title-match floor ${d.cutoffs.title_floor}, outlier fence ${d.cutoffs.outlier.toFixed(3)}.`);
          const top = d.pages.filter(p => p.verdict !== 'on_topic' && p.verdict !== 'secondary').slice(0, 12)
            .map(p => `${p.url} [${p.label}] dist=${round(p.distance)} fit=${round(p.topic_fit)} title=${p.title_sim ?? 'n/a'}: ${p.text}`);
          if (top.length) lines.push(`Pages drifting:\n  - ${top.join('\n  - ')}`);
          const groups = [...new Set(d.pages.filter(p => p.group).map(p => p.group))];
          if (groups.length) lines.push(`Secondary topics (groups of similar pages outside the core): ${groups.join(', ')}`);
          return lines.join('\n');
      }

      if (activeTab === 'link_graph') {
          const g = linkGraphRef.current;
          if (!g) { lines.push('The link graph has not been computed yet.'); return lines.join('\n'); }
          const sc = g.score;
          lines.push(`Link relevance score: ${sc.value ?? 'n/a'}/100${sc.backlinks?.value != null ? ` (average of internal links ${sc.internal_value} and backlinks ${sc.backlinks.value})` : ''}.`);
          lines.push(`Internal: equity-weighted editorial link similarity ${sc.weighted_sim}, random baseline ${sc.baseline_sim}, ideal ${sc.ideal_sim}.`);
          if (sc.backlinks?.value != null) lines.push(`Backlinks: value-weighted similarity of linking page to the page it links to ${sc.backlinks.weighted_sim}, random-target baseline ${sc.backlinks.baseline_sim}, ideal ${sc.backlinks.ideal_sim}; ${sc.backlinks.domains} domains. Value = authority (linking page referring domains + DR) x quality (page traffic + keywords) x follow; one domain counts once.`);
          lines.push(`Editorial links: ${sc.links} (relevant ${sc.band_counts.relevant}, weak ${sc.band_counts.weak}, off-topic ${sc.band_counts.off_topic}); equity share relevant ${Math.round(sc.band_equity.relevant * 100)}%.`);
          lines.push(`Not scored: ${sc.sitewide_links} nav/footer links, ${sc.template_links} template links.`);
          lines.push(`Content pages with no relevant editorial link in: ${sc.pages_without_relevant_inlinks} of ${sc.content_pages}.`);
          if (g.off_topic_links.length) lines.push(`Top off-topic links:\n  - ${g.off_topic_links.slice(0, 8).map(o => `${o.source} -> ${o.target} (${o.sim}); instead ${o.instead?.url ?? 'n/a'}`).join('\n  - ')}`);
          if (g.starved_pages.length) lines.push(`Pages needing relevant links:\n  - ${g.starved_pages.slice(0, 8).map(p => `${p.url} (${p.queries} queries, ${p.relevant_in} relevant in)`).join('\n  - ')}`);
          const ib = g.external.inbound_summary;
          if (ib.count) lines.push(`Backlinks to crawled pages: ${ib.count} from ${ib.domains} domains; bands ${JSON.stringify(ib.bands)}${typeof ib.relevant_value_share === 'number' ? `; ${Math.round(ib.relevant_value_share * 100)}% of backlink value from relevant pages, ${Math.round((ib.off_topic_value_share ?? 0) * 100)}% from off-topic` : ''}${ib.visibility ? `; linking pages with traffic ${ib.visibility.traffic}, ranking only ${ib.visibility.ranks}, no visibility ${ib.visibility.none}` : ''}.`);
          const topBl = g.external.inbound.slice(0, 8).map(l => `${l.source} -> ${l.target} DR ${l.dr ?? 'n/a'}, ${l.rd ?? 0} RD, ${l.traffic ?? 0} visits, sim ${l.sim ?? 'n/a'} (${l.band ?? 'not scored'})${l.better ? `, closer to ${l.better.url}` : ''}`);
          if (topBl.length) lines.push(`Most valuable backlinks:\n  - ${topBl.join('\n  - ')}`);
          const un = g.external.uncrawled_summary;
          if (un?.backlinks) lines.push(`${un.backlinks} more backlinks point to ${un.targets} URLs not in this crawl; most linked: ${(g.external.uncrawled || []).slice(0, 6).map(u => `${u.url} (${u.domains} domains)`).join(', ')}.`);
          return lines.join('\n');
      }
      if (activeTab === 'link_opportunities') {
          const lo: any[] = analysisData.link_opportunities || [];
          lines.push(`Missing internal link opportunities: ${lo.length}`);
          if (lo.length > 0) {
              const top = lo.slice(0, 10).map((l: any) => `${l.source_title || l.source} ⟶ ${l.target_title || l.target} (d=${round(l.distance)})`);
              lines.push(`Top 10:\n  - ${top.join('\n  - ')}`);
          }
          return lines.join('\n');
      }

      if (activeTab === 'topical_gaps') {
          const tg: any[] = analysisData.topical_gaps || [];
          lines.push(`Total topical gaps (ghost keywords with no near match): ${tg.length}`);
          if (tg.length > 0) {
              const top = tg.slice(0, 10).map((g: any) => `"${g.keyword}" (closest=${g.closest_url || 'none'}, d=${round(g.distance)})`);
              lines.push(`Top 10 gaps:\n  - ${top.join('\n  - ')}`);
          }
          return lines.join('\n');
      }

      const lh = linkHealthRef.current;
      if ((activeTab === 'external_links' || activeTab === 'internal_matrix') && lh && lh.kind === (activeTab === 'external_links' ? 'external' : 'internal')) {
          const sm = lh.summary;
          lines.push(`${lh.kind === 'external' ? 'Backlinks' : 'Internal links'}: ${sm.links} (${sm.scored ?? 'n/a'} scored, to ${sm.targets ?? 'n/a'} pages); average relevance ${sm.avg_relevance ?? 'n/a'}; weak below ${lh.weak_cut ?? 'n/a'}, good from ${lh.good_cut ?? 'n/a'}.`);
          if (sm.status_counts) lines.push(`Pages by status: ${Object.entries(sm.status_counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
          const need = lh.pages.filter(p => p.severity === 'high' || p.severity === 'medium').slice(0, 10)
            .map(p => `${p.url} [${p.status}] ${p.inbound} links from ${p.sources} sources, relevant ${p.relevant}, weak ${p.weak}, avg ${p.avg_relevance ?? 'n/a'}, ${p.queries} queries`);
          if (need.length) lines.push(`Pages needing attention:\n  - ${need.join('\n  - ')}`);
          return lines.join('\n');
      }
      if (activeTab === 'external_links' || activeTab === 'internal_matrix') {
          const arr: any[] = analysisData[activeTab === 'external_links' ? 'network_external' : 'network_internal'] || [];
          const dilute = arr.filter(l => (l.relevance_score || 0) < 0.6);
          const reinforce = arr.filter(l => (l.relevance_score || 0) >= 0.6);
          lines.push(`Total links: ${arr.length}`);
          lines.push(`Diluting (<0.6 relevance): ${dilute.length}`);
          lines.push(`Reinforcing (≥0.6 relevance): ${reinforce.length}`);
          if (dilute.length > 0) {
              const top = [...dilute].sort((a, b) => (a.relevance_score || 0) - (b.relevance_score || 0)).slice(0, 8).map(l => `${l.source_title || l.source} ⟶ ${l.target_title || l.target} (rel=${round(l.relevance_score)})`);
              lines.push(`8 most diluting links:\n  - ${top.join('\n  - ')}`);
          }
          return lines.join('\n');
      }

      if (activeTab === 'iqr_bullseye' || activeTab === 'bullseye') {
          const bs: any[] = analysisData.bullseye || [];
          const sorted = [...bs].sort((a, b) => b.distance - a.distance);
          lines.push(`Total nodes: ${bs.length}`);
          if (bs.length > 0) {
              const mean = bs.reduce((s, n) => s + n.distance, 0) / bs.length;
              lines.push(`Mean distance from centroid: ${round(mean)}`);
              lines.push(`5 outermost:\n  - ${sorted.slice(0, 5).map(n => `${n.url} (d=${round(n.distance)})`).join('\n  - ')}`);
              lines.push(`5 innermost:\n  - ${sorted.slice(-5).reverse().map(n => `${n.url} (d=${round(n.distance)})`).join('\n  - ')}`);
          }
          return lines.join('\n');
      }

      // Generic fallback — still ship actual numbers
      lines.push(`UMAP node count: ${(analysisData.umap || []).length}`);
      lines.push(`Keyword mappings: ${(analysisData.keyword_mappings || []).length}`);
      lines.push(`Link opportunities: ${(analysisData.link_opportunities || []).length}`);
      return lines.join('\n');
  };

  const handleGenerateInsight = async () => {
      if (!analysisData) return;
      setInsightLoading(true);

      const payload = buildInsightPayload();
      
      try {
          const res = await axios.post(`${API_BASE}/api/projects/${projectId}/generate-view-summary`, {
              view_name: activeTab,
              payload_text: payload
          });
          // Backend returns { summary: "..." }. Older callers expected { data: "..." } — accept either for safety.
          const insight = res.data?.summary ?? res.data?.data ?? '';
          if (!insight) {
              setViewInsights(prev => ({...prev, [activeTab]: '⚠️ The LLM returned an empty response. Check that the local Gemma inference layer is loaded.'}));
          } else {
              setViewInsights(prev => ({...prev, [activeTab]: insight}));
          }
      } catch (err: any) {
          console.error(err);
          const msg = err?.response?.data?.detail || err?.message || 'Unknown error';
          setViewInsights(prev => ({...prev, [activeTab]: `⚠️ Failed to generate insights: ${msg}`}));
      } finally {
          setInsightLoading(false);
      }
  };


  // Fetch analysis data wrapper
  const fetchAnalysis = async (metric: string) => {
    try {
      const res = await axios.get(`${API_BASE}/api/projects/${projectId}/analysis?distance_metric=${metric}`);
      setAnalysisData(res.data);
      if (loading) setLoading(false);
      fetchEntities();
    } catch (err) {
      console.error(err);
      if (loading) setLoading(false);
    }
  };

  const fetchEntities = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/projects/${projectId}/entities`);
      setEntities(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  // Initial load and polling if data is missing
  useEffect(() => {
    let isPolling = true;
    let currentlyIngesting = false;
    
    fetchAnalysis(distanceMetric);
    fetchEntities();

    const interval = setInterval(async () => {
       if (!isPolling) return;
       try {
           const progRes = await axios.get(`${API_BASE}/api/projects/${projectId}/progress`);
           if (progRes.data.status === 'ingesting') {
               setIngestProgress(progRes.data.progress);
               currentlyIngesting = true;
           } else {
               setIngestProgress(null);
               if (currentlyIngesting) {
                   currentlyIngesting = false;
                   fetchAnalysis(distanceMetric);
                   setPlanRefresh(k => k + 1);
                   fetchStructure();
                   setLinkRefresh(k => k + 1);
                   const pRes = await axios.get(`${API_BASE}/api/projects/${projectId}/metadata`);
                   setProjectMetadata(pRes.data);
                   setUploadsRefresh(k => k + 1);
               }
           }
       } catch (err) {
           console.error("Polling error", err);
       }
    }, 2000);
    
    return () => { isPolling = false; clearInterval(interval); };
  }, [projectId, distanceMetric]);

  const handleReembed = async (fetchMissing: boolean) => {
    try {
      const res = await axios.post(`${API_BASE}/api/projects/${projectId}/reembed`, { fetch_missing: fetchMissing });
      if (res.data.status === 'busy') addToast('This project is already processing.', 'info');
      else addToast('Re-embedding with EmbeddingGemma 2 — progress shows above the plan.', 'success');
      setIngestProgress({ phase: 'Queued re-embed', current: 0, total: 1, estimated_time_remaining: 0 });
    } catch (err: any) {
      addToast(`Re-embed failed to start: ${err?.response?.data?.detail || err?.message}`, 'error');
    }
  };

  const locateGhost = async () => {
    const q = ghostKeyword.trim();
    if (!q) { setGhostPoint(null); setGhostMatches([]); return; }
    setLocating(true);
    try {
      const res = await axios.get(`${API_BASE}/api/projects/${projectId}/locate`, { params: { q } });
      if (res.data.error) {
        addToast(res.data.error, 'error');
        setGhostPoint(null); setGhostMatches([]);
      } else {
        setGhostPoint({ x: res.data.x, y: res.data.y, z: res.data.z, label: q });
        setGhostMatches(res.data.matches || []);
      }
    } catch (err: any) {
      addToast(`Locate failed: ${err?.response?.data?.detail || err?.message}`, 'error');
    } finally {
      setLocating(false);
    }
  };

  // Handle distance metric change
  const handleMetricChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const metric = e.target.value;
    setDistanceMetric(metric);
    fetchAnalysis(metric);
  };
  
  const handleExportCSV = () => {
    setIsExporting(true);
    if (!analysisData) return;
    
    // Build CSV from 3D Map and Bullseye data
    let csvStr = "ID,URL,Category,Focus Distance,Zone,Action Insight\n";
    const zoneByUrl: Record<string, string> = {};
    (analysisData.iqr_bullseye?.nodes || []).forEach((n: any) => { zoneByUrl[n.url] = n.zone; });
    const insightFor: Record<string, string> = { Core: 'Core asset', Focus: 'Supporting page', Expansion: 'Needs internal links / tightening', Peripheral: 'Review: refocus, merge or prune' };
    analysisData.bullseye.forEach((b: any) => {
        const zone = zoneByUrl[b.url] || '';
        const insight = insightFor[zone] || 'Keyword';
        csvStr += `${b.id},"${String(b.url).replace(/"/g, '""')}",${b.category},${b.distance.toFixed(3)},${zone},${insight}\n`;
    });
    
    const blob = new Blob([csvStr], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('hidden', '');
    a.setAttribute('href', url);
    a.setAttribute('download', `project_${projectId}_action_plan.csv`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setIsExporting(false);
  };

  const handleCompFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setCompFile(file);
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result && typeof ev.target.result === 'string') {
          const firstLine = ev.target.result.split('\n')[0];
          const headers = firstLine.split(',').map(h => h.replace(/^["']|["']$/g, '').trim());
          setCompHeaders(headers);
        }
      };
      reader.readAsText(file.slice(0, 5000));
    }
  };

  // Uploads: show the file in the panel at once (with transfer %), then hand over to
  // the server-side status (queued / processing / loaded / failed), which survives reloads.
  const postUpload = async (formData: FormData, filename: string, kind: string): Promise<boolean> => {
    const key = `${Date.now()}-${filename}`;
    setPendingUploads(p => [...p, { key, filename, kind, pct: 0 }]);
    try {
      await axios.post(`${API_BASE}/api/projects/${projectId}/upload-csv`, formData, {
        onUploadProgress: ev => {
          const pct = ev.total ? Math.round((ev.loaded / ev.total) * 100) : 0;
          setPendingUploads(p => p.map(x => (x.key === key ? { ...x, pct } : x)));
        },
      });
      setPendingUploads(p => p.filter(x => x.key !== key));
      setUploadsRefresh(k => k + 1);
      return true;
    } catch (err: any) {
      const msg = err?.response?.data?.detail || err?.message || 'network error';
      setPendingUploads(p => p.map(x => (x.key === key ? { ...x, error: msg } : x)));
      setTimeout(() => setPendingUploads(p => p.filter(x => x.key !== key)), 15000);
      return false;
    }
  };

  const handleKwFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append("source_type", "keyword");
        formData.append("source_name", "Keywords");
        formData.append("vector_column", "");
        formData.append("file", file);
        if (await postUpload(formData, file.name, 'keyword')) addToast(`${file.name} uploaded. Its status is in Uploaded files.`, 'info');
        else addToast("Failed to upload the keyword CSV.", 'error');
      } finally {
        setIsUploading(false);
        e.target.value = '';
      }
    }
  };

  const submitCompFile = async () => {
      if (!compFile || !compName) return;
      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append("source_type", "competitor");
        formData.append("source_name", compName);
        formData.append("vector_mode", compVectorSource.mode);
        formData.append("vector_column", compVectorSource.mode === 'csv' ? compVectorSource.column : "");
        formData.append("vector_model", compVectorSource.mode === 'csv' ? compVectorSource.model : "");
        formData.append("fetch_missing", String(compVectorSource.fetchMissing));
        formData.append("file", compFile);
        if (await postUpload(formData, compFile.name, 'competitor')) addToast(`${compFile.name} uploaded. Its status is in Uploaded files.`, 'info');
        else addToast("Failed to upload the competitor CSV.", 'error');
      } finally {
        setIsUploading(false);
        setCompFile(null);
        setCompHeaders([]);
      }
  };

  const handleLinkFileChange = async (e: React.ChangeEvent<HTMLInputElement>, linkType: string) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append("source_type", linkType);
        formData.append("source_name", `${linkType}_link_import`);
        formData.append("vector_column", "");
        formData.append("file", file);
        if (await postUpload(formData, file.name, linkType)) addToast(`${file.name} uploaded. Its status is in Uploaded files.`, 'info');
        else addToast(`Failed to upload the ${linkType} links CSV.`, 'error');
      } finally {
        setIsUploading(false);
        e.target.value = '';
      }
    }
  };

  const cancelRewrite = () => {
    if (rewriteAbortRef.current) {
      rewriteAbortRef.current.abort();
      rewriteAbortRef.current = null;
    }
  };

  const [exportToast, setExportToast] = useState<string | null>(null);
  // Auto-dismiss the toast after 4s.
  useEffect(() => {
    if (!exportToast) return;
    const id = setTimeout(() => setExportToast(null), 4000);
    return () => clearTimeout(id);
  }, [exportToast]);

  const safeSlug = (s: string) => (s || 'rewrite-brief')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'rewrite-brief';

  const exportRewriteAsWord = () => {
      if (!rewriteBrief) return;
      const title = `Rewrite Brief — ${activeRewriteTarget.keyword || 'untitled'}`;
      const meta = `<p><strong>Target Keyword:</strong> ${escapeHtml(activeRewriteTarget.keyword)}<br>`
          + `<strong>URL:</strong> <a href="${escapeHtml(activeRewriteTarget.url)}">${escapeHtml(activeRewriteTarget.url)}</a></p><hr>`;
      const bodyHtml = meta + markdownToHtml(rewriteBrief);
      const html = buildWordHtml(title, bodyHtml);
      const filename = `rewrite-${safeSlug(activeRewriteTarget.keyword)}.doc`;
      downloadDocFile(filename, html);
      setExportToast(`Downloaded ${filename}`);
  };

  const exportRewriteAsGoogleDoc = async () => {
      if (!rewriteBrief) return;
      const title = `Rewrite Brief — ${activeRewriteTarget.keyword || 'untitled'}`;
      const meta = `<p><strong>Target Keyword:</strong> ${escapeHtml(activeRewriteTarget.keyword)}<br>`
          + `<strong>URL:</strong> <a href="${escapeHtml(activeRewriteTarget.url)}">${escapeHtml(activeRewriteTarget.url)}</a></p><hr>`;
      const html = `<h1>${escapeHtml(title)}</h1>${meta}${markdownToHtml(rewriteBrief)}`;
      const md = `# ${title}\n\n**Target Keyword:** ${activeRewriteTarget.keyword}\n**URL:** ${activeRewriteTarget.url}\n\n---\n\n${rewriteBrief}`;
      const copied = await copyHtmlAndMarkdown(html, md);
      // Opens a fresh blank Google Doc; user pastes (Cmd/Ctrl-V) to drop in the styled content.
      window.open('https://docs.google.com/document/create', '_blank', 'noopener,noreferrer');
      setExportToast(copied
          ? 'Brief copied to clipboard. Paste (Ctrl/Cmd-V) into the new Google Doc.'
          : 'Could not copy automatically — copy the brief manually, then paste it into the Google Doc.');
  };

  const handleGenerateRewrite = async (keyword: string, url: string, force: boolean = false, evidence: string = '') => {
    setActiveRewriteTarget({keyword, url});
    setRewriteBrief("");
    setRewriteModalOpen(true);
    setIsGeneratingRewrite(true);
    // Abandon any previous in-flight rewrite before starting a new one.
    if (rewriteAbortRef.current) rewriteAbortRef.current.abort();
    const controller = new AbortController();
    rewriteAbortRef.current = controller;
    try {
        // Real-time fetch + Gemma generation can take 1–4 minutes on CPU; give axios room.
        const response = await axios.post(
            `${API_BASE}/api/projects/${projectId}/generate-rewrite`,
            { keyword, url, force: force || !!evidence, evidence },
            { timeout: 300000, signal: controller.signal }
        );
        const brief = response.data?.data ?? '';
        const fetchedRealtime = response.data?.fetched_realtime === true;
        const pageFound = response.data?.page_found === true;
        const bodyChars = response.data?.body_chars ?? 0;
        const fromCache = response.data?.from_cache === true;
        const updatedAt = response.data?.updated_at as string | undefined;
        let note = '';
        if (fromCache) {
            const when = updatedAt ? new Date(updatedAt).toLocaleString() : 'previously';
            note = `> 💾 Loaded from saved brief (generated ${when}). Click **Regenerate** below if you want a fresh version.\n\n`;
        } else if (fetchedRealtime) {
            note = `> ℹ️ Page wasn't in the crawled cache, so it was fetched on demand via Scrapling + Trafilatura (${bodyChars.toLocaleString()} chars extracted). Future rewrites for this URL will skip the network hit.\n\n`;
        } else if (!pageFound) {
            note = '> ⚠️ Page is not in the crawl cache and on-demand fetch failed. The brief below was generated from the keyword and URL alone — quality will be lower than a brief grounded in real page content.\n\n';
        }
        setRewriteBrief(note + brief);
        // Refresh saved-brief badges. The endpoint persists on every non-cached
        // generation, so this is how new rows pick up the ✓ indicator.
        if (!fromCache) {
            setSavedBriefKeys(prev => {
                const next = new Set(prev);
                next.add(briefKey(keyword, url));
                return next;
            });
        }
    } catch (err: any) {
        console.error(err);
        const status = err?.response?.status;
        const detail = err?.response?.data?.detail || err?.message || 'Unknown error';
        if (axios.isCancel(err) || err?.name === 'CanceledError' || err?.name === 'AbortError') {
            setRewriteBrief(`ℹ️ Canceled.`);
        } else if (err?.code === 'ECONNABORTED') {
            setRewriteBrief(`⚠️ Request timed out after 5 minutes. The local Gemma model is likely still loading, paging, or running out of memory. Check the backend console — it now prints '[rewrite]' and '[llm]' lines so you can see exactly where time is being spent.`);
        } else if (status) {
            setRewriteBrief(`⚠️ Backend returned ${status}: ${detail}`);
        } else {
            setRewriteBrief(`⚠️ Could not reach the backend at ${API_BASE}. Is the FastAPI server running?\n\nDetail: ${detail}`);
        }
    } finally {
        setIsGeneratingRewrite(false);
        rewriteAbortRef.current = null;
    }
  };

  return (
    <div className="workspace-container">
      <aside className="sidebar">
        <Link to="/" className="back-link">
          <ArrowLeft size={16} /> Back to Dashboard
        </Link>
        <div className="project-info">
          <h2 style={{ fontSize: '1.1rem', lineHeight: 1.3 }}>{projectName || `Project #${projectId}`}</h2>
          {projectDomain && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>{projectDomain}</div>}
          {analysisData && (() => {
            const fi = interpretFocusScore(analysisData.focus_score);
            return (
              <>
                <div className="stat">
                  <span>Focus Score:</span>
                  <strong style={{ color: fi.color }}>
                    {(analysisData.focus_score * 100).toFixed(1)}% — {fi.label}
                  </strong>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: 1.4 }}>
                  {fi.advice}
                </div>
                {analysisData.bullseye && (
                  <div className="stat" style={{ marginTop: '0.5rem' }}>
                    <span>Pages Analyzed:</span>
                    <strong>{analysisData.iqr_bullseye?.stats?.total ?? analysisData.bullseye.length}</strong>
                  </div>
                )}
                {analysisData.keyword_mappings && analysisData.keyword_mappings.length > 0 && (
                  <div className="stat">
                    <span>Keywords Mapped:</span>
                    <strong>{analysisData.keyword_mappings.length}</strong>
                  </div>
                )}
              </>
            );
          })()}
          <div className="embed-badge">
            Embeddings: <strong>{embedStatus?.model?.replace('google/', '') || 'embeddinggemma-2'}</strong>
            {embedStatus?.loaded ? ` · ${embedStatus.device}${embedStatus.dtype ? ` (${embedStatus.dtype})` : ''}` : embedStatus?.error ? '' : ' · loading…'}
            {embedStatus?.error && <div className="warn">Model failed to load: {String(embedStatus.error).slice(0, 160)}</div>}
            {embedStatus?.gpu?.warning && (
              <div className="warn" style={{ marginTop: '0.3rem' }} title={embedStatus.gpu.fix}>
                {embedStatus.gpu.warning} Fix: run <code>setup_gpu.ps1</code> in vws-backend.
              </div>
            )}
            <label className="dim-select" title={DIM_TIP}>
              Vector size
              <select value={analysisDim ?? ''} onChange={e => changeDim(Number(e.target.value))}>
                <option value={768}>768 (full, default)</option>
                <option value={512}>512</option>
                <option value={256}>256</option>
                <option value={128}>128</option>
              </select>
            </label>
            {analysisDim !== null && analysisDim !== 768 && <div className="muted" style={{ marginTop: '0.2rem' }}>{DIM_NOTE[analysisDim]}</div>}
            {analysisData?.vector_health?.needs_reembed && (
              <div className="warn" style={{ marginTop: '0.3rem' }}>
                {analysisData.vector_health.legacy ? 'Legacy 300-d vectors.' : 'Mixed vector models.'}{' '}
                <button className="link-btn" onClick={() => handleReembed(true)} disabled={!!ingestProgress}><RefreshCw size={11} /> Re-embed</button>
              </div>
            )}
          </div>
          <button className="btn-secondary" onClick={fetchMetadata} style={{marginTop: '0.75rem', width: '100%', fontSize: '0.8rem', padding: '0.35rem'}}>Inspect Dataset Metadata</button>
        </div>

        <nav className="view-tabs">
          <div className="tab-group-label">Act</div>
          <button className={activeTab === 'actions' ? 'active' : ''} onClick={() => setActiveTab('actions')}><span className="tab-emoji" aria-hidden><ListChecks size={15} /></span> Action Plan</button>
          <button className={activeTab === 'lab' ? 'active' : ''} onClick={() => setActiveTab('lab')}><span className="tab-emoji" aria-hidden><FlaskConical size={15} /></span> Relevance Lab</button>
          <div className="tab-group-label">Site Structure</div>
          <button className={activeTab === 'iqr_bullseye' ? 'active' : ''} onClick={() => setActiveTab('iqr_bullseye')}><span className="tab-emoji" aria-hidden>📊</span> Site Focus</button>
          <button className={activeTab === 'topic_map' ? 'active' : ''} onClick={() => setActiveTab('topic_map')}><span className="tab-emoji" aria-hidden>🛰️</span> Topic Clusters</button>
          <button className={activeTab === '3dmap' ? 'active' : ''} onClick={() => setActiveTab('3dmap')}><span className="tab-emoji" aria-hidden>🌐</span> 3D Topical Map</button>
          <button className={activeTab === 'semantic_drift' ? 'active' : ''} onClick={() => setActiveTab('semantic_drift')}><span className="tab-emoji" aria-hidden>🌊</span> Semantic Drift</button>
          <div className="tab-group-label">Queries &amp; Content</div>
          <button className={activeTab === 'bullseye' ? 'active' : ''} onClick={() => setActiveTab('bullseye')}><span className="tab-emoji" aria-hidden>🎯</span> Query Bullseye</button>
          <button className={activeTab === 'topical_gaps' ? 'active' : ''} onClick={() => setActiveTab('topical_gaps')}><span className="tab-emoji" aria-hidden>👻</span> Content Gaps</button>
          <button className={activeTab === 'intersection' ? 'active' : ''} onClick={() => setActiveTab('intersection')}><span className="tab-emoji" aria-hidden>⚔️</span> Intersection</button>
          <div className="tab-group-label">Links</div>
          <button className={activeTab === 'link_graph' ? 'active' : ''} onClick={() => setActiveTab('link_graph')}><span className="tab-emoji" aria-hidden><Network size={15} /></span> Link Graph</button>
          <button className={activeTab === 'link_opportunities' ? 'active' : ''} onClick={() => setActiveTab('link_opportunities')}><span className="tab-emoji" aria-hidden>⭐</span> Link Opportunities</button>
          <button className={activeTab === 'internal_matrix' ? 'active' : ''} onClick={() => setActiveTab('internal_matrix')}><span className="tab-emoji" aria-hidden>🕸️</span> Internal Link Health</button>
          <button className={activeTab === 'external_links' ? 'active' : ''} onClick={() => setActiveTab('external_links')}><span className="tab-emoji" aria-hidden>🔗</span> Backlink Relevance</button>
        </nav>

        <div className="upload-section">
          <h3>Data Ingestion</h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {projectId && (
                <UploadsPanel projectId={projectId} refreshKey={uploadsRefresh} pending={pendingUploads} notify={addToast}
                  onChanged={() => {
                    fetchAnalysis(distanceMetric); fetchEntities(); fetchStructure();
                    setPlanRefresh(k => k + 1); setLinkRefresh(k => k + 1);
                    axios.get(`${API_BASE}/api/projects/${projectId}/metadata`).then(r => setProjectMetadata(r.data)).catch(() => {});
                  }} />
              )}

              <label className="upload-btn">
                <Upload size={14} /> Upload Competitor CSV
                <input type="file" accept=".csv" onChange={handleCompFileChange} hidden />
              </label>
              
              {compHeaders.length > 0 && (
                 <div style={{ background: 'var(--bg-dark)', padding: '1rem', borderRadius: '6px', border: '1px solid var(--border)', fontSize: '0.85rem' }}>
                    <div style={{ marginBottom: '0.5rem' }}>
                        <label style={{ display: 'block', color: 'var(--text-muted)' }}>Competitor Domain Name:</label>
                        <input type="text" value={compName} onChange={e => setCompName(e.target.value)} placeholder="example.com" style={{ width: '100%', padding: '0.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'white', boxSizing: 'border-box' }}/>
                    </div>
                    <VectorSourcePicker file={compFile} value={compVectorSource} onChange={setCompVectorSource} />
                    <button className="btn-primary" style={{ width: '100%', padding: '0.5rem', marginTop: '0.75rem' }} onClick={submitCompFile} disabled={isUploading || !compName || !isVectorSourceValid(compVectorSource)}>Submit Competitor</button>
                 </div>
              )}
              
              <label className="upload-btn">
                <Upload size={14} /> Upload Keyword CSV
                <input type="file" accept=".csv" onChange={handleKwFileChange} hidden />
              </label>
              
              <label className="upload-btn" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                <Upload size={14} /> Upload External Links (Ahrefs)
                <input type="file" accept=".csv" onChange={(e) => handleLinkFileChange(e, "external")} hidden />
              </label>

              <label className="upload-btn" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                <Upload size={14} /> Upload Internal Nodes (Screaming Frog)
                <input type="file" accept=".csv" onChange={(e) => handleLinkFileChange(e, "internal")} hidden />
              </label>
              
              <button 
                  className="btn-secondary" 
                  style={{ width: '100%', fontSize: '0.8rem', padding: '0.5rem' }} 
                  onClick={() => fetchAnalysis(distanceMetric)}
                  disabled={loading}
              >
                  Refresh Graph Data
              </button>
          </div>
        </div>
      </aside>

      <main className="visualization-area">
        {/* View description banner */}
        {VIEW_INFO[activeTab] && !OWN_HOWTO.has(activeTab) && (
          <div className="view-description">
            <p>{VIEW_INFO[activeTab].description}</p>
          </div>
        )}

        <div className="vis-header" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <h2>{VIEW_INFO[activeTab]?.title || activeTab.toUpperCase()}</h2>
          
          {activeTab === '3dmap' && (
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginLeft: 'auto' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: '#94a3b8', cursor: 'pointer' }}>
                   <input 
                      type="checkbox" 
                      checked={isolateOpportunities} 
                      onChange={e => setIsolateOpportunities(e.target.checked)} 
                   />
                   Isolate SEO Opportunities
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: '#94a3b8' }}>
                   Color by
                   <select value={mapColorBy} onChange={e => setMapColorBy(e.target.value as any)} style={{ padding: '0.3rem', background: 'var(--bg-dark)', border: '1px solid var(--border)', color: 'white', borderRadius: 4 }}>
                     <option value="topic">Topic</option>
                     <option value="zone">Zone</option>
                     <option value="dataset">Dataset</option>
                   </select>
                </label>
                <div className="ghost-search" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Locate a query:</span>
                    <input 
                        type="text" 
                        placeholder="e.g. enterprise seo agency" 
                        value={ghostKeyword}
                        onChange={(e) => setGhostKeyword(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') locateGhost(); }}
                        style={{ padding: '0.4rem', borderRadius: '4px', background: 'var(--bg-dark)', border: '1px solid var(--border)', color: 'white' }}
                    />
                    <button className="btn-secondary" onClick={locateGhost} disabled={locating} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        {locating ? <Loader2 size={13} className="spinner" /> : <Crosshair size={13} />} Locate
                    </button>
                </div>
            </div>
          )}

          {activeTab === '3dmap' && (<>
          <div className="distance-selector" style={{ marginLeft: activeTab === '3dmap' ? '0' : 'auto' }}>
            <label>Distance Metric:</label>
            <select value={distanceMetric} onChange={handleMetricChange}>
              <option value="cosine">Cosine</option>
              <option value="euclidean">Euclidean</option>
              <option value="manhattan">Manhattan</option>
            </select>
          </div>

          <button
            className="btn-primary"
            onClick={handleGenerateInsight}
            disabled={insightLoading || !analysisData}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            {insightLoading ? <Loader2 size={14} className="spinner" /> : <Sparkles size={14} />}
            {insightLoading ? "Thinking…" : "Generate AI Insights"}
          </button>

          <button className="btn-secondary" onClick={handleExportCSV} disabled={isExporting || !analysisData}>
             Export Page Zones CSV
          </button>
          </>)}
        </div>

        {activeTab === '3dmap' && ghostMatches.length > 0 && (
          <div className="locate-results">
            <span>Closest pages to "<strong style={{ color: 'var(--text-main)' }}>{ghostPoint?.label}</strong>":</span>
            {ghostMatches.slice(0, 6).map(m => (
              <button key={m.url} title={`${m.url}\nOpen in Relevance Lab`} onClick={() => openLab({ queries: [ghostPoint?.label || ghostKeyword], url: m.url, autoRun: true })}>
                {shortUrl(m.url)} <span className="mono">{m.similarity.toFixed(3)}</span>
              </button>
            ))}
            <button onClick={() => { setGhostPoint(null); setGhostMatches([]); }} title="Clear">✕</button>
          </div>
        )}

        {activeTab === 'actions' && projectId && (
          <ActionPlan projectId={projectId} projectName={projectName} refreshKey={planRefresh} ingestProgress={ingestProgress}
            initialSearch={actionSearch}
            onOpenLab={openLab} onGenerateBrief={(k, u) => handleGenerateRewrite(k, u)} onReembed={handleReembed} notify={addToast} />
        )}
        {projectId && (
          <div style={{ display: activeTab === 'lab' ? 'block' : 'none' }}>
            <RelevanceLab projectId={projectId} initial={labInit} notify={addToast}
              onGenerateBrief={(k, u, ev) => handleGenerateRewrite(k, u, false, ev)} />
          </div>
        )}
        
        {viewInsights[activeTab] && (
            <div
                style={{
                    background: 'linear-gradient(180deg, rgba(56,189,248,0.10) 0%, rgba(56,189,248,0.04) 100%)',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    margin: '0 0 1rem 0',
                    padding: '1rem 1.25rem 1rem 1.25rem',
                    borderRadius: '12px',
                    position: 'relative',
                    textAlign: 'left',
                    color: '#e2e8f0',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        color: 'var(--accent)',
                        marginBottom: '0.4rem',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}
                >
                    <Sparkles size={14} />
                    <span>AI View Insights · Gemma 4</span>
                </div>
                <div
                    style={{
                        fontSize: '0.82rem',
                        lineHeight: '1.5',
                        color: '#e2e8f0',
                        paddingRight: '1.5rem',
                    }}
                >
                    {renderMarkdown(viewInsights[activeTab])}
                </div>
                <button
                    onClick={() => setViewInsights(prev => ({ ...prev, [activeTab]: '' }))}
                    aria-label="Dismiss insights"
                    style={{
                        position: 'absolute',
                        top: '0.4rem',
                        right: '0.5rem',
                        background: 'transparent',
                        border: 'none',
                        color: '#64748b',
                        cursor: 'pointer',
                        fontSize: '1.1rem',
                        lineHeight: 1,
                        padding: '0.25rem 0.4rem',
                        borderRadius: '4px',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(148, 163, 184, 0.15)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                    ✕
                </button>
            </div>
        )}

        {/* Quick Wins Summary — computed from analysis data */}
        {analysisData && activeTab === '3dmap' && (() => {
          const bs = analysisData.bullseye || [];
          const kw = analysisData.keyword_mappings || [];
          const lo = analysisData.link_opportunities || [];
          const tg = analysisData.topical_gaps || [];
          const sd = analysisData.semantic_drift || [];
          // Zones come from the IQR fences, so they hold for any embedding model's scale.
          const criticalDrift = sd.filter((s: any) => s.zone === 'Peripheral').length;
          const cannibalization = kw.filter((k: any) => k.cannibalization_risk).length;
          const outerRing = sd.filter((s: any) => s.zone === 'Expansion').length || bs.filter((b: any) => b.distance > 0.6).length;
          const hasIssues = criticalDrift > 0 || cannibalization > 0 || outerRing > 0 || lo.length > 0 || tg.length > 0;
          if (!hasIssues) return null;
          return (
            <div className="quick-wins">
              <div className="quick-wins-header">
                <TrendingUp size={16} />
                <span>Quick Wins — Top Actions for This Site</span>
                <button className="link-btn" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }} onClick={() => setActiveTab('actions')}><ListChecks size={13} /> Open the ranked Action Plan</button>
              </div>
              <div className="quick-wins-grid">
                {criticalDrift > 0 && (
                  <button className="qw-card qw-critical" onClick={() => setActiveTab('semantic_drift')}>
                    <AlertTriangle size={18} />
                    <div className="qw-stat">{criticalDrift}</div>
                    <div className="qw-label">off-topic pages (outside the IQR fence)</div>
                  </button>
                )}
                {outerRing > 0 && (
                  <button className="qw-card qw-warn" onClick={() => setActiveTab('bullseye')}>
                    <Target size={18} />
                    <div className="qw-stat">{outerRing}</div>
                    <div className="qw-label">pages far from your topical center</div>
                  </button>
                )}
                {lo.length > 0 && (
                  <button className="qw-card qw-good" onClick={() => setActiveTab('link_opportunities')}>
                    <CheckCircle size={18} />
                    <div className="qw-stat">{lo.length}</div>
                    <div className="qw-label">missing internal links to build</div>
                  </button>
                )}
                {tg.length > 0 && (
                  <button className="qw-card qw-info" onClick={() => setActiveTab('topical_gaps')}>
                    <TrendingUp size={18} />
                    <div className="qw-stat">{tg.length}</div>
                    <div className="qw-label">content gaps — topics you don't cover</div>
                  </button>
                )}
                {cannibalization > 0 && (
                  <button className="qw-card qw-warn" onClick={() => { setActiveTab('3dmap'); setKwFilterRiskOnly(true); }}>
                    <AlertTriangle size={18} />
                    <div className="qw-stat">{cannibalization}</div>
                    <div className="qw-label">keyword cannibalization risks</div>
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {projectId && ['bullseye', 'iqr_bullseye', 'topic_map'].includes(activeTab) && !structure && (
          <div className="act-loading">{structureLoading ? <><Loader2 className="spinner" size={22} /> Clustering topics and diagnosing pages…</> : 'No structure yet: this project needs at least 3 embedded pages.'}</div>
        )}
        {structure?.error && ['bullseye', 'iqr_bullseye', 'topic_map'].includes(activeTab) && (
          <div className="act-error">{structure.error}</div>
        )}
        {projectId && activeTab === 'bullseye' && (
          <QueryBullseyeView projectId={projectId} structure={structure && !structure.error ? structure : null}
            suggestions={(analysisData?.keyword_mappings || []).map((k: any) => ({ keyword: k.keyword, band: k.band || 'partial', volume: k.volume }))
              .sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0))}
            center={bullseyeCenter} selectedUrl={selectedUrl} onSelect={selectPage} onOpenLab={openLab}
            onBrief={(k, u) => handleGenerateRewrite(k, u)} />
        )}
        {structure && !structure.error && activeTab === 'iqr_bullseye' && (
          <SiteFocusView structure={structure} selectedUrl={selectedUrl} onSelect={selectPage} />
        )}
        {structure && !structure.error && activeTab === 'topic_map' && (
          <TopicClustersView structure={structure} selectedUrl={selectedUrl} onSelect={selectPage} onOpenLab={openLab}
            onCenterPage={centerBullseye} onArchitecture={runArchitecture} />
        )}
        {projectId && activeTab === 'semantic_drift' && (
          <DriftView projectId={projectId} refreshKey={linkRefresh} selectedUrl={selectedUrl} onSelect={selectPage} onOpenLab={openLab}
            onLoaded={d => { driftRef.current = d; }} />
        )}
        {projectId && activeTab === 'link_graph' && (
          <LinkGraphView projectId={projectId} refreshKey={linkRefresh} onSelect={selectPage} notify={addToast}
            onLoaded={d => { linkGraphRef.current = d; }} />
        )}
        {projectId && (activeTab === 'internal_matrix' || activeTab === 'external_links') && (
          <LinkHealthView projectId={projectId} kind={activeTab === 'internal_matrix' ? 'internal' : 'external'} refreshKey={linkRefresh}
            onSelect={selectPage} notify={addToast} onLoaded={d => { linkHealthRef.current = d; }} />
        )}
        {projectId && activeTab === 'link_opportunities' && (
          <ActionPlan projectId={projectId} projectName={projectName} refreshKey={planRefresh} ingestProgress={ingestProgress}
            lockedTypes={['internal_link', 'weak_link']} compact
            onOpenLab={openLab} onGenerateBrief={(k, u) => handleGenerateRewrite(k, u)} onReembed={handleReembed} notify={addToast} />
        )}
        {projectId && activeTab === 'topical_gaps' && (
          <ActionPlan projectId={projectId} projectName={projectName} refreshKey={planRefresh} ingestProgress={ingestProgress}
            lockedTypes={['create', 'competitor_gap']}
            onOpenLab={openLab} onGenerateBrief={(k, u) => handleGenerateRewrite(k, u)} onReembed={handleReembed} notify={addToast} />
        )}
        {projectId && activeTab === 'intersection' && (
          <IntersectionView projectId={projectId} entities={entities} onOpenLab={openLab} onSelect={selectPage} notify={addToast} />
        )}

        {activeTab === '3dmap' && (
        <div className="vis-content">
          {loading ? (
            <div className="placeholder-viz" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
              <Loader2 className="spinner" size={48} />
              Analyzing your content topology...
            </div>
          ) : analysisData ? (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
                {analysisData.umap && analysisData.umap.length === 0 && (
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(15, 23, 42, 0.8)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
                        <div style={{ background: 'var(--bg-card)', padding: '2rem', borderRadius: '12px', border: '1px solid var(--border)', textAlign: 'center', maxWidth: '400px', width: '100%' }}>
                            <Loader2 className="spinner" size={48} style={{ margin: '0 auto 1rem auto', color: 'var(--accent)' }}/>
                            <h2 style={{ marginTop: 0, color: 'var(--text-main)' }}>{ingestProgress ? 'Ingesting Data...' : 'Rendering Topology...'}</h2>
                            
                            {ingestProgress ? (
                                <div style={{ marginTop: '1.5rem', textAlign: 'left' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                                        <span>{ingestProgress.phase || 'Processing'}: {ingestProgress.current} of {ingestProgress.total}</span>
                                        <span>{Math.round((ingestProgress.current / ingestProgress.total) * 100)}%</span>
                                    </div>
                                    <div style={{ width: '100%', height: '8px', background: 'var(--bg-dark)', borderRadius: '4px', overflow: 'hidden', marginBottom: '1rem' }}>
                                        <div style={{ width: `${(ingestProgress.current / ingestProgress.total) * 100}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.5s ease-out' }} />
                                    </div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                                        Estimated Time Remaining: {ingestProgress.estimated_time_remaining > 60 ? `${Math.round(ingestProgress.estimated_time_remaining / 60)} minutes` : `${Math.round(ingestProgress.estimated_time_remaining)} seconds`}
                                    </div>
                                </div>
                            ) : (
                                <div style={{ marginTop: '1.5rem', textAlign: 'left' }}>
                                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1rem' }}>Calculating semantic distances and projecting vector mathematics into 3D space. This usually takes 5-15 seconds.</p>
                                    <div style={{ width: '100%', height: '8px', background: 'var(--bg-dark)', borderRadius: '4px', overflow: 'hidden', marginBottom: '0.5rem', position: 'relative' }}>
                                        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '40%', background: 'var(--accent)', animation: 'indeterminate 1.5s infinite ease-in-out', borderRadius: '4px' }} />
                                    </div>
                                    <style>{`
                                        @keyframes indeterminate {
                                            0% { left: -40%; }
                                            50% { left: 100%; width: 40%; }
                                            100% { left: -40%; width: 40%; }
                                        }
                                    `}</style>
                                </div>
                            )}
                        </div>
                    </div>
                )}
                <div style={{ height: '600px', position: 'relative', overflow: activeTab === '3dmap' ? 'hidden' : 'visible', opacity: isolateOpportunities && activeTab === '3dmap' ? 0.8 : 1 }}>
                  {activeTab === '3dmap' && (
                      <VisualMap3D 
                        data={isolateOpportunities ? analysisData.umap.filter((n:any)=>n.source_type !== 'base') : analysisData.umap} 
                        ghostPoint={ghostPoint} 
                        onPointClick={(n: any) => n?.raw_url && selectPage(n.raw_url)} 
                        colorBy={mapColorBy}
                        structure={structure}
                      />
                  )}
                </div>
                
                {/* Keyword Data Table inside Visualization Area if keywords injected */}
                {analysisData.keyword_mappings && analysisData.keyword_mappings.length > 0 && activeTab === '3dmap' && (
                    <div style={{ minHeight: '280px', maxHeight: '420px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)', padding: '0.85rem 1rem', overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.75rem', gap: '1rem', flexWrap: 'wrap' }}>
                            <h3 style={{ margin: 0, fontSize: '1rem' }}>Keyword Coverage — How Well Your Content Matches Target Keywords</h3>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Showing {filteredKeywordMappings.length} of {analysisData.keyword_mappings.length}
                                {(kwFilterKeyword || kwFilterUrl || kwFilterDataset || kwFilterMinDist || kwFilterMaxDist || kwFilterRiskOnly) && (
                                    <button
                                        onClick={() => {
                                            setKwFilterKeyword(''); setKwFilterUrl(''); setKwFilterDataset('');
                                            setKwFilterMinDist(''); setKwFilterMaxDist(''); setKwFilterRiskOnly(false);
                                        }}
                                        style={{ marginLeft: '0.75rem', background: 'transparent', border: '1px solid var(--border)', color: 'var(--accent)', fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: '4px', cursor: 'pointer' }}
                                    >
                                        Clear Filters
                                    </button>
                                )}
                            </div>
                        </div>

                        {(() => {
                            const sortIndicator = (key: KwSortKey) => kwSortKey !== key ? ' ⇅' : (kwSortDir === 'asc' ? ' ▲' : ' ▼');
                            const thBase: React.CSSProperties = { padding: '0.5rem', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' };
                            const filterInput: React.CSSProperties = { width: '100%', padding: '0.3rem 0.4rem', background: 'var(--bg-dark)', border: '1px solid var(--border)', color: 'white', borderRadius: '4px', fontSize: '0.75rem', boxSizing: 'border-box' };
                            return (
                                <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                                    <colgroup>
                                        <col style={{ width: '24%' }} />
                                        <col style={{ width: '32%' }} />
                                        <col style={{ width: '13%' }} />
                                        <col style={{ width: '12%' }} />
                                        <col style={{ width: '19%' }} />
                                    </colgroup>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', textAlign: 'left' }}>
                                            <th style={thBase} onClick={() => handleKwSort('keyword')} title="Click to sort by keyword">Keyword{sortIndicator('keyword')}</th>
                                            <th style={thBase} onClick={() => handleKwSort('closest_url')} title="Click to sort by URL">Closest Matching Target URL{sortIndicator('closest_url')}</th>
                                            <th style={thBase} onClick={() => handleKwSort('dataset')} title="Click to sort by dataset">Dataset{sortIndicator('dataset')}</th>
                                            <th style={thBase} onClick={() => handleKwSort('distance')} title="Click to sort by match score (higher = better)">Match Score{sortIndicator('distance')}</th>
                                            <th style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>AI Action</th>
                                        </tr>
                                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                            <th style={{ padding: '0.3rem 0.5rem' }}>
                                                <input
                                                    type="text"
                                                    placeholder="Filter..."
                                                    value={kwFilterKeyword}
                                                    onChange={e => setKwFilterKeyword(e.target.value)}
                                                    style={filterInput}
                                                />
                                            </th>
                                            <th style={{ padding: '0.3rem 0.5rem' }}>
                                                <input
                                                    type="text"
                                                    placeholder="Filter URL..."
                                                    value={kwFilterUrl}
                                                    onChange={e => setKwFilterUrl(e.target.value)}
                                                    style={filterInput}
                                                />
                                            </th>
                                            <th style={{ padding: '0.3rem 0.5rem' }}>
                                                <select
                                                    value={kwFilterDataset}
                                                    onChange={e => setKwFilterDataset(e.target.value)}
                                                    style={filterInput}
                                                >
                                                    <option value="">All datasets</option>
                                                    {kwDatasets.map(ds => (
                                                        <option key={ds} value={ds}>{ds}</option>
                                                    ))}
                                                </select>
                                            </th>
                                            <th style={{ padding: '0.3rem 0.5rem' }}>
                                                <div style={{ display: 'flex', gap: '0.25rem' }}>
                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        placeholder="min"
                                                        value={kwFilterMinDist}
                                                        onChange={e => setKwFilterMinDist(e.target.value)}
                                                        style={{ ...filterInput, width: '50%' }}
                                                    />
                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        placeholder="max"
                                                        value={kwFilterMaxDist}
                                                        onChange={e => setKwFilterMaxDist(e.target.value)}
                                                        style={{ ...filterInput, width: '50%' }}
                                                    />
                                                </div>
                                            </th>
                                            <th style={{ padding: '0.3rem 0.5rem' }}>
                                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', fontWeight: 'normal' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={kwFilterRiskOnly}
                                                        onChange={e => setKwFilterRiskOnly(e.target.checked)}
                                                    />
                                                    Risk only
                                                </label>
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredKeywordMappings.length === 0 ? (
                                            <tr>
                                                <td colSpan={5} style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                                    No keyword mappings match the current filters.
                                                </td>
                                            </tr>
                                        ) : filteredKeywordMappings.map((km: any, i: number) => {
                                            const hasBrief = savedBriefKeys.has(briefKey(km.keyword, km.closest_url));
                                            const dist = typeof km.distance === 'number' ? km.distance : parseFloat(km.distance);
                                            const match = Math.max(0, Math.min(1, 1 - dist));
                                            const priority = matchPriority(match);
                                            return (
                                            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: km.cannibalization_risk ? 'rgba(239, 68, 68, 0.1)' : 'transparent', lineHeight: 1.3 }}>
                                                <td style={{ padding: '0.25rem 0.5rem', wordBreak: 'break-word', overflowWrap: 'anywhere' }} title={km.keyword}>
                                                    <strong>{km.keyword}</strong>
                                                    {km.cannibalization_risk && <span style={{ color: '#ef4444', fontSize: '0.7rem', marginLeft: '0.4rem' }} title="Cannibalization Risk — multiple pages competing for this keyword">⚠️ cannibalizing</span>}
                                                    {hasBrief && <span style={{ color: '#10b981', fontSize: '0.7rem', marginLeft: '0.4rem' }} title="Saved brief available">📄</span>}
                                                </td>
                                                <td style={{ padding: '0.25rem 0.5rem', color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={km.closest_url}>{km.closest_url}</td>
                                                <td style={{ padding: '0.25rem 0.5rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={km.dataset}>{km.dataset}</td>
                                                <td style={{ padding: '0.25rem 0.5rem', whiteSpace: 'nowrap' }}>
                                                    <span style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{(match * 100).toFixed(1)}%</span>
                                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', fontWeight: 600, color: priority.color, background: `${priority.color}18`, padding: '0.1rem 0.35rem', borderRadius: '3px' }}>{priority.label}</span>
                                                </td>
                                                <td style={{ padding: '0.25rem 0.5rem' }}>
                                                    <button
                                                        className={hasBrief ? "btn-secondary" : "btn-primary"}
                                                        style={{
                                                            fontSize: '0.7rem',
                                                            padding: '0.2rem 0.55rem',
                                                            whiteSpace: 'nowrap',
                                                            ...(hasBrief
                                                                ? { background: 'rgba(16, 185, 129, 0.15)', borderColor: 'rgba(16, 185, 129, 0.45)', color: '#86efac' }
                                                                : {}),
                                                        }}
                                                        onClick={() => handleGenerateRewrite(km.keyword, km.closest_url)}
                                                        title={hasBrief ? "View saved brief (no regeneration cost)" : `${priority.action}`}
                                                    >
                                                        {hasBrief ? '📄 View' : '🚀 Rewrite'}
                                                    </button>
                                                    <button
                                                        className="btn-secondary"
                                                        style={{ fontSize: '0.7rem', padding: '0.2rem 0.45rem', marginLeft: '0.3rem', whiteSpace: 'nowrap' }}
                                                        onClick={() => openLab({ queries: [km.keyword], url: km.own_url || km.closest_url, autoRun: true })}
                                                        title="Score this page's passages against the keyword"
                                                    >
                                                        Lab
                                                    </button>
                                                </td>
                                            </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            );
                        })()}
                    </div>
                )}
            </div>
          ) : (
            <div className="placeholder-viz">Failed to load data</div>
          )}
        </div>
        )}
      </main>

      {selectedPage && activeTab !== 'actions' && activeTab !== 'lab' && (
        <PageDrawer page={selectedPage} actions={drawerActions} linkGraphLoaded={structure?.link_graph_loaded}
          onClose={() => setSelectedUrl(null)} onSelectUrl={selectPage} onOpenLab={openLab} onOpenActions={openActionsFor}
          onCenter={centerBullseye} onBrief={(k, u) => handleGenerateRewrite(k, u)} notify={addToast} />
      )}

      {/* AI Rewrite Modal */}
      {rewriteModalOpen && (
          <div className="modal-backdrop" onClick={() => setRewriteModalOpen(false)}>
              <div className="modal" style={{ width: '800px', maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto', textAlign: 'left' }} onClick={e => e.stopPropagation()}>
                  <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem', marginBottom: '1rem', textAlign: 'left' }}>
                      <h2 style={{ margin: 0, textAlign: 'left' }}>Gemma 4 AI Rewrite Execution</h2>
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0.5rem 0 0 0', textAlign: 'left' }}>
                          Targeting <strong>{activeRewriteTarget.keyword}</strong> via <span style={{ color: 'var(--accent)' }}>{activeRewriteTarget.url}</span>
                      </p>
                  </div>

                  <div style={{ background: 'var(--bg-dark)', padding: '1.25rem 1.5rem', borderRadius: '8px', minHeight: '200px', fontSize: '0.9rem', lineHeight: '1.5', color: '#e2e8f0', textAlign: 'left' }}>
                      {isGeneratingRewrite ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                                  <Loader2 className="spinner" size={20} />
                                  <span style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
                                      Quantized Local Gemma-4-E2B generating brief… <span style={{ color: 'var(--accent)' }}>{rewriteElapsed}s</span>
                                  </span>
                              </div>
                              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                  Rewrite briefs ask Gemma for up to 600 tokens of structured output and typically take 30–90 seconds on CPU. The modal will update when generation finishes.
                              </div>
                          </div>
                      ) : (
                          rewriteBrief
                              ? renderMarkdown(rewriteBrief)
                              : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No content returned.</span>
                      )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.25rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          {!isGeneratingRewrite && rewriteBrief && !rewriteBrief.startsWith('⚠️') && !rewriteBrief.startsWith('ℹ️ Canceled') && (
                              <>
                                  <button
                                      className="btn-secondary"
                                      onClick={() => handleGenerateRewrite(activeRewriteTarget.keyword, activeRewriteTarget.url, true)}
                                      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                                      title="Discard the saved brief and run Gemma again"
                                  >
                                      <Sparkles size={14} /> Regenerate
                                  </button>
                                  <button
                                      className="btn-secondary"
                                      onClick={exportRewriteAsWord}
                                      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                                      title="Download as Word document (.doc)"
                                  >
                                      <FileDown size={14} /> Download Word
                                  </button>
                                  <button
                                      className="btn-secondary"
                                      onClick={exportRewriteAsGoogleDoc}
                                      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                                      title="Copy to clipboard and open a new Google Doc"
                                  >
                                      <FileText size={14} /> Open in Google Docs
                                  </button>
                              </>
                          )}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                          {isGeneratingRewrite && (
                              <button
                                  className="btn-secondary"
                                  style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.4)', color: '#fca5a5' }}
                                  onClick={cancelRewrite}
                              >
                                  Cancel Generation
                              </button>
                          )}
                          <button className="btn-secondary" onClick={() => { cancelRewrite(); setRewriteModalOpen(false); }}>Close</button>
                      </div>
                  </div>

                  {exportToast && (
                      <div
                          style={{
                              marginTop: '1rem',
                              padding: '0.6rem 0.9rem',
                              background: 'rgba(16, 185, 129, 0.12)',
                              border: '1px solid rgba(16, 185, 129, 0.35)',
                              borderRadius: '6px',
                              color: '#86efac',
                              fontSize: '0.85rem',
                              textAlign: 'left',
                          }}
                      >
                          {exportToast}
                      </div>
                  )}
              </div>
          </div>
      )}
      {metadataModalOpen && projectMetadata && (
        <div className="rewrite-modal-backdrop" onClick={() => setMetadataModalOpen(false)}>
            <div className="rewrite-modal" onClick={e => e.stopPropagation()} style={{maxWidth: '600px'}}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
                    <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Project Metadata</h2>
                    <span style={{color: 'var(--text-muted)'}}>Created: {projectMetadata.project.created_at}</span>
                </div>
                
                <p><strong>Crawl Mode:</strong> {projectMetadata.project.crawl_mode?.toUpperCase() || 'CSV/EXTERNAL'}</p>
                <p><strong>Domain:</strong> {projectMetadata.project.domain}</p>
                {projectMetadata.project.vector_sources && Object.keys(projectMetadata.project.vector_sources).length > 0 && (
                    <div style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
                        <strong>Imported vectors</strong>
                        {Object.values(projectMetadata.project.vector_sources).map((v: any) => (
                            <div key={v.source_name} style={{ color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                                {v.source_name}: <code>{v.column}</code> · {v.dim}-d · declared <strong style={{ color: 'var(--text-main)' }}>{v.declared_model}</strong>
                                {v.verified === true && <span style={{ color: '#10b981' }}> · verified ({v.probe_similarity})</span>}
                                {v.verified === false && <span style={{ color: '#ef4444' }}> · did not match the declared model ({v.probe_similarity})</span>}
                                {v.rows_without_vectors > 0 && <span> · {v.rows_without_vectors} rows without vectors</span>}
                            </div>
                        ))}
                    </div>
                )}
                
                {(projectMetadata.uploads?.length ?? 0) > 0 && <>
                <h3 style={{marginTop: '1.5rem', marginBottom: '0.5rem'}}>Uploaded files</h3>
                <table className="meta-t">
                    <thead><tr><th>File</th><th>Status</th><th className="num">Added</th></tr></thead>
                    <tbody>
                        {projectMetadata.uploads.map((u: any, idx: number) => (
                            <tr key={u.id ?? `l${idx}`} title={u.message || ''}>
                                <td><div className="meta-file">{u.filename}</div><div className="muted small">{u.kind_label}{u.legacy ? ' · imported before file tracking' : ''}</div></td>
                                <td className={`meta-st ${u.status}`}>{u.status === 'done' ? 'Loaded' : u.status[0].toUpperCase() + u.status.slice(1)}</td>
                                <td className="num">{metaAdded(u)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                </>}

                <h3 style={{marginTop: '1.5rem', marginBottom: '0.5rem'}}>What's in the project</h3>
                <table className="meta-t">
                    <thead><tr><th>Data</th><th>Source</th><th className="num">Count</th></tr></thead>
                    <tbody>
                        {projectMetadata.files.map((file: any, idx: number) => (
                            <tr key={idx}>
                                <td>{META_LABEL[file.source_type] || file.source_type}</td>
                                <td className="muted">{file.source_name}</td>
                                <td className="num meta-n">{Number(file.volume).toLocaleString()}</td>
                            </tr>
                        ))}
                        {Object.entries(projectMetadata.links || {}).map(([kind, n]: [string, any]) => (
                            <tr key={`links-${kind}`}>
                                <td>{kind === 'external' ? 'Backlinks' : kind === 'internal' ? 'Internal links' : `${kind} links`}</td>
                                <td className="muted">{kind === 'external' ? 'Links from other sites to yours' : 'Links between your pages'}</td>
                                <td className="num meta-n">{Number(n).toLocaleString()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                <button className="btn-secondary" onClick={() => setMetadataModalOpen(false)} style={{width: '100%', marginTop: '1.5rem'}}>Close</button>
            </div>
        </div>
      )}
      <ToastContainer />
    </div>
  );
}

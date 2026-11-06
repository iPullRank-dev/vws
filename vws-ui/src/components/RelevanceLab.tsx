import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, Check, CheckCircle, Copy, FlaskConical, Loader2, MinusCircle, Pencil, RefreshCw, RotateCcw, Sparkles, Wand2, X } from 'lucide-react';
import { API_BASE } from '../config';
import { BAND_COLOR, copyText, fmt, heatColor, shortUrl, verdictOf } from '../lib/vws';
import type { LabPayload } from '../lib/vws';
import './act.css';

interface Passage { index: number; heading: string; text: string; words: number; scores: number[] }
interface CompetitorResult {
  url: string; title?: string; error?: string; passage_count?: number;
  doc_scores?: number[]; best_passages?: ({ score: number; heading: string; text: string } | null)[];
}
interface LabResult {
  error?: string;
  url: string | null; title: string; source: string; char_count: number; model: string;
  thresholds: { strong: number; gap: number };
  max_tokens?: number;
  dim?: number;
  queries: string[];
  document: { scores: number[] };
  passages: Passage[];
  per_query: { query: string; doc_score: number; best_passage: number | null; best_score: number | null; verdict: string;
    competitor_best?: { url: string; score: number; delta: number } }[];
  competitors: CompetitorResult[];
  seconds: number;
}
interface Rescore { passages: number[][]; document: number[]; verdicts: string[] }
interface Suggestion {
  status: 'queued' | 'loading' | 'ready' | 'error' | 'accepted' | 'rejected';
  started: number;
  variant: number;
  targets: number[];
  baseText: string;            // the text the rewrite was generated from
  prevEdit?: string;           // what the passage held before Accept (for Undo)
  text?: string;
  before?: number[];
  after?: number[];
  deltas?: number[];
  verdicts_before?: string[];
  verdicts_after?: string[];
  target_gain?: number;
  verdict?: 'improves' | 'mixed' | 'no_gain';
  why?: string;
  placeholders?: string[];
  words_before?: number;
  words_after?: number;
  model?: string;
  seconds?: number;
  error?: string;
}

interface Props {
  projectId: string;
  initial: (LabPayload & { nonce: number }) | null;
  onGenerateBrief: (keyword: string, url: string, evidence: string) => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const VERDICT_LABEL: Record<string, string> = { covered: 'Covered', partial: 'Partial', missing: 'Missing' };

export default function RelevanceLab({ projectId, initial, onGenerateBrief, notify }: Props) {
  const [queriesText, setQueriesText] = useState('');
  const [url, setUrl] = useState('');
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [compareText, setCompareText] = useState('');
  const [pages, setPages] = useState<{ url: string; title: string; source_type: string }[]>([]);

  const [result, setResult] = useState<LabResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [activeQ, setActiveQ] = useState(0);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [rescore, setRescore] = useState<Rescore | null>(null);
  const [rescoredEdits, setRescoredEdits] = useState<string>('');
  const [rescoring, setRescoring] = useState(false);
  const [sortMode, setSortMode] = useState<'doc' | 'low' | 'high'>('doc');
  const [expandedP, setExpandedP] = useState<Set<number>>(new Set());
  const passageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  // Heatmap: the cell you clicked stays selected, and the passage it points to is outlined.
  const [sel, setSel] = useState<{ p: number; q: number } | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [hover, setHover] = useState<{ p: number; q: number; x: number; y: number } | null>(null);
  const heatWrapRef = useRef<HTMLDivElement | null>(null);
  // AI rewrite suggestions, keyed by passage index. Requests run one at a time.
  const [suggestions, setSuggestions] = useState<Record<number, Suggestion>>({});
  const chain = useRef<Promise<void>>(Promise.resolve());
  const runId = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    axios.get(`${API_BASE}/api/projects/${projectId}/pages`).then(r => setPages(r.data.pages || [])).catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const s = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - s) / 1000)), 1000);
    return () => clearInterval(id);
  }, [loading]);

  const busySuggestions = Object.values(suggestions).some(x => x.status === 'loading' || x.status === 'queued');
  useEffect(() => {
    if (!busySuggestions) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [busySuggestions]);

  const run = async (qs: string[], u: string, compare: string[], paste?: { text: string; title: string }) => {
    if (!qs.length) { setError('Enter at least one query.'); return; }
    setLoading(true); setError(''); setEdits({}); setRescore(null); setEditing(null); setActiveQ(0);
    setSel(null); setSuggestions({}); runId.current += 1;
    try {
      const res = await axios.post(`${API_BASE}/api/projects/${projectId}/lab/analyze`, {
        queries: qs, url: paste ? null : u || null, text: paste?.text || null, title: paste?.title || null,
        compare_urls: compare,
      }, { timeout: 600000 });
      if (res.data.error) { setError(res.data.error); setResult(null); }
      else setResult(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Analysis failed.');
    } finally {
      setLoading(false);
    }
  };

  // Populate from an Action Plan / keyword-table hand-off.
  useEffect(() => {
    if (!initial) return;
    const qs = (initial.queries || []).filter(Boolean);
    setQueriesText(qs.join('\n'));
    setUrl(initial.url || '');
    setCompareText((initial.compare_urls || []).join('\n'));
    // No page yet (e.g. a "create" action): open the draft pane instead.
    setPasteMode(!initial.url);
    if (initial.autoRun && qs.length && (initial.url || (initial.compare_urls || []).length)) {
      if (initial.url) run(qs, initial.url, initial.compare_urls || []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.nonce]);

  const queries = result?.queries || [];
  const th = result?.thresholds || { strong: 0.76, gap: 0.66 };
  const editKey = JSON.stringify(edits);
  const dirty = Object.keys(edits).length > 0 && editKey !== rescoredEdits;

  const scoresOf = (i: number) => (rescore ? rescore.passages[i] : result?.passages[i]?.scores) || [];
  const docScores = rescore ? rescore.document : result?.document.scores || [];

  const perQuery = useMemo(() => {
    if (!result) return [];
    return queries.map((q, qi) => {
      let best = -1, bestS = -Infinity;
      result.passages.forEach((_, i) => { const s = scoresOf(i)[qi]; if (s > bestS) { bestS = s; best = i; } });
      const doc = docScores[qi];
      const top = Math.max(doc, best >= 0 ? bestS : doc);
      return {
        query: q, doc, origDoc: result.document.scores[qi], best, bestS: best >= 0 ? bestS : null,
        origBest: result.per_query[qi]?.best_score ?? null, verdict: verdictOf(top, th), competitor: result.per_query[qi]?.competitor_best,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, rescore]);

  // Global "Suggest rewrites": for each query that isn't covered, its best passage.
  const suggestPlan = useMemo(() => {
    const byP = new Map<number, number[]>();
    perQuery.forEach((pq, qi) => { if (pq.verdict !== 'covered' && pq.best >= 0) byP.set(pq.best, [...(byP.get(pq.best) || []), qi]); });
    return [...byP.entries()].slice(0, 4).map(([p, qs]) => ({ p, qs }));
  }, [perQuery]);
  const sugCounts = useMemo(() => {
    const v = Object.values(suggestions);
    return { ready: v.filter(x => x.status === 'ready').length, improves: v.filter(x => x.status === 'ready' && x.verdict === 'improves').length };
  }, [suggestions]);

  const heatRange = useMemo(() => {
    if (!result) return { lo: 0.5, hi: 0.85 };
    const all = result.passages.flatMap(p => p.scores);
    return { lo: Math.min(th.gap - 0.08, ...all), hi: Math.max(th.strong + 0.04, ...all) };
  }, [result, th.gap, th.strong]);

  const orderedPassages = useMemo(() => {
    if (!result) return [];
    // Sort on the live page's scores so an edited passage stays put while you iterate.
    const ps = [...result.passages];
    if (sortMode === 'low') ps.sort((a, b) => (a.scores[activeQ] ?? 0) - (b.scores[activeQ] ?? 0));
    if (sortMode === 'high') ps.sort((a, b) => (b.scores[activeQ] ?? 0) - (a.scores[activeQ] ?? 0));
    return ps;
  }, [result, sortMode, activeQ]);

  const doRescore = async () => {
    if (!result) return;
    setRescoring(true);
    try {
      const passages = result.passages.map(p => ({ heading: p.heading, text: edits[p.index] ?? p.text }));
      const res = await axios.post(`${API_BASE}/api/lab/score`, { queries, passages, title: result.title, dim: result.dim }, { timeout: 300000 });
      if (res.data.error) notify(res.data.error, 'error');
      else { setRescore(res.data); setRescoredEdits(editKey); }
    } catch (e: any) {
      notify(e?.response?.data?.detail || e?.message || 'Re-score failed.', 'error');
    } finally {
      setRescoring(false);
    }
  };

  const jumpTo = (i: number, qi?: number) => {
    const q = qi ?? activeQ;
    if (qi !== undefined) setActiveQ(qi);
    setSel({ p: i, q });
    setSortMode('doc');
    setExpandedP(prev => new Set(prev).add(i));
    setFlash(null);
    setTimeout(() => {
      passageRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlash(i);
      setTimeout(() => setFlash(f => (f === i ? null : f)), 1800);
    }, 30);
  };

  // --- AI rewrite suggestions -------------------------------------------------
  const textOf = (i: number) => (result ? edits[i] ?? result.passages[i]?.text ?? '' : '');

  const requestSuggestion = (pi: number, targets: number[], variant = 0) => {
    if (!result) return;
    const res = result;
    const myRun = runId.current;
    const p = res.passages[pi];
    const base = textOf(pi);
    const before = pi > 0 ? textOf(pi - 1) : '';
    const after = pi < res.passages.length - 1 ? textOf(pi + 1) : '';
    setSuggestions(s => ({ ...s, [pi]: { status: 'queued', started: Date.now(), variant, targets, baseText: base } }));
    chain.current = chain.current.then(async () => {
      if (runId.current !== myRun) return;
      setSuggestions(s => (s[pi]?.status === 'queued' ? { ...s, [pi]: { ...s[pi], status: 'loading', started: Date.now() } } : s));
      try {
        const r = await axios.post(`${API_BASE}/api/lab/suggest`, {
          queries: res.queries, passage: { heading: p.heading, text: base }, title: res.title, targets, dim: res.dim,
          before, after, variant,
        }, { timeout: 900000 });
        if (runId.current !== myRun) return;
        setSuggestions(s => ({ ...s, [pi]: r.data.error ? { ...s[pi], status: 'error', error: r.data.error } : { ...s[pi], ...r.data, status: 'ready' } }));
      } catch (e: any) {
        if (runId.current !== myRun) return;
        setSuggestions(s => ({ ...s, [pi]: { ...s[pi], status: 'error', error: e?.response?.data?.detail || e?.message || 'Suggestion failed.' } }));
      }
    });
  };

  const acceptSuggestion = (pi: number, thenEdit = false) => {
    const sg = suggestions[pi];
    if (!sg?.text) return;
    setSuggestions(s => ({ ...s, [pi]: { ...s[pi], status: 'accepted', prevEdit: edits[pi] } }));
    setEdits(e => ({ ...e, [pi]: sg.text! }));
    if (thenEdit) setEditing(pi);
  };
  const undoAccept = (pi: number) => {
    const sg = suggestions[pi];
    setEdits(e => { const n = { ...e }; if (sg?.prevEdit === undefined) delete n[pi]; else n[pi] = sg.prevEdit; return n; });
    setSuggestions(s => ({ ...s, [pi]: { ...s[pi], status: 'ready' } }));
  };
  const rejectSuggestion = (pi: number) => setSuggestions(s => ({ ...s, [pi]: { ...s[pi], status: 'rejected' } }));

  const buildEvidence = () => {
    if (!result) return '';
    const lines: string[] = ['Per query (page score / best passage / verdict):'];
    perQuery.forEach(p => lines.push(`- "${p.query}": page ${fmt(p.doc)} / §${p.best + 1} ${fmt(p.bestS)} / ${p.verdict}` +
      (p.competitor ? ` (best competitor ${fmt(p.competitor.score)} at ${p.competitor.url})` : '')));
    const head = 0;
    const weakest = [...result.passages].sort((a, b) => scoresOf(a.index)[head] - scoresOf(b.index)[head]).slice(0, 4);
    lines.push(`Weakest passages for "${queries[head]}":`);
    weakest.forEach(p => lines.push(`- §${p.index + 1} (${fmt(scoresOf(p.index)[head])}): ${(edits[p.index] ?? p.text).slice(0, 160).replace(/\s+/g, ' ')}…`));
    const missing = perQuery.filter(p => p.verdict === 'missing').map(p => `"${p.query}"`);
    if (missing.length) lines.push(`Sub-queries with no passage that answers them: ${missing.join(', ')}`);
    return lines.join('\n');
  };

  const copyEdits = async () => {
    if (!result) return;
    const md = result.passages.filter(p => edits[p.index] !== undefined && edits[p.index] !== p.text).map(p =>
      `### §${p.index + 1}${p.heading ? ` · ${p.heading}` : ''}\n\n**Before**\n\n${p.text}\n\n**After**\n\n${edits[p.index]}`).join('\n\n---\n\n');
    notify((await copyText(md || 'No edits.')) ? 'Edited passages copied (before/after Markdown).' : 'Copy failed.', 'info');
  };

  const submit = () => {
    const qs = queriesText.split('\n').map(s => s.trim()).filter(Boolean);
    const compare = compareText.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    run(qs, url.trim(), compare, pasteMode ? { text: pasteText, title: pasteTitle } : undefined);
  };

  const editedCount = result ? result.passages.filter(p => edits[p.index] !== undefined && edits[p.index] !== p.text).length : 0;

  return (
    <div className="lab">
      <section className="lab-input act-card">
        <div className="lab-input-grid">
          <label className="lab-field">
            <span>Queries <small>head query first, then fan-out sub-queries, one per line</small></span>
            <textarea rows={5} value={queriesText} onChange={e => setQueriesText(e.target.value)}
              placeholder={'enterprise seo agency\nhow do enterprise seo agencies price retainers\nenterprise seo vs in-house team'} />
          </label>
          <div className="lab-field-col">
            <div className="lab-tabs">
              <button className={!pasteMode ? 'on' : ''} onClick={() => setPasteMode(false)}>Page URL</button>
              <button className={pasteMode ? 'on' : ''} onClick={() => setPasteMode(true)}>Paste draft</button>
            </div>
            {!pasteMode ? (
              <label className="lab-field">
                <input list="lab-pages" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://… (pick a crawled page or any URL)" />
                <datalist id="lab-pages">{pages.slice(0, 2000).map(p => <option key={p.url} value={p.url}>{p.source_type === 'competitor' ? `Competitor · ${p.title}` : p.title}</option>)}</datalist>
              </label>
            ) : (
              <>
                <input value={pasteTitle} onChange={e => setPasteTitle(e.target.value)} placeholder="Title (optional)" className="lab-plain" />
                <textarea rows={3} value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="Paste the draft. Use line breaks between paragraphs; short lines become headings." className="lab-plain" />
              </>
            )}
            <label className="lab-field">
              <span>Compare against <small>up to 3 competitor URLs</small></span>
              <textarea rows={2} value={compareText} onChange={e => setCompareText(e.target.value)} placeholder="https://competitor.com/page" />
            </label>
          </div>
        </div>
        <div className="lab-run">
          <button className="btn-primary" onClick={submit} disabled={loading}>
            {loading ? <Loader2 size={14} className="spinner" /> : <FlaskConical size={14} />} {loading ? `Scoring… ${elapsed}s` : 'Score passages'}
          </button>
          <span className="muted small">Queries use the <code>task: search result</code> prompt; passages and the page use <code>title: … | text: …</code>. Fetching and embedding a long page takes a few seconds on GPU, longer on CPU.</span>
        </div>
        {error && <div className="act-error">{error}</div>}
      </section>

      {result && (
        <>
          <section className="act-card">
            <header>
              <h3>{result.title || shortUrl(result.url)} <span className="muted small">· {result.passages.length} passages · {result.char_count.toLocaleString()} chars · {result.source === 'fetched' ? 'fetched live' : result.source === 'pasted' ? 'pasted draft' : 'from project'}</span></h3>
              <span className="muted small" title="The page score embeds the whole page up to the model's token window. Raise VWS_EMBED_MAX_TOKENS (max 8192) to cover longer pages.">{result.model} · strong ≥ {th.strong} · gap &lt; {th.gap}{result.max_tokens ? ` · page score covers the first ${result.max_tokens.toLocaleString()} tokens` : ''}</span>
            </header>
            <table className="mini lab-q">
              <thead><tr><th>Query</th><th className="num">Page</th><th className="num">Best passage</th><th>Verdict</th>{result.competitors.length > 0 && <th className="num">Best competitor</th>}</tr></thead>
              <tbody>
                {perQuery.map((p, qi) => (
                  <tr key={qi} className={qi === activeQ ? 'active' : ''} onClick={() => setActiveQ(qi)}>
                    <td>{qi === 0 ? <strong>{p.query}</strong> : p.query}</td>
                    <td className="num"><Delta now={p.doc} before={rescore ? p.origDoc : undefined} /></td>
                    <td className="num">
                      {p.best >= 0 ? <button className="link-btn" onClick={e => { e.stopPropagation(); jumpTo(p.best, qi); }}>§{p.best + 1}</button> : '—'}{' '}
                      <Delta now={p.bestS ?? NaN} before={rescore ? (p.origBest ?? undefined) : undefined} />
                    </td>
                    <td><span className="verdict" style={{ color: BAND_COLOR[p.verdict], borderColor: `${BAND_COLOR[p.verdict]}66` }}>{VERDICT_LABEL[p.verdict]}</span></td>
                    {result.competitors.length > 0 && (
                      <td className="num">{p.competitor ? <span title={p.competitor.url}>{fmt(p.competitor.score)} <span className={p.competitor.delta >= 0 ? 'pos' : 'neg'}>({p.competitor.delta >= 0 ? '+' : ''}{fmt(p.competitor.delta)} you)</span></span> : '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            <h4 className="lab-sub">Where each query is answered <span className="muted small">columns are passages §1–§{result.passages.length} in page order · hover a cell for details · click to open that passage below</span></h4>
            <div className="heat-wrap" ref={heatWrapRef} onMouseLeave={() => setHover(null)}>
              <div className="heat" style={{ gridTemplateColumns: `minmax(120px, 200px) repeat(${result.passages.length}, minmax(4px, 1fr))` }}>
                {/* Column numbers so a cell can be matched to its passage card. */}
                <div className="heat-colhead-label muted">passage</div>
                {result.passages.map(p => {
                  const n = result.passages.length;
                  const step = n <= 24 ? 1 : Math.ceil(n / 24);
                  const on = sel?.p === p.index || hover?.p === p.index;
                  return (
                    <div key={p.index} className={`heat-colhead ${on ? 'on' : ''}`} onClick={() => jumpTo(p.index)}>
                      {on || p.index % step === 0 ? `§${p.index + 1}` : ''}
                    </div>
                  );
                })}
                {queries.map((q, qi) => (
                  <div key={qi} className="heat-row" style={{ display: 'contents' }}>
                    <div className={`heat-label ${qi === activeQ ? 'active' : ''} ${sel?.q === qi ? 'sel' : ''}`} onClick={() => setActiveQ(qi)} title={q}>{q}</div>
                    {result.passages.map(p => {
                      const s = scoresOf(p.index)[qi];
                      const isBest = perQuery[qi]?.best === p.index;
                      const isSel = sel?.p === p.index && sel?.q === qi;
                      const inCol = sel?.p === p.index || hover?.p === p.index;
                      return (
                        <div key={p.index}
                          className={`heat-cell ${isBest ? 'best' : ''} ${isSel ? 'sel' : ''} ${inCol ? 'col' : ''}`}
                          style={{ background: heatColor(s, heatRange.lo, heatRange.hi) }}
                          onMouseEnter={ev => {
                            const box = heatWrapRef.current?.getBoundingClientRect();
                            const r = (ev.currentTarget as HTMLDivElement).getBoundingClientRect();
                            if (box) setHover({ p: p.index, q: qi, x: r.left - box.left + r.width / 2, y: r.bottom - box.top });
                          }}
                          onClick={() => jumpTo(p.index, qi)} />
                      );
                    })}
                  </div>
                ))}
              </div>
              {hover && result.passages[hover.p] && (() => {
                const hp = result.passages[hover.p];
                const hs = scoresOf(hover.p)[hover.q];
                const v = verdictOf(hs, th);
                const left = Math.max(8, Math.min(hover.x - 150, (heatWrapRef.current?.clientWidth || 600) - 308));
                return (
                  <div className="heat-tip" style={{ left, top: hover.y + 6 }}>
                    <div className="heat-tip-head"><strong>§{hp.index + 1}</strong>{hp.heading ? ` · ${hp.heading}` : ''}</div>
                    <div>"{queries[hover.q]}": <span className="mono">{fmt(hs)}</span> <span style={{ color: BAND_COLOR[v] }}>{VERDICT_LABEL[v]}</span>
                      {perQuery[hover.q]?.best === hp.index && <span className="heat-tip-best"> · best passage for this query</span>}</div>
                    <p>{(edits[hp.index] ?? hp.text).slice(0, 160)}{(edits[hp.index] ?? hp.text).length > 160 ? '…' : ''}</p>
                    <div className="muted">Click to open §{hp.index + 1} in the passage list</div>
                  </div>
                );
              })()}
            </div>
            <div className="heat-legend">
              <span>{fmt(heatRange.lo, 2)}</span>
              <div style={{ background: `linear-gradient(90deg, ${heatColor(heatRange.lo, heatRange.lo, heatRange.hi)}, ${heatColor(heatRange.hi, heatRange.lo, heatRange.hi)})` }} />
              <span>{fmt(heatRange.hi, 2)}</span>
              <span className="muted"><i className="lg-best" /> best passage for that query</span>
              <span className="muted"><i className="lg-sel" /> the cell you clicked</span>
            </div>
            {sel && result.passages[sel.p] && (
              <div className="heat-selected">
                Showing <strong>§{sel.p + 1}</strong>{result.passages[sel.p].heading ? ` · ${result.passages[sel.p].heading}` : ''} for "{queries[sel.q]}"
                (<span className="mono">{fmt(scoresOf(sel.p)[sel.q])}</span>)
                <button className="link-btn" onClick={() => jumpTo(sel.p, sel.q)}>scroll to it</button>
                <button className="link-btn" onClick={() => setSel(null)}>clear</button>
              </div>
            )}
          </section>

          {result.competitors.length > 0 && (
            <section className="act-card">
              <header><h3>Competitor passages</h3></header>
              {result.competitors.map(c => (
                <details key={c.url} className="lab-comp">
                  <summary><a href={c.url} target="_blank" rel="noreferrer">{shortUrl(c.url)}</a>{c.error ? <span className="neg"> {c.error}</span> : <span className="muted small"> · {c.passage_count} passages · page score for "{queries[activeQ]}": {fmt(c.doc_scores?.[activeQ])}</span>}</summary>
                  {!c.error && c.best_passages?.[activeQ] && (
                    <div className="lab-comp-p">
                      <div className="muted small">Their best passage for "{queries[activeQ]}" scores <strong>{fmt(c.best_passages[activeQ]!.score)}</strong>{c.best_passages[activeQ]!.heading ? ` · ${c.best_passages[activeQ]!.heading}` : ''}</div>
                      <p>{c.best_passages[activeQ]!.text}</p>
                    </div>
                  )}
                </details>
              ))}
            </section>
          )}

          <section className="act-card">
            <header className="lab-ptoolbar">
              <h3>Passages <span className="muted small">scored against "{queries[activeQ]}"</span></h3>
              <div className="seg">
                <button className={sortMode === 'doc' ? 'on' : ''} onClick={() => setSortMode('doc')}>Page order</button>
                <button className={sortMode === 'low' ? 'on' : ''} onClick={() => setSortMode('low')}>Weakest first</button>
                <button className={sortMode === 'high' ? 'on' : ''} onClick={() => setSortMode('high')}>Strongest first</button>
              </div>
            </header>
            <div className="lab-actions">
              <button className="btn-primary" disabled={!dirty || rescoring} onClick={doRescore}>
                {rescoring ? <Loader2 size={14} className="spinner" /> : <Wand2 size={14} />} Re-score {editedCount ? `${editedCount} edit${editedCount > 1 ? 's' : ''}` : 'edits'}
              </button>
              <button className="btn-secondary" disabled={!editedCount} onClick={copyEdits}><Copy size={14} /> Copy before/after</button>
              <button className="btn-secondary" disabled={!editedCount} onClick={() => { setEdits({}); setRescore(null); setRescoredEdits(''); }}><RotateCcw size={14} /> Discard edits</button>
              {result.url && (
                <button className="btn-secondary" onClick={() => onGenerateBrief(queries[0], result.url!, buildEvidence())}><Sparkles size={14} /> AI brief from this evidence</button>
              )}
              {rescore && !dirty && <span className="muted small">Scores reflect your edits. Deltas are against the live page.</span>}
            </div>

            <div className="sug-bar">
              <button className="btn-primary" disabled={!suggestPlan.length || busySuggestions}
                title={suggestPlan.length
                  ? `Rewrites ${suggestPlan.map(x => `§${x.p + 1}`).join(', ')}: the best passage for each query that isn't covered yet`
                  : 'Every query is already covered. Use ✨ on any passage to rewrite it for the selected query.'}
                onClick={() => suggestPlan.forEach(x => requestSuggestion(x.p, x.qs))}>
                {busySuggestions ? <Loader2 size={14} className="spinner" /> : <Sparkles size={14} />} Suggest rewrites{suggestPlan.length ? ` (${suggestPlan.length})` : ''}
              </button>
              <span className="muted small">
                {suggestPlan.length
                  ? <>The local model rewrites the best passage for each query that isn't covered, then every rewrite is embedded and scored. You accept or reject each one.</>
                  : <>Every query is covered. Use <Sparkles size={11} /> on a passage to rewrite it for "{queries[activeQ]}".</>}
              </span>
              {sugCounts.ready > 0 && (
                <span className="sug-summary">
                  {sugCounts.ready} to review{sugCounts.improves ? ` · ${sugCounts.improves} improve` : ''}
                  {sugCounts.improves > 0 && <button className="btn-secondary" onClick={() => Object.entries(suggestions).forEach(([k, v]) => { if (v.status === 'ready' && v.verdict === 'improves') acceptSuggestion(Number(k)); })}><Check size={13} /> Accept all that improve</button>}
                  <button className="btn-secondary" onClick={() => Object.entries(suggestions).forEach(([k, v]) => { if (v.status === 'ready') rejectSuggestion(Number(k)); })}><X size={13} /> Reject all</button>
                </span>
              )}
            </div>

            <div className="lab-passages">
              {orderedPassages.map(p => {
                const sNow = scoresOf(p.index);
                const s = sNow[activeQ];
                const orig = p.scores[activeQ];
                const v = verdictOf(s, th);
                const bestFor = perQuery.filter(q => q.best === p.index).map(q => q.query);
                const isEditing = editing === p.index;
                const edited = edits[p.index] !== undefined && edits[p.index] !== p.text;
                const pct = Math.max(0, Math.min(100, ((s - heatRange.lo) / (heatRange.hi - heatRange.lo)) * 100));
                const tick = (t: number) => `${Math.max(0, Math.min(100, ((t - heatRange.lo) / (heatRange.hi - heatRange.lo)) * 100))}%`;
                return (
                  <div key={p.index} ref={el => { passageRefs.current[p.index] = el; }}
                    className={`lab-p ${edited ? 'edited' : ''} ${sel?.p === p.index ? 'selected' : ''} ${flash === p.index ? 'flash' : ''}`}>
                    <div className="lab-p-head">
                      <span className="lab-p-idx">§{p.index + 1}</span>
                      {sel?.p === p.index && <span className="lab-sel-badge">selected in heatmap</span>}
                      <span className="lab-p-heading">{p.heading || <span className="muted">no heading</span>}</span>
                      {bestFor.length > 0 && <span className="lab-badge">best for {bestFor.length === 1 ? `"${bestFor[0]}"` : `${bestFor.length} queries`}</span>}
                      <div className="lab-score">
                        <div className="lab-score-bar">
                          <div className="fill" style={{ width: `${pct}%`, background: BAND_COLOR[v] }} />
                          <i style={{ left: tick(th.gap) }} /><i style={{ left: tick(th.strong) }} />
                        </div>
                        <Delta now={s} before={rescore && sNow !== p.scores ? orig : undefined} />
                      </div>
                      <div className="lab-dots">
                        {queries.map((q, qi) => <span key={qi} title={`${q}: ${fmt(sNow[qi])}`} style={{ background: heatColor(sNow[qi], heatRange.lo, heatRange.hi), outline: qi === activeQ ? '1px solid var(--text-main)' : 'none' }} />)}
                      </div>
                      <button className="icon-btn" title={`Suggest a rewrite of §${p.index + 1} for "${queries[activeQ]}"`}
                        disabled={suggestions[p.index]?.status === 'loading' || suggestions[p.index]?.status === 'queued'}
                        onClick={() => requestSuggestion(p.index, [activeQ])}><Sparkles size={13} /></button>
                      <button className="icon-btn" title={isEditing ? 'Done editing' : 'Edit this passage'} onClick={() => setEditing(isEditing ? null : p.index)}><Pencil size={13} /></button>
                      {edited && <button className="icon-btn" title="Revert this passage" onClick={() => setEdits(e => { const n = { ...e }; delete n[p.index]; return n; })}><RotateCcw size={13} /></button>}
                    </div>
                    {isEditing ? (
                      <textarea className="lab-edit" value={edits[p.index] ?? p.text} rows={Math.min(14, Math.max(4, Math.ceil((edits[p.index] ?? p.text).length / 110)))}
                        onChange={e => { const val = e.target.value; setEdits(prev => ({ ...prev, [p.index]: val })); }} autoFocus />
                    ) : (
                      <p className={`lab-p-text ${expandedP.has(p.index) ? 'full' : ''}`} onClick={() => setExpandedP(prev => { const n = new Set(prev); if (n.has(p.index)) n.delete(p.index); else n.add(p.index); return n; })}>
                        {edits[p.index] ?? p.text}
                      </p>
                    )}
                    <div className="muted small">{p.words} words{edited ? ' · edited' : ''}</div>
                    {suggestions[p.index] && suggestions[p.index].status !== 'rejected' && (
                      <SuggestionCard sg={suggestions[p.index]} index={p.index} queries={queries} th={th}
                        onAccept={() => acceptSuggestion(p.index)} onAcceptEdit={() => acceptSuggestion(p.index, true)}
                        onReject={() => rejectSuggestion(p.index)} onUndo={() => undoAccept(p.index)}
                        onAnother={() => requestSuggestion(p.index, suggestions[p.index].targets, (suggestions[p.index].variant || 0) + 1)} />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {!result && !loading && (
        <div className="lab-empty muted">
          <FlaskConical size={22} />
          <p>Score any page against a head query and its fan-out. You'll see which passages carry each query, which sub-queries nothing answers, and how a competitor's best passage compares. Edit a passage and re-score to test a rewrite before it ships.</p>
        </div>
      )}
    </div>
  );
}

function Delta({ now, before }: { now: number; before?: number }) {
  if (!Number.isFinite(now)) return <span>—</span>;
  if (before === undefined || !Number.isFinite(before) || Math.abs(now - before) < 0.0005) return <span className="mono">{fmt(now)}</span>;
  const d = now - before;
  return <span className="mono">{fmt(now)} <span className={d > 0 ? 'pos' : 'neg'}>{d > 0 ? '+' : ''}{fmt(d)}</span></span>;
}

// Word-level diff (LCS) for the before/after redline. Passages are short, so O(n·m) is fine.
type Seg = { t: 'same' | 'add' | 'del'; text: string };
function wordDiff(a: string, b: string): Seg[] {
  const A = a.split(/(\s+)/).filter(Boolean), B = b.split(/(\s+)/).filter(Boolean);
  // Compare on a normalized key so a newline→space or ’→' swap isn't shown as an edit.
  const key = (t: string) => (/^\s+$/.test(t) ? ' ' : t.replace(/[’‘]/g, "'").replace(/[“”]/g, '"'));
  const KA = A.map(key), KB = B.map(key);
  if (A.length * B.length > 600_000) return [{ t: 'del', text: a }, { t: 'add', text: b }];
  const n = A.length, m = B.length;
  const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = KA[i] === KB[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Seg[] = [];
  const push = (t: Seg['t'], text: string) => { const last = out[out.length - 1]; if (last && last.t === t) last.text += text; else out.push({ t, text }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (KA[i] === KB[j]) { push('same', B[j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++]);
    else push('add', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
}

// Placeholders the model leaves for facts it doesn't have, e.g. [add: typical cost range].
function withPlaceholders(text: string) {
  return text.split(/(\[add:[^\]]*\])/g).map((part, k) =>
    /^\[add:/.test(part) ? <mark key={k} className="sug-ph" title="Fill this in before publishing">{part}</mark> : part);
}

const SUG_VERDICT = {
  improves: { label: 'Improves', color: 'var(--good)', Icon: CheckCircle },
  mixed: { label: 'Mixed', color: 'var(--warn)', Icon: AlertTriangle },
  no_gain: { label: 'No gain', color: 'var(--text-muted)', Icon: MinusCircle },
} as const;

function SuggestionCard({ sg, index, queries, th, onAccept, onAcceptEdit, onReject, onUndo, onAnother }: {
  sg: Suggestion; index: number; queries: string[]; th: { strong: number; gap: number };
  onAccept: () => void; onAcceptEdit: () => void; onReject: () => void; onUndo: () => void; onAnother: () => void;
}) {
  const [view, setView] = useState<'changes' | 'clean'>('changes');
  const diff = useMemo(() => (sg.text ? wordDiff(sg.baseText, sg.text) : []), [sg.baseText, sg.text]);
  const targetNames = sg.targets.map(i => `"${queries[i]}"`).join(', ');

  if (sg.status === 'queued' || sg.status === 'loading') {
    const secs = Math.floor((Date.now() - sg.started) / 1000);
    return (
      <div className="sug-card loading">
        <Loader2 size={14} className="spinner" />
        <span>{sg.status === 'queued' ? `Queued: rewrite of §${index + 1} for ${targetNames}` : `Writing a rewrite of §${index + 1} for ${targetNames}… ${secs}s`}</span>
        {sg.status === 'loading' && secs > 15 && <span className="muted small">The first one loads the local model, which can take a minute or two on CPU.</span>}
      </div>
    );
  }
  if (sg.status === 'error') {
    return (
      <div className="sug-card error">
        <AlertTriangle size={14} style={{ color: 'var(--bad)' }} /><span>{sg.error}</span>
        <div className="sug-actions"><button className="btn-secondary" onClick={onAnother}><RefreshCw size={13} /> Try again</button><button className="btn-secondary" onClick={onReject}><X size={13} /> Dismiss</button></div>
      </div>
    );
  }
  if (sg.status === 'accepted') {
    return (
      <div className="sug-card accepted">
        <Check size={14} style={{ color: 'var(--good)' }} />
        <span>Rewrite accepted into §{index + 1}. Press <b>Re-score</b> to see what it does to the whole page.</span>
        <button className="link-btn" onClick={onUndo}>Undo</button>
      </div>
    );
  }
  const V = SUG_VERDICT[sg.verdict || 'no_gain'];
  const order = [...queries.keys()].sort((a, b) => Number(sg.targets.includes(b)) - Number(sg.targets.includes(a)));
  return (
    <div className="sug-card">
      <div className="sug-head">
        <Sparkles size={14} />
        <strong>Suggested rewrite</strong>
        <span className="muted small">for {targetNames}</span>
        <span className="sug-verdict" style={{ color: V.color, borderColor: V.color }}><V.Icon size={12} /> {V.label}</span>
        <div className="seg sug-view">
          <button className={view === 'changes' ? 'on' : ''} onClick={() => setView('changes')}>Changes</button>
          <button className={view === 'clean' ? 'on' : ''} onClick={() => setView('clean')}>Clean</button>
        </div>
      </div>
      {sg.why && <div className="sug-why">{sg.why}</div>}
      <div className="sug-scores">
        {order.map(qi => {
          const b = sg.before?.[qi], a = sg.after?.[qi], d = sg.deltas?.[qi] ?? 0;
          const vb = sg.verdicts_before?.[qi], va = sg.verdicts_after?.[qi];
          return (
            <div key={qi} className={`sug-score ${sg.targets.includes(qi) ? 'target' : ''}`} title={sg.targets.includes(qi) ? 'Query this rewrite targets' : 'Other query (should not drop)'}>
              <span className="sug-q">{queries[qi]}</span>
              <span className="mono">{fmt(b)} → {fmt(a)}</span>
              <span className={`mono ${d > 0.0005 ? 'pos' : d < -0.0005 ? 'neg' : 'muted'}`}>{d > 0 ? '+' : ''}{fmt(d)}</span>
              {vb && va && vb !== va && <span className="sug-band" style={{ color: BAND_COLOR[va] }}>{VERDICT_LABEL[vb]} → {VERDICT_LABEL[va]}</span>}
            </div>
          );
        })}
      </div>
      <p className="sug-text">
        {view === 'clean'
          ? withPlaceholders(sg.text || '')
          : diff.map((d, k) => d.t === 'same' ? <span key={k}>{withPlaceholders(d.text)}</span>
            : d.t === 'add' ? <ins key={k}>{withPlaceholders(d.text)}</ins> : <del key={k}>{d.text}</del>)}
      </p>
      <div className="sug-foot muted small">
        {sg.words_before} → {sg.words_after} words · {sg.model}{sg.seconds ? ` · ${sg.seconds}s` : ''}
        {sg.placeholders && sg.placeholders.length > 0 && <span className="sug-ph-note"> · {sg.placeholders.length} placeholder{sg.placeholders.length > 1 ? 's' : ''} to fill in before publishing</span>}
        <span> · scored at strong ≥ {th.strong}</span>
      </div>
      <div className="sug-actions">
        <button className="btn-primary" onClick={onAccept}><Check size={13} /> Accept</button>
        <button className="btn-secondary" onClick={onAcceptEdit}><Pencil size={13} /> Accept &amp; edit</button>
        <button className="btn-secondary" onClick={onReject}><X size={13} /> Reject</button>
        <button className="btn-secondary" onClick={onAnother}><RefreshCw size={13} /> Another version</button>
      </div>
    </div>
  );
}

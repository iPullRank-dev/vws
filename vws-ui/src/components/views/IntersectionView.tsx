import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Download, FlaskConical, GitCompare, Loader2 } from 'lucide-react';
import { API_BASE } from '../../config';
import { csvCell, downloadText, fmt, shortUrl } from '../../lib/vws';
import type { LabPayload } from '../../lib/vws';

interface Entity { id: number; url: string; title: string; source_type: string }

interface Props {
  projectId: string;
  entities: Entity[];
  onOpenLab: (p: LabPayload) => void;
  onSelect: (url: string) => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const VERDICT_COLOR: Record<string, string> = {
  'Near-duplicates': '#ef4444', 'Competing for the same queries': '#fb923c', 'Closely related': '#60a5fa', 'Distinct': '#10b981',
  'Page targets this query': '#10b981', 'Related, not targeted': '#f59e0b', "Doesn't answer it": '#ef4444', 'Two queries': '#94a3b8',
};

export default function IntersectionView({ projectId, entities, onOpenLab, onSelect, notify }: Props) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [res, setRes] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [psg, setPsg] = useState<any>(null);
  const [psgLoading, setPsgLoading] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [suggested, setSuggested] = useState<{ a: string; b: string; why: string }[]>([]);

  // Suggest the pairs most worth checking: the Action Plan's cannibalization / duplicate pairs.
  useEffect(() => {
    axios.get(`${API_BASE}/api/projects/${projectId}/actions`).then(r => {
      const pairs = (r.data.actions || []).filter((x: any) => (x.type === 'cannibalization' || x.type === 'consolidate') && x.urls.length >= 2)
        .slice(0, 6).map((x: any) => ({ a: x.urls[0], b: x.urls[1], why: x.type === 'consolidate' ? 'near-duplicates' : `compete on ${x.metrics?.queries ?? ''} queries` }));
      setSuggested(pairs);
    }).catch(() => {});
  }, [projectId]);

  const labelOf = (e: Entity) => e.source_type === 'keyword' ? `Query: ${e.title}` : `${e.title} — ${e.url}`;
  const byLabel = useMemo(() => Object.fromEntries(entities.map(e => [labelOf(e), e])), [entities]);
  const byUrl = useMemo(() => Object.fromEntries(entities.filter(e => e.source_type !== 'keyword').map(e => [e.url, e])), [entities]);
  const ea = byLabel[a], eb = byLabel[b];

  const compare = async (pa?: Entity, pb?: Entity) => {
    const A = pa || ea, B = pb || eb;
    if (!A || !B) { notify('Pick both items from the suggestions.', 'error'); return; }
    setLoading(true); setPsg(null);
    try {
      const r = await axios.get(`${API_BASE}/api/projects/${projectId}/compare`, { params: { source_id: A.id, target_id: B.id } });
      if (r.data.error) { notify(r.data.error, 'error'); return; }
      setRes(r.data);
      setHistory(h => [{ t: new Date(), a: r.data.entity_a, b: r.data.entity_b, sim: r.data.similarity, verdict: r.data.verdict?.label }, ...h].slice(0, 100));
    } catch (e: any) {
      notify(e?.message || 'Compare failed.', 'error');
    } finally { setLoading(false); }
  };

  const comparePassages = async () => {
    if (!res) return;
    setPsgLoading(true);
    try {
      const r = await axios.post(`${API_BASE}/api/projects/${projectId}/compare-passages`, { url_a: res.entity_a.url, url_b: res.entity_b.url }, { timeout: 300000 });
      if (r.data.error) notify(r.data.error, 'error'); else setPsg(r.data);
    } catch (e: any) {
      notify(e?.response?.data?.detail || e?.message || 'Failed.', 'error');
    } finally { setPsgLoading(false); }
  };

  const bothPages = res && res.entity_a.source_type !== 'keyword' && res.entity_b.source_type !== 'keyword';
  const v = res?.verdict;

  return (
    <div className="view">
      <div className="howto">
        <strong>How to read this.</strong> Pick any two items: two pages, a page and a query, or two queries. You get their similarity, a plain
        verdict against this project's thresholds (near-duplicate, competing for the same queries, closely related, distinct), the queries
        both pages contend for, and for two pages a section-by-section comparison that shows which passages say the same thing (merge or
        differentiate those) and which are unique to each page.
      </div>

      <div className="target-bar">
        <div className="target-field">
          <label>A</label>
          <input list="ix-ents" value={a} onChange={e => setA(e.target.value)} placeholder="Page or query" />
        </div>
        <div className="target-field">
          <label>B</label>
          <input list="ix-ents" value={b} onChange={e => setB(e.target.value)} placeholder="Page or query" />
        </div>
        <datalist id="ix-ents">{entities.slice(0, 4000).map(e => <option key={e.id} value={labelOf(e)} />)}</datalist>
        <button className="btn-primary" onClick={() => compare()} disabled={loading || !ea || !eb}>{loading ? <Loader2 size={13} className="spinner" /> : <GitCompare size={13} />} Compare</button>
      </div>

      {!res && suggested.length > 0 && (
        <div className="target-suggest">
          <span className="muted small">Worth checking (from the Action Plan):</span>
          {suggested.filter(p => byUrl[p.a] && byUrl[p.b]).map(p => (
            <button key={p.a + p.b} className="chip" onClick={() => { setA(labelOf(byUrl[p.a])); setB(labelOf(byUrl[p.b])); compare(byUrl[p.a], byUrl[p.b]); }}>
              {shortUrl(p.a)} vs {shortUrl(p.b)} <span>{p.why}</span>
            </button>
          ))}
        </div>
      )}

      {res && v && (
        <div className="verdict-card" style={{ borderLeftColor: VERDICT_COLOR[v.label] || '#64748b' }}>
          <div className="verdict-head" style={{ color: VERDICT_COLOR[v.label] }}>{v.label} · similarity {fmt(res.similarity)}</div>
          <p>{v.text}</p>
          {res.linked && bothPages && (
            <p className="small muted">Links: A → B {res.linked.a_to_b ? 'yes' : 'no'} · B → A {res.linked.b_to_a ? 'yes' : 'no'}</p>
          )}
          <div className="act-buttons">
            {res.lab && <button className="btn-primary" onClick={() => onOpenLab({ ...res.lab, autoRun: true })}><FlaskConical size={13} /> Open in Lab</button>}
            {bothPages && <button className="btn-primary" onClick={comparePassages} disabled={psgLoading}>{psgLoading ? <Loader2 size={13} className="spinner" /> : <GitCompare size={13} />} Compare passages</button>}
            {bothPages && <button className="btn-secondary" onClick={() => onSelect(res.entity_a.url)}>Inspect A</button>}
            {bothPages && <button className="btn-secondary" onClick={() => onSelect(res.entity_b.url)}>Inspect B</button>}
          </div>
        </div>
      )}

      {res?.shared_queries?.length > 0 && (
        <div className="act-card">
          <h3>Queries both pages contend for</h3>
          <table className="mini">
            <thead><tr><th>Query</th><th className="num">A</th><th className="num">B</th><th>Suggested owner</th></tr></thead>
            <tbody>
              {res.shared_queries.map((s: any) => (
                <tr key={s.keyword}><td>{s.keyword}</td><td className="num">{fmt(s.a)}</td><td className="num">{fmt(s.b)}</td>
                  <td className="url">{shortUrl(s.a >= s.b ? res.entity_a.url : res.entity_b.url)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {psg && (
        <div className="act-card">
          <h3>Section by section <span className="muted small">· A has {psg.a.passages} passages, B has {psg.b.passages} · {Math.round(psg.duplicate_share_a * 100)}% of A and {Math.round(psg.duplicate_share_b * 100)}% of B have a near-copy on the other page</span></h3>
          <h4>Closest matching sections</h4>
          {psg.overlap.map((o: any, i: number) => (
            <div key={i} className={`pair ${o.duplicate ? 'dup' : ''}`}>
              <div className="pair-head"><span className="mono">{fmt(o.similarity)}</span>{o.duplicate ? <span className="neg"> near-duplicate: merge or rewrite one</span> : <span className="muted"> related</span>}</div>
              <div className="pair-cols">
                <div><div className="muted small">A §{o.a.index + 1}{o.a.heading ? ` · ${o.a.heading}` : ''}</div><p>{o.a.text}</p></div>
                <div><div className="muted small">B §{o.b.index + 1}{o.b.heading ? ` · ${o.b.heading}` : ''}</div><p>{o.b.text}</p></div>
              </div>
            </div>
          ))}
          <div className="pair-cols" style={{ marginTop: '0.6rem' }}>
            <div><h4>Unique to A</h4>{psg.unique_a.map((u: any) => <p key={u.index} className="small"><span className="muted">§{u.index + 1}</span> {u.text.slice(0, 220)}…</p>)}</div>
            <div><h4>Unique to B</h4>{psg.unique_b.map((u: any) => <p key={u.index} className="small"><span className="muted">§{u.index + 1}</span> {u.text.slice(0, 220)}…</p>)}</div>
          </div>
        </div>
      )}

      {res && (
        <div className="pair-cols">
          {[['A', res.neighbors_a], ['B', res.neighbors_b]].map(([k, list]: any) => (
            <div key={k} className="act-card">
              <h4>Nearest to {k}</h4>
              <ul className="drawer-list">{list.map((n: any) => <li key={n.id}><span className="small">{n.source_type === 'keyword' ? `Query: ${n.title}` : shortUrl(n.url)}</span><span className="mono muted">{fmt(n.similarity)}</span></li>)}</ul>
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="act-card">
          <header><h3>Comparison log</h3>
            <button className="btn-secondary" onClick={() => downloadText(`project_${projectId}_comparisons.csv`,
              ['Time,A,B,Similarity,Verdict', ...history.map(h => [h.t.toISOString(), h.a.url || h.a.title, h.b.url || h.b.title, h.sim, h.verdict].map(csvCell).join(','))].join('\n'), 'text/csv')}><Download size={13} /> CSV</button>
          </header>
          <table className="mini">
            <tbody>{history.map((h, i) => <tr key={i}><td className="muted">{h.t.toLocaleTimeString()}</td><td>{h.a.title}</td><td>{h.b.title}</td><td className="num">{fmt(h.sim)}</td><td>{h.verdict}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

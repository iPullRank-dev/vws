import { Copy, Crosshair, ExternalLink, FlaskConical, ListChecks, Sparkles, X } from 'lucide-react';
import { BAND_COLOR, SEVERITY_COLOR, ZONE_COLOR, ZONE_HELP, copyText, fmt, shortUrl } from '../../lib/vws';
import type { LabPayload, PageDiag, PlanAction } from '../../lib/vws';

interface Props {
  page: PageDiag | null;
  actions?: PlanAction[];
  linkGraphLoaded?: boolean;
  onClose: () => void;
  onSelectUrl: (url: string) => void;
  onOpenLab: (p: LabPayload) => void;
  onOpenActions: (url: string) => void;
  onCenter?: (pageId: number) => void;
  onBrief?: (keyword: string, url: string) => void;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export default function PageDrawer({ page, actions = [], linkGraphLoaded, onClose, onSelectUrl, onOpenLab, onOpenActions, onCenter, onBrief, notify }: Props) {
  if (!page) return null;
  const rec = page.recommendation;
  const mine = actions.filter(a => a.urls.includes(page.url) || a.primary_url === page.url);
  const queries = page.queries.map(q => q.keyword);

  const summary = () => [
    `${page.title} — ${page.url}`,
    `Zone: ${page.zone} (further from center than ${page.percentile.toFixed(0)}% of pages) · Topic: ${page.cluster_label}${page.is_hub ? ' (hub)' : ''}`,
    `Recommendation: ${rec.verdict}. ${rec.text}`,
    page.queries.length ? `Best page for: ${page.queries.slice(0, 8).map(q => `${q.keyword} (${fmt(q.similarity)})`).join('; ')}` : 'Best page for: no target queries',
  ].join('\n');

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <div style={{ minWidth: 0 }}>
          <div className="drawer-title">{page.title}</div>
          <a className="drawer-url" href={page.url} target="_blank" rel="noreferrer">{shortUrl(page.url)} <ExternalLink size={11} /></a>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close"><X size={14} /></button>
      </header>

      <div className="drawer-chips">
        <span className="chip-z" style={{ color: ZONE_COLOR[page.zone], borderColor: `${ZONE_COLOR[page.zone]}66` }}>{page.zone}</span>
        <span className="muted small">further out than {page.percentile.toFixed(0)}% of pages</span>
      </div>
      <p className="muted small" style={{ margin: '0.2rem 0 0.6rem' }}>{ZONE_HELP[page.zone].what}</p>

      <div className="drawer-rec" style={{ borderColor: `${SEVERITY_COLOR[rec.severity]}88` }}>
        <div className="drawer-rec-head" style={{ color: SEVERITY_COLOR[rec.severity] }}>{rec.verdict}</div>
        <p>{rec.text}</p>
        {rec.target_url && rec.target_url !== page.url && (
          <button className="link-btn" onClick={() => onSelectUrl(rec.target_url!)}>Inspect {shortUrl(rec.target_url)}</button>
        )}
      </div>

      <div className="drawer-actions">
        <button className="btn-primary" onClick={() => onOpenLab({ queries: queries.length ? queries.slice(0, 8) : [page.title], url: page.url, autoRun: true })}>
          <FlaskConical size={13} /> Lab
        </button>
        {mine.length > 0 && <button className="btn-secondary" onClick={() => onOpenActions(page.url)}><ListChecks size={13} /> {mine.length} action{mine.length > 1 ? 's' : ''}</button>}
        {onCenter && <button className="btn-secondary" onClick={() => onCenter(page.page_id)} title="Put this page in the Bullseye center"><Crosshair size={13} /> Center</button>}
        {onBrief && queries.length > 0 && <button className="btn-secondary" onClick={() => onBrief(queries[0], page.url)}><Sparkles size={13} /> Brief</button>}
        <button className="btn-secondary" onClick={async () => notify((await copyText(summary())) ? 'Page summary copied.' : 'Copy failed.', 'info')}><Copy size={13} /></button>
      </div>

      <section>
        <h4>Topic</h4>
        <p className="small">
          <strong>{page.cluster_label}</strong>{page.is_hub ? <span className="hub-badge">hub</span> : <> · hub <button className="link-btn" onClick={() => onSelectUrl(page.hub_url)}>{shortUrl(page.hub_url)}</button></>}
          <span className="muted"> · fit {fmt(page.fit)}</span>
        </p>
      </section>

      <section>
        <h4>Best page for <span className="muted">({page.query_counts.strong} clearly, {page.query_counts.partial} partly)</span></h4>
        {page.queries.length === 0 ? <p className="muted small">No target query maps to this page{linkGraphLoaded === undefined ? '' : ''}.</p> : (
          <table className="mini">
            <tbody>
              {page.queries.slice(0, 10).map(q => (
                <tr key={q.keyword}>
                  <td>{q.keyword}</td>
                  <td className="num"><span className="band-dot" style={{ background: BAND_COLOR[q.band] }} title={q.band} />{fmt(q.similarity)}</td>
                  <td className="num muted">{q.volume ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4>Closest pages</h4>
        <ul className="drawer-list">
          {page.neighbors.map(n => (
            <li key={n.url}><button className="link-btn" onClick={() => onSelectUrl(n.url)}>{shortUrl(n.url)}</button><span className="mono muted">{fmt(n.similarity)}</span></li>
          ))}
        </ul>
      </section>

      <section>
        <h4>Internal links</h4>
        {linkGraphLoaded ? (
          <p className="small">
            {page.links.inbound} in · {page.links.outbound} out
            {page.links.inbound_avg_relevance !== null && <> · inbound relevance {fmt(page.links.inbound_avg_relevance)}</>}
            {page.links.links_to_hub === false && <span className="warn-text"> · doesn't link to its hub</span>}
          </p>
        ) : <p className="muted small">Upload a Screaming Frog "All Inlinks" export to see links.</p>}
      </section>

      {mine.length > 0 && (
        <section>
          <h4>Open actions for this page</h4>
          <ul className="drawer-list">
            {mine.slice(0, 6).map(a => <li key={a.key}><span className="small">{a.type_label}: {a.title}</span><span className={`small st st-${a.status}`}>{a.status}</span></li>)}
          </ul>
        </section>
      )}
    </aside>
  );
}

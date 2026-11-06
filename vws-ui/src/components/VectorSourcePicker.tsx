import { useEffect, useState, type CSSProperties } from 'react';
import axios from 'axios';
import { API_BASE } from '../config';
import { countVectorDims, readCsvRecords } from '../lib/vws';

export interface VectorSourceValue {
  mode: 'reembed' | 'csv';
  column: string;
  model: string;      // canonical id, or free text for "other"
  fetchMissing: boolean;
}

export const DEFAULT_VECTOR_SOURCE: VectorSourceValue = { mode: 'reembed', column: '', model: '', fetchMissing: true };

const MODELS: { id: string; label: string; dims: number[] }[] = [
  { id: 'google/embeddinggemma-2', label: 'EmbeddingGemma 2 (google/embeddinggemma-2)', dims: [768, 512, 256, 128] },
  { id: 'google/embeddinggemma-300m', label: 'EmbeddingGemma 1 (google/embeddinggemma-300m)', dims: [768, 512, 256, 128] },
  { id: 'text-embedding-3-small', label: 'OpenAI text-embedding-3-small', dims: [1536] },
  { id: 'text-embedding-3-large', label: 'OpenAI text-embedding-3-large', dims: [3072] },
  { id: 'gemini-embedding-001', label: 'Google gemini-embedding-001', dims: [3072, 1536, 768] },
];

export function isVectorSourceValid(v: VectorSourceValue): boolean {
  return v.mode === 'reembed' || (!!v.column && !!v.model.trim());
}

interface Props {
  file: File | null;
  value: VectorSourceValue;
  onChange: (v: VectorSourceValue) => void;
}

const selectStyle: CSSProperties = {
  width: '100%', padding: '0.55rem', borderRadius: '6px', background: 'var(--bg-dark)',
  border: '1px solid var(--border)', color: 'white', outline: 'none', boxSizing: 'border-box',
};

export default function VectorSourcePicker({ file, value, onChange }: Props) {
  const [headers, setHeaders] = useState<string[]>([]);
  const [dimsByCol, setDimsByCol] = useState<Record<string, number>>({});
  const [activeModel, setActiveModel] = useState<{ model: string; dim: number } | null>(null);
  const [otherModel, setOtherModel] = useState(false);

  useEffect(() => {
    axios.get(`${API_BASE}/api/embedder/status`).then(r => setActiveModel({ model: r.data.model, dim: r.data.dim })).catch(() => {});
  }, []);

  // Parse the header + first data row so we can show which columns hold vectors
  // and how many dimensions they have (Screaming Frog writes them as text).
  useEffect(() => {
    if (!file) { setHeaders([]); setDimsByCol({}); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const text = typeof ev.target?.result === 'string' ? ev.target.result.replace(/^﻿/, '') : '';
      const recs = readCsvRecords(text, 2);
      const hdr = (recs[0] || []).map(h => h.trim());
      const first = recs[1] || [];
      const dims: Record<string, number> = {};
      hdr.forEach((h, i) => { const d = countVectorDims(first[i]); if (d >= 16) dims[h] = d; });
      setHeaders(hdr);
      setDimsByCol(dims);
      const vecCols = Object.keys(dims);
      if (vecCols.length) onChange({ ...value, mode: 'csv', column: vecCols[0] });
      else onChange({ ...value, mode: 'reembed', column: '' });
    };
    reader.readAsText(file.slice(0, 2_000_000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  if (!file) return null;
  const vecCols = Object.keys(dimsByCol);
  const dim = value.column ? dimsByCol[value.column] : 0;
  const known = MODELS.find(m => m.id === value.model);
  const dimMismatch = !!(known && dim && !known.dims.includes(dim));
  const sameAsLocal = !!(activeModel && value.model === activeModel.model && (!dim || dim >= activeModel.dim));

  return (
    <div className="vsp">
      <div className="vsp-options">
        <label className={`vsp-option ${value.mode === 'csv' ? 'on' : ''} ${vecCols.length === 0 ? 'disabled' : ''}`}>
          <input type="radio" checked={value.mode === 'csv'} disabled={vecCols.length === 0}
            onChange={() => onChange({ ...value, mode: 'csv', column: value.column || vecCols[0] || '' })} />
          <span>
            <strong>Use the embeddings in this CSV</strong>
            <small>{vecCols.length ? `Found ${vecCols.length} vector column${vecCols.length > 1 ? 's' : ''}.` : 'No vector column detected in the first row.'}</small>
          </span>
        </label>
        <label className={`vsp-option ${value.mode === 'reembed' ? 'on' : ''}`}>
          <input type="radio" checked={value.mode === 'reembed'} onChange={() => onChange({ ...value, mode: 'reembed' })} />
          <span>
            <strong>Re-embed locally with EmbeddingGemma 2</strong>
            <small>Fetches each page's text and embeds it here. Slower, but keywords, the locator and the Lab all share one space.</small>
          </span>
        </label>
      </div>

      {value.mode === 'csv' && (
        <div className="vsp-fields">
          <label>Vector column</label>
          <select style={selectStyle} value={value.column} onChange={e => onChange({ ...value, column: e.target.value })}>
            {vecCols.map(c => <option key={c} value={c}>{c} ({dimsByCol[c]}-d)</option>)}
            {headers.filter(h => !dimsByCol[h]).map(h => <option key={h} value={h}>{h}</option>)}
          </select>

          <label>Which model produced these vectors?</label>
          <select style={selectStyle} value={otherModel ? '__other' : value.model}
            onChange={e => {
              if (e.target.value === '__other') { setOtherModel(true); onChange({ ...value, model: '' }); }
              else { setOtherModel(false); onChange({ ...value, model: e.target.value }); }
            }}>
            <option value="">Select the model configured in Screaming Frog…</option>
            {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            <option value="__other">Other…</option>
          </select>
          {otherModel && (
            <input type="text" placeholder="Model name exactly as configured (e.g. nomic-embed-text)" value={value.model}
              onChange={e => onChange({ ...value, model: e.target.value })} style={{ ...selectStyle, marginTop: '0.4rem' }} />
          )}

          <div className="vsp-notes">
            {dim > 0 && <div>Detected <strong>{dim}</strong> dimensions in <code>{value.column}</code>.</div>}
            {dimMismatch && <div className="warn">{known!.label} normally outputs {known!.dims.join(' / ')} dimensions, not {dim}. Double-check the model.</div>}
            {value.model && (sameAsLocal ? (
              <div className="good">Same space as the local engine, so keyword mapping, the ghost locator and Lab scores are comparable. VWS spot-checks this on import by embedding a sample of page titles.</div>
            ) : (
              <div>Page-to-page views will work. Keyword mapping needs pages and keywords from the same model, so the project will ask you to re-embed locally before keyword actions run.</div>
            ))}
            {!value.model && <div className="warn">Vectors from different models can't be compared, so VWS needs to know which one made these.</div>}
          </div>
        </div>
      )}

      {value.mode === 'reembed' && (
        <label className="vsp-check">
          <input type="checkbox" checked={value.fetchMissing} onChange={e => onChange({ ...value, fetchMissing: e.target.checked })} />
          Fetch page text for rows that don't include it (needed for most Screaming Frog exports)
        </label>
      )}
    </div>
  );
}

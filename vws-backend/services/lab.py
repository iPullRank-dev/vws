"""Relevance Lab: query fan-out x passage scoring for a single page.

Given one or more queries (a head query plus its fan-out sub-queries) and a
page, the Lab:

  1. pulls the page body (project cache -> on-demand fetch -> pasted text),
  2. splits it into passages,
  3. embeds queries ("task: search result | query: ...") and passages / the
     whole page ("title: ... | text: ...") with EmbeddingGemma 2,
  4. returns a passage x query score matrix, a per-query verdict, and the same
     numbers for any competitor URLs.

`score_passages` re-scores edited text without touching the network, which is
what powers the edit -> re-score loop in the UI.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict

import numpy as np

from services.database import get_db
from services.embedder import DEFAULT_ANALYSIS_DIM, VALID_DIMS, clean_title, embed_documents, embed_queries, model_tag, truncate
from services.passages import join_passages, passage_embedding_text, split_passages
from services.realtime_fetch import MIN_USEFUL_CHARS, cache_into_pages, fetch_and_extract
from services.embedder import MAX_TOKENS, MODEL_ID

MAX_QUERIES = 25
MAX_PASSAGES = 120

# In-memory vector cache so the edit -> re-score loop only embeds what changed.
_VEC_CACHE: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_CACHE_MAX = 6000
_CACHE_LOCK = threading.Lock()


def _cached(kind: str, texts: list[str], title: str | None = None) -> np.ndarray:
    keys = [(kind, title or "", t) for t in texts]
    with _CACHE_LOCK:
        missing = [i for i, k in enumerate(keys) if k not in _VEC_CACHE]
    if missing:
        if kind == "q":
            vecs = embed_queries([texts[i] for i in missing])
        else:
            vecs = embed_documents([texts[i] for i in missing], [title] * len(missing))
    else:
        vecs = []
    with _CACHE_LOCK:
        for i, v in zip(missing, vecs):
            _VEC_CACHE[keys[i]] = v
        fresh = {keys[i]: v for i, v in zip(missing, vecs)}
        out = np.vstack([fresh.get(k) if k in fresh else _VEC_CACHE[k] for k in keys])
        for k in keys:
            if k in _VEC_CACHE:
                _VEC_CACHE.move_to_end(k)
        while len(_VEC_CACHE) > _CACHE_MAX:
            _VEC_CACHE.popitem(last=False)
    return out


def lab_thresholds(dim: int) -> dict:
    from services.thresholds import calibrated_for
    t = calibrated_for(MODEL_ID, dim) or {"strong": 0.76, "gap": 0.66}
    return {"strong": t["strong"], "gap": t["gap"]}


def project_dim(project_id: int | None) -> int:
    if project_id is None:
        return DEFAULT_ANALYSIS_DIM
    from services.vectors import get_project_settings
    conn = get_db()
    try:
        return get_project_settings(conn, project_id)["analysis_dim"]
    finally:
        conn.close()


def _verdict(score: float, th: dict) -> str:
    return "covered" if score >= th["strong"] else ("partial" if score >= th["gap"] else "missing")


def get_page_text(project_id: int | None, url: str) -> tuple[str, str, str]:
    """Return (title, body, source) for a URL: 'project' cache, 'fetched', or 'unavailable'."""
    variants = [url, url.rstrip("/"), url + "/"] if not url.endswith("/") else [url, url.rstrip("/")]
    title, body = "", ""
    matched = url
    if project_id is not None:
        conn = get_db()
        cur = conn.cursor()
        for u in variants:
            cur.execute("SELECT url, title, content FROM pages WHERE project_id = ? AND url = ? "
                        "ORDER BY length(content) DESC LIMIT 1", (project_id, u))
            row = cur.fetchone()
            if row:
                matched, title, body = row["url"], row["title"] or "", row["content"] or ""
                break
        conn.close()
        if len(body) >= MIN_USEFUL_CHARS:
            return clean_title(title, matched), body, "project"

    fetched = fetch_and_extract(url)
    if fetched:
        f_title, f_body = fetched
        title = f_title or title
        body = f_body
        if project_id is not None:
            try:
                conn = get_db()
                cache_into_pages(conn, project_id, matched, title, body)
                conn.close()
            except Exception as e:
                print(f"[lab] cache failed: {e}")
        return clean_title(title, url), body, "fetched"
    return clean_title(title, url), body, "unavailable" if not body else "project"


def _score_doc(title: str, body: str, qv: np.ndarray, dim: int) -> dict:
    passages = split_passages(body)[:MAX_PASSAGES]
    vecs = truncate(_cached("d", [passage_embedding_text(p) for p in passages] + [body], title), dim)
    pv, dv = vecs[:-1], vecs[-1]
    P = pv @ qv.T if len(passages) else np.zeros((0, qv.shape[0]), dtype=np.float32)
    D = dv @ qv.T
    return {"passages": passages, "P": P, "D": D}


def analyze(project_id: int | None, queries: list[str], url: str | None = None, text: str | None = None,
            title: str | None = None, compare_urls: list[str] | None = None, dim: int | None = None) -> dict:
    t0 = time.time()
    queries = [q.strip() for q in (queries or []) if q and q.strip()][:MAX_QUERIES]
    if not queries:
        return {"error": "Enter at least one query."}
    dim = dim if dim in VALID_DIMS else project_dim(project_id)
    th = lab_thresholds(dim)

    if text and text.strip():
        page_title, body, source = (title or "").strip() or "none", text.strip(), "pasted"
    elif url:
        page_title, body, source = get_page_text(project_id, url)
    else:
        return {"error": "Provide a URL or paste page text."}
    if not body:
        return {"error": f"Couldn't get any text for {url}. The page may block bots; paste its text instead."}

    qv = truncate(_cached("q", queries), dim)
    target = _score_doc(page_title, body, qv, dim)
    P, D = target["P"], target["D"]

    competitors = []
    for cu in [u for u in (compare_urls or []) if u and u.strip()][:3]:
        c_title, c_body, c_source = get_page_text(project_id, cu.strip())
        if not c_body:
            competitors.append({"url": cu, "error": "Could not fetch this page."})
            continue
        cs = _score_doc(c_title, c_body, qv, dim)
        best = []
        for qi in range(len(queries)):
            if len(cs["passages"]):
                j = int(np.argmax(cs["P"][:, qi]))
                best.append({"score": round(float(cs["P"][j, qi]), 4), "heading": cs["passages"][j]["heading"],
                             "text": cs["passages"][j]["text"]})
            else:
                best.append(None)
        competitors.append({"url": cu, "title": c_title, "source": c_source, "passage_count": len(cs["passages"]),
                            "doc_scores": [round(float(x), 4) for x in cs["D"]], "best_passages": best})

    per_query = []
    for qi, q in enumerate(queries):
        if len(target["passages"]):
            j = int(np.argmax(P[:, qi]))
            best_p, best_s = j, float(P[j, qi])
        else:
            best_p, best_s = None, float("nan")
        doc_s = float(D[qi])
        top = max(doc_s, best_s if best_p is not None else doc_s)
        entry = {"query": q, "doc_score": round(doc_s, 4), "best_passage": best_p,
                 "best_score": round(best_s, 4) if best_p is not None else None, "verdict": _verdict(top, th)}
        comp_scores = [(c["url"], max(c["doc_scores"][qi], (c["best_passages"][qi] or {}).get("score", 0)))
                       for c in competitors if "doc_scores" in c]
        if comp_scores:
            cu, cs = max(comp_scores, key=lambda x: x[1])
            entry["competitor_best"] = {"url": cu, "score": round(float(cs), 4), "delta": round(float(top - cs), 4)}
        per_query.append(entry)

    return {
        "url": url, "title": page_title, "source": source, "char_count": len(body),
        "model": model_tag(), "dim": dim, "thresholds": th, "queries": queries, "max_tokens": MAX_TOKENS,
        "document": {"scores": [round(float(x), 4) for x in D]},
        "passages": [{"index": p["index"], "heading": p["heading"], "text": p["text"], "words": p["words"],
                      "scores": [round(float(x), 4) for x in P[i]]} for i, p in enumerate(target["passages"])],
        "per_query": per_query,
        "competitors": competitors,
        "seconds": round(time.time() - t0, 1),
    }


def score_passages(queries: list[str], passages: list[dict], title: str | None = None, dim: int | None = None) -> dict:
    """Re-score (edited) passages + the reassembled page. No network."""
    queries = [q.strip() for q in (queries or []) if q and q.strip()][:MAX_QUERIES]
    passages = [p for p in (passages or []) if (p.get("text") or "").strip()][:MAX_PASSAGES]
    if not queries or not passages:
        return {"error": "Need at least one query and one passage."}
    dim = dim if dim in VALID_DIMS else DEFAULT_ANALYSIS_DIM
    qv = truncate(_cached("q", queries), dim)
    body = join_passages(passages)
    t = (title or "").strip() or "none"
    vecs = truncate(_cached("d", [passage_embedding_text(p) for p in passages] + [body], t), dim)
    P = vecs[:-1] @ qv.T
    D = vecs[-1] @ qv.T
    th = lab_thresholds(dim)
    return {
        "passages": [[round(float(x), 4) for x in row] for row in P],
        "document": [round(float(x), 4) for x in D],
        "verdicts": [_verdict(max(float(D[qi]), float(P[:, qi].max())), th) for qi in range(len(queries))],
        "thresholds": th,
    }


# ---------------------------------------------------------------------------
# AI rewrite suggestions (accept / reject in the UI)
# ---------------------------------------------------------------------------
_STATUS_WORDS = {"covered": "answered", "partial": "only partly answered", "missing": "not answered"}


def suggest_rewrite(queries: list[str], passage: dict, title: str | None = None, targets: list[int] | None = None,
                    dim: int | None = None, before: str = "", after: str = "", variant: int = 0) -> dict:
    """Ask the local LLM to rewrite one passage for `targets` (query indexes), then
    embed the rewrite and report what it does to every query's score, so the
    user accepts on evidence rather than on how the prose reads."""
    import re
    from services.llm import LocalLLMManager

    t0 = time.time()
    queries = [q.strip() for q in (queries or []) if q and q.strip()][:MAX_QUERIES]
    text = (passage or {}).get("text", "").strip()
    heading = ((passage or {}).get("heading") or "").strip()
    if not queries or not text:
        return {"error": "Need at least one query and a passage with text."}
    dim = dim if dim in VALID_DIMS else DEFAULT_ANALYSIS_DIM
    th = lab_thresholds(dim)
    t = (title or "").strip() or "none"
    qv = truncate(_cached("q", queries), dim)
    cur = truncate(_cached("d", [passage_embedding_text({"heading": heading, "text": text})], t), dim)[0] @ qv.T

    idx = [i for i in (targets or []) if 0 <= i < len(queries)]
    if not idx:
        # Default: the queries this passage doesn't fully answer yet, head query first.
        idx = [i for i in range(len(queries)) if _verdict(float(cur[i]), th) != "covered"] or [0]
    idx = idx[:4]
    tgt = [{"query": queries[i], "status": _STATUS_WORDS[_verdict(float(cur[i]), th)]} for i in idx]

    llm = LocalLLMManager.get_instance()
    gen = llm.suggest_passage_rewrite(title or "", heading, text, tgt, before, after, variant)
    if gen.get("error"):
        return {"error": gen["error"], "model": llm.model_id}
    new_text = gen["text"]
    # Keep the page's typography: small models straighten curly quotes, which
    # would otherwise show up as edits everywhere.
    if "’" in text:
        new_text = re.sub(r"(\w)'(\w)", "\\1’\\2", new_text)
    if not new_text or new_text.strip() == text:
        return {"error": "The model returned no change for this passage. Try another version.", "model": llm.model_id}

    new = truncate(_cached("d", [passage_embedding_text({"heading": heading, "text": new_text})], t), dim)[0] @ qv.T
    deltas = new - cur
    gain = float(np.mean(deltas[idx]))
    worst_other = min([float(deltas[i]) for i in range(len(queries)) if i not in idx] or [0.0])
    if gain >= 0.01 and worst_other > -0.03:
        verdict, why = "improves", f"Raises the target {'query' if len(idx) == 1 else 'queries'} by {gain:+.3f} on average without hurting the others."
    elif gain >= 0.01:
        verdict, why = "mixed", f"Raises the target queries by {gain:+.3f} but drops another query by {worst_other:.3f}."
    else:
        verdict, why = "no_gain", f"Doesn't raise the target queries ({gain:+.3f}). Reject it or try another version."

    return {
        "text": new_text,
        "targets": idx,
        "before": [round(float(x), 4) for x in cur],
        "after": [round(float(x), 4) for x in new],
        "deltas": [round(float(x), 4) for x in deltas],
        "verdicts_before": [_verdict(float(x), th) for x in cur],
        "verdicts_after": [_verdict(float(x), th) for x in new],
        "target_gain": round(gain, 4),
        "verdict": verdict,
        "why": why,
        "placeholders": re.findall(r"\[add:[^\]]*\]", new_text),
        "words_before": len(text.split()),
        "words_after": len(new_text.split()),
        "model": llm.model_id,
        "seconds": round(time.time() - t0, 1),
        "dim": dim,
    }

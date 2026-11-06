"""CSV ingestion + (re)embedding pipelines.

All vectors written here come from the active local model (EmbeddingGemma 2)
unless the user explicitly asks to keep vectors from a CSV column, in which case
they're tagged `csv:<column>` and the project is flagged as mixed if keywords
are added later.
"""
from __future__ import annotations

import ast
import json
import os
import re
import threading
import time
from collections import Counter, defaultdict
from urllib.parse import urlparse

import numpy as np
import pandas as pd

from services.database import get_db
from services.embedder import clean_title, embed_documents, embed_queries, truncate
from services.realtime_fetch import MIN_USEFUL_CHARS, fetch_iter
from services.vectors import is_own_page, save_vectors

# Project-level progress, read by /progress, the re-embed busy check and the
# uploads list. Several imports in one project can run at once, so each upload
# reports into JOB_PROGRESS and this dict holds a merged view: the job with the
# most work left on top, every active job under "jobs".
INGESTION_PROGRESS: dict[int, dict] = {}
JOB_PROGRESS: dict[int, dict] = {}           # upload_id -> progress (+ project_id)
_DIRECT_PROGRESS: dict[int, dict] = {}       # project_id -> progress of a job that isn't an upload (re-embed)
_PROGRESS_LOCK = threading.Lock()
# The upload this thread is importing (set by services/uploads.py), so the
# pipelines below report per file without passing an id through every call.
_JOB = threading.local()

EMBED_CHUNK = 32
# Bumped when backlink metadata gains fields; older rows are refreshed from the saved file.
LINK_META_VERSION = 2
MAX_SYNTH_FETCH = int(os.environ.get("VWS_MAX_SYNTH_FETCH", "200"))
FETCH_WORKERS = int(os.environ.get("VWS_FETCH_WORKERS", "8"))
LINK_COMMIT_EVERY = 5000


# ---------------------------------------------------------------------------
# progress helpers
# ---------------------------------------------------------------------------
def set_job(upload_id: int | None, label: str = "", on_rows_ready=None) -> None:
    """Bind (or with None, unbind) the current thread to an upload. Unbinding
    clears whatever progress the upload left behind."""
    prev = getattr(_JOB, "upload_id", None)
    if upload_id is None and prev is not None:
        with _PROGRESS_LOCK:
            p = JOB_PROGRESS.pop(prev, None)
            if p:
                _publish(p["project_id"])
    _JOB.upload_id = upload_id
    _JOB.label = label
    _JOB.on_rows_ready = on_rows_ready


def current_job() -> int | None:
    return getattr(_JOB, "upload_id", None)


def _rows_ready() -> None:
    """The import has written its page rows (the slow fetch/embed comes next).
    Link imports waiting on this crawl can start now."""
    cb = getattr(_JOB, "on_rows_ready", None)
    if cb:
        _JOB.on_rows_ready = None
        try:
            cb()
        except Exception as e:
            print(f"[ingest] rows-ready signal failed: {e}")


def _publish(project_id: int) -> None:
    """Rebuild INGESTION_PROGRESS[project_id] from the jobs running in it."""
    jobs = [dict(p, upload_id=uid) for uid, p in JOB_PROGRESS.items() if p.get("project_id") == project_id]
    if project_id in _DIRECT_PROGRESS:
        jobs.append(dict(_DIRECT_PROGRESS[project_id], upload_id=None))
    if not jobs:
        INGESTION_PROGRESS.pop(project_id, None)
        return
    jobs.sort(key=lambda j: j.get("job_start") or j.get("start_time") or 0)

    def left(j):
        return j.get("estimated_time_remaining") or 0

    top = max(jobs, key=left)
    merged = {k: top.get(k) for k in ("phase", "current", "total", "estimated_time_remaining", "start_time")}
    if len(jobs) > 1 and top.get("label"):
        merged["phase"] = f"{top['label']}: {top['phase']}"
    merged["jobs"] = jobs
    INGESTION_PROGRESS[project_id] = merged


def _progress(project_id: int, phase: str, current: int, total: int, start: float, **extra) -> None:
    elapsed = time.time() - start
    rate = current / elapsed if elapsed > 0 and current > 0 else 0
    eta = (total - current) / rate if rate > 0 else 0
    p = {
        "phase": phase,
        "current": current,
        "total": total,
        "estimated_time_remaining": eta,
        "start_time": start,
        **extra,
    }
    uid = current_job()
    with _PROGRESS_LOCK:
        if uid is not None:
            prev = JOB_PROGRESS.get(uid) or {}
            p.update(project_id=project_id, label=getattr(_JOB, "label", ""),
                     job_start=prev.get("job_start") or start)
            JOB_PROGRESS[uid] = p
        else:
            _DIRECT_PROGRESS[project_id] = p
        _publish(project_id)


def set_direct_progress(project_id: int, p: dict) -> None:
    with _PROGRESS_LOCK:
        _DIRECT_PROGRESS[project_id] = p
        _publish(project_id)


def _done(project_id: int) -> None:
    uid = current_job()
    with _PROGRESS_LOCK:
        if uid is not None:
            JOB_PROGRESS.pop(uid, None)
        else:
            _DIRECT_PROGRESS.pop(project_id, None)
        _publish(project_id)


def job_progress(upload_id: int) -> dict | None:
    return JOB_PROGRESS.get(upload_id)


def _update_page_count(project_id: int) -> None:
    conn = get_db()
    cur = conn.cursor()
    # The site's own pages: not keywords, competitor pages or backlink sources.
    cur.execute("SELECT COUNT(*) AS c FROM pages WHERE project_id = ? AND source_type NOT IN ('keyword', 'competitor', 'external_link')", (project_id,))
    n = cur.fetchone()["c"]
    cur.execute("UPDATE projects SET total_pages = ? WHERE id = ?", (n, project_id))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# CSV helpers
# ---------------------------------------------------------------------------
def _read_csv(path: str) -> pd.DataFrame | None:
    for enc in ("utf-8-sig", "latin-1"):
        try:
            df = pd.read_csv(path, low_memory=False, encoding=enc)
            df.columns = [str(c).replace("﻿", "").strip().strip('"') for c in df.columns]
            return df
        except Exception as e:
            last = e
    print(f"Failed to read CSV {path}: {last}")
    return None


def _find_col(df: pd.DataFrame, exact: list[str], contains: list[str] = ()) -> str | None:
    lower = {c.lower(): c for c in df.columns}
    for name in exact:
        if name.lower() in lower:
            return lower[name.lower()]
    for c in df.columns:
        cl = c.lower()
        if any(k in cl for k in contains):
            return c
    return None


_VEC_SPLIT = None


def _parse_vector(val) -> np.ndarray | None:
    """Screaming Frog writes embeddings as text: comma-separated floats, with
    scientific notation (9.74E-4) and sometimes [brackets] or other separators."""
    global _VEC_SPLIT
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return None
    try:
        if isinstance(val, str):
            import re
            if _VEC_SPLIT is None:
                _VEC_SPLIT = re.compile(r"[\s,;|]+")
            s = val.strip().strip("[]()")
            parts = [x for x in _VEC_SPLIT.split(s) if x]
            arr = np.asarray([float(x) for x in parts], dtype=np.float32)
        else:
            arr = np.asarray(val, dtype=np.float32)
        if arr.ndim != 1 or arr.size < 16 or not np.all(np.isfinite(arr)):
            return None
        return arr
    except Exception:
        return None


def canonical_vector_model(declared: str | None) -> str:
    """Normalize the user's 'which model made these vectors' answer."""
    d = (declared or "").strip()
    aliases = {
        "embeddinggemma-2": "google/embeddinggemma-2",
        "embeddinggemma2": "google/embeddinggemma-2",
        "embeddinggemma": "google/embeddinggemma-300m",
        "embeddinggemma-300m": "google/embeddinggemma-300m",
    }
    return aliases.get(d.lower(), d) or "unknown"


def _num(val) -> float | None:
    try:
        if isinstance(val, str):
            val = val.replace(",", "").strip()
        f = float(val)
        return None if np.isnan(f) else f
    except Exception:
        return None


# ---------------------------------------------------------------------------
# shared embedding pipelines (used by ingestion, crawler and re-embed)
# ---------------------------------------------------------------------------
def embed_and_store_pages(project_id: int, rows: list[dict], fetch_missing: bool = True,
                          phase_prefix: str = "", max_fetch: int | None = None) -> int:
    """rows: [{id, url, title, content}]. Fetches bodies that are missing,
    writes them back to `pages`, embeds title+body as documents, stores vectors.
    Returns the number of vectors written.

    Streams: pages that already have a body are embedded first, and each fetched
    page is embedded as soon as a batch of them is in, while the rest are still
    downloading. Vectors land in the project as the import runs (the analyses
    can be refreshed mid-import), and the embedder works during the fetch instead
    of after it."""
    start = time.time()
    need_fetch = [r for r in rows if fetch_missing and len(r.get("content") or "") < MIN_USEFUL_CHARS
                  and str(r.get("url", "")).startswith("http")]
    if max_fetch is not None:
        need_fetch = need_fetch[:max_fetch]
    fetch_ids = {id(r) for r in need_fetch}
    ready = [r for r in rows if id(r) not in fetch_ids]   # embed these right away
    by_url: dict[str, list[dict]] = defaultdict(list)
    for r in need_fetch:
        by_url[r["url"]].append(r)
    total = len(rows)
    n_fetch = len(by_url)
    written = fetched = 0

    def report() -> None:
        if fetched < n_fetch:
            _progress(project_id, f"{phase_prefix}Fetching page content", fetched, n_fetch, start,
                      embedded=written, embed_total=total)
        else:
            _progress(project_id, f"{phase_prefix}Embedding pages with EmbeddingGemma 2", written, total, start,
                      embedded=written, embed_total=total)

    def flush(batch: list[dict]) -> None:
        nonlocal written
        if not batch:
            return
        conn = get_db()
        cur = conn.cursor()
        # Replace placeholder titles ("Extracted Page", bare URLs) with readable ones.
        for r in batch:
            cleaned = clean_title(r.get("title"), r.get("url", ""))
            if cleaned and cleaned != (r.get("title") or ""):
                r["title"] = cleaned
                cur.execute("UPDATE pages SET title = ? WHERE id = ?", (cleaned, r["id"]))
        conn.commit()
        conn.close()
        for i in range(0, len(batch), EMBED_CHUNK):
            chunk = batch[i:i + EMBED_CHUNK]
            titles = [clean_title(r.get("title"), r.get("url", "")) for r in chunk]
            texts = [(r.get("content") or "").strip() or t for r, t in zip(chunk, titles)]
            try:
                vecs = embed_documents(texts, titles)
            except Exception as e:
                print(f"[ingest] embedding failed: {e}")
                raise
            conn = get_db()
            save_vectors(conn.cursor(), [(r["id"], v) for r, v in zip(chunk, vecs)])
            conn.commit()
            conn.close()
            written += len(chunk)
            report()

    report()
    if not need_fetch:
        flush(ready)
        return written

    pending: list[dict] = []
    stream = fetch_iter(list(by_url), workers=FETCH_WORKERS)
    try:
        for url, res in stream:
            fetched += 1
            got = by_url.get(url, [])
            if res:
                new_title, body = res
                conn = get_db()
                cur = conn.cursor()
                for r in got:
                    if body and len(body) > len(r.get("content") or ""):
                        r["content"] = body
                    # Prefer the page's real <title> over placeholders or slug-derived titles.
                    if new_title and (not r.get("title") or r.get("title") == clean_title("", r["url"])
                                      or not clean_title(r.get("title"), "")):
                        r["title"] = new_title
                    cur.execute("UPDATE pages SET title = ?, content = ? WHERE id = ?",
                                (r["title"], (r["content"] or "")[:100000], r["id"]))
                conn.commit()
                conn.close()
            pending.extend(got)
            # Pages that didn't need a fetch go first, a chunk at a time, so the
            # embedder never sits idle while the network is the bottleneck.
            if ready:
                flush(ready[:EMBED_CHUNK])
                del ready[:EMBED_CHUNK]
            if len(pending) >= EMBED_CHUNK:
                flush(pending)
                pending = []
            elif fetched % 10 == 0 or fetched == n_fetch:
                report()
    finally:
        stream.close()
    flush(ready)
    flush(pending)
    return written


def embed_and_store_keywords(project_id: int, rows: list[dict], phase_prefix: str = "") -> int:
    """rows: [{id, keyword}] -> query embeddings (task: search result)."""
    start = time.time()
    total = len(rows)
    written = 0
    for i in range(0, total, 128):
        chunk = rows[i:i + 128]
        vecs = embed_queries([r["keyword"] for r in chunk], task="search")
        conn = get_db()
        save_vectors(conn.cursor(), [(r["id"], v) for r, v in zip(chunk, vecs)])
        conn.commit()
        conn.close()
        written += len(chunk)
        _progress(project_id, f"{phase_prefix}Embedding keywords", written, total, start)
    return written


# ---------------------------------------------------------------------------
# Screaming Frog / competitor page CSV
# ---------------------------------------------------------------------------
def ingest_screaming_frog_csv(project_id: int, file_path: str, vector_column: str = "",
                              source_type: str = "base", source_name: str = "Base CSV",
                              vector_mode: str = "reembed", fetch_missing: bool = True,
                              vector_model: str = "", upload_id: int | None = None) -> bool:
    """vector_mode:
        'reembed' (default) - fetch each page's body and embed it locally with EmbeddingGemma 2.
        'csv'               - keep the vectors in `vector_column`. Screaming Frog can use any
                              embedding model, so the caller must say which one (`vector_model`).
                              Vectors are tagged '<model>:<dim>'; they only count as comparable
                              with local keyword/Lab vectors when that tag matches the active model.
    """
    print(f"Ingesting CSV for project {project_id}: type={source_type} mode={vector_mode} vector_col={vector_column!r}")
    start = time.time()
    _progress(project_id, "Reading CSV", 0, 1, start)
    df = _read_csv(file_path)
    if df is None or df.empty:
        _done(project_id)
        return False

    url_col = _find_col(df, ["Address", "URL", "Url", "Page", "Landing Page"]) or df.columns[0]
    title_col = _find_col(df, ["Title 1", "Title", "Page Title", "H1-1"])
    content_col = _find_col(df, ["Content", "Body Text", "Main Content", "Extracted Text", "Text"], [])
    ctype_col = _find_col(df, ["Content Type"])
    status_col = _find_col(df, ["Status Code"])

    if ctype_col:
        df = df[df[ctype_col].isna() | df[ctype_col].astype(str).str.contains("html", case=False)]
    if status_col:
        codes = pd.to_numeric(df[status_col], errors="coerce")
        df = df[codes.isna() | (codes == 200)]
    df = df[df[url_col].notna()].drop_duplicates(subset=[url_col])

    use_csv_vectors = vector_mode == "csv" and vector_column and vector_column in df.columns

    conn = get_db()
    cur = conn.cursor()
    rows: list[dict] = []
    csv_vecs: list[tuple[int, np.ndarray]] = []
    skipped_no_vec = 0
    total = len(df)
    for n, (_, r) in enumerate(df.iterrows(), start=1):
        url = str(r[url_col]).strip()
        raw_title = str(r[title_col]).strip() if title_col and not pd.isna(r[title_col]) else ""
        title = clean_title(raw_title, url)
        content = str(r[content_col]) if content_col and not pd.isna(r[content_col]) else ""
        vec = _parse_vector(r[vector_column]) if use_csv_vectors else None
        if use_csv_vectors and vec is None:
            skipped_no_vec += 1
        cur.execute(
            "INSERT INTO pages (project_id, url, title, content, source_type, source_name, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (project_id, url, title, content[:100000], source_type, source_name, upload_id),
        )
        pid = cur.lastrowid
        rows.append({"id": pid, "url": url, "title": title, "content": content})
        if vec is not None:
            csv_vecs.append((pid, vec))
        if n % 50 == 0:
            _progress(project_id, "Importing rows", n, total, start)
    conn.commit()
    _rows_ready()  # link imports can match against these rows while pages are fetched

    if use_csv_vectors:
        info = _store_declared_vectors(cur, csv_vecs, vector_model, vector_column, skipped_no_vec, source_name, rows)
        _record_vector_source(cur, project_id, source_name, info)
        conn.commit()
        conn.close()
        print(f"[ingest] CSV vectors: {info}")
    else:
        conn.close()
        try:
            embed_and_store_pages(project_id, rows, fetch_missing=fetch_missing)
        except Exception as e:
            print(f"[ingest] page embedding failed: {e}")

    _update_page_count(project_id)
    _done(project_id)
    return True



# ---------------------------------------------------------------------------
# declared (CSV) vectors
# ---------------------------------------------------------------------------
def _probe_same_space(csv_vecs, rows, dim: int) -> float | None:
    """Sanity-check a 'these came from EmbeddingGemma 2' claim.

    Embeds ~24 page titles locally and compares each with that page's CSV vector.
    Same model: a title-only embedding lands ~0.6-0.75 from the full-page vector.
    Different model: the spaces are unrelated and paired cosine sits near 0.
    """
    by_id = {r["id"]: r for r in rows}
    sample = [(pid, v) for pid, v in csv_vecs if pid in by_id][:24]
    if len(sample) < 5:
        return None
    titles = [clean_title(by_id[pid].get("title"), by_id[pid].get("url", "")) or by_id[pid].get("url", "") for pid, _ in sample]
    try:
        local = embed_documents(titles, titles)
    except Exception as e:
        print(f"[ingest] probe skipped: {e}")
        return None
    sims = []
    for (pid, v), lv in zip(sample, local):
        d = min(len(v), len(lv))
        a, b = truncate(np.asarray(v, dtype=np.float32), d), truncate(lv, d)
        sims.append(float(a @ b))
    return float(np.median(sims)) if sims else None


def _store_declared_vectors(cur, csv_vecs, vector_model, vector_column, skipped, source_name, rows=None) -> dict:
    from collections import Counter
    from services.embedder import MODEL_ID

    model = canonical_vector_model(vector_model)
    dims = Counter(int(v.shape[0]) for _, v in csv_vecs)
    dim = dims.most_common(1)[0][0] if dims else 0
    kept = [(pid, v) for pid, v in csv_vecs if v.shape[0] == dim]

    # Vectors are stored at their native size; analysis truncates Matryoshka
    # models (EmbeddingGemma, text-embedding-3, gemini-embedding) to the project's size.
    probe, verified, tag = None, None, model
    if model == MODEL_ID and kept:
        probe = _probe_same_space(kept, rows or [], dim)
        if probe is not None:
            verified = probe >= 0.3
            if not verified:
                # Don't let a wrong label silently mix spaces with local keywords.
                tag = f"unverified:{model}"
    save_vectors(cur, kept, model=tag)
    return {
        "source_name": source_name,
        "column": vector_column,
        "declared_model": model,
        "stored_as": tag,
        "dim": dim,
        "dims_seen": {str(k): v for k, v in dims.items()},
        "rows_with_vectors": len(kept),
        "rows_without_vectors": skipped + (len(csv_vecs) - len(kept)),
        "probe_similarity": round(probe, 3) if probe is not None else None,
        "verified": verified,
        "compatible_with_local": tag == MODEL_ID,
    }


def _record_vector_source(cur, project_id: int, source_name: str, info: dict) -> None:
    import json
    cur.execute("SELECT vector_sources FROM projects WHERE id = ?", (project_id,))
    row = cur.fetchone()
    try:
        current = json.loads(row["vector_sources"]) if row and row["vector_sources"] else {}
    except Exception:
        current = {}
    current[source_name] = info
    cur.execute("UPDATE projects SET vector_sources = ? WHERE id = ?", (json.dumps(current), project_id))

# ---------------------------------------------------------------------------
# Keywords CSV
# ---------------------------------------------------------------------------
def ingest_keyword_csv(project_id: int, file_path: str, upload_id: int | None = None,
                       source_name: str = "Keywords") -> bool:
    print(f"Ingesting keyword CSV for project {project_id}.")
    start = time.time()
    _progress(project_id, "Reading keyword CSV", 0, 1, start)
    df = _read_csv(file_path)
    if df is None or df.empty:
        _done(project_id)
        return False

    kw_col = _find_col(df, ["Keyword", "Keywords", "Query", "Queries", "Top queries", "Search Term"], ["keyword", "query"]) or df.columns[0]
    vol_col = _find_col(df, ["Volume", "Search Volume", "Avg. monthly searches", "SV", "Impressions"], ["volume", "search vol"])

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT lower(title) AS k FROM pages WHERE project_id = ? AND source_type = 'keyword'", (project_id,))
    seen = {r["k"] for r in cur.fetchall()}
    rows: list[dict] = []
    for _, r in df.iterrows():
        kw = str(r[kw_col]).strip() if not pd.isna(r[kw_col]) else ""
        if not kw or kw.lower() in seen:
            continue
        seen.add(kw.lower())
        vol = _num(r[vol_col]) if vol_col else None
        cur.execute(
            "INSERT INTO pages (project_id, url, title, content, source_type, source_name, volume, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (project_id, kw, kw, kw, "keyword", source_name, vol, upload_id),
        )
        rows.append({"id": cur.lastrowid, "keyword": kw})
    conn.commit()
    conn.close()

    try:
        embed_and_store_keywords(project_id, rows)
    except Exception as e:
        print(f"[ingest] keyword embedding failed: {e}")
    _done(project_id)
    return True


# ---------------------------------------------------------------------------
# Links CSV (Screaming Frog "All Inlinks" / Ahrefs or Semrush backlinks)
# ---------------------------------------------------------------------------
# Link types that are real links, per export. Screaming Frog's Type column
# ("Hyperlink", "Image" = an <img src>, "CSS", "Canonical"...) and Ahrefs'
# ("text", "image" = an image wrapped in a link, "alternate", "canonical",
# "rss", "frame", "redirect") use the same column name with different values.
_LINK_TYPES = {
    "internal": {"hyperlink", "ahref", "link", "a", "text"},
    "external": {"hyperlink", "ahref", "link", "a", "text", "image", "frame", "iframe"},
}
_ALL_KNOWN_TYPES = _LINK_TYPES["external"] | {"alternate", "canonical", "rss", "redirect", "css", "javascript", "js",
                                              "stylesheet", "rel prev", "rel next", "hreflang", "amp", "form", "meta refresh"}
_TRUE = {"true", "1", "yes", "y", "t"}


def _host(u: str) -> str:
    try:
        h = urlparse(u).netloc.lower().split("@")[-1].split(":")[0]
    except Exception:
        return ""
    return h[4:] if h.startswith("www.") else h


def url_key(u: str) -> str:
    """Scheme-, www- and trailing-slash-insensitive identity for matching URLs
    across exports (Ahrefs reports www/http variants the crawl doesn't have)."""
    try:
        p = urlparse((u or "").strip())
    except Exception:
        return (u or "").strip().lower()
    h = p.netloc.lower()
    h = h[4:] if h.startswith("www.") else h
    path = p.path.rstrip("/") or "/"
    return h + path + (f"?{p.query}" if p.query else "")


# Pages that came from a crawl (not from links, keywords or competitors). Their
# hosts define "your site" when a links export is imported.
CRAWL_TYPES = ("base", "realtime", "")

# A link endpoint with one of these extensions is a file, not a page.
_FILE_EXT = re.compile(
    r"\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|gz|rar|7z|tar|mp4|m4v|mov|webm|mp3|wav|ogg|"
    r"css|js|mjs|json|xml|txt|csv|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|exe|dmg|apk)$", re.I)


def is_file_url(u: str) -> bool:
    try:
        return bool(_FILE_EXT.search(urlparse(u).path or ""))
    except Exception:
        return False


def _site_hosts(page_rows) -> set[str]:
    """Hosts of the crawled site. Falls back to every own page when the project
    has no crawl yet (links imported first)."""
    crawl = {_host(r["url"]) for r in page_rows if (r["source_type"] or "") in CRAWL_TYPES}
    hosts = crawl or {_host(r["url"]) for r in page_rows if is_own_page(r["source_type"])}
    hosts.discard("")
    return hosts


def _on_hosts(h: str, hosts: set[str]) -> bool:
    return bool(h) and (h in hosts or any(h.endswith("." + o) for o in hosts))


def cleanup_link_nodes(project_id: int | None = None) -> dict:
    """Move pages that an internal-links import invented for link endpoints
    missing from the crawl out of the site analysis.

    Older imports turned every such endpoint into a site page, so a Screaming
    Frog "All Inlinks" export added thousands of Twitter, YouTube and image URLs
    plus redirects, ?page_id= and UTM variants of the site's own URLs, all
    embedded from words in the URL. They inflated the page count and produced
    nonsense actions. Once a project has a crawl, every such page is re-tagged
    (not deleted), so the links that point at them still show up as outbound
    or uncrawled links. Safe to run repeatedly."""
    conn = get_db()
    cur = conn.cursor()
    pids = [project_id] if project_id is not None else [
        r[0] for r in cur.execute("SELECT DISTINCT project_id FROM pages WHERE source_type = 'internal_link'")]
    moved: dict[int, int] = {}
    for pid in pids:
        rows = cur.execute("SELECT id, url, source_type FROM pages WHERE project_id = ? AND source_type != 'keyword'",
                           (pid,)).fetchall()
        hosts = {_host(r["url"]) for r in rows if (r["source_type"] or "") in CRAWL_TYPES}
        hosts.discard("")
        if not hosts:
            continue  # no crawl to tell the site's own hosts apart
        groups: dict[str, list[int]] = defaultdict(list)
        for r in rows:
            if r["source_type"] != "internal_link":
                continue
            own = _on_hosts(_host(r["url"]), hosts) and not is_file_url(r["url"])
            groups[UNCRAWLED_SOURCE_NAME if own else OUTBOUND_SOURCE_NAME].append(r["id"])
        if not groups:
            continue
        for name, ids in groups.items():
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                cur.execute(f"UPDATE pages SET source_type = 'external_link', source_name = ? WHERE id IN ({','.join('?' * len(chunk))})",
                            [name, *chunk])
        moved[pid] = sum(len(v) for v in groups.values())
    conn.commit()
    conn.close()
    for pid in moved:
        _update_page_count(pid)
    if moved:
        print(f"[ingest] moved link-only pages out of the site analysis: {moved}")
    return moved


OUTBOUND_SOURCE_NAME = "Outbound link (not crawled)"
UNCRAWLED_SOURCE_NAME = "Linked page (not in crawl)"


def _cell(r, col) -> str:
    if not col:
        return ""
    v = r[col]
    return "" if pd.isna(v) else str(v).strip()


def _fnum(v: str) -> float | None:
    try:
        return float(str(v).replace(",", ""))
    except Exception:
        return None


def ingest_links_csv(project_id: int, file_path: str, link_type: str, upload_id: int | None = None,
                     meta_only: bool = False) -> dict | bool:
    """Import an internal-links or backlinks export. Returns stats (truthy) or False
    when the file can't be read at all. Every skipped row is counted by reason.
    meta_only: re-read a file already imported and only refresh `links.meta` on its
    rows (no inserts, no new pages, no embedding)."""
    print(f"Ingesting {link_type} links CSV for project {project_id}.")
    start = time.time()
    _progress(project_id, f"Reading {link_type} links", 0, 1, start)
    df = _read_csv(file_path)
    if df is None or df.empty:
        _done(project_id)
        return False

    source_col = _find_col(df, ["From", "Source", "Source URL", "Source url", "Referring page URL", "Referring Page URL"], ["source", "from", "referring page url"])
    target_col = _find_col(df, ["To", "Destination", "Target URL", "Target url", "Target", "Link URL"], ["destination", "target"])
    anchor_col = _find_col(df, ["Anchor Text", "Anchor", "Link Anchor"], ["anchor"])
    type_col = _find_col(df, ["Type", "Link Type"])
    lost_col = _find_col(df, ["Lost", "Lost status", "Lost Status", "Lost link", "Lost Link"])
    title_col = _find_col(df, ["Referring page title", "Source title", "Source Title"])
    dr_col = _find_col(df, ["Domain rating", "Domain Rating", "DR", "Page ascore", "Page AS"])
    ur_col = _find_col(df, ["UR", "URL Rating", "URL rating"])
    traffic_col = _find_col(df, ["Page traffic", "Traffic"])
    # Authority and search visibility of the linking page (Ahrefs: per referring page).
    rd_col = _find_col(df, ["Referring domains", "Referring Domains", "Page referring domains"])
    kw_col = _find_col(df, ["Keywords", "Organic keywords", "Page keywords"])
    dtraffic_col = _find_col(df, ["Domain traffic", "Domain Traffic"])
    nofollow_col = _find_col(df, ["Nofollow", "Nofollow?", "No follow"])
    ugc_col = _find_col(df, ["UGC"])
    sponsored_col = _find_col(df, ["Sponsored"])
    spam_col = _find_col(df, ["Is spam"])
    content_col = _find_col(df, ["Content"])
    left_col = _find_col(df, ["Left context"])
    right_col = _find_col(df, ["Right context"])
    cat_col = _find_col(df, ["Page category"])
    first_col = _find_col(df, ["First seen", "First Seen"])
    last_col = _find_col(df, ["Last seen", "Last Seen"])
    if not source_col and len(df.columns) > 0:
        source_col = df.columns[0]
    if not target_col and len(df.columns) > 1:
        target_col = df.columns[1]
    if not source_col or not target_col:
        print("Could not parse source/target columns from links CSV.")
        _done(project_id)
        return False

    total_rows = len(df)
    skipped: Counter = Counter()
    keep_types = _LINK_TYPES.get(link_type, _LINK_TYPES["external"])
    if type_col:
        types = df[type_col].astype(str).str.strip().str.lower()
        # Only filter when the column holds link types we recognise (another
        # tool's "Type" column could mean something else entirely).
        if types.isin(_ALL_KNOWN_TYPES).mean() > 0.5:
            for t, n in types[~types.isin(keep_types)].value_counts().items():
                skipped[f"{t} links"] += int(n)
            df = df[types.isin(keep_types)]
    # Ahrefs has both "Lost" (date) and "Lost status" (reason); either marks a lost link.
    lost_cols = [c for c in {lost_col, _find_col(df, ["Lost status", "Lost Status"])} if c]
    if lost_cols:
        lost = pd.Series(False, index=df.index)
        for c in lost_cols:
            v = df[c].astype(str).str.strip().str.lower()
            lost |= df[c].notna() & ~v.isin(["", "false", "0", "no", "nan"])
        if lost.any():
            skipped["lost links"] += int(lost.sum())
            df = df[~lost]

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT url, source_type FROM pages WHERE project_id = ? AND source_type != 'keyword'", (project_id,))
    page_rows = cur.fetchall()
    by_key = {}
    for r in page_rows:
        by_key.setdefault(url_key(r["url"]), r["url"])
    own_hosts = _site_hosts(page_rows)

    def is_own_host(h: str) -> bool:
        return _on_hosts(h, own_hosts)

    inserted = dupes = adopted = 0
    seen: set = set()
    run_url: dict[str, str] = {}
    # Rows this file already owns (a replay after another file was removed): they
    # count as the file's own, not as "already loaded from another file".
    own_before = cur.execute("SELECT COUNT(*) FROM links WHERE upload_id = ?", (upload_id,)).fetchone()[0] if upload_id is not None else 0
    sources: dict[str, dict] = {}          # backlinks: referring page -> best metadata
    target_hits: Counter = Counter()       # backlinks: canonical target -> rows
    uncrawled: Counter = Counter()
    uncrawled_domains: dict[str, set] = defaultdict(set)
    total = len(df)
    for n, (_, r) in enumerate(df.iterrows(), start=1):
        src_raw, tgt_raw = _cell(r, source_col), _cell(r, target_col)
        if not src_raw.startswith("http") or not tgt_raw.startswith("http"):
            skipped["rows without a valid URL"] += 1
            continue
        # Variants of one URL (http/https, www, trailing slash) become one: the page's
        # stored URL if it exists, else the first spelling seen in this file.
        src = by_key.get(url_key(src_raw)) or run_url.setdefault(url_key(src_raw), src_raw)
        tgt = by_key.get(url_key(tgt_raw)) or run_url.setdefault(url_key(tgt_raw), tgt_raw)
        if url_key(src) == url_key(tgt):
            skipped["self-links"] += 1
            continue
        anchor = _cell(r, anchor_col)
        meta = None
        if link_type == "external":
            if is_own_host(_host(src)):
                skipped["links from your own site"] += 1
                continue
            if not is_own_host(_host(tgt)) and own_hosts:
                skipped["links to other sites"] += 1
                continue
            meta = {k: v for k, v in {
                "v": LINK_META_VERSION,
                "dr": _fnum(_cell(r, dr_col)), "ur": _fnum(_cell(r, ur_col)), "traffic": _fnum(_cell(r, traffic_col)),
                "rd": _fnum(_cell(r, rd_col)), "kw": _fnum(_cell(r, kw_col)), "dtraffic": _fnum(_cell(r, dtraffic_col)),
                "nofollow": _cell(r, nofollow_col).lower() in _TRUE if nofollow_col else None,
                "ugc": _cell(r, ugc_col).lower() in _TRUE if ugc_col else None,
                "sponsored": _cell(r, sponsored_col).lower() in _TRUE if sponsored_col else None,
                "spam": _cell(r, spam_col).lower() in _TRUE if spam_col else None,
                "in_content": _cell(r, content_col).lower() in _TRUE if content_col else None,
                "type": _cell(r, type_col).lower() if type_col else None,
                "first_seen": _cell(r, first_col) or None, "last_seen": _cell(r, last_col) or None,
            }.items() if v is not None}
            k = url_key(tgt)
            if k in by_key:
                target_hits[k] += 1
            else:
                uncrawled[tgt] += 1
                uncrawled_domains[tgt].add(_host(src))
            s = sources.setdefault(src, {"title": "", "context": "", "category": "", "prio": -1e9, "scoreable": False})
            # Links to crawled pages can be scored now, so their referring pages are fetched and embedded first.
            s["scoreable"] = s["scoreable"] or k in by_key
            ctx = " ".join(x for x in (_cell(r, left_col), anchor, _cell(r, right_col)) if x).strip()
            prio = ((0 if meta.get("nofollow") else 2) + (0 if meta.get("spam") else 1)
                    + np.log1p(meta.get("dr") or 0) / 2 + np.log1p(meta.get("traffic") or 0) / 4
                    + np.log1p(meta.get("rd") or 0) / 4 + np.log1p(meta.get("kw") or 0) / 4)
            if prio > s["prio"] or (not s["context"] and ctx):
                s["prio"] = max(prio, s["prio"])
                s["title"] = s["title"] or _cell(r, title_col)
                if ctx and len(ctx) > len(s["context"]):
                    s["context"] = ctx
                s["category"] = s["category"] or _cell(r, cat_col)
        if meta and (own_before or meta_only):
            # Replaying its own file: refresh the tool metadata (newer fields), also on
            # rows an older import stored under another spelling of the same URL.
            # (+upload_id keeps SQLite on the unique (project, source, target) index.)
            cur.execute(
                "UPDATE links SET meta = ? WHERE project_id = ? AND link_type = ? AND +upload_id = ? "
                "AND source_url IN (?, ?) AND target_url IN (?, ?)",
                (json.dumps(meta), project_id, link_type, upload_id, src, src_raw, tgt, tgt_raw),
            )
        if meta_only:
            continue
        if (src, tgt) in seen:
            # One page linking the same target twice is stored once.
            skipped["repeat links (same page to the same target)"] += 1
            continue
        seen.add((src, tgt))
        cur.execute(
            "INSERT OR IGNORE INTO links (project_id, source_url, target_url, link_type, anchor_text, upload_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (project_id, src, tgt, link_type, anchor, upload_id, json.dumps(meta) if meta else None),
        )
        if cur.rowcount:
            inserted += 1
        else:
            dupes += 1
            if upload_id is not None:
                # A row imported before uploads were tracked now belongs to this file,
                # so Remove / Re-import on it work (and it picks up the tool's metadata).
                cur.execute(
                    "UPDATE links SET upload_id = ?, meta = COALESCE(meta, ?) WHERE project_id = ? AND source_url = ? "
                    "AND target_url = ? AND link_type = ? AND upload_id IS NULL",
                    (upload_id, json.dumps(meta) if meta else None, project_id, src, tgt, link_type),
                )
                adopted += cur.rowcount
            if anchor:
                cur.execute(
                    "UPDATE links SET anchor_text = ? WHERE project_id = ? AND source_url = ? AND target_url = ? "
                    "AND link_type = ? AND (anchor_text IS NULL OR anchor_text = '')",
                    (anchor, project_id, src, tgt, link_type),
                )
        if n % 2000 == 0 and not meta_only:
            _progress(project_id, f"Importing {link_type} links", n, total, start)
        if n % LINK_COMMIT_EVERY == 0:
            # Short write transactions: other imports in the project write while this runs.
            conn.commit()
    if meta_only:
        conn.commit()
        conn.close()
        _done(project_id)
        return {"ok": True, "meta_only": True, "rows": total_rows}
    if adopted:
        # ...and so do the link-only pages those rows created back then.
        cur.execute(
            "UPDATE pages SET upload_id = ? WHERE project_id = ? AND upload_id IS NULL AND source_type = ? AND url IN "
            "(SELECT source_url FROM links WHERE upload_id = ? UNION SELECT target_url FROM links WHERE upload_id = ?)",
            (upload_id, project_id, f"{link_type}_link", upload_id, upload_id),
        )
    conn.commit()

    # Nodes the links reference that the project doesn't have yet.
    cur.execute("SELECT url FROM pages WHERE project_id = ?", (project_id,))
    existing = {url_key(r["url"]) for r in cur.fetchall()}
    rows: list[dict] = []
    not_added: Counter = Counter()
    if link_type == "external":
        # Only the referring pages: backlink targets are your own pages, and one
        # that isn't in the crawl is reported (not invented as a node).
        new_sources = sorted((u for u in sources if url_key(u) not in existing),
                             key=lambda u: (not sources[u]["scoreable"], -sources[u]["prio"]))
        for u in new_sources:
            meta = sources[u]
            title = meta["title"] or clean_title("", u)
            # Title + the text around the link stand in for the page until it's fetched.
            snippet = " ".join(x for x in (meta["context"], meta["category"]) if x)
            cur.execute(
                "INSERT INTO pages (project_id, url, title, content, source_type, source_name, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (project_id, u, title, snippet, "external_link", "External Source", upload_id),
            )
            rows.append({"id": cur.lastrowid, "url": u, "title": title, "content": snippet, "snippet": snippet})
    else:
        referenced = set()
        cur.execute("SELECT source_url, target_url FROM links WHERE project_id = ? AND link_type = ? AND upload_id IS ?",
                    (project_id, link_type, upload_id))
        for a, b in cur.fetchall():
            referenced.update((a, b))
        # With a crawl loaded, the crawl defines the site: endpoints missing from it
        # are reported, not invented as pages (redirects, ?page_id= and UTM variants,
        # other sites, images). Links to them stay, so the Link Graph still lists
        # outbound links. Without a crawl (links imported first), your own pages are
        # added so the graph has nodes; other sites and files never are.
        has_crawl = any((r["source_type"] or "") in CRAWL_TYPES for r in page_rows)
        for u in sorted(x for x in referenced if url_key(x) not in existing):
            if own_hosts and not is_own_host(_host(u)):
                not_added["other sites"] += 1
                continue
            if is_file_url(u):
                not_added["files (images, PDFs...)"] += 1
                continue
            if has_crawl:
                not_added["your URLs not in the crawl"] += 1
                continue
            title = clean_title("", u)
            cur.execute(
                "INSERT INTO pages (project_id, url, title, content, source_type, source_name, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (project_id, u, title, "", f"{link_type}_link", f"{link_type.capitalize()} Source", upload_id),
            )
            rows.append({"id": cur.lastrowid, "url": u, "title": title, "content": ""})
    conn.commit()
    conn.close()

    fetched = 0
    if rows:
        print(f"Synthesized {len(rows)} nodes referenced by {link_type} links.")
        try:
            embed_and_store_pages(project_id, rows, fetch_missing=True, max_fetch=MAX_SYNTH_FETCH,
                                  phase_prefix="Referring pages: " if link_type == "external" else "")
        except Exception as e:
            print(f"[ingest] link node embedding failed: {e}")
        if link_type == "external":
            got = [r["id"] for r in rows if (r.get("content") or "") != r.get("snippet", "")]
            fetched = len(got)
            if got:
                conn = get_db()
                conn.executemany("UPDATE pages SET source_name = 'External Source (fetched)' WHERE id = ?", [(i,) for i in got])
                conn.commit()
                conn.close()
    _update_page_count(project_id)
    _done(project_id)
    if link_type == "external" and upload_id is not None:
        # Counted from the database so a replay (no new pages) still reports them.
        conn = get_db()
        fetched, synth_total = conn.execute(
            "SELECT SUM(source_name = 'External Source (fetched)'), COUNT(*) FROM pages "
            "WHERE upload_id = ? AND source_type = 'external_link'", (upload_id,)).fetchone()
        conn.close()
        fetched, synth_total = int(fetched or 0), int(synth_total or 0)
    else:
        synth_total = len(rows)
    stats = {
        "ok": True, "rows": total_rows, "inserted": inserted + own_before, "duplicates": max(0, dupes - own_before),
        "adopted": adopted, "replayed": bool(own_before), "meta_version": LINK_META_VERSION,
        "skipped": dict(skipped.most_common()), "new_nodes": len(rows),
    }
    if not_added:
        stats["endpoints_not_added_as_pages"] = dict(not_added.most_common())
    if link_type == "external":
        stats.update({
            "referring_pages": len(sources), "referring_domains": len({_host(u) for u in sources}),
            "fetched_pages": fetched, "context_scored": max(0, synth_total - fetched),
            "targets_matched_rows": int(sum(target_hits.values())), "targets_not_in_crawl_rows": int(sum(uncrawled.values())),
            "top_uncrawled": [{"url": u, "backlinks": c, "domains": len(uncrawled_domains[u])} for u, c in uncrawled.most_common(15)],
        })
    print(f"[ingest] links: {stats}")
    return stats


# ---------------------------------------------------------------------------
# Re-embed an entire project with the active model
# ---------------------------------------------------------------------------
def reembed_project(project_id: int, fetch_missing: bool = True) -> dict:
    """Re-embeds every page (documents) and keyword (queries) in a project with
    the active model. Pages whose stored body is missing or trivial are fetched
    first, so Screaming Frog vector-only imports end up with real content too."""
    start = time.time()
    _progress(project_id, "Preparing re-embed", 0, 1, start)
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, url, title, content, source_type FROM pages WHERE project_id = ?", (project_id,))
    all_rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    kw_rows = [{"id": r["id"], "keyword": r["title"] or r["url"]} for r in all_rows if r["source_type"] == "keyword"]
    page_rows = [r for r in all_rows if r["source_type"] != "keyword"]
    # Own pages and competitors get fetched; external backlink sources are capped.
    primary = [r for r in page_rows if is_own_page(r["source_type"]) or r["source_type"] == "competitor"]
    external = [r for r in page_rows if r not in primary]

    result = {"pages": 0, "keywords": 0, "external": 0}
    try:
        n_steps = 1 + (1 if external else 0) + (1 if kw_rows else 0)
        step = 1
        if primary:
            result["pages"] = embed_and_store_pages(project_id, primary, fetch_missing=fetch_missing,
                                                    phase_prefix=f"[{step}/{n_steps}] ")
        step += 1
        if external:
            result["external"] = embed_and_store_pages(project_id, external, fetch_missing=fetch_missing,
                                                       phase_prefix=f"[{step}/{n_steps}] ", max_fetch=MAX_SYNTH_FETCH)
            step += 1
        if kw_rows:
            result["keywords"] = embed_and_store_keywords(project_id, kw_rows, phase_prefix=f"[{step}/{n_steps}] ")
        # Drop legacy vectors so the project no longer reads as mixed.
        conn = get_db()
        cur = conn.cursor()
        cur.execute("DELETE FROM vec_embeddings WHERE rowid IN (SELECT id FROM pages WHERE project_id = ?)", (project_id,))
        cur.execute("UPDATE projects SET vector_sources = NULL WHERE id = ?", (project_id,))
        conn.commit()
        conn.close()
        _update_page_count(project_id)
    finally:
        _done(project_id)
    result["seconds"] = round(time.time() - start, 1)
    print(f"[reembed] project {project_id}: {result}")
    return result

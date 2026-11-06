from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional
from pydantic import BaseModel
import uvicorn
import os
import sys
import asyncio
import json
import random

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi.responses import StreamingResponse

from services import uploads as uploads_svc
from services.database import setup_db, get_db
from services.crawler import execute_crawl_pipeline, extract_urls
from services.embedder import embedder_status, warmup as warmup_embedder
from services.ingestion import (ingest_screaming_frog_csv, ingest_keyword_csv, ingest_links_csv,
                                reembed_project, INGESTION_PROGRESS, set_direct_progress)
from services.analysis import perform_analysis, compare_entities, get_project_entities, locate_query
from services.actions import build_action_plan, set_action_state
from services import lab as relevance_lab
from services import insights
from services.structure import build_structure
from services.vectors import get_project_settings, set_project_settings
from services.llm import LocalLLMManager
from services.realtime_fetch import fetch_and_extract, cache_into_pages, MIN_USEFUL_CHARS

app = FastAPI(title="VWS Backend API", version="1.0.0")

# CORS for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CRAWL_QUEUES = {}

@app.on_event("startup")
def startup_event():
    setup_db()
    # Older internal-link imports turned other sites' URLs and image files into
    # site pages; move them out of the analysis (idempotent, quick when clean).
    try:
        from services.ingestion import cleanup_link_nodes
        cleanup_link_nodes()
    except Exception as e:
        print(f"[startup] link-node cleanup skipped: {e}")
    # Imports cut off by a restart show up as "interrupted" once their heartbeat
    # goes stale (services/uploads.py), not here: another backend instance may
    # still be running them.
    # Load EmbeddingGemma 2 in the background so the first request isn't slow.
    import threading
    threading.Thread(target=warmup_embedder, daemon=True).start()

@app.get("/api/health")
def health():
    """Readiness check for the desktop app (it waits for this before opening the UI)."""
    return {"ok": True}


class ProjectCreate(BaseModel):
    name: str
    crawl_mode: str = "url" # url, list, or sitemap
    start_urls: str
    crawler_type: str = "playwright" # scrapling or playwright
    max_urls: int = 100
    concurrency: int = 5

@app.post("/api/projects")
async def create_project(project: ProjectCreate, background_tasks: BackgroundTasks):
    domain = project.start_urls.split('\n')[0].replace('https://', '').replace('http://', '').split('/')[0]
    
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO projects (name, domain) VALUES (?, ?)", (project.name, domain))
    project_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    urls = extract_urls(project.crawl_mode, project.start_urls, project.max_urls)
    
    # Setup Background Task
    message_queue = asyncio.Queue()
    CRAWL_QUEUES[project_id] = message_queue
    main_loop = asyncio.get_running_loop()
    background_tasks.add_task(execute_crawl_pipeline, project_id, urls, project.concurrency, message_queue, main_loop)
    
    return {"message": "Project created", "data": {"id": project_id, **project.dict(), "domain": domain}}

@app.get("/api/projects")
def list_projects():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM projects ORDER BY id DESC")
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    # Projects whose score was never stored (it used to be written only by Recompute).
    from services.analysis import store_project_stats
    for row in rows:
        if not row["focus_score"] and (row["total_pages"] or 0) > 0:
            try:
                row.update(store_project_stats(row["id"]))
            except Exception as e:
                print(f"[projects] focus score for {row['id']} failed: {e}")
    projects = []
    for row in rows:
        projects.append({
            "id": row["id"],
            "name": row["name"],
            "domain": row["domain"],
            "total_pages": row["total_pages"],
            "focus_score": row["focus_score"],
            "crawldate": row["created_at"].split(" ")[0] if row["created_at"] else "N/A"
        })
    return {"projects": projects}

@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int):
    conn = get_db()
    cursor = conn.cursor()
    # Remove vectors (legacy + current)
    cursor.execute("""
        DELETE FROM vec_embeddings 
        WHERE rowid IN (SELECT id FROM pages WHERE project_id = ?)
    """, (project_id,))
    cursor.execute("DELETE FROM page_vectors WHERE page_id IN (SELECT id FROM pages WHERE project_id = ?)", (project_id,))
    for table in ("links", "rewrite_briefs", "action_state", "crawl_log"):
        cursor.execute(f"DELETE FROM {table} WHERE project_id = ?", (project_id,))
    # Remove pages
    cursor.execute("DELETE FROM pages WHERE project_id = ?", (project_id,))
    # Remove project metadata
    cursor.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    conn.commit()
    conn.close()
    # Its uploaded files (rows + saved copies). After the commit: a second
    # connection writing inside the open transaction would hit "database is locked".
    uploads_svc.delete_project_uploads(project_id)

    # Clean up queue if exists
    if project_id in CRAWL_QUEUES:
        del CRAWL_QUEUES[project_id]
        
    return {"status": "deleted"}

@app.post("/api/projects/{project_id}/recompute")
def recompute_project(project_id: int):
    from services.analysis import perform_analysis
    
    from services.analysis import store_project_stats
    try:
        analysis_data = perform_analysis(project_id)
        focus_score = analysis_data.get("focus_score", 0.0)
    except Exception as e:
        print("Recompute Analysis failed, defaulting to 0:", e)
        focus_score = 0.0
    st = store_project_stats(project_id, focus_score)
    return {"status": "success", **st}

@app.get("/api/projects/{project_id}/metadata")
def get_project_metadata(project_id: int):
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
    project_row = cursor.fetchone()
    if not project_row:
        conn.close()
        return {"error": "Project not found"}
        
    project_meta = {
        "id": project_row["id"],
        "name": project_row["name"],
        "domain": project_row["domain"],
        "created_at": project_row["created_at"],
        "vector_sources": json.loads(project_row["vector_sources"]) if project_row["vector_sources"] else {},
    }
    
    cursor.execute("""
        SELECT source_name, source_type, COUNT(*) as volume
        FROM pages
        WHERE project_id = ?
        GROUP BY source_name, source_type
        ORDER BY volume DESC
    """, (project_id,))
    
    files = []
    for row in cursor.fetchall():
        files.append({
            "source_name": row["source_name"],
            "source_type": row["source_type"],
            "volume": row["volume"]
        })
    # Links aren't pages, so a links or backlinks file never showed up above.
    links = {r["link_type"]: r["n"] for r in cursor.execute(
        "SELECT link_type, COUNT(*) AS n FROM links WHERE project_id = ? GROUP BY link_type", (project_id,)).fetchall()}
    conn.close()
    try:
        up = uploads_svc.list_uploads(project_id)
        uploads = [{k: u.get(k) for k in ("id", "kind", "kind_label", "filename", "status", "message", "created_at", "counts", "stats", "legacy")}
                   for u in up["uploads"] + up["legacy"]]
    except Exception as e:
        print(f"[metadata] uploads list failed: {e}")
        uploads = []
    return {
        "project": project_meta,
        "files": files,
        "links": links,
        "uploads": uploads,
    }

@app.post("/api/projects/{project_id}/crawl")
def trigger_crawl(project_id: int):
    return {"status": "crawling"}

@app.get("/api/projects/{project_id}/progress")
def get_ingestion_progress(project_id: int):
    prog = INGESTION_PROGRESS.get(project_id)
    if prog:
        return {"status": "ingesting", "progress": prog}
    return {"status": "complete"}

@app.post("/api/projects/upload-csv-init")
async def upload_csv_init(
    background_tasks: BackgroundTasks,
    name: str = Form(...),
    vector_column: str = Form(""),
    vector_mode: str = Form("reembed"),
    vector_model: str = Form(""),
    fetch_missing: bool = Form(True),
    file: UploadFile = File(...)
):
    data = await file.read()
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO projects (name, domain, total_pages, focus_score) VALUES (?, ?, ?, ?)", (name, "Local CSV", 0, 0.0))
    project_id = cursor.lastrowid
    conn.commit()
    conn.close()

    # The file is kept (services/uploads.py) so it can be re-imported later.
    up = uploads_svc.create_upload(project_id, "base", "Base CSV", file.filename or "crawl.csv", data,
                                   {"vector_column": vector_column, "vector_mode": vector_mode,
                                    "vector_model": vector_model, "fetch_missing": fetch_missing})
    uploads_svc.submit(up["id"])
    
    return {"message": "Project CSV initialized", "data": {"id": project_id, "name": name, "domain": "Local CSV"}}

@app.post("/api/projects/{project_id}/upload-csv")
async def upload_csv(
    project_id: int, 
    background_tasks: BackgroundTasks,
    source_type: str = Form(...),
    source_name: str = Form(...),
    vector_column: str = Form(""),
    vector_mode: str = Form("reembed"),
    vector_model: str = Form(""),
    fetch_missing: bool = Form(True),
    file: UploadFile = File(...)
):
    if source_type not in ("competitor", "keyword", "external", "internal"):
        raise HTTPException(status_code=400, detail=f"Unknown source type: {source_type}")
    data = await file.read()
    fname = file.filename or f"{source_type}.csv"
    if source_type == "keyword":
        source_name = f"Keywords · {fname}"
    elif source_type in ("external", "internal"):
        source_name = f"{source_type}_link_import"
    # The file is kept and registered, so it stays listed after a reload or restart
    # and can be removed or re-imported on its own.
    up = uploads_svc.create_upload(project_id, source_type, source_name, fname, data,
                                   {"vector_column": vector_column, "vector_mode": vector_mode,
                                    "vector_model": vector_model, "fetch_missing": fetch_missing})
    uploads_svc.submit(up["id"])
    return {"status": "csv submitted for ingestion", "upload": up["id"]}


@app.get("/api/projects/{project_id}/uploads")
def get_uploads(project_id: int):
    """Every file uploaded into the project (kept on disk), with live row counts."""
    return uploads_svc.list_uploads(project_id)


@app.delete("/api/projects/{project_id}/uploads/{upload_id}")
def delete_upload(project_id: int, upload_id: int, background_tasks: BackgroundTasks):
    res = uploads_svc.remove_upload(project_id, upload_id)
    if res.get("error"):
        raise HTTPException(status_code=400, detail=res["error"])
    if res.get("replay"):
        background_tasks.add_task(uploads_svc.replay_uploads, res["replay"])
    return res


@app.post("/api/projects/{project_id}/uploads/{upload_id}/reimport")
def reimport_upload(project_id: int, upload_id: int, background_tasks: BackgroundTasks):
    res = uploads_svc.reset_upload(project_id, upload_id)
    if res.get("error"):
        raise HTTPException(status_code=400, detail=res["error"])
    uploads_svc.submit(upload_id)
    return res


@app.get("/api/projects/{project_id}/uploads/{upload_id}/file")
def download_upload(project_id: int, upload_id: int):
    from fastapi.responses import FileResponse
    u = uploads_svc.get_upload(upload_id)
    if not u or u["project_id"] != project_id or not u.get("stored_path") or not os.path.exists(u["stored_path"]):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(u["stored_path"], filename=u["filename"], media_type="text/csv")

@app.delete("/api/projects/{project_id}/data/{source_name}")
def delete_source_data(project_id: int, source_name: str, background_tasks: BackgroundTasks):
    conn = get_db()
    cursor = conn.cursor()
    # Data imported before uploads were tracked (upload_id IS NULL). Tracked files
    # are removed with DELETE /uploads/{id}, which only touches that file's rows.
    link_type = {"Internal Source": "internal", "External Source": "external",
                 "internal_link_import": "internal", "external_link_import": "external",
                 "internal": "internal", "external": "external"}.get(source_name)
    if link_type:
        page_filter = ("project_id = ? AND upload_id IS NULL AND (source_name = ? OR source_type = ?)",
                       (project_id, source_name, f"{link_type}_link"))
    else:
        page_filter = ("project_id = ? AND upload_id IS NULL AND source_name = ?", (project_id, source_name))
    cursor.execute(f"DELETE FROM vec_embeddings WHERE rowid IN (SELECT id FROM pages WHERE {page_filter[0]})", page_filter[1])
    cursor.execute(f"DELETE FROM page_vectors WHERE page_id IN (SELECT id FROM pages WHERE {page_filter[0]})", page_filter[1])
    if link_type:
        cursor.execute("DELETE FROM links WHERE project_id = ? AND link_type = ? AND upload_id IS NULL", (project_id, link_type))
    cursor.execute(f"DELETE FROM pages WHERE {page_filter[0]}", page_filter[1])
    # Tracked files of the same type may have shared rows with this data (imports
    # skip rows that already exist); replay them so those rows come back.
    kind = link_type or ("keyword" if source_name == "Keywords" or source_name.startswith("Keywords") else None)
    if kind:
        replay = uploads_svc.tracked_of_kind(project_id, kind)
        if replay:
            background_tasks.add_task(uploads_svc.replay_uploads, replay)
    
    conn.commit()
    conn.close()
    return {"status": "success", "message": f"Deleted source {source_name}"}

@app.get("/api/projects/{project_id}/analysis")
def get_analysis_data(project_id: int, distance_metric: str = "cosine"):
    # Pull the simulated data generated securely by our math engine mock
    data = perform_analysis(project_id, distance_metric)
    if distance_metric == "cosine":
        try:  # keep the dashboard card in step with what the workspace shows
            from services.analysis import store_project_stats
            store_project_stats(project_id, data.get("focus_score"))
        except Exception as e:
            print(f"[analysis] storing focus score failed: {e}")
    return data

@app.get("/api/projects/{project_id}/entities")
def get_entities(project_id: int):
    return get_project_entities(project_id)

@app.get("/api/projects/{project_id}/compare")
def compare(project_id: int, source_id: int, target_id: int, metric: str = "cosine"):
    res = insights.compare_pages(project_id, source_id, target_id)
    if "similarity" in res:
        res["distance"] = round(1.0 - res["similarity"], 4)  # kept for the history log / CSV
    return res

class RewriteRequest(BaseModel):
    keyword: str
    url: str
    force: bool = False  # when True, ignore cached brief and regenerate
    evidence: str = ""   # optional Relevance Lab findings to ground the brief

class ViewSummaryRequest(BaseModel):
    view_name: str
    payload_text: str

@app.post("/api/projects/{project_id}/generate-rewrite")
def generate_rewrite(project_id: int, req: RewriteRequest):
    """Generate an AI rewrite brief. If the URL is in the project's pages table
    we use the cached body. If it's missing OR has trivial body content, we
    fetch the page on demand with Scrapling and extract with Trafilatura, then
    cache the result back into pages for next time."""
    import time
    t_start = time.time()
    print(f"\n[rewrite] START url={req.url!r} keyword={req.keyword!r} force={req.force}")

    # Cache short-circuit: if we already generated a brief for this exact
    # (project, keyword, url) and the caller didn't ask for a regeneration,
    # return the saved text immediately.
    if not req.force:
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT brief_text, body_chars, fetched_realtime, created_at, updated_at "
                "FROM rewrite_briefs WHERE project_id = ? AND keyword = ? AND url = ?",
                (project_id, req.keyword, req.url),
            )
            cached = cursor.fetchone()
            conn.close()
            if cached:
                print(f"[rewrite] CACHE HIT for {req.keyword!r} → {req.url!r}")
                return {
                    "status": "success",
                    "data": cached["brief_text"],
                    "page_found": True,
                    "fetched_realtime": bool(cached["fetched_realtime"]),
                    "body_chars": cached["body_chars"] or 0,
                    "from_cache": True,
                    "created_at": cached["created_at"],
                    "updated_at": cached["updated_at"],
                    "timing": {"prep_s": 0.0, "llm_s": 0.0, "total_s": round(time.time() - t_start, 2)},
                }
        except Exception as e:
            print(f"[rewrite] cache lookup failed: {e}")

    page_title = ""
    page_body = ""
    page_found_in_db = False
    fetched_realtime = False

    # Try a few common URL variants so a trailing-slash mismatch doesn't miss.
    url_variants = [req.url]
    if req.url.endswith('/'):
        url_variants.append(req.url.rstrip('/'))
    else:
        url_variants.append(req.url + '/')

    matched_url = req.url
    try:
        conn = get_db()
        cursor = conn.cursor()
        for u in url_variants:
            cursor.execute(
                "SELECT title, url, content FROM pages WHERE project_id = ? AND url = ?",
                (project_id, u),
            )
            row = cursor.fetchone()
            if row:
                page_found_in_db = True
                matched_url = row['url']
                page_title = row['title'] or ""
                page_body = row['content'] or "" if 'content' in row.keys() else ""
                break
        conn.close()
    except Exception as e:
        print(f"generate_rewrite: page lookup failed: {e}")

    # If we don't have enough body text, fetch in real time and cache it.
    if len(page_body) < MIN_USEFUL_CHARS:
        print(f"generate_rewrite: body for {req.url} is {len(page_body)} chars, fetching on demand…")
        fetched = fetch_and_extract(req.url)
        if fetched is not None:
            fetched_realtime = True
            new_title, new_body = fetched
            if new_title and not page_title:
                page_title = new_title
            if new_body and len(new_body) > len(page_body):
                page_body = new_body
            # Cache so subsequent rewrites for this URL skip the network hit.
            try:
                conn = get_db()
                cache_into_pages(conn, project_id, matched_url, page_title, page_body)
                conn.close()
            except Exception as e:
                print(f"generate_rewrite: caching failed: {e}")

    # Build the LLM context.
    page_content = f"Title: {page_title or '(unknown)'}\nURL: {req.url}"
    if page_body:
        page_content += f"\nBody Content: {page_body[:3000]}"
    if req.evidence:
        page_content += (
            "\n\nRelevance Lab measurements (EmbeddingGemma 2 cosine similarity; use these to decide "
            "which passages to rewrite and which sub-queries need new passages):\n" + req.evidence[:4000]
        )
    if not page_body:
        page_content += (
            "\n\nNote: Page body could not be retrieved (the URL is not crawled "
            "and on-demand fetch also failed). Produce the brief from the keyword "
            "and URL alone, treating the page as a hypothetical target."
        )

    t_ctx = time.time()
    print(f"[rewrite] page_found_db={page_found_in_db} fetched_rt={fetched_realtime} body_chars={len(page_body)} (ctx prep: {t_ctx-t_start:.1f}s)")

    llm = LocalLLMManager.get_instance()
    t_llm = time.time()
    result = llm.generate_rewrite_brief(req.keyword, page_content)
    t_done = time.time()
    print(f"[rewrite] DONE llm_gen={t_done-t_llm:.1f}s total={t_done-t_start:.1f}s")

    # Persist the brief so reopening the modal doesn't trigger a regeneration.
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO rewrite_briefs (project_id, keyword, url, brief_text, body_chars, fetched_realtime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(project_id, keyword, url) DO UPDATE SET
                brief_text = excluded.brief_text,
                body_chars = excluded.body_chars,
                fetched_realtime = excluded.fetched_realtime,
                updated_at = CURRENT_TIMESTAMP
            """,
            (project_id, req.keyword, req.url, result, len(page_body), 1 if fetched_realtime else 0),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[rewrite] cache write failed: {e}")

    return {
        "status": "success",
        "data": result,
        "page_found": page_found_in_db or fetched_realtime,
        "fetched_realtime": fetched_realtime,
        "body_chars": len(page_body),
        "from_cache": False,
        "timing": {"prep_s": round(t_ctx - t_start, 1), "llm_s": round(t_done - t_llm, 1), "total_s": round(t_done - t_start, 1)},
    }


@app.get("/api/projects/{project_id}/rewrite-briefs")
def list_rewrite_briefs(project_id: int):
    """Return the (keyword, url, updated_at) of every cached brief in this
    project. The frontend uses this to badge table rows that already have a
    saved brief."""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT keyword, url, updated_at FROM rewrite_briefs WHERE project_id = ? ORDER BY updated_at DESC",
            (project_id,),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return {"briefs": rows}
    except Exception as e:
        return {"briefs": [], "error": str(e)}


@app.delete("/api/projects/{project_id}/rewrite-briefs")
def delete_rewrite_brief(project_id: int, keyword: str, url: str):
    """Allow the UI to drop a cached brief — useful if the user wants to start
    fresh without going through the regenerate path."""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM rewrite_briefs WHERE project_id = ? AND keyword = ? AND url = ?",
            (project_id, keyword, url),
        )
        conn.commit()
        deleted = cursor.rowcount
        conn.close()
        return {"deleted": deleted}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/projects/{project_id}/generate-view-summary")
def generate_view_summary(project_id: int, request: ViewSummaryRequest):
    llm = LocalLLMManager.get_instance()
    summary = llm.generate_view_summary(request.view_name, request.payload_text)
    return {"summary": summary}

@app.get("/api/llm/status")
def llm_status():
    """Reports whether the local LLM is loaded and surfaces the load error if not."""
    llm = LocalLLMManager.get_instance()
    return {
        "loaded": llm.model is not None and llm.processor is not None,
        "model_id": llm.model_id,
        "error": llm.load_error,
    }
    
class ArchitectureRequest(BaseModel):
    clusters: list

@app.post("/api/projects/{project_id}/generate-architecture")
def generate_site_architecture(project_id: int, request: ArchitectureRequest):
    llm = LocalLLMManager.get_instance()
    summary = llm.generate_site_architecture(request.clusters)
    return {"architecture": summary}

# ---------------------------------------------------------------------------
# Embedding engine
# ---------------------------------------------------------------------------
@app.get("/api/embedder/status")
def get_embedder_status():
    return embedder_status()


class ReembedRequest(BaseModel):
    fetch_missing: bool = True


@app.post("/api/projects/{project_id}/reembed")
def reembed(project_id: int, req: ReembedRequest, background_tasks: BackgroundTasks):
    if project_id in INGESTION_PROGRESS:
        return {"status": "busy", "progress": INGESTION_PROGRESS[project_id]}
    set_direct_progress(project_id, {"phase": "Queued re-embed", "current": 0, "total": 1,
                                     "estimated_time_remaining": 0, "start_time": 0})
    background_tasks.add_task(reembed_project, project_id, req.fetch_missing)
    return {"status": "started"}


# ---------------------------------------------------------------------------
# Action Plan
# ---------------------------------------------------------------------------
@app.get("/api/projects/{project_id}/actions")
def get_actions(project_id: int, strong: Optional[float] = None, gap: Optional[float] = None,
                cannibal_margin: Optional[float] = None, dup: Optional[float] = None,
                link_min: Optional[float] = None, cluster: Optional[float] = None):
    overrides = {"strong": strong, "gap": gap, "cannibal_margin": cannibal_margin, "dup": dup,
                 "link_min": link_min, "cluster": cluster}
    return build_action_plan(project_id, overrides)


class ActionStateRequest(BaseModel):
    key: str
    status: str
    note: Optional[str] = None


@app.post("/api/projects/{project_id}/actions/state")
def update_action_state(project_id: int, req: ActionStateRequest):
    return set_action_state(project_id, req.key, req.status, req.note)


# ---------------------------------------------------------------------------
# Relevance Lab
# ---------------------------------------------------------------------------
class LabAnalyzeRequest(BaseModel):
    queries: List[str]
    url: Optional[str] = None
    text: Optional[str] = None
    title: Optional[str] = None
    compare_urls: List[str] = []


@app.post("/api/projects/{project_id}/lab/analyze")
def lab_analyze(project_id: int, req: LabAnalyzeRequest):
    try:
        return relevance_lab.analyze(project_id, req.queries, req.url, req.text, req.title, req.compare_urls)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lab analysis failed: {e}")


class LabScoreRequest(BaseModel):
    queries: List[str]
    passages: List[dict]
    title: Optional[str] = None
    dim: Optional[int] = None


@app.post("/api/lab/score")
def lab_score(req: LabScoreRequest):
    try:
        return relevance_lab.score_passages(req.queries, req.passages, req.title, req.dim)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Scoring failed: {e}")


class LabSuggestRequest(BaseModel):
    queries: List[str]
    passage: dict
    title: Optional[str] = None
    targets: Optional[List[int]] = None
    dim: Optional[int] = None
    before: str = ""
    after: str = ""
    variant: int = 0


@app.post("/api/lab/suggest")
def lab_suggest(req: LabSuggestRequest):
    """Local-LLM rewrite of one passage, measured against every query."""
    try:
        return relevance_lab.suggest_rewrite(req.queries, req.passage, req.title, req.targets, req.dim,
                                             req.before, req.after, req.variant)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Suggestion failed: {e}")


# ---------------------------------------------------------------------------
# Project settings (analysis vector size)
# ---------------------------------------------------------------------------
@app.get("/api/projects/{project_id}/settings")
def get_settings(project_id: int):
    conn = get_db()
    try:
        return get_project_settings(conn, project_id)
    finally:
        conn.close()


class SettingsRequest(BaseModel):
    analysis_dim: Optional[int] = None


@app.post("/api/projects/{project_id}/settings")
def update_settings(project_id: int, req: SettingsRequest):
    conn = get_db()
    try:
        return set_project_settings(conn, project_id, {k: v for k, v in req.dict().items() if v is not None})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Structure + per-view analyses
# ---------------------------------------------------------------------------
@app.get("/api/projects/{project_id}/structure")
def get_structure(project_id: int):
    return build_structure(project_id)


@app.get("/api/projects/{project_id}/link-graph")
def get_link_graph(project_id: int):
    """Internal + external links scored for relevance, with a graph-level score."""
    from services.linkgraph import build_link_graph
    try:
        uploads_svc.refresh_link_meta(project_id)  # no-op once backlink rows carry the current fields
        return build_link_graph(project_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Link graph failed: {e}")


@app.get("/api/projects/{project_id}/drift")
def get_drift(project_id: int):
    """Semantic Drift: site, topic and title lenses per page."""
    from services.drift import build_drift
    try:
        return build_drift(project_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Drift failed: {e}")


@app.get("/api/projects/{project_id}/target")
def get_target(project_id: int, q: Optional[str] = None, page_id: Optional[int] = None):
    try:
        return insights.target(project_id, q.strip() if q else None, page_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Target failed: {e}")


@app.get("/api/projects/{project_id}/link-health")
def get_link_health(project_id: int, kind: str = "internal"):
    return insights.link_health(project_id, "external" if kind == "external" else "internal")


class PlacementRequest(BaseModel):
    source_url: str
    target_url: str
    anchor: str = ""


@app.post("/api/projects/{project_id}/link-placement")
def post_link_placement(project_id: int, req: PlacementRequest):
    try:
        return insights.link_placement(project_id, req.source_url, req.target_url, req.anchor)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Placement failed: {e}")


class ComparePassagesRequest(BaseModel):
    url_a: str
    url_b: str


@app.post("/api/projects/{project_id}/compare-passages")
def post_compare_passages(project_id: int, req: ComparePassagesRequest):
    try:
        return insights.compare_passages(project_id, req.url_a, req.url_b)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Passage comparison failed: {e}")


@app.get("/api/projects/{project_id}/locate")
def locate(project_id: int, q: str):
    try:
        return locate_query(project_id, q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Locate failed: {e}")


@app.get("/api/projects/{project_id}/pages")
def list_pages(project_id: int, include_external: bool = False):
    """Lightweight page list for pickers: the site's own pages first, then
    competitors. Backlink referring pages (other sites, often scrapers that
    republish your articles under your titles) only with include_external=true."""
    conn = get_db()
    cur = conn.cursor()
    ext = "" if include_external else " AND source_type != 'external_link'"
    cur.execute(
        "SELECT id, url, title, source_type, source_name, length(content) AS chars FROM pages "
        f"WHERE project_id = ? AND source_type != 'keyword'{ext} "
        "ORDER BY CASE source_type WHEN 'competitor' THEN 2 WHEN 'external_link' THEN 3 "
        "WHEN 'internal_link' THEN 1 ELSE 0 END, url", (project_id,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"pages": rows}


async def live_crawl_generator(project_id: int):
    # Retrieve the active queue
    queue = CRAWL_QUEUES.get(project_id)
    if not queue:
        yield f"data: {json.dumps({'type': 'error', 'message': 'No active crawl found for this project.'})}\n\n"
        return
        
    yield f"data: {json.dumps({'type': 'status', 'message': f'Crawl initialized... waiting for crawler...', 'project_id': project_id})}\n\n"
    
    while True:
        event = await queue.get()
        yield f"data: {json.dumps(event)}\n\n"
        
        if event.get("type") == "complete":
            break

@app.get("/api/projects/{project_id}/stream")
async def stream_crawl(project_id: int):
    return StreamingResponse(live_crawl_generator(project_id), media_type="text/event-stream")


@app.get("/api/projects/{project_id}/crawl-log")
def crawl_log(project_id: int):
    """Everything the live crawl screen has shown so far, in order. Lets the
    page rebuild its table after a refresh and export it after the crawl."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT data FROM crawl_log WHERE project_id = ? ORDER BY seq", (project_id,))
    events = [json.loads(r["data"]) for r in cur.fetchall()]
    conn.close()
    return {
        "events": events,
        "complete": any(e.get("type") == "complete" for e in events),
        "active": project_id in CRAWL_QUEUES,
    }

if __name__ == "__main__":
    # Dev: python main.py. The desktop app starts uvicorn itself on a free port.
    uvicorn.run("main:app", host=os.environ.get("VWS_HOST", "0.0.0.0"), port=int(os.environ.get("VWS_PORT", "8060")),
                reload=os.environ.get("VWS_RELOAD", "1") == "1")

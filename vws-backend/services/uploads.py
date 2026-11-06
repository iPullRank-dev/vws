"""Uploaded data files: kept on disk and tracked per project.

Every CSV uploaded into a project (base crawl export, competitor crawl, keyword
list, internal links, backlinks) gets a row in `uploads` and a copy under
UPLOAD_DIR/project_<id>/. Rows it creates in `pages` and `links` carry its
upload_id, so the project's data sources survive page reloads and backend
restarts, a single file can be removed without touching the others, and any
file can be re-imported (after an interruption, a failed import or a model
change) from the saved copy.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import traceback
from collections import defaultdict

from services.database import get_db

UPLOAD_DIR = os.environ.get("VWS_UPLOAD_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")

KIND_LABEL = {
    "base": "Crawl export",
    "competitor": "Competitor crawl",
    "keyword": "Keywords",
    "internal": "Internal links",
    "external": "Backlinks",
}
# Imports run side by side, each on its own thread (submit()). A file only
# waits when it has to, and its row says what it's waiting for:
#  - an earlier file of the same kind that's still loading (rows two files share
#    belong to the first, so files of one kind load in upload order);
#  - for a links file, earlier crawl or competitor files until their page rows
#    are written (links are matched against them), not until those pages are
#    fetched and embedded, which is the slow part;
#  - a backlink metadata refresh that holds the project for a few seconds.
# The embedder serializes its own calls (services/embedder.py), and SQLite runs
# in WAL mode with short write transactions, so concurrent imports are safe.
PAGE_KINDS = {"base", "competitor"}
LINK_KINDS = {"internal", "external"}


class _ProjectQueue:
    def __init__(self) -> None:
        self.cond = threading.Condition()
        self.jobs: dict[int, dict] = {}   # upload_id -> {kind, filename, running, rows_ready}
        self.exclusive = False


_QUEUES: dict[int, _ProjectQueue] = defaultdict(_ProjectQueue)
_QUEUES_LOCK = threading.Lock()


def _queue(project_id: int) -> _ProjectQueue:
    with _QUEUES_LOCK:
        return _QUEUES[project_id]


def _blocker(q: _ProjectQueue, upload_id: int) -> str | None:
    """Why an upload can't start yet, or None. Caller holds q.cond."""
    if q.exclusive:
        return "Waiting for a backlink metadata refresh to finish."
    me = q.jobs[upload_id]
    for oid in sorted(q.jobs):
        if oid >= upload_id:
            break
        o = q.jobs[oid]
        if o["kind"] == me["kind"]:
            return f"Waiting for {o['filename']} to finish (files of the same type load in upload order)."
        if me["kind"] in LINK_KINDS and o["kind"] in PAGE_KINDS and not o["rows_ready"]:
            return f"Waiting for the pages in {o['filename']} to be read (links are matched against them)."
    return None

# Liveness: imports running in this process are in _ACTIVE and get a heartbeat
# every few seconds. A queued/processing row that no live process is beating for
# was cut off (restart, auto-reload, crash) and is shown as interrupted. Decided
# lazily, not at startup, because a second backend instance (Electron dev + a
# manual `python main.py`, or uvicorn --reload) must not flag the other's work.
_ACTIVE: set[int] = set()
_ACTIVE_LOCK = threading.Lock()
_HB_STARTED = False
HEARTBEAT_EVERY = 5
STALE_AFTER = 20


def _beat(ids) -> None:
    if not ids:
        return
    conn = get_db()
    now = time.time()
    conn.executemany("UPDATE uploads SET heartbeat_at = ? WHERE id = ?", [(now, i) for i in ids])
    conn.commit()
    conn.close()


def _heartbeat_loop() -> None:
    while True:
        time.sleep(HEARTBEAT_EVERY)
        with _ACTIVE_LOCK:
            ids = list(_ACTIVE)
        try:
            _beat(ids)
        except Exception as e:  # never let liveness tracking kill an import
            print(f"[uploads] heartbeat failed: {e}")


def _track(upload_id: int, on: bool) -> None:
    global _HB_STARTED
    with _ACTIVE_LOCK:
        (_ACTIVE.add if on else _ACTIVE.discard)(upload_id)
        if on and not _HB_STARTED:
            _HB_STARTED = True
            threading.Thread(target=_heartbeat_loop, daemon=True).start()
    if on:
        _beat([upload_id])

# Kinds whose rows are de-duplicated across files (a keyword or link that two
# files share belongs to the first). Removing one replays the others.
_SHARED_KINDS = {"keyword", "internal", "external"}


def _safe_name(name: str) -> str:
    base = os.path.basename(name or "upload.csv")
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base).strip() or "upload.csv"
    return base[:120]


def project_dir(project_id: int) -> str:
    return os.path.join(UPLOAD_DIR, f"project_{int(project_id)}")


def create_upload(project_id: int, kind: str, source_name: str, filename: str, data: bytes, options: dict | None = None) -> dict:
    """Store the file and register it. Returns the upload row (status 'queued')."""
    conn = get_db()
    cur = conn.cursor()
    sha1 = hashlib.sha1(data).hexdigest()
    cur.execute(
        "INSERT INTO uploads (project_id, kind, source_name, filename, bytes, options, status, heartbeat_at, sha1) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
        (project_id, kind, source_name, filename or "upload.csv", len(data), json.dumps(options or {}), time.time(), sha1),
    )
    uid = cur.lastrowid
    os.makedirs(project_dir(project_id), exist_ok=True)
    path = os.path.join(project_dir(project_id), f"{uid}_{_safe_name(filename)}")
    with open(path, "wb") as f:
        f.write(data)
    cur.execute("UPDATE uploads SET stored_path = ? WHERE id = ?", (path, uid))
    conn.commit()
    conn.close()
    return get_upload(uid)


def get_upload(upload_id: int) -> dict | None:
    conn = get_db()
    r = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
    conn.close()
    if not r:
        return None
    d = dict(r)
    d["options"] = json.loads(d["options"]) if d.get("options") else {}
    return d


def _set_status(upload_id: int, status: str, message: str = "", stats: dict | None = None) -> None:
    conn = get_db()
    if stats is not None:
        conn.execute("UPDATE uploads SET stats = ? WHERE id = ?", (json.dumps(stats), upload_id))
    if status in ("done", "failed"):
        conn.execute("UPDATE uploads SET status = ?, message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", (status, message, upload_id))
    else:
        conn.execute("UPDATE uploads SET status = ?, message = ? WHERE id = ?", (status, message, upload_id))
    conn.commit()
    conn.close()


def _is_stale(row: dict) -> bool:
    if row["status"] not in ("queued", "processing"):
        return False
    with _ACTIVE_LOCK:
        if row["id"] in _ACTIVE:
            return False
    hb = row.get("heartbeat_at")
    return hb is None or (time.time() - float(hb)) > STALE_AFTER


def flag_interrupted(conn, rows: list[dict]) -> None:
    """Persist 'interrupted' for queued/processing rows nobody is working on."""
    for r in rows:
        if _is_stale(r):
            r["status"] = "interrupted"
            r["message"] = "The backend stopped before this import finished. Re-import it from the saved file."
            conn.execute("UPDATE uploads SET status = ?, message = ? WHERE id = ? AND status IN ('queued', 'processing')",
                         (r["status"], r["message"], r["id"]))
    conn.commit()


def _counts(conn, upload_id: int) -> dict:
    pages = conn.execute("SELECT COUNT(*) FROM pages WHERE upload_id = ? AND source_type != 'keyword'", (upload_id,)).fetchone()[0]
    kws = conn.execute("SELECT COUNT(*) FROM pages WHERE upload_id = ? AND source_type = 'keyword'", (upload_id,)).fetchone()[0]
    links = conn.execute("SELECT COUNT(*) FROM links WHERE upload_id = ?", (upload_id,)).fetchone()[0]
    vecs = conn.execute("SELECT COUNT(*) FROM page_vectors WHERE page_id IN (SELECT id FROM pages WHERE upload_id = ?)", (upload_id,)).fetchone()[0]
    return {"pages": pages, "keywords": kws, "links": links, "vectors": vecs}


def submit(upload_id: int) -> threading.Thread | None:
    """Start importing a stored file in the background and return at once.
    The import waits only for what it depends on (see _blocker)."""
    u = get_upload(upload_id)
    if not u:
        return None
    q = _queue(u["project_id"])
    with q.cond:
        if upload_id in q.jobs:  # already queued or running in this process
            return None
        q.jobs[upload_id] = {"kind": u["kind"], "filename": u["filename"], "running": False, "rows_ready": False}
    _track(upload_id, True)  # heartbeat while it waits, too, so it isn't flagged interrupted
    if u["status"] != "queued":  # a replay of a finished file
        _set_status(upload_id, "queued", "")
    t = threading.Thread(target=_worker, args=(upload_id,), name=f"vws-import-{upload_id}", daemon=True)
    t.start()
    return t


def run_upload(upload_id: int) -> None:
    """Import a stored file and wait for it to finish."""
    t = submit(upload_id)
    if t:
        t.join()


def _worker(upload_id: int) -> None:
    u = get_upload(upload_id)
    pid = u["project_id"] if u else None
    q = _queue(pid) if pid is not None else None
    try:
        if not u:
            return
        path = u.get("stored_path")
        if not path or not os.path.exists(path):
            _set_status(upload_id, "failed", "The saved file is missing, so it can't be imported. Upload it again.")
            return
        if not u.get("sha1"):  # uploaded before hashes were recorded
            with open(path, "rb") as f:
                u["sha1"] = hashlib.sha1(f.read()).hexdigest()
            conn = get_db()
            conn.execute("UPDATE uploads SET sha1 = ? WHERE id = ?", (u["sha1"], upload_id))
            conn.commit()
            conn.close()

        shown = None
        while True:
            with q.cond:
                why = _blocker(q, upload_id)
                if not why:
                    q.jobs[upload_id]["running"] = True
                    break
                if why == shown:
                    q.cond.wait(timeout=5)
                    continue
            shown = why
            _set_status(upload_id, "queued", why)

        def rows_ready() -> None:
            with q.cond:
                if upload_id in q.jobs:
                    q.jobs[upload_id]["rows_ready"] = True
                q.cond.notify_all()

        from services.ingestion import set_job
        set_job(upload_id, u["filename"], rows_ready)
        try:
            _run_locked(upload_id, u, path, pid)
        finally:
            set_job(None)
    except Exception as e:
        traceback.print_exc()
        _set_status(upload_id, "failed", f"{type(e).__name__}: {e}")
    finally:
        if q is not None:
            with q.cond:
                q.jobs.pop(upload_id, None)
                q.cond.notify_all()
        _track(upload_id, False)


def _run_locked(upload_id: int, u: dict, path: str, pid: int) -> None:
    from services.ingestion import ingest_keyword_csv, ingest_links_csv, ingest_screaming_frog_csv, _done

    _set_status(upload_id, "processing")
    opts = u["options"] or {}
    try:
        if u["kind"] in ("base", "competitor"):
            ok = ingest_screaming_frog_csv(pid, path, opts.get("vector_column", ""), u["kind"], u["source_name"],
                                           vector_mode=opts.get("vector_mode", "reembed"),
                                           fetch_missing=bool(opts.get("fetch_missing", True)),
                                           vector_model=opts.get("vector_model", ""), upload_id=upload_id)
        elif u["kind"] == "keyword":
            ok = ingest_keyword_csv(pid, path, upload_id=upload_id, source_name=u["source_name"])
        elif u["kind"] in ("internal", "external"):
            ok = ingest_links_csv(pid, path, u["kind"], upload_id=upload_id)
        else:
            ok = False
        try:
            from services.analysis import store_project_stats
            store_project_stats(pid)  # focus score + page count for the dashboard card
        except Exception as e:
            print(f"[uploads] project stats update failed: {e}")
        conn = get_db()
        c = _counts(conn, upload_id)
        twin = None
        if u.get("sha1"):
            twin = conn.execute("SELECT filename, created_at FROM uploads WHERE project_id = ? AND sha1 = ? AND id < ? ORDER BY id LIMIT 1",
                                (pid, u["sha1"], upload_id)).fetchone()
        conn.close()
        if not ok:
            _set_status(upload_id, "failed", "No usable rows could be read from this CSV. Check that it has the expected columns.")
        elif isinstance(ok, dict):
            status, msg = _links_message(u["kind"], ok, twin)
            _set_status(upload_id, status, msg, ok)
        else:
            added = c["keywords"] or c["links"] or c["pages"]
            if added:
                msg = ""
            elif twin:
                msg = f"Same file as {twin['filename']} uploaded earlier, so there was nothing new to add. You can remove this copy."
            else:
                msg = "Nothing new: every row in this file is already in the project."
            _set_status(upload_id, "done", msg)
    except Exception as e:
        traceback.print_exc()
        _done(pid)
        _set_status(upload_id, "failed", f"{type(e).__name__}: {e}")


def _plural(n: int, word: str) -> str:
    return f"{n:,} {word}{'' if n == 1 else 's'}"


def _links_message(kind: str, st: dict, twin) -> tuple[str, str]:
    """Status + one readable sentence from the importer's stats."""
    skipped = st.get("skipped") or {}
    skip_txt = "; ".join(f"{n:,} {why}" for why, n in list(skipped.items())[:5])
    rows, ins, dup = st.get("rows", 0), st.get("inserted", 0), st.get("duplicates", 0)
    if ins == 0 and dup == 0:
        return "failed", (f"None of the {rows:,} rows could be used" + (f" (skipped: {skip_txt})." if skip_txt else ".")
                          + " Check that this is a links export with source and target URL columns.")
    adopted = st.get("adopted", 0)
    what = "backlinks" if kind == "external" else "links"
    if ins == 0 and adopted:
        return "done", (f"{adopted:,} {what} were already in the project from before file tracking; they now belong to this file, "
                        "so Remove and Re-import work on them." + (f" Skipped: {skip_txt}." if skip_txt else ""))
    if ins == 0:
        return "done", (f"Nothing new: all {dup:,} {what} in this file were already loaded"
                        + (f" by {twin['filename']} (same file). You can remove this copy." if twin else " from another file."))
    parts = []
    if kind == "external":
        parts.append(f"{_plural(ins, 'backlink')} added from {_plural(st.get('referring_pages', 0), 'referring page')} "
                     f"on {_plural(st.get('referring_domains', 0), 'domain')}.")
        nc = st.get("targets_not_in_crawl_rows", 0)
        if nc:
            parts.append(f"{nc:,} point to pages that aren't in this crawl (see Link Graph).")
        if st.get("fetched_pages") or st.get("context_scored"):
            parts.append(f"{st.get('fetched_pages', 0):,} referring pages fetched in full; the other "
                         f"{st.get('context_scored', 0):,} are scored from their title and the text around the link.")
    else:
        parts.append(f"{_plural(ins, 'link')} added." + (f" {st['new_nodes']:,} linked URLs weren't in the crawl and were added as pages." if st.get("new_nodes") else ""))
    if adopted:
        parts.append(f"{adopted:,} were already in the project from before file tracking and now belong to this file.")
    if dup - adopted > 0:
        parts.append(f"{dup - adopted:,} were already loaded" + (f" (same file as {twin['filename']})." if twin else " from another file."))
    if skip_txt:
        parts.append(f"Skipped: {skip_txt}.")
    return "done", " ".join(parts)


def _delete_rows(cur, project_id: int, upload_id: int) -> None:
    ids = [r[0] for r in cur.execute("SELECT id FROM pages WHERE project_id = ? AND upload_id = ?", (project_id, upload_id)).fetchall()]
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        marks = ",".join("?" * len(chunk))
        cur.execute(f"DELETE FROM page_vectors WHERE page_id IN ({marks})", chunk)
        try:
            cur.execute(f"DELETE FROM vec_embeddings WHERE rowid IN ({marks})", chunk)
        except Exception:
            pass
    cur.execute("DELETE FROM pages WHERE project_id = ? AND upload_id = ?", (project_id, upload_id))
    cur.execute("DELETE FROM links WHERE project_id = ? AND upload_id = ?", (project_id, upload_id))


def _drop_vector_source_if_unused(cur, project_id: int, source_name: str) -> None:
    left = cur.execute("SELECT COUNT(*) FROM pages WHERE project_id = ? AND source_name = ?", (project_id, source_name)).fetchone()[0]
    if left:
        return
    row = cur.execute("SELECT vector_sources FROM projects WHERE id = ?", (project_id,)).fetchone()
    try:
        vs = json.loads(row[0]) if row and row[0] else {}
    except Exception:
        vs = {}
    if source_name in vs:
        vs.pop(source_name)
        cur.execute("UPDATE projects SET vector_sources = ? WHERE id = ?", (json.dumps(vs), project_id))


def _update_page_count(cur, project_id: int) -> None:
    n = cur.execute("SELECT COUNT(*) FROM pages WHERE project_id = ? AND source_type NOT IN ('keyword', 'competitor', 'external_link')",
                    (project_id,)).fetchone()[0]
    cur.execute("UPDATE projects SET total_pages = ? WHERE id = ?", (n, project_id))


def remove_upload(project_id: int, upload_id: int) -> dict:
    """Delete one file and the rows it created. Returns uploads to replay (same
    kind, still present) so rows they shared with this one come back."""
    u = get_upload(upload_id)
    if not u or u["project_id"] != project_id:
        return {"error": "Upload not found."}
    if u["kind"] == "base":
        return {"error": "This file is the project's own crawl. Delete the project instead, or re-import it."}
    if u["status"] in ("queued", "processing") and not _is_stale(u):
        return {"error": "This file is still being imported. Remove it once it finishes."}
    conn = get_db()
    cur = conn.cursor()
    _delete_rows(cur, project_id, upload_id)
    _drop_vector_source_if_unused(cur, project_id, u["source_name"])
    cur.execute("DELETE FROM uploads WHERE id = ?", (upload_id,))
    _update_page_count(cur, project_id)
    replay = []
    if u["kind"] in _SHARED_KINDS:
        replay = [r[0] for r in cur.execute(
            "SELECT id FROM uploads WHERE project_id = ? AND kind = ? AND status = 'done' ORDER BY id", (project_id, u["kind"])).fetchall()]
    conn.commit()
    conn.close()
    try:
        if u.get("stored_path") and os.path.exists(u["stored_path"]):
            os.remove(u["stored_path"])
    except OSError:
        pass
    return {"removed": upload_id, "replay": replay}


def reset_upload(project_id: int, upload_id: int) -> dict:
    """Clear an upload's rows before importing its saved file again."""
    u = get_upload(upload_id)
    if not u or u["project_id"] != project_id:
        return {"error": "Upload not found."}
    if not u.get("stored_path") or not os.path.exists(u["stored_path"]):
        return {"error": "The saved file is missing, so it can't be re-imported. Upload it again."}
    if u["status"] in ("queued", "processing") and not _is_stale(u):
        return {"error": "This file is still being imported."}
    conn = get_db()
    cur = conn.cursor()
    _delete_rows(cur, project_id, upload_id)
    cur.execute("UPDATE uploads SET status = 'queued', message = '', heartbeat_at = ? WHERE id = ?", (time.time(), upload_id))
    conn.commit()
    conn.close()
    return {"queued": upload_id}


def replay_uploads(upload_ids: list[int]) -> None:
    """Re-run shared-kind imports so rows they had in common with a removed file
    are restored (imports skip rows that already exist)."""
    for uid in upload_ids:
        u = get_upload(uid)
        if u and u.get("stored_path") and os.path.exists(u["stored_path"]):
            submit(uid)  # same kind, so they still load one after another


def refresh_link_meta(project_id: int) -> int:
    """Re-read saved backlink files whose rows predate the current metadata fields
    (e.g. referring domains, keywords). Rows and referring pages already exist, so
    this only updates `links.meta`: seconds, nothing is re-embedded."""
    from services.ingestion import LINK_META_VERSION, ingest_links_csv
    conn = get_db()
    # Tracked per file (stats.meta_version), so the check is one small query.
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM uploads WHERE project_id = ? AND kind = 'external' AND status = 'done' "
        "AND COALESCE(json_extract(stats, '$.meta_version'), 0) < ? "
        "AND EXISTS (SELECT 1 FROM links WHERE upload_id = uploads.id)", (project_id, LINK_META_VERSION)).fetchall()]
    busy = [dict(r) for r in conn.execute(
        "SELECT * FROM uploads WHERE project_id = ? AND status IN ('queued', 'processing')", (project_id,)).fetchall()]
    conn.close()
    if not ids or any(not _is_stale(u) for u in busy):
        return 0
    q = _queue(project_id)
    with q.cond:
        if q.jobs or q.exclusive:
            return 0
        q.exclusive = True
    done = 0
    try:
        for uid in ids:
            u = get_upload(uid)
            if not u or u["status"] != "done" or not u.get("stored_path") or not os.path.exists(u["stored_path"]):
                continue
            print(f"[uploads] refreshing backlink metadata from {u['filename']}")
            ingest_links_csv(project_id, u["stored_path"], "external", uid, meta_only=True)
            try:
                st = json.loads(u.get("stats") or "{}") or {}
            except Exception:
                st = {}
            st["meta_version"] = LINK_META_VERSION
            c2 = get_db()
            c2.execute("UPDATE uploads SET stats = ? WHERE id = ?", (json.dumps(st), uid))
            c2.commit()
            c2.close()
            done += 1
    except Exception as e:
        print(f"[uploads] metadata refresh failed: {e}")
    finally:
        with q.cond:
            q.exclusive = False
            q.cond.notify_all()
    return done


def list_uploads(project_id: int) -> dict:
    from services.ingestion import job_progress
    conn = get_db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM uploads WHERE project_id = ? ORDER BY id", (project_id,)).fetchall()]
    flag_interrupted(conn, rows)
    out = []
    for r in rows:
        c = _counts(conn, r["id"])
        out.append({
            "id": r["id"], "kind": r["kind"], "kind_label": KIND_LABEL.get(r["kind"], r["kind"]),
            "source_name": r["source_name"], "filename": r["filename"], "bytes": r["bytes"],
            "status": r["status"], "message": r["message"] or "", "created_at": r["created_at"], "finished_at": r["finished_at"],
            "file_kept": bool(r["stored_path"] and os.path.exists(r["stored_path"])),
            "options": json.loads(r["options"]) if r["options"] else {},
            "stats": json.loads(r["stats"]) if r.get("stats") else None,
            "counts": c, "legacy": False,
            # Live step + progress for this file (several can be importing at once).
            "progress": job_progress(r["id"]) if r["status"] == "processing" else None,
        })

    # Data imported before uploads were tracked (no upload_id): still listed, removable by source.
    legacy = []
    for r in conn.execute(
            "SELECT source_type, source_name, COUNT(*) AS n FROM pages WHERE project_id = ? AND upload_id IS NULL "
            "AND source_type NOT IN ('base', 'internal_link', 'external_link') GROUP BY source_type, source_name", (project_id,)).fetchall():
        kind = "keyword" if r["source_type"] == "keyword" else ("competitor" if r["source_type"] == "competitor" else r["source_type"])
        legacy.append({"id": None, "kind": kind, "kind_label": KIND_LABEL.get(kind, kind), "source_name": r["source_name"] or kind,
                       "filename": r["source_name"] or KIND_LABEL.get(kind, kind), "status": "done", "message": "", "legacy": True,
                       "file_kept": False, "remove_key": r["source_name"],
                       "counts": {"pages": 0 if kind == "keyword" else r["n"], "keywords": r["n"] if kind == "keyword" else 0, "links": 0, "vectors": 0}})
    nodes = defaultdict(int)
    for r in conn.execute("SELECT source_type, COUNT(*) AS n FROM pages WHERE project_id = ? AND upload_id IS NULL "
                          "AND source_type IN ('internal_link', 'external_link') GROUP BY source_type", (project_id,)).fetchall():
        nodes[r["source_type"].split("_")[0]] = r["n"]
    for r in conn.execute("SELECT link_type, COUNT(*) AS n FROM links WHERE project_id = ? AND upload_id IS NULL GROUP BY link_type",
                          (project_id,)).fetchall():
        kind = r["link_type"]
        legacy.append({"id": None, "kind": kind, "kind_label": KIND_LABEL.get(kind, kind), "source_name": f"{kind}_link_import",
                       "filename": KIND_LABEL.get(kind, kind), "status": "done", "message": "", "legacy": True, "file_kept": False,
                       "remove_key": kind, "counts": {"pages": nodes.get(kind, 0), "keywords": 0, "links": r["n"], "vectors": 0}})
    conn.close()
    return {"uploads": out, "legacy": legacy, "upload_dir": project_dir(project_id)}


def delete_project_uploads(project_id: int) -> None:
    conn = get_db()
    conn.execute("DELETE FROM uploads WHERE project_id = ?", (project_id,))
    conn.commit()
    conn.close()
    shutil.rmtree(project_dir(project_id), ignore_errors=True)


def tracked_of_kind(project_id: int, kind: str) -> list[int]:
    conn = get_db()
    ids = [r[0] for r in conn.execute("SELECT id FROM uploads WHERE project_id = ? AND kind = ? AND status = 'done' ORDER BY id",
                                      (project_id, kind)).fetchall()]
    conn.close()
    return ids

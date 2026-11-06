"""Vector storage + loading.

Vectors live in a plain SQLite table (`page_vectors`) as float32 blobs, one row
per page, tagged with the model that produced them. Analysis code always loads
whole projects into numpy, so a vec0 virtual table bought us nothing except a
fixed dimension (it was hard-wired to 300). The tag is what lets the app refuse
to compare, say, Screaming Frog vectors against locally embedded keywords.

Vectors are stored at full size (768-d for EmbeddingGemma 2). Each project has
an analysis size (default 256); Matryoshka models are truncated to it and
re-normalized on load, so changing the size is instant.

Projects created before the EmbeddingGemma 2 upgrade still have their 300-d
vectors in the legacy `vec_embeddings` table; we read those as a fallback and
flag the project for re-embedding.
"""
from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field

import numpy as np

from services.embedder import (DEFAULT_ANALYSIS_DIM, VALID_DIMS, base_model_name, clean_title, model_tag,
                               supports_truncation)

KEYWORD_TYPES = {"keyword"}
COMPETITOR_TYPES = {"competitor"}
EXTERNAL_TYPES = {"external_link"}
# Everything else (base, realtime, internal_link, '') is the project's own site.


def is_own_page(source_type: str | None) -> bool:
    st = source_type or "base"
    return st not in KEYWORD_TYPES | COMPETITOR_TYPES | EXTERNAL_TYPES


def setup_vector_tables(cursor) -> None:
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS page_vectors (
            page_id INTEGER PRIMARY KEY,
            model TEXT NOT NULL,
            dim INTEGER NOT NULL,
            vec BLOB NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def _normalize(m: np.ndarray) -> np.ndarray:
    m = np.asarray(m, dtype=np.float32)
    if m.ndim == 1:
        n = np.linalg.norm(m)
        return m / n if n > 0 else m
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return m / n


def save_vectors(cursor, rows: list[tuple[int, np.ndarray]], model: str | None = None) -> None:
    tag = model or model_tag()
    payload = []
    for page_id, vec in rows:
        v = _normalize(np.asarray(vec, dtype=np.float32))
        payload.append((int(page_id), tag, int(v.shape[0]), v.astype(np.float32).tobytes()))
    cursor.executemany(
        """
        INSERT INTO page_vectors (page_id, model, dim, vec, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(page_id) DO UPDATE SET model=excluded.model, dim=excluded.dim,
            vec=excluded.vec, updated_at=CURRENT_TIMESTAMP
        """,
        payload,
    )


# ---------------------------------------------------------------------------
# project settings
# ---------------------------------------------------------------------------
def get_project_settings(conn, project_id: int) -> dict:
    cur = conn.cursor()
    try:
        cur.execute("SELECT settings FROM projects WHERE id = ?", (project_id,))
        row = cur.fetchone()
        s = json.loads(row["settings"]) if row and row["settings"] else {}
    except Exception:
        s = {}
    dim = s.get("analysis_dim")
    s["analysis_dim"] = dim if dim in VALID_DIMS else DEFAULT_ANALYSIS_DIM
    return s


def set_project_settings(conn, project_id: int, updates: dict) -> dict:
    s = get_project_settings(conn, project_id)
    if "analysis_dim" in updates and updates["analysis_dim"] in VALID_DIMS:
        s["analysis_dim"] = int(updates["analysis_dim"])
    conn.cursor().execute("UPDATE projects SET settings = ? WHERE id = ?", (json.dumps(s), project_id))
    conn.commit()
    return s


@dataclass
class VectorSet:
    ids: list[int] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    titles: list[str] = field(default_factory=list)
    types: list[str] = field(default_factory=list)
    names: list[str] = field(default_factory=list)
    volumes: list[float | None] = field(default_factory=list)
    models: list[str] = field(default_factory=list)   # "<model>@<effective dim>"
    matrix: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), dtype=np.float32))
    health: dict = field(default_factory=dict)
    dim: int = 0

    def __len__(self) -> int:
        return len(self.ids)

    def indices(self, pred) -> list[int]:
        return [i for i, t in enumerate(self.types) if pred(t)]


def _role(source_type: str) -> str:
    if source_type in KEYWORD_TYPES:
        return "keywords"
    if source_type in COMPETITOR_TYPES:
        return "competitors"
    if source_type in EXTERNAL_TYPES:
        return "external"
    return "pages"


def active_identity(dim: int) -> str:
    return f"{model_tag()}@{dim}"


def _vector_health(models: list[str], types: list[str], source: str, missing: int, excluded: int,
                   declared: dict | None, dim: int) -> dict:
    counts = Counter(models)
    by_role: dict[str, Counter] = {}
    for m, t in zip(models, types):
        by_role.setdefault(_role(t), Counter())[m] += 1
    active = active_identity(dim)
    legacy = source == "legacy"
    names = {m.split("@")[0] for m in counts}
    mixed = len(counts) > 1
    foreign = bool(counts) and all(m.split("@")[0] != model_tag() for m in counts)

    def fmt(c: Counter) -> str:
        return ", ".join(f"{k} ({v})" for k, v in c.most_common())

    if legacy:
        msg = ("This project still uses the old 300-d vectors (EmbeddingGemma 1 truncated to 300 dims, no task "
               "prompts, plus any imported CSV vectors). Scores are approximate. Re-embed with EmbeddingGemma 2.")
    elif any(n.startswith("unverified:") for n in names):
        bad = next(n for n in names if n.startswith("unverified:"))
        probe = next((v.get("probe_similarity") for v in (declared or {}).values()
                      if base_model_name(v.get("stored_as", "")) == base_model_name(bad) and v.get("verified") is False), None)
        msg = (f"The CSV vectors were labeled {bad.split(':', 1)[1]}, but they don't match it: page titles embedded locally "
               f"with that model sit at {probe if probe is not None else '~0'} cosine from their CSV vectors (same model gives "
               "~0.6+). Check which model Screaming Frog used, or re-embed locally.")
    elif mixed:
        parts = [f"{role}: {fmt(c)}" for role, c in by_role.items()]
        msg = ("Vectors in this project come from different models, so similarity between them is not meaningful ("
               + "; ".join(parts) + "). Re-embed locally, or re-export the Screaming Frog crawl with " + model_tag() + ".")
    elif foreign:
        msg = (f"Vectors were produced by {fmt(counts)}. Page-to-page views are fine, but keywords, the ghost-keyword "
               f"locator and the Lab embed with {model_tag()}. Re-embed (or re-export from Screaming Frog with that model) "
               "before adding keywords.")
    elif missing:
        msg = f"{missing} pages have no vector yet."
    else:
        msg = ""
    return {
        "source": source,
        "models": dict(counts),
        "models_by_role": {k: dict(v) for k, v in by_role.items()},
        "active_model": active,
        "analysis_dim": dim,
        "legacy": legacy,
        "mixed": mixed,
        "foreign": foreign,
        "pages_without_vectors": missing,
        "excluded_dim_mismatch": excluded,
        "needs_reembed": legacy or mixed,
        "declared_sources": declared or {},
        "message": msg,
    }


def _title(r) -> str:
    if (r["source_type"] or "") == "keyword":
        return r["title"] or r["url"] or ""
    return clean_title(r["title"], r["url"] or "")


def load_project_vectors(conn, project_id: int, dim: int | None = None, include_external: bool = False) -> VectorSet:
    """Load every vector in a project at the project's analysis size (or `dim`).
    Backlink source pages (external_link) are left out unless `include_external`:
    a backlinks export can bring thousands of them, which would swamp the site's
    center, zones and maps. Only the link views ask for them."""
    ext_sql = "" if include_external else " AND p.source_type != 'external_link'"
    cur = conn.cursor()
    target_dim = dim if dim in VALID_DIMS else get_project_settings(conn, project_id)["analysis_dim"]
    cur.execute("SELECT COUNT(*) AS c FROM pages p WHERE p.project_id = ?" + ext_sql, (project_id,))
    total_pages = cur.fetchone()["c"]

    cur.execute(
        """
        SELECT p.id, p.url, p.title, p.source_type, p.source_name, p.volume, v.model, v.dim, v.vec
        FROM pages p INNER JOIN page_vectors v ON v.page_id = p.id
        WHERE p.project_id = ?""" + ext_sql + """
        ORDER BY p.id
        """,
        (project_id,),
    )
    entries: list[dict] = []
    for r in cur.fetchall():
        tag = r["model"]
        vec = np.frombuffer(r["vec"], dtype=np.float32)
        eff = min(target_dim, int(r["dim"])) if supports_truncation(tag) else int(r["dim"])
        name = base_model_name(tag) if not tag.startswith("unverified:") else "unverified:" + base_model_name(tag)
        entries.append({"row": r, "model": f"{name}@{eff}", "dim": eff, "vec": vec[:eff]})
    have_new = {e["row"]["id"] for e in entries}

    # Legacy 300-d sqlite-vec rows for pages that haven't been re-embedded yet.
    try:
        cur.execute(
            """
            SELECT p.id, p.url, p.title, p.source_type, p.source_name, p.volume,
                   vec_to_json(v.embedding) AS embedding
            FROM pages p INNER JOIN vec_embeddings v ON p.id = v.rowid
            WHERE p.project_id = ?""" + ext_sql + """
            ORDER BY p.id
            """,
            (project_id,),
        )
        for r in cur.fetchall():
            if r["id"] in have_new:
                continue
            try:
                vec = np.asarray(json.loads(r["embedding"]), dtype=np.float32)
            except Exception:
                continue
            entries.append({"row": r, "model": "legacy@300", "dim": int(vec.shape[0]), "vec": vec})
    except Exception as e:
        print(f"[vectors] legacy load failed: {e}")

    # Vectors of different sizes can't share a matrix. Keep the group that holds
    # most of the site's own pages (keywords alone are useless without pages);
    # the rest is reported so the UI can ask for a re-embed.
    vs = VectorSet()
    vecs: list[np.ndarray] = []
    excluded = 0
    excluded_models: Counter = Counter()
    if entries:
        groups: dict[int, list[dict]] = {}
        for e in entries:
            groups.setdefault(e["dim"], []).append(e)
        keep_dim = max(groups, key=lambda d: (sum(1 for e in groups[d] if is_own_page(e["row"]["source_type"])), len(groups[d])))
        vs.dim = keep_dim
        for e in sorted(entries, key=lambda e: e["row"]["id"]):
            r = e["row"]
            if e["dim"] != keep_dim:
                excluded += 1
                excluded_models[e["model"]] += 1
                continue
            vecs.append(e["vec"])
            vs.ids.append(r["id"]); vs.urls.append(r["url"] or ""); vs.titles.append(_title(r))
            vs.types.append(r["source_type"] or "base"); vs.names.append(r["source_name"] or "Base Crawl")
            vs.volumes.append(r["volume"]); vs.models.append(e["model"])
    source = "legacy" if vs.models and all(m.startswith("legacy") for m in vs.models) else "page_vectors"

    vs.matrix = _normalize(np.vstack(vecs)) if vecs else np.zeros((0, 0), dtype=np.float32)
    missing = max(0, total_pages - len(vs.ids) - excluded)
    declared = None
    try:
        cur.execute("SELECT vector_sources FROM projects WHERE id = ?", (project_id,))
        row = cur.fetchone()
        if row and row["vector_sources"]:
            declared = json.loads(row["vector_sources"])
    except Exception:
        pass
    vs.health = _vector_health(vs.models, vs.types, source, missing, excluded, declared, vs.dim or target_dim)
    vs.health["requested_dim"] = target_dim
    if excluded:
        vs.health["needs_reembed"] = True
        vs.health["mixed"] = True
        vs.health["excluded_models"] = dict(excluded_models)
        vs.health["message"] = (
            f"{excluded} vectors from {', '.join(excluded_models)} were left out because they come from a different "
            "model/size than the rest of the project (e.g. keywords added after the EmbeddingGemma 2 upgrade to a project "
            "with old 300-d page vectors). Re-embed so everything shares one space. " + (vs.health.get("message") or "")
        ).strip()
    vs.health["total_pages"] = total_pages
    vs.health["vectors"] = len(vs.ids)
    return vs

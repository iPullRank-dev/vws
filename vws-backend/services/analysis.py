import threading

import numpy as np
from scipy.spatial.distance import cdist

from services.database import get_db
from services.thresholds import suggest
from services.vectors import load_project_vectors, is_own_page, VectorSet

# Cache of fitted 3-D projections so the ghost-keyword locator can drop a real
# query embedding into the exact same space the map was drawn in.
_PROJECTION_CACHE: dict[int, dict] = {}
_CACHE_LOCK = threading.Lock()


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def cosine_dist(a: np.ndarray, b: np.ndarray) -> float:
    return 1.0 - cosine_sim(a, b)


def fit_projection(project_id: int, vs: VectorSet):
    from sklearn.decomposition import PCA
    reducer = PCA(n_components=3, random_state=42)
    coords = reducer.fit_transform(vs.matrix)
    with _CACHE_LOCK:
        _PROJECTION_CACHE[project_id] = {"reducer": reducer, "ids": list(vs.ids), "dim": vs.matrix.shape[1]}
    return coords


def get_projection(project_id: int):
    with _CACHE_LOCK:
        return _PROJECTION_CACHE.get(project_id)


def load_links(conn, project_id: int):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT l.source_url, l.target_url, l.link_type, l.anchor_text, l.meta,
               p1.id as source_id, p1.title as source_title,
               p2.id as target_id, p2.title as target_title
        FROM links l
        LEFT JOIN pages p1 ON l.source_url = p1.url AND p1.project_id = l.project_id
        LEFT JOIN pages p2 ON l.target_url = p2.url AND p2.project_id = l.project_id
        WHERE l.project_id = ?
        """,
        (project_id,),
    )
    return cur.fetchall()


def _iqr_zones(distances: np.ndarray):
    q1, q2, q3 = (float(np.percentile(distances, p)) for p in (25, 50, 75))
    outlier = q3 + 1.5 * (q3 - q1)

    def zone(d: float) -> str:
        if d <= q1:
            return "Core"
        if d <= q3:
            return "Focus"
        if d <= outlier:
            return "Expansion"
        return "Peripheral"

    return {"q1": q1, "q2": q2, "q3": q3, "outlier": outlier}, zone


def store_project_stats(project_id: int, focus_score: float | None = None) -> dict:
    """Keep the dashboard card current: the focus score (same formula as the
    analysis: 1 - mean cosine distance to the center / 2) and the site's own page
    count. Called after analyses, crawls and imports."""
    if focus_score is None:
        conn = get_db()
        vs = load_project_vectors(conn, project_id)
        conn.close()
        if len(vs) < 3:
            focus_score = 0.0
        else:
            m = vs.matrix
            focus_score = max(0.0, 1.0 - float(cdist(m, m.mean(axis=0, keepdims=True), metric="cosine").mean()) / 2.0)
    conn = get_db()
    n = conn.execute("SELECT COUNT(*) FROM pages WHERE project_id = ? AND source_type NOT IN "
                     "('keyword', 'competitor', 'external_link')", (project_id,)).fetchone()[0]
    conn.execute("UPDATE projects SET focus_score = ?, total_pages = ? WHERE id = ?", (float(focus_score), n, project_id))
    conn.commit()
    conn.close()
    return {"focus_score": float(focus_score), "total_pages": n}


def perform_analysis(project_id: int, distance_metric: str = "cosine", dim: int | None = None):
    conn = get_db()
    vs = load_project_vectors(conn, project_id, dim)
    conn.close()

    if len(vs) < 3:
        print("Warning: fewer than 3 vectors for project. Yielding sparse visual.")
        out = generate_sparse_fallback(project_id)
        out["vector_health"] = vs.health
        return out

    vec_array = vs.matrix
    print(f"Applying PCA to {len(vec_array)} vectors of shape {vec_array.shape}")
    embeddings_3d = fit_projection(project_id, vs)

    centroid = np.mean(vec_array, axis=0).reshape(1, -1)
    distances = cdist(vec_array, centroid, metric=distance_metric).flatten()

    meta_title = vs.titles
    kw_indices = vs.indices(lambda t: t == "keyword")
    base_indices = vs.indices(lambda t: t != "keyword")
    own_indices = vs.indices(is_own_page)

    # Similarity matrices used for thresholds + flags (always cosine).
    page_pairs = None
    if len(own_indices) > 1:
        own_vecs = vec_array[own_indices]
        pp = own_vecs @ own_vecs.T
        page_pairs = pp[np.triu_indices(len(own_indices), 1)]
    kw_best_own = None
    kw_own_sims = None
    if kw_indices and own_indices:
        kw_own_sims = vec_array[kw_indices] @ vec_array[own_indices].T
        kw_best_own = kw_own_sims.max(axis=1)
    th = suggest(vs.health, kw_best_own, page_pairs, None, vs.dim)

    umap_data, bullseye_data, nodes = [], [], []
    for i in range(len(vs)):
        category = vs.names[i] or "Base Crawl"
        umap_data.append({
            "id": f"node_{i}", "page_id": vs.ids[i], "url": f"[{category}] {meta_title[i]} - {vs.urls[i]}",
            "raw_url": vs.urls[i], "title": meta_title[i], "category": category, "source_type": vs.types[i],
            "x": float(embeddings_3d[i][0]), "y": float(embeddings_3d[i][1]), "z": float(embeddings_3d[i][2]),
        })
        bullseye_data.append({
            "id": f"node_{i}", "url": vs.urls[i], "category": category,
            "distance": float(distances[i]), "angle": (i * 137.5) % 360,
        })
        nodes.append({"id": f"node_{i}", "name": vs.urls[i], "group": (i % 5)})

    # --- IQR bullseye over non-keyword nodes -------------------------------
    iqr_bullseye = {"stats": {}, "nodes": [], "thresholds": {}}
    zone_of = None
    if base_indices:
        base_d = distances[base_indices]
        thresholds, zone_of = _iqr_zones(base_d)
        counts = {"Core": 0, "Focus": 0, "Expansion": 0, "Peripheral": 0}
        iqr_nodes = []
        for idx in base_indices:
            z = zone_of(float(distances[idx]))
            counts[z] += 1
            iqr_nodes.append({
                "url": vs.urls[idx], "category": vs.names[idx] or "Base Crawl", "title": meta_title[idx],
                "distance": float(distances[idx]), "angle": (idx * 137.5) % 360, "zone": z,
            })
        total_p = len(base_indices)
        iqr_bullseye = {
            "stats": {
                **{k.lower(): {"count": v, "pct": round(v / total_p * 100, 1)} for k, v in counts.items()},
                "total": total_p,
            },
            "thresholds": thresholds,
            "nodes": iqr_nodes,
        }

    # --- keyword -> closest page mapping ------------------------------------
    keyword_mappings = []
    if kw_indices and base_indices:
        kw_to_base = cdist(vec_array[kw_indices], vec_array[base_indices], metric=distance_metric)
        own_pos = {g: j for j, g in enumerate(own_indices)}
        for k_idx, dist_row in enumerate(kw_to_base):
            closest_local = int(np.argmin(dist_row))
            closest_global = base_indices[closest_local]
            entry = {
                "keyword": vs.urls[kw_indices[k_idx]],
                "keyword_id": vs.ids[kw_indices[k_idx]],
                "volume": vs.volumes[kw_indices[k_idx]],
                "closest_url": vs.urls[closest_global],
                "dataset": vs.names[closest_global],
                "distance": float(dist_row[closest_local]),
                "cannibalization_risk": False,
            }
            if kw_own_sims is not None:
                row = kw_own_sims[k_idx]
                order = np.argsort(-row)
                best = float(row[order[0]])
                entry["own_url"] = vs.urls[own_indices[order[0]]]
                entry["similarity"] = best
                entry["band"] = "strong" if best >= th["strong"] else ("partial" if best >= th["gap"] else "gap")
                if len(order) > 1:
                    second = float(row[order[1]])
                    entry["runner_up_url"] = vs.urls[own_indices[order[1]]]
                    entry["runner_up_similarity"] = second
                    entry["cannibalization_risk"] = bool(second >= th["gap"] and best - second <= th["cannibal_margin"])
            keyword_mappings.append(entry)

    topical_gaps = [k for k in keyword_mappings if k.get("band") == "gap"]

    # --- links --------------------------------------------------------------
    conn = get_db()
    links_rows = load_links(conn, project_id)
    conn.close()
    url_to_idx = {}
    for i, u in enumerate(vs.urls):
        url_to_idx.setdefault(u, i)

    network_external, network_internal = [], []
    for lr in links_rows:
        if not lr["source_id"] or not lr["target_id"]:
            continue
        s_url, t_url = lr["source_url"], lr["target_url"]
        rel = 0.0
        if s_url in url_to_idx and t_url in url_to_idx:
            rel = float(vec_array[url_to_idx[s_url]] @ vec_array[url_to_idx[t_url]])
        item = {
            "source": lr["source_id"], "target": lr["target_id"],
            "relevance_score": rel, "anchor_text": lr["anchor_text"],
            "weak": rel < th["weak_link"],
        }
        if lr["link_type"] == "external":
            # Referring pages aren't in this vector set (kept out of the site map), so
            # backlinks are scored by the Link Graph and Backlink Relevance views instead.
            continue
        elif lr["link_type"] == "internal":
            item["source_title"] = lr["source_title"] or s_url
            item["target_title"] = lr["target_title"] or t_url
            network_internal.append(item)

    score = max(0, 1.0 - (float(np.mean(distances)) / 2.0))

    # --- semantic drift (own + competitor pages, IQR zones) -----------------
    semantic_drift = []
    for i in range(len(vs)):
        e = vec_array[i]
        c = centroid[0]
        semantic_drift.append({
            "url": vs.urls[i], "title": meta_title[i], "source_type": vs.types[i],
            "drift_cosine": float(cosine_dist(e, c)), "drift_l2": float(np.linalg.norm(e - c)),
            "zone": zone_of(float(distances[i])) if (zone_of and vs.types[i] != "keyword") else None,
        })
    semantic_drift.sort(key=lambda x: x["drift_cosine"], reverse=True)

    # --- internal link opportunities: top neighbors lacking a link ---------
    link_opportunities = []
    if len(own_indices) > 1:
        existing = set()
        for lr in links_rows:
            if lr["link_type"] == "internal":
                existing.add((lr["source_url"], lr["target_url"]))
                existing.add((lr["target_url"], lr["source_url"]))
        own_vecs = vec_array[own_indices]
        sims = own_vecs @ own_vecs.T
        np.fill_diagonal(sims, -1)
        seen = set()
        for a in range(len(own_indices)):
            for b in np.argsort(-sims[a])[:3]:
                s = float(sims[a, b])
                if s < th["link_min"]:
                    break
                u1, u2 = vs.urls[own_indices[a]], vs.urls[own_indices[b]]
                key = tuple(sorted((u1, u2)))
                if key in seen or (u1, u2) in existing or u1 == u2:
                    continue
                seen.add(key)
                link_opportunities.append({
                    "source_url": u1, "target_url": u2,
                    "source_title": meta_title[own_indices[a]], "target_title": meta_title[own_indices[b]],
                    "relevance_score": s,
                })
        link_opportunities.sort(key=lambda x: x["relevance_score"], reverse=True)
        link_opportunities = link_opportunities[:500]

    return {
        "umap": umap_data,
        "bullseye": bullseye_data,
        "topic_map": None,
        "topic_list": [],
        "network_nodes": nodes,
        "network_external": network_external,
        "network_internal": network_internal,
        "keyword_mappings": keyword_mappings,
        "iqr_bullseye": iqr_bullseye,
        "topical_gaps": topical_gaps,
        "link_opportunities": link_opportunities,
        "semantic_drift": semantic_drift,
        "focus_score": score,
        "distance_metric": distance_metric,
        "thresholds": th,
        "vector_health": vs.health,
    }


def generate_sparse_fallback(project_id: int):
    return {"umap": [], "bullseye": [], "iqr_bullseye": {"nodes": [], "stats": {}, "thresholds": {}},
            "topic_map": None, "topic_list": [], "network_nodes": [], "network_external": [],
            "network_internal": [], "keyword_mappings": [], "topical_gaps": [], "link_opportunities": [],
            "semantic_drift": [], "focus_score": 0.0}


def locate_query(project_id: int, query: str, top_k: int = 10) -> dict:
    """Embed a query with the active model and place it in the project's map."""
    from services.embedder import embed_queries, truncate
    from services.vectors import active_identity

    conn = get_db()
    vs = load_project_vectors(conn, project_id)
    conn.close()
    if len(vs) < 3:
        return {"error": "Not enough vectors in this project yet."}
    active = active_identity(vs.dim)
    own = vs.indices(is_own_page)
    comparable = [i for i in own if vs.models[i] == active]
    if not comparable:
        return {"error": f"This project's page vectors weren't made with {active}, so a query embedded with it "
                         "can't be placed honestly. Re-embed the project first."}
    q = truncate(embed_queries([query]), vs.dim)[0]
    proj = get_projection(project_id)
    if not proj or proj["ids"] != list(vs.ids):
        fit_projection(project_id, vs)
        proj = get_projection(project_id)
    xyz = proj["reducer"].transform(q.reshape(1, -1))[0]
    sims = vs.matrix[comparable] @ q
    order = np.argsort(-sims)[:top_k]
    return {
        "query": query,
        "x": float(xyz[0]), "y": float(xyz[1]), "z": float(xyz[2]),
        "dim": vs.dim,
        "matches": [{"url": vs.urls[comparable[i]], "title": vs.titles[comparable[i]], "page_id": vs.ids[comparable[i]],
                     "similarity": float(sims[i])} for i in order],
    }


def get_project_entities(project_id: int):
    conn = get_db()
    vs = load_project_vectors(conn, project_id)
    conn.close()
    entities = []
    for i in range(len(vs)):
        st = vs.types[i]
        label = f"[{st}] Keyword: {vs.titles[i]}" if st == "keyword" else f"[{st}] {vs.titles[i]} - {vs.urls[i]}"
        entities.append({"id": vs.ids[i], "url": vs.urls[i], "label": label, "title": vs.titles[i], "source_type": st})
    return entities


def compare_entities(project_id: int, source_id: int, target_id: int, distance_metric: str = "cosine"):
    conn = get_db()
    vs = load_project_vectors(conn, project_id)
    conn.close()
    pos = {pid: i for i, pid in enumerate(vs.ids)}
    if source_id not in pos or target_id not in pos:
        return {"error": f"Invalid entities. Source {source_id} found: {source_id in pos}. Target {target_id} found: {target_id in pos}. "
                         f"Project has {len(vs)} embedded items."}

    def ent(i):
        return {"id": vs.ids[i], "url": vs.urls[i], "title": vs.titles[i], "source_type": vs.types[i]}

    s_idx, t_idx = pos[source_id], pos[target_id]
    sv, tv = vs.matrix[s_idx].reshape(1, -1), vs.matrix[t_idx].reshape(1, -1)
    dist = cdist(sv, tv, metric=distance_metric)[0][0]
    s_d = cdist(sv, vs.matrix, metric=distance_metric)[0]
    t_d = cdist(tv, vs.matrix, metric=distance_metric)[0]
    s_nb = [ent(i) for i in np.argsort(s_d) if i != s_idx][:5]
    t_nb = [ent(i) for i in np.argsort(t_d) if i != t_idx][:5]
    return {"distance": float(dist), "entity_a": ent(s_idx), "entity_b": ent(t_idx),
            "neighbors_a": s_nb, "neighbors_b": t_nb}

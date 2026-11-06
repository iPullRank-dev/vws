"""Semantic Drift: does each page stay on its subject?

Three lenses, all measured against this project's own distribution so they
hold for any vector size:

  site   distance from the site's center (the Site Focus zones)
  topic  fit to its own topic cluster, and whether another topic fits better
  title  whether the page delivers on its own title: the title is embedded as
         a search query and scored against the page. Pages whose title was
         generated from the URL use their best target query instead.

The verdicts separate pages that drift (fix or prune) from pages that are
coherent but sit in a deliberate secondary topic (case studies, careers...).
"""
from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np

from services.database import get_db
from services.embedder import MODEL_ID, title_from_url, truncate
from services.structure import build_structure
from services.vectors import is_own_page, load_project_vectors

VERDICTS = {
    "off_title": {"label": "Doesn't match its title", "severity": "high"},
    "off_site": {"label": "Off-topic page", "severity": "high"},
    "off_topic": {"label": "Drifted from its topic", "severity": "medium"},
    "secondary": {"label": "Secondary topic", "severity": "low"},
    "on_topic": {"label": "On topic", "severity": "none"},
}
_SEV_RANK = {"high": 0, "medium": 1, "low": 2, "none": 3}


def _short(u: str) -> str:
    from urllib.parse import urlparse
    try:
        p = urlparse(u)
        return (p.path or "/") + (f"?{p.query}" if p.query else "")
    except Exception:
        return u


def _iqr_low(values: np.ndarray) -> float:
    q1, q3 = np.percentile(values, [25, 75])
    return float(q1 - 1.5 * (q3 - q1))


_ARCHIVE_FOLDERS = {"author", "authors", "category", "categories", "tag", "tags", "page", "topics", "team"}


def _folder(u: str) -> str:
    """First path segment, e.g. /case-studies/ — used to name a group of similar pages."""
    from urllib.parse import urlparse
    try:
        seg = [x for x in urlparse(u).path.split("/") if x]
    except Exception:
        return ""
    return f"/{seg[0]}/" if len(seg) >= 2 else ""


def build_drift(project_id: int, dim: int | None = None) -> dict:
    s = build_structure(project_id, dim)
    if s.get("error"):
        return {"error": s["error"], "health": s.get("health"), "dim": s.get("dim")}
    dim = s["dim"]
    pages = s["pages"]
    th = s["thresholds"]
    fences = s["fences"]
    health = s["health"] or {}

    conn = get_db()
    vs = load_project_vectors(conn, project_id, dim)
    conn.close()
    row = {vs.urls[i]: i for i in range(len(vs.urls)) if is_own_page(vs.types[i])}
    P = np.vstack([vs.matrix[row[p["url"]]] for p in pages])

    # --- topic lens ---------------------------------------------------------
    by_cluster: dict[int, list[int]] = defaultdict(list)
    for j, p in enumerate(pages):
        by_cluster[p["cluster"]].append(j)
    cids = sorted(by_cluster)
    C = np.vstack([P[by_cluster[c]].mean(axis=0) for c in cids])
    C /= np.linalg.norm(C, axis=1, keepdims=True)
    cpos = {c: k for k, c in enumerate(cids)}
    PC = P @ C.T                                  # page x topic centroid
    labels = {c["id"]: c for c in s["clusters"]}
    site_c = P.mean(axis=0)
    site_c /= (np.linalg.norm(site_c) or 1.0)
    topic_dist = {c: float(1 - C[cpos[c]] @ site_c) for c in cids}   # how far each topic sits from the site center
    fits = np.array([PC[j, cpos[p["cluster"]]] for j, p in enumerate(pages)])
    fit_low_global = float(np.percentile(fits, 10))
    fit_low = {}
    for c, members in by_cluster.items():
        f = fits[members]
        fit_low[c] = min(_iqr_low(f), fit_low_global) if len(members) >= 6 else fit_low_global

    # --- title lens -----------------------------------------------------------
    same_space = (not health.get("legacy") and not health.get("mixed") and not health.get("foreign")
                  and not any(str(m).startswith("unverified:") for m in (health.get("models") or {})))
    anchors: list[tuple[str | None, str | None]] = []
    for p in pages:
        t = (p.get("title") or "").strip()
        auto = (not t) or t == title_from_url(p["url"]) or t.replace("-", " ").lower() == title_from_url(p["url"]).lower()
        if _folder(p["url"]).strip("/") in _ARCHIVE_FOLDERS:
            anchors.append((None, None))            # archive pages: the title is just a label or a name
        elif t and not auto:
            anchors.append((t, "title"))
        elif t and len(t.replace("-", " ").split()) >= 3:
            anchors.append((t.replace("-", " "), "url"))
        else:
            anchors.append((None, None))
    title_sim = np.full(len(pages), np.nan, dtype=np.float32)
    title_note = None
    if not same_space:
        title_note = ("Title match needs vectors made locally with " + MODEL_ID + ". Re-embed this project to turn it on.")
    else:
        idx = [j for j, (a, _) in enumerate(anchors) if a]
        if idx:
            from services.lab import _cached
            Q = truncate(_cached("q", [anchors[j][0] for j in idx]), dim)
            title_sim[idx] = (P[idx] * Q).sum(axis=1)
        n_auto = sum(1 for _, k in anchors if k != "title")
        n_none = sum(1 for _, k in anchors if k is None)
        if n_auto > len(pages) * 0.5:
            title_note = (f"{n_auto} of {len(pages)} pages have no real title (it was generated from the URL). Their URL words "
                          f"stand in where they're descriptive; {n_none} pages have no usable title and skip this check. "
                          "Re-crawl to pick up real titles.")
    valid = ~np.isnan(title_sim)
    if valid.sum() >= 8:
        title_cut = float(max(min(_iqr_low(title_sim[valid]), th["gap"]), float(np.nanpercentile(title_sim, 3))))
    else:
        title_cut = float(th["gap"])

    # --- far groups -------------------------------------------------------------
    # A far page with close neighbors that are also far belongs to a secondary
    # topic (case studies, a tool, an event series). A far page without them is drift.
    S = P @ P.T
    np.fill_diagonal(S, -1.0)
    nn_sim = S.max(axis=1)
    nn_cut = float(np.percentile(nn_sim, 50))
    far = [j for j, p in enumerate(pages) if p["zone"] in ("Expansion", "Peripheral")]
    far_set = set(far)
    parent = {j: j for j in far}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a in far:
        for b in far:
            if a < b and S[a, b] >= nn_cut:
                parent[find(a)] = find(b)
    groups: dict[int, list[int]] = defaultdict(list)
    for j in far:
        groups[find(j)].append(j)
    group_of = {}
    for g, members in groups.items():
        if len(members) >= 3 and any(pages[m]["zone"] == "Peripheral" for m in members):
            segs = Counter(_folder(pages[m]["url"]) for m in members)
            seg, cnt = segs.most_common(1)[0]
            name = f"{seg}" if seg and cnt >= 0.6 * len(members) else \
                Counter(pages[m]["cluster_label"] for m in members).most_common(1)[0][0]
            for m in members:
                group_of[m] = {"name": name, "size": len(members)}
    # Far pages in the same folder as a group belong to it (e.g. the rest of /case-studies/).
    by_name = {}
    for g in group_of.values():
        by_name.setdefault(g["name"], g)
    for j in far:
        if j not in group_of and _folder(pages[j]["url"]) in by_name:
            g = by_name[_folder(pages[j]["url"])]
            g["size"] += 1
            group_of[j] = g

    # --- per-page verdict -------------------------------------------------------
    out = []
    for j, p in enumerate(pages):
        cid = p["cluster"]
        cl = labels.get(cid, {"label": "this topic", "size": len(by_cluster[cid]), "hub_url": p["hub_url"]})
        order = np.argsort(-PC[j])
        best_c = cids[int(order[0])]
        other = best_c if best_c != cid else (cids[int(order[1])] if len(cids) > 1 else None)
        fit = float(fits[j])
        other_fit = float(PC[j, cpos[other]]) if other is not None else None
        anchor, anchor_kind = anchors[j]
        ts = None if np.isnan(title_sim[j]) else float(title_sim[j])
        near = p["neighbors"][0] if p.get("neighbors") else None
        strong = p["query_counts"]["strong"]
        topic_far = topic_dist[cid] > fences["q3"]
        n_q = strong + p["query_counts"]["partial"]

        if ts is not None and ts < title_cut:
            what = "title" if anchor_kind == "title" else "URL title"
            key = "off_title"
            near_txt = f"{_short(near['url'])} ({near['similarity']:.2f})" if near else "other pages"
            text = (f"The page scores {ts:.3f} against its own {what} \"{anchor}\", below this project's floor of {title_cut:.3f}, "
                    f"so it doesn't read as an answer to it. The body is closest to {near_txt}. "
                    f"Rewrite the opening so it answers the {what}, or retitle the page to what it covers.")
        elif p["zone"] == "Peripheral" and j in group_of:
            key = "secondary"
            g = group_of[j]
            text = (f"Part of a group of {g['size']} similar pages ({g['name']}) that sits outside your core. That's a secondary "
                    f"topic rather than drift. Fine if it's deliberate: link the group to the core pages it supports "
                    f"(e.g. from {_short(near['url']) if near else _short(p['hub_url'])}); if it isn't, consolidate it.")
        elif p["zone"] == "Peripheral":
            key = "off_site"
            near_txt = f"{_short(near['url'])} at {near['similarity']:.2f}" if near else "none"
            if n_q:
                text = (f"Far from the site's center with no group of similar pages around it (closest: {near_txt}), yet it's "
                        f"the best page for {n_q} quer{'y' if n_q == 1 else 'ies'}. Keep it, tighten it around those queries and "
                        f"link to it from a related core page.")
            else:
                text = (f"Far from the site's center with no group of similar pages around it (closest: {near_txt}), and no "
                        f"target query maps here. Merge it into the closest page with a 301, refocus it on a core topic, or noindex it.")
        elif (other is not None and other != cid and other_fit is not None and other_fit > fit + 0.01
              and labels.get(other, {}).get("label") != cl["label"]):
            key = "off_topic"
            ol = labels.get(other, {}).get("label", "another topic")
            text = (f"Grouped with \"{cl['label']}\" but it fits \"{ol}\" better ({other_fit:.3f} vs {fit:.3f}). Link it from that "
                    f"topic's hub {_short(labels.get(other, {}).get('hub_url', ''))} and make sure its own hub isn't the only page pointing to it.")
        elif fit < fit_low[cid]:
            key = "off_topic"
            text = (f"Sits at the edge of the \"{cl['label']}\" topic (fit {fit:.3f}, the topic's floor is {fit_low[cid]:.3f}). "
                    f"Tie it back in: link it from the hub {_short(p['hub_url'])} and add a passage that connects it to the topic, "
                    f"or move it under the topic it really belongs to.")
        elif j in group_of or (p["zone"] == "Expansion" and topic_far):
            key = "secondary"
            name = group_of[j]["name"] if j in group_of else cl["label"]
            text = (f"Part of a secondary topic ({name}) outside your core. Fine if it's deliberate: link it to the core "
                    f"page it supports, e.g. {_short(near['url']) if near else _short(p['hub_url'])}.")
        else:
            key = "on_topic"
            text = "Stays on its subject: it delivers on its title, fits its topic and sits within the site's core range."

        out.append({
            "page_id": p["page_id"], "url": p["url"], "title": p["title"], "zone": p["zone"],
            "distance": p["distance"], "cluster": cid, "cluster_label": cl["label"], "hub_url": p["hub_url"],
            "topic_fit": round(fit, 4), "topic_floor": round(fit_low[cid], 4),
            "better_topic": labels.get(other, {}).get("label") if key == "off_topic" and other != cid and other_fit and other_fit > fit + 0.01 else None,
            "group": group_of.get(j, {}).get("name"),
            "nearest": near,
            "title_sim": None if ts is None else round(ts, 4), "anchor": anchor, "anchor_kind": anchor_kind,
            "queries": [q["keyword"] for q in p.get("queries", [])[:5]], "query_counts": p["query_counts"],
            "verdict": key, "label": VERDICTS[key]["label"], "severity": VERDICTS[key]["severity"], "text": text,
        })

    out.sort(key=lambda r: (_SEV_RANK[r["severity"]], -(r["distance"] or 0)))
    counts = Counter(r["verdict"] for r in out)
    n = len(out)
    return {
        "dim": dim,
        "health": health,
        "pages": out,
        "counts": {k: counts.get(k, 0) for k in VERDICTS},
        "labels": {k: v["label"] for k, v in VERDICTS.items()},
        "on_topic_share": round(counts.get("on_topic", 0) / n, 4) if n else 0,
        "drift_share": round((counts.get("off_title", 0) + counts.get("off_site", 0) + counts.get("off_topic", 0)) / n, 4) if n else 0,
        "cutoffs": {"title_floor": round(title_cut, 4), "q3": fences["q3"], "outlier": fences["outlier"],
                    "fit_floor_global": round(fit_low_global, 4), "strong": th["strong"], "gap": th["gap"]},
        "title_available": bool(valid.any()),
        "title_note": title_note,
        "topics": [{"id": c, "label": labels.get(c, {}).get("label", str(c)), "distance": round(topic_dist[c], 4),
                    "outside_core": topic_dist[c] > fences["q3"], "size": len(by_cluster[c])} for c in cids],
    }

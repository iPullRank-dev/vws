"""Site structure: topic clusters + a per-page diagnosis with a recommended action.

This is the shared backbone for the Bullseye, Site Focus, Topic Clusters, Drift
and the page drawer, so every view tells the same story about a page:

    where it sits      zone (IQR fences on distance from the site's center),
                       percentile, topic cluster, fit to that cluster
    what it's for      queries it is the best page for, by coverage band
    how it's wired     inbound/outbound internal links, link to its topic hub
    what to do         one recommended action with the specific URL to use
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict

import numpy as np

from services.analysis import _iqr_zones, load_links
from services.database import get_db
from services.thresholds import suggest
from services.vectors import is_own_page, load_project_vectors

_STOP = set("""a an and are as at be by for from how in into is it its of on or our the this to vs what when where which
who why with you your we us i my me can do does not no yes more most best top guide page home blog new about
using use used will just get vs. & - | — – amp""".split())


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9][a-z0-9'+.-]*[a-z0-9]|[a-z0-9]", (text or "").lower())
            if t not in _STOP and len(t) > 2 and not t.isdigit()]


def _cluster_pages(X: np.ndarray) -> np.ndarray:
    """Ward clustering on unit vectors (Euclidean ~ cosine) into ~sqrt(n/1.5) topics."""
    n = len(X)
    if n < 4:
        return np.zeros(n, dtype=int)
    from scipy.cluster.hierarchy import fcluster, linkage
    k = int(np.clip(round(np.sqrt(n / 1.5)), 2, 30))
    Z = linkage(X, method="ward")
    return fcluster(Z, t=k, criterion="maxclust") - 1


_JUNK_QUERY = re.compile(r"\b(i'?m sorry|i couldn'?t|i can'?t|as an ai|i apologi[sz]e|unable to (find|provide)|no results)\b", re.I)


def _label_ok(q: str) -> bool:
    """Keep refusals and run-on strings that slipped into keyword lists out of topic labels."""
    return bool(q) and len(q.split()) <= 10 and q.strip().lower() not in ("keyword", "keywords", "query") and not _JUNK_QUERY.search(q)


def _label(titles: list[str], kw_texts: list[str], global_df: Counter, n_docs: int) -> str:
    if kw_texts:
        return " / ".join(kw_texts[:2])
    tf = Counter(t for title in titles for t in set(_tokens(title)))
    scored = sorted(tf, key=lambda t: -(tf[t] * np.log((1 + n_docs) / (1 + global_df[t]))))
    return " · ".join(scored[:3]) if scored else (titles[0] if titles else "Topic")


def build_structure(project_id: int, dim: int | None = None) -> dict:
    conn = get_db()
    vs = load_project_vectors(conn, project_id, dim)
    links = load_links(conn, project_id)
    conn.close()

    own = vs.indices(is_own_page)
    kws = vs.indices(lambda t: t == "keyword")
    if len(own) < 3:
        return {"pages": [], "clusters": [], "health": vs.health, "dim": vs.dim, "error": "Not enough pages with vectors yet."}

    M = vs.matrix
    O = M[own]
    n = len(own)
    url = [vs.urls[i] for i in own]
    title = [vs.titles[i] for i in own]
    pos = {u: j for j, u in enumerate(url)}

    PP = O @ O.T
    np.fill_diagonal(PP, -1.0)
    pp_upper = PP[np.triu_indices(n, 1)]

    kw_ok = bool(kws) and {vs.models[i] for i in kws} == {vs.models[i] for i in own}
    KO = M[kws] @ O.T if kw_ok else None
    th = suggest(vs.health, KO.max(axis=1) if KO is not None else None, pp_upper, None, vs.dim)

    # --- site center + zones -------------------------------------------------
    c = O.mean(axis=0)
    c /= (np.linalg.norm(c) or 1.0)
    dist = 1.0 - O @ c
    fences, zone_of = _iqr_zones(dist)
    zones = [zone_of(float(d)) for d in dist]
    pct = (np.argsort(np.argsort(dist)) / max(1, n - 1)) * 100

    # links
    internal = [(lr["source_url"], lr["target_url"], lr["anchor_text"] or "") for lr in links if lr["link_type"] == "internal"]
    link_graph = bool(internal)
    out_links: dict[str, set] = defaultdict(set)
    in_links: dict[str, list] = defaultdict(list)
    for s, t, a in internal:
        if s in pos and t in pos and s != t:
            out_links[s].add(t)
            in_links[t].append((s, a))

    # --- topic clusters ----------------------------------------------------------
    lab = _cluster_pages(O)
    clusters: dict[int, list[int]] = defaultdict(list)
    for j, l in enumerate(lab):
        clusters[int(l)].append(j)

    # queries -> best page
    best_for: dict[int, list[tuple[int, float, str]]] = defaultdict(list)
    gap_kw: list[int] = []
    if KO is not None:
        bp = KO.argmax(axis=1)
        bs = KO.max(axis=1)
        for k in range(len(kws)):
            band = "strong" if bs[k] >= th["strong"] else ("partial" if bs[k] >= th["gap"] else "gap")
            if band == "gap":
                gap_kw.append(k)
            else:
                best_for[int(bp[k])].append((k, float(bs[k]), band))

    def kw_text(k):
        return vs.titles[kws[k]] or vs.urls[kws[k]]

    def kw_weight(k):
        v = vs.volumes[kws[k]]
        return v if (v is not None and v > 0) else 1.0

    global_df = Counter(t for ti in title for t in set(_tokens(ti)))
    cluster_out = []
    hub_of: dict[int, int] = {}
    centroids = {}
    for cid, members in clusters.items():
        sub = O[members]
        cc = sub.mean(axis=0)
        cc /= (np.linalg.norm(cc) or 1.0)
        centroids[cid] = cc
        outside_core = float(1.0 - cc @ c) > fences["q3"]
        fit = sub @ cc
        # Suggested hub: the most central page, nudged towards pages that already
        # win queries and already receive links from the rest of the topic.
        mset_urls = {url[m] for m in members}
        hub_score = [float(fit[i]) + 0.015 * np.log1p(sum(1 for _, _, b in best_for.get(m, []) if b == "strong"))
                     + 0.015 * np.log1p(sum(1 for s_, _ in in_links.get(url[m], []) if s_ in mset_urls))
                     for i, m in enumerate(members)]
        hub = members[int(np.argmax(hub_score))]
        hub_of[cid] = hub
        q = [(k, s, b) for j in members for (k, s, b) in best_for.get(j, [])]
        # Label with the queries that sit closest to the topic's center (most representative).
        rep_q = sorted([x for x in q if _label_ok(kw_text(x[0]))], key=lambda x: -float(M[kws[x[0]]] @ cc))[:2]
        q.sort(key=lambda x: (-kw_weight(x[0]), -x[1]))
        label = _label([title[j] for j in members], [kw_text(k) for k, _, _ in rep_q], global_df, n)
        cluster_out.append({"id": cid, "label": label, "size": len(members), "hub": hub, "members": members,
                            "cohesion": float(fit.mean()), "queries": q, "outside_core": outside_core})

    # gap queries -> nearest topic (expansion opportunities)
    gap_by_cluster: dict[int, list[int]] = defaultdict(list)
    if gap_kw:
        C = np.vstack([centroids[c["id"]] for c in cluster_out])
        G = M[[kws[k] for k in gap_kw]] @ C.T
        for gi, k in enumerate(gap_kw):
            gap_by_cluster[cluster_out[int(np.argmax(G[gi]))]["id"]].append(k)

    # --- polar angles: one sector per topic, sized by page count ----------------
    order = sorted(cluster_out, key=lambda c: -c["size"])
    gap_deg = 4.0 if len(order) > 1 else 0.0
    usable = 360.0 - gap_deg * len(order)
    angle = np.zeros(n)
    start = 0.0
    for c in order:
        span = usable * c["size"] / n
        c["angle_start"], c["angle_end"] = start, start + span
        members = sorted(c["members"], key=lambda j: -float(O[j] @ centroids[c["id"]]))
        for r, j in enumerate(members):
            angle[j] = start + span * (r + 0.5) / len(members)
        c["angle_mid"] = start + span / 2
        start += span + gap_deg

    # 2-D layout for the topic bubble chart (PCA of page vectors)
    from sklearn.decomposition import PCA
    xy = PCA(n_components=2, random_state=42).fit_transform(O) if n >= 3 else np.zeros((n, 2))

    # --- per-page diagnosis ------------------------------------------------------
    pages = []
    core_idx = [j for j in range(n) if zones[j] == "Core"]
    for j in range(n):
        cid = int(lab[j])
        cl = next(c for c in cluster_out if c["id"] == cid)
        hub = hub_of[cid]
        nn = [int(x) for x in np.argsort(-PP[j])[:5]]
        q = sorted(best_for.get(j, []), key=lambda x: (-kw_weight(x[0]), -x[1]))
        n_strong = sum(1 for _, _, b in q if b == "strong")
        n_partial = sum(1 for _, _, b in q if b == "partial")
        inbound = in_links.get(url[j], [])
        in_rel = [float(PP[pos[s], j]) for s, _ in inbound if s in pos]
        # best core page in the same topic (or anywhere) that doesn't already link here
        linked_from = {s for s, _ in inbound}
        cand = [k for k in (cl["members"] if len(cl["members"]) > 1 else core_idx) if k != j and url[k] not in linked_from]
        cand.sort(key=lambda k: (zones[k] != "Core", -PP[k, j]))
        link_src = cand[0] if cand else None
        rec = _recommend(j, zones[j], cl, hub, q, n_strong, n_partial, nn, PP, url, title, link_src,
                         kw_text, link_graph, out_links, in_links)
        pages.append({
            "page_id": vs.ids[own[j]], "url": url[j], "title": title[j], "source_type": vs.types[own[j]],
            "zone": zones[j], "distance": round(float(dist[j]), 4), "percentile": round(float(pct[j]), 1),
            "cluster": cid, "cluster_label": cl["label"], "is_hub": hub == j,
            "hub_url": url[hub], "fit": round(float(O[j] @ centroids[cid]), 4),
            "angle": round(float(angle[j]), 2), "x": round(float(xy[j][0]), 4), "y": round(float(xy[j][1]), 4),
            "neighbors": [{"url": url[k], "title": title[k], "similarity": round(float(PP[j, k]), 4)} for k in nn],
            "queries": [{"keyword": kw_text(k), "similarity": round(s, 4), "band": b, "volume": vs.volumes[kws[k]]} for k, s, b in q[:15]],
            "query_counts": {"strong": n_strong, "partial": n_partial},
            "links": {"inbound": len(inbound), "outbound": len(out_links.get(url[j], ())),
                      "inbound_avg_relevance": round(float(np.mean(in_rel)), 4) if in_rel else None,
                      "links_to_hub": (url[hub] in out_links.get(url[j], set())) if hub != j else None},
            "recommendation": rec,
        })

    sized = [c["cohesion"] for c in cluster_out if c["size"] >= 3]
    loose_cut = float(np.percentile(sized, 20)) if len(sized) >= 4 else -1.0
    clusters_json = []
    for c in sorted(cluster_out, key=lambda c: -c["size"]):
        members = c["members"]
        hub = c["hub"]
        mset = {url[m] for m in members}
        within = sum(1 for s in mset for t in out_links.get(s, ()) if t in mset)
        possible = max(1, len(members) * (len(members) - 1))
        spokes = [m for m in members if m != hub]
        spokes_to_hub = sum(1 for m in spokes if url[hub] in out_links.get(url[m], set()))
        hub_to_spokes = sum(1 for m in spokes if url[m] in out_links.get(url[hub], set()))
        gq = sorted(gap_by_cluster.get(c["id"], []), key=lambda k: -kw_weight(k))
        n_strong = sum(1 for _, _, b in c["queries"] if b == "strong")
        n_partial = sum(1 for _, _, b in c["queries"] if b == "partial")
        cx = float(np.mean([xy[m][0] for m in members])); cy = float(np.mean([xy[m][1] for m in members]))
        clusters_json.append({
            "id": c["id"], "label": c["label"], "size": c["size"], "hub_url": url[hub], "hub_title": title[hub],
            "cohesion": round(c["cohesion"], 4), "x": round(cx, 4), "y": round(cy, 4),
            "angle_start": round(c["angle_start"], 2), "angle_end": round(c["angle_end"], 2), "angle_mid": round(c["angle_mid"], 2),
            "zones": dict(Counter(zones[m] for m in members)),
            "queries": {"strong": n_strong, "partial": n_partial,
                        "top": [{"keyword": kw_text(k), "similarity": round(s, 4), "band": b} for k, s, b in c["queries"][:8]]},
            "gap_queries": {"count": len(gq), "volume": sum(float(vs.volumes[kws[k]] or 0) for k in gq),
                            "top": [kw_text(k) for k in gq[:8]]},
            "links": {"within": within, "density": round(within / possible, 3), "spokes": len(spokes),
                      "spokes_to_hub": spokes_to_hub, "hub_to_spokes": hub_to_spokes},
            "pages": [url[m] for m in sorted(members, key=lambda m: -float(O[m] @ centroids[c["id"]]))],
            "recommendation": _recommend_cluster(c, url, title, hub, spokes, spokes_to_hub, hub_to_spokes, len(gq),
                                                 n_strong, n_partial, link_graph, gq, kw_text, loose_cut),
        })

    zone_counts = Counter(zones)
    return {
        "dim": vs.dim, "health": vs.health, "thresholds": th, "link_graph_loaded": link_graph,
        "fences": fences, "zone_counts": dict(zone_counts),
        "pages": pages, "clusters": clusters_json,
        "summary": {"pages": n, "clusters": len(clusters_json), "keywords": len(kws), "gap_queries": len(gap_kw)},
    }


def _short(u: str) -> str:
    from services.actions import short_url
    return short_url(u)


def _recommend(j, zone, cl, hub, q, n_strong, n_partial, nn, PP, url, title, link_src, kw_text, link_graph, out_links, in_links):
    near = nn[0] if nn else None
    near_txt = f"{_short(url[near])} ({PP[j, near]:.2f})" if near is not None else "—"
    top_q = kw_text(q[0][0]) if q else None
    isolated = cl["size"] <= 2
    src = f"{_short(url[link_src])}" if link_src is not None else None
    no_inbound = link_graph and not in_links.get(url[j])

    if zone == "Peripheral":
        if isolated and not q:
            return {"verdict": "Review: merge, refocus or prune", "severity": "high",
                    "text": (f"Far from every topic on the site and no target query maps here. If it overlaps {near_txt}, merge it there "
                             "and 301; if it still earns traffic or links, refresh it to connect to a core topic; otherwise noindex or remove."),
                    "target_url": url[near] if near is not None else None, "action": "merge"}
        if isolated:
            return {"verdict": "Keep, but support it", "severity": "medium",
                    "text": (f"Off your main topics, yet it's the best page for {len(q)} quer{'y' if len(q) == 1 else 'ies'}"
                             f" (e.g. \"{top_q}\"). Link to it from {src or near_txt} and tighten it around that query."),
                    "target_url": url[link_src] if link_src is not None else None, "action": "link"}
        if not cl.get("outside_core"):
            # The topic is fine; this page is the outlier within it.
            if q:
                return {"verdict": "Keep, but support it", "severity": "medium",
                        "text": (f"Far from the core and from the rest of \"{cl['label']}\", yet it's the best page for {len(q)} "
                                 f"quer{'y' if len(q) == 1 else 'ies'} (e.g. \"{top_q}\"). Tighten it around that query and link to it "
                                 f"from {src or near_txt}."),
                        "target_url": url[link_src] if link_src is not None else None, "action": "link"}
            return {"verdict": "Review: merge, refocus or prune", "severity": "high",
                    "text": (f"An outlier even within \"{cl['label']}\" and no target query maps here. If it overlaps {near_txt}, merge "
                             "it there and 301; if it earns traffic or links, refocus it on the topic; otherwise noindex or remove."),
                    "target_url": url[near] if near is not None else None, "action": "merge"}
        return {"verdict": "Strategic call on this topic", "severity": "medium",
                "text": (f"Part of the \"{cl['label']}\" topic ({cl['size']} pages), which sits outside your core. If it's a "
                         f"deliberate secondary topic (case studies, careers, a tool), link it to the core pages it supports; if not, "
                         f"build it out around its hub {_short(url[hub])} or consolidate it."),
                "target_url": url[hub], "action": "topic"}
    if zone == "Expansion":
        if n_partial:
            return {"verdict": "Strengthen", "severity": "medium",
                    "text": (f"Best page for {n_partial} under-optimized quer{'y' if n_partial == 1 else 'ies'} (\"{top_q}\"), and drifting "
                             f"from the core. Add a link from {src or near_txt} and rework the passages that fail those queries in the Lab."),
                    "target_url": url[link_src] if link_src is not None else None, "action": "optimize"}
        return {"verdict": "Connect", "severity": "low",
                "text": (f"Drifting from the core with no target query of its own. Link to it from {src or near_txt}"
                         + (" (it has no internal links pointing in)" if no_inbound else "") + ", or fold it into a stronger page."),
                "target_url": url[link_src] if link_src is not None else None, "action": "link"}
    if hub == j and cl["size"] > 2:
        missing = [m for m in cl["members"] if m != j and url[m] not in out_links.get(url[j], set())]
        if link_graph and missing:
            return {"verdict": "Topic hub: link out to its spokes", "severity": "low",
                    "text": (f"Most central page of \"{cl['label']}\". It doesn't link to {len(missing)} of its {cl['size'] - 1} spoke pages; "
                             f"add links, starting with {_short(url[missing[0]])}."),
                    "target_url": url[missing[0]], "action": "link"}
        return {"verdict": "Topic hub", "severity": "none",
                "text": f"Most central page of \"{cl['label']}\". Keep it current and use it to pass relevance to the topic's weaker pages.",
                "target_url": None, "action": "none"}
    if n_partial:
        return {"verdict": "Optimize", "severity": "medium",
                "text": (f"On-topic and the best page for {n_partial} quer{'y' if n_partial == 1 else 'ies'} it doesn't clearly target yet "
                         f"(\"{top_q}\"). Open it in the Lab with those queries."),
                "target_url": None, "action": "optimize"}
    if zone == "Core":
        return {"verdict": "Core asset", "severity": "none",
                "text": "Sits at the center of the site's topics. Use it as a link source for under-supported pages in the same topic.",
                "target_url": None, "action": "none"}
    return {"verdict": "Supporting page", "severity": "none",
            "text": ("On-topic" + (f" and clearly targets {n_strong} quer{'y' if n_strong == 1 else 'ies'}" if n_strong else "")
                     + (". Make sure it links to its topic hub " + _short(url[hub]) + "." if hub != j and url[hub] not in out_links.get(url[j], set()) and link_graph else ".")),
            "target_url": url[hub] if hub != j else None, "action": "none"}


def _recommend_cluster(c, url, title, hub, spokes, spokes_to_hub, hub_to_spokes, n_gap, n_strong, n_partial, link_graph, gq, kw_text,
                       loose_cut=-1.0):
    if link_graph and spokes and spokes_to_hub < len(spokes) * 0.5:
        return {"verdict": "Wire up hub and spokes", "severity": "medium",
                "text": (f"Only {spokes_to_hub} of {len(spokes)} pages link to the hub {_short(url[hub])}"
                         + (f", and the hub links to {hub_to_spokes}" if hub_to_spokes < len(spokes) else "")
                         + ". Add the missing links so relevance concentrates on the hub.")}
    if n_gap >= 5:
        return {"verdict": "Expand this topic", "severity": "medium",
                "text": (f"{n_gap} uncovered queries sit closest to this topic (e.g. \"{kw_text(gq[0])}\"). Build them out from "
                         f"the hub {_short(url[hub])}; see Create actions in the Action Plan.")}
    if n_partial > n_strong and n_partial >= 3:
        return {"verdict": "Optimize existing pages", "severity": "medium",
                "text": f"{n_partial} queries map here but aren't clearly targeted ({n_strong} are). Work the Optimize actions for these pages."}
    if c["size"] <= 2 and not c["queries"]:
        return {"verdict": "Thin, untargeted topic", "severity": "low",
                "text": "One or two pages and no target queries. Decide whether this topic matters; if not, fold the pages into stronger ones."}
    if c["size"] >= 4 and c["cohesion"] < loose_cut:
        return {"verdict": "Loose topic", "severity": "low",
                "text": "Pages in this group are only loosely related. Consider splitting it into tighter sub-topics, each with its own hub."}
    return {"verdict": "Healthy topic", "severity": "none",
            "text": f"Coherent topic with a clear hub ({_short(url[hub])})."}

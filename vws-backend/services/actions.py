"""Action Plan engine.

Turns the project's vectors into a ranked list of concrete tasks a relevance
engineer (or a writer / dev they hand it to) can execute:

    create          queries nothing on the site answers  -> new page or new section
    optimize        a page is the best match but isn't clearly targeting the query
    cannibalization two pages are too close to call for the same queries
    consolidate     near-duplicate pages
    internal_link   pages that should link to an under-supported target (with anchor)
    weak_link       existing internal links between unrelated pages
    prune           off-topic pages no target query maps to
    competitor_gap  competitor pages with no counterpart on the site

Each action carries the evidence (similarities, volumes, URLs), concrete steps,
an impact/effort estimate, a stable key for status tracking, and a payload that
opens it in the Relevance Lab.
"""
from __future__ import annotations

import hashlib
import math
from collections import defaultdict
from urllib.parse import urlparse

import numpy as np

from services.analysis import load_links, _iqr_zones
from services.database import get_db
from services.thresholds import merge, suggest
from services.vectors import is_own_page, load_project_vectors

# Priority = impact x effort factor. Effort tempers, it doesn't dominate: a
# high-impact page build should still outrank a marginal link tweak.
EFFORT_FACTOR = {"low": 1.0, "medium": 0.85, "high": 0.7}
TYPE_WEIGHT = {
    "create": 1.0, "optimize": 1.0, "cannibalization": 0.9, "consolidate": 0.85,
    "internal_link": 0.8, "competitor_gap": 0.6, "prune": 0.5, "weak_link": 0.4,
}
TYPE_LABEL = {
    "create": "Create", "expand": "Expand", "optimize": "Optimize", "cannibalization": "De-cannibalize",
    "consolidate": "Consolidate", "internal_link": "Internal links", "weak_link": "Fix links",
    "prune": "Prune / refocus", "competitor_gap": "Competitor gap",
}


def _key(*parts) -> str:
    return hashlib.sha1("||".join(str(p) for p in parts).encode()).hexdigest()[:14]


def short_url(u: str) -> str:
    try:
        p = urlparse(u)
        path = p.path or "/"
        return path if len(path) <= 70 else path[:67] + "..."
    except Exception:
        return u


def _load_states(conn, project_id: int) -> dict:
    cur = conn.cursor()
    try:
        cur.execute("SELECT action_key, status, note, updated_at FROM action_state WHERE project_id = ?", (project_id,))
        return {r["action_key"]: dict(r) for r in cur.fetchall()}
    except Exception:
        return {}


def set_action_state(project_id: int, key: str, status: str, note: str | None = None) -> dict:
    status = status if status in {"open", "doing", "done", "skipped"} else "open"
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO action_state (project_id, action_key, status, note, updated_at)
        VALUES (?, ?, ?, COALESCE(?, ''), CURRENT_TIMESTAMP)
        ON CONFLICT(project_id, action_key) DO UPDATE SET status = excluded.status,
            note = COALESCE(?, action_state.note), updated_at = CURRENT_TIMESTAMP
        """,
        (project_id, key, status, note, note),
    )
    conn.commit()
    conn.close()
    return {"key": key, "status": status}


def _cluster(vecs: np.ndarray, min_sim: float) -> list[list[int]]:
    n = len(vecs)
    if n == 0:
        return []
    if n == 1:
        return [[0]]
    from scipy.cluster.hierarchy import fcluster, linkage
    Z = linkage(vecs, method="average", metric="cosine")
    labels = fcluster(Z, t=max(1e-6, 1.0 - min_sim), criterion="distance")
    groups: dict[int, list[int]] = defaultdict(list)
    for i, lab in enumerate(labels):
        groups[int(lab)].append(i)
    return list(groups.values())


_PLAN_CACHE: dict = {}


def build_action_plan(project_id: int, overrides: dict | None = None, dim: int | None = None) -> dict:
    """Cached wrapper: the plan itself is pure vector math; statuses/notes are merged fresh."""
    import copy
    import time
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) AS c, COALESCE(MAX(v.updated_at), '') AS m FROM page_vectors v JOIN pages p ON p.id = v.page_id "
                "WHERE p.project_id = ?", (project_id,))
    r = cur.fetchone()
    cur.execute("SELECT COUNT(*) AS c FROM links WHERE project_id = ?", (project_id,))
    n_links = cur.fetchone()["c"]
    from services.vectors import get_project_settings
    eff_dim = dim or get_project_settings(conn, project_id)["analysis_dim"]
    states = _load_states(conn, project_id)
    conn.close()
    key = (project_id, eff_dim, r["c"], r["m"], n_links, tuple(sorted((k, v) for k, v in (overrides or {}).items() if v is not None)))
    hit = _PLAN_CACHE.get(project_id)
    if hit and hit[0] == key and time.time() - hit[1] < 600:
        plan = copy.deepcopy(hit[2])
    else:
        plan = _build_action_plan(project_id, overrides, eff_dim)
        _PLAN_CACHE[project_id] = (key, time.time(), copy.deepcopy(plan))
    for a in plan["actions"]:
        st = states.get(a["key"])
        a["status"] = st["status"] if st else "open"
        a["note"] = st["note"] if st else ""
    by_type: dict[str, dict] = defaultdict(lambda: {"open": 0, "doing": 0, "done": 0, "skipped": 0})
    for a in plan["actions"]:
        by_type[a["type"]][a["status"]] += 1
    plan["summary"]["by_type"] = dict(by_type)
    plan["summary"]["open"] = sum(1 for a in plan["actions"] if a["status"] in ("open", "doing"))
    plan["summary"]["done"] = sum(1 for a in plan["actions"] if a["status"] == "done")
    plan["summary"]["quick_wins"] = sum(1 for a in plan["actions"] if a["quick_win"] and a["status"] == "open")
    return plan


def _build_action_plan(project_id: int, overrides: dict | None, dim: int) -> dict:
    conn = get_db()
    vs = load_project_vectors(conn, project_id, dim)
    links = load_links(conn, project_id)
    states = _load_states(conn, project_id)
    conn.close()

    M = vs.matrix
    own = vs.indices(is_own_page)
    kws = vs.indices(lambda t: t == "keyword")
    comps = vs.indices(lambda t: t == "competitor")
    health = vs.health

    def models_of(idx):
        return {vs.models[i] for i in idx}

    kw_ok = bool(kws and own) and models_of(kws) == models_of(own) and len(models_of(own)) == 1
    comp_ok = bool(comps and own) and models_of(comps) == models_of(own)

    # ---- similarity matrices ------------------------------------------------
    PP = M[own] @ M[own].T if len(own) > 1 else np.zeros((len(own), len(own)), dtype=np.float32)
    pp_upper = PP[np.triu_indices(len(own), 1)] if len(own) > 1 else np.array([])
    KO = M[kws] @ M[own].T if kw_ok else None
    kw_best = KO.max(axis=1) if KO is not None and KO.size else None
    KK_upper = None
    if kw_ok and 2 <= len(kws) <= 6000:
        KK = M[kws] @ M[kws].T
        KK_upper = KK[np.triu_indices(len(kws), 1)]

    defaults = suggest(health, kw_best, pp_upper, KK_upper, vs.dim)
    th = merge(defaults, overrides or {})

    # keyword weights: search volume when the CSV had it, else 1 per keyword
    vols = [vs.volumes[i] for i in kws]
    has_volume = any(v is not None and v > 0 for v in vols)
    known = [v for v in vols if v is not None and v > 0]
    fallback_vol = float(np.median(known)) if known else 1.0
    weights = np.array([(v if (v is not None and v > 0) else (fallback_vol * 0.25 if has_volume else 1.0)) for v in vols], dtype=np.float64)
    nominal = float(np.median(weights)) if len(weights) else 1.0

    title = lambda i: vs.titles[i] or short_url(vs.urls[i])  # noqa: E731
    actions: list[dict] = []

    def add(a: dict, raw_impact: float):
        a["raw_impact"] = max(0.0, float(raw_impact)) * TYPE_WEIGHT.get(a["type"], 0.5)
        a.setdefault("keywords", [])
        a.setdefault("links", [])
        a.setdefault("urls", [])
        a.setdefault("metrics", {})
        a["type_label"] = TYPE_LABEL.get(a.get("variant") or a["type"], a["type"])
        actions.append(a)

    # links already present (own -> own)
    internal_pairs = {(lr["source_url"], lr["target_url"]) for lr in links if lr["link_type"] == "internal"}
    link_graph_loaded = bool(internal_pairs)

    best_page_of_kw: dict[int, int] = {}
    band_of_kw: dict[int, str] = {}
    coverage = {b: {"count": 0, "volume": 0.0} for b in ("strong", "partial", "gap")}
    histogram = None

    if KO is not None:
        order = np.argsort(-KO, axis=1)
        for k in range(len(kws)):
            b = float(KO[k, order[k, 0]])
            band = "strong" if b >= th["strong"] else ("partial" if b >= th["gap"] else "gap")
            best_page_of_kw[k] = int(order[k, 0])
            band_of_kw[k] = band
            coverage[band]["count"] += 1
            coverage[band]["volume"] += float(vols[k] or 0)

        edges = np.round(np.linspace(min(float(kw_best.min()), th["gap"]) - 0.01, max(float(kw_best.max()), th["strong"]) + 0.01, 31), 4)
        counts, _ = np.histogram(kw_best, bins=edges)
        vol_hist, _ = np.histogram(kw_best, bins=edges, weights=[v or 0 for v in vols])
        histogram = {"edges": edges.tolist(), "counts": counts.tolist(), "volume": vol_hist.tolist()}

        def kw_entry(k, extra=None):
            e = {"keyword": vs.titles[kws[k]] or vs.urls[kws[k]], "similarity": round(float(KO[k, best_page_of_kw[k]]), 4),
                 "volume": vols[k], "band": band_of_kw[k], "best_url": vs.urls[own[best_page_of_kw[k]]]}
            if extra:
                e.update(extra)
            return e

        KC = M[kws] @ M[comps].T if comp_ok else None

        def comp_best(k):
            if KC is None:
                return None
            j = int(np.argmax(KC[k]))
            return {"url": vs.urls[comps[j]], "name": vs.names[comps[j]], "similarity": round(float(KC[k, j]), 4)}

        # ---- CREATE / EXPAND: clustered gap queries --------------------------
        gap_k = [k for k in range(len(kws)) if band_of_kw[k] == "gap"]
        for grp in _cluster(M[[kws[k] for k in gap_k]], th["cluster"]) if gap_k else []:
            members = [gap_k[i] for i in grp]
            c = M[[kws[k] for k in members]].mean(axis=0)
            c /= (np.linalg.norm(c) or 1.0)
            members.sort(key=lambda k: (-weights[k], -float(M[kws[k]] @ c)))
            head = members[0]
            near_sims = M[own] @ c
            near = int(np.argmax(near_sims))
            best_member_sim = max(float(KO[k, best_page_of_kw[k]]) for k in members)
            expand = best_member_sim >= th["gap"] - 0.03
            head_kw = vs.titles[kws[head]]
            comp = None
            if comp_ok:
                cs = M[comps] @ c
                j = int(np.argmax(cs))
                comp = {"url": vs.urls[comps[j]], "name": vs.names[comps[j]], "similarity": round(float(cs[j]), 4)}
            n = len(members)
            vol_sum = sum(float(vols[k] or 0) for k in members)
            why = (f"{n} quer{'y' if n == 1 else 'ies'} with no page above the {th['gap']:.2f} gap line. "
                   f"Closest existing page: {short_url(vs.urls[own[near]])} ({best_member_sim:.2f}).")
            if comp and comp["similarity"] >= th["strong"]:
                why += f" {comp['name']} covers it ({comp['similarity']:.2f})."
            steps = [
                (f"Add a dedicated section to {short_url(vs.urls[own[near]])} that answers \"{head_kw}\" directly, "
                 f"using the query's wording in an H2.") if expand else
                (f"Create a new page targeting \"{head_kw}\"" + (f" that also answers the {n - 1} related queries listed." if n > 1 else ".")),
                f"Link to it from {short_url(vs.urls[own[near]])} (the closest existing topic) with anchor \"{head_kw}\".",
            ]
            if comp:
                steps.append(f"Benchmark against {comp['url']} in the Relevance Lab.")
            steps.append(f"Draft, then score it in the Relevance Lab until each query is at or above {th['strong']:.2f}.")
            add({
                "key": _key("create", head_kw.lower()),
                "type": "create", "variant": "expand" if expand else "create",
                "title": (f"Expand {short_url(vs.urls[own[near]])} to cover \"{head_kw}\"" if expand
                          else f"Create content for \"{head_kw}\"") + (f" (+{n - 1} related)" if n > 1 else ""),
                "why": why, "steps": steps, "effort": "medium" if expand else "high",
                "primary_url": vs.urls[own[near]],
                "urls": [vs.urls[own[near]]] + ([comp["url"]] if comp else []),
                "keywords": [kw_entry(k, {"competitor": comp_best(k)}) for k in members[:100]],
                "metrics": {"queries": n, "volume": vol_sum if has_volume else None, "best_similarity": round(best_member_sim, 4)},
                "lab": {"queries": [vs.titles[kws[k]] for k in members[:8]], "url": vs.urls[own[near]] if expand else None,
                        "compare_urls": [comp["url"]] if comp else []},
            }, sum(weights[k] for k in members))

        # ---- OPTIMIZE: partial matches, grouped by page then by subtopic -------
        by_page: dict[int, list[int]] = defaultdict(list)
        for k in range(len(kws)):
            if band_of_kw[k] == "partial":
                by_page[best_page_of_kw[k]].append(k)
        for p, page_members in by_page.items():
            # Split a page's queries into subtopics so each action is one change
            # ("add a section on X"), with stragglers rolled into a long-tail action.
            groups = _cluster(M[[kws[k] for k in page_members]], th["cluster"])
            topical = [[page_members[i] for i in g] for g in groups if len(g) >= 3]
            tail = [page_members[i] for g in groups if len(g) < 3 for i in g]
            if not topical:
                topical, tail = [page_members], []
            elif tail:
                topical.append(tail)
            for gi, members in enumerate(topical):
                is_tail = bool(tail) and members is tail
                members.sort(key=lambda k: (-weights[k], -KO[k, p]))
                head = members[0]
                head_kw = vs.titles[kws[head]]
                sims = [float(KO[k, p]) for k in members]
                n = len(members)
                losing = [k for k in members if (cb := comp_best(k)) and cb["similarity"] > KO[k, p]]
                why = (f"Best page on the site for {n} {'related ' if not is_tail else ''}quer{'y' if n == 1 else 'ies'}, "
                       f"but none clear the {th['strong']:.2f} \"clearly targets\" line "
                       f"(best {max(sims):.2f}, avg {np.mean(sims):.2f}).")
                if losing:
                    why += f" A competitor page scores higher on {len(losing)} of them."
                gap_to_strong = sum(weights[k] * (th["strong"] - KO[k, p]) / max(1e-6, th["strong"] - th["gap"]) for k in members)
                page = short_url(vs.urls[own[p]])
                add({
                    "key": _key("optimize", vs.urls[own[p]], "tail" if is_tail else head_kw.lower()),
                    "type": "optimize",
                    "title": (f"Optimize {page} for remaining queries (\"{head_kw}\" +{n - 1})" if is_tail
                              else f"Optimize {page} for \"{head_kw}\"" + (f" (+{n - 1} related)" if n > 1 else "")),
                    "why": why,
                    "steps": [
                        "Open in the Relevance Lab to see which passages score lowest against these queries.",
                        (f"Fold these queries into the sections where they fit; give any that score under {th['gap']:.2f} in the Lab a sentence that answers them directly."
                         if is_tail else
                         f"Add or rewrite one passage that answers \"{head_kw}\" directly, with the query's wording in its heading."),
                        "Point internal links at this page using these queries as anchors (see the Internal links actions).",
                        f"Re-score in the Lab until the head query is at or above {th['strong']:.2f}.",
                    ],
                    "effort": "medium", "primary_url": vs.urls[own[p]], "urls": [vs.urls[own[p]]],
                    "keywords": [kw_entry(k, {"competitor": comp_best(k)}) for k in members[:100]],
                    "metrics": {"queries": n, "avg_similarity": round(float(np.mean(sims)), 4),
                                "volume": sum(float(vols[k] or 0) for k in members) if has_volume else None},
                    "lab": {"queries": [vs.titles[kws[k]] for k in members[:8]], "url": vs.urls[own[p]],
                            "compare_urls": list({comp_best(k)["url"] for k in losing[:2]}) if losing else []},
                }, gap_to_strong)

        # ---- CANNIBALIZATION: page pairs too close to call --------------------
        pairs: dict[tuple[int, int], list[int]] = defaultdict(list)
        for k in range(len(kws) if KO.shape[1] > 1 else 0):
            a, b = int(order[k, 0]), int(order[k, 1])
            s1, s2 = float(KO[k, a]), float(KO[k, b])
            if s2 >= th["gap"] and s1 - s2 <= th["cannibal_margin"]:
                pairs[tuple(sorted((a, b)))].append(k)
        for (a, b), members in pairs.items():
            members.sort(key=lambda k: (-weights[k], -max(KO[k, a], KO[k, b])))
            wins_a = sum(weights[k] for k in members if KO[k, a] >= KO[k, b])
            wins_b = sum(weights[k] for k in members if KO[k, b] > KO[k, a])
            winner, loser = (a, b) if wins_a >= wins_b else (b, a)
            pair_sim = float(PP[a, b])
            head_kw = vs.titles[kws[members[0]]]
            n = len(members)
            merge_them = pair_sim >= th["dup"]
            wu, lu = vs.urls[own[winner]], vs.urls[own[loser]]
            steps = ([f"Merge {short_url(lu)} into {short_url(wu)}: move any unique content across, then 301 {short_url(lu)}.",
                      "Update internal links that point at the retired URL."]
                     if merge_them else
                     [f"Make {short_url(wu)} the primary page for these queries.",
                      f"Refocus {short_url(lu)} on what's distinct about it; trim the overlapping passages.",
                      f"Link {short_url(lu)} -> {short_url(wu)} with anchor \"{head_kw}\".",
                      "Re-run the plan: the margin between the two pages should widen past "
                      f"{th['cannibal_margin']:.3f}."])
            add({
                "key": _key("cannibal", *sorted((wu, lu))),
                "type": "cannibalization" if not merge_them else "consolidate",
                "title": f"{'Merge' if merge_them else 'Separate'} {short_url(wu)} and {short_url(lu)} on \"{head_kw}\"" + (f" (+{n - 1})" if n > 1 else ""),
                "why": (f"Both pages match {n} quer{'y' if n == 1 else 'ies'} within {th['cannibal_margin']:.3f} of each other. "
                        f"Page-to-page similarity is {pair_sim:.3f}" + (" (near-duplicate)." if merge_them else ".")),
                "steps": steps, "effort": "high" if merge_them else "medium",
                "primary_url": wu, "urls": [wu, lu],
                "keywords": [kw_entry(k, {"runner_up_url": vs.urls[own[b if best_page_of_kw[k] == a else a]],
                                          "margin": round(float(abs(KO[k, a] - KO[k, b])), 4)}) for k in members[:100]],
                "metrics": {"queries": n, "pair_similarity": round(pair_sim, 4)},
                "lab": {"queries": [vs.titles[kws[k]] for k in members[:8]], "url": wu, "compare_urls": [lu]},
            }, sum(weights[k] for k in members))

    # ---- CONSOLIDATE: near-duplicate pages not already covered ---------------
    covered_pairs = {tuple(sorted(a["urls"][:2])) for a in actions if a["type"] in ("cannibalization", "consolidate")}
    if len(own) > 1:
        ii, jj = np.where(np.triu(PP, 1) >= th["dup"])
        dup_pairs = sorted(zip(ii.tolist(), jj.tolist()), key=lambda ab: -PP[ab[0], ab[1]])[:40]
        for a, b in dup_pairs:
            ua, ub = vs.urls[own[a]], vs.urls[own[b]]
            if tuple(sorted((ua, ub))) in covered_pairs:
                continue
            keep, drop = (ua, ub) if len(short_url(ua)) <= len(short_url(ub)) else (ub, ua)
            add({
                "key": _key("dup", *sorted((ua, ub))),
                "type": "consolidate",
                "title": f"Consolidate near-duplicates {short_url(keep)} and {short_url(drop)}",
                "why": f"Document similarity {float(PP[a, b]):.3f}. Retrieval systems will treat these as the same content and split signals between them.",
                "steps": [f"Pick the canonical (suggested: {short_url(keep)}).",
                          f"Merge unique content from {short_url(drop)}, then 301 it (or canonicalize if both must stay live).",
                          "Repoint internal links to the canonical."],
                "effort": "medium", "primary_url": keep, "urls": [keep, drop],
                "metrics": {"pair_similarity": round(float(PP[a, b]), 4)},
                "lab": {"queries": [], "url": keep, "compare_urls": [drop]},
            }, nominal * 2)

    # ---- INTERNAL LINKS: support pages that need relevance ---------------------
    if len(own) > 1:
        sims = PP.copy()
        np.fill_diagonal(sims, -1)
        target_kws: dict[int, list[int]] = defaultdict(list)
        for k, p in best_page_of_kw.items():
            if band_of_kw[k] in ("partial", "strong"):
                target_kws[p].append(k)
        if target_kws:
            targets = sorted(target_kws, key=lambda p: -sum(weights[k] * (2 if band_of_kw[k] == "partial" else 1) for k in target_kws[p]))[:60]
        else:
            # No keywords: link pages to their closest unlinked neighbors.
            targets = list(np.argsort(-np.sort(sims, axis=1)[:, -1])[:40])
        for t in targets:
            tu = vs.urls[own[t]]
            cands = [s for s in np.argsort(-sims[:, t]) if sims[s, t] >= th["link_min"]
                     and (vs.urls[own[s]], tu) not in internal_pairs and vs.urls[own[s]] != tu][:3]
            if not cands:
                continue
            ks = sorted(target_kws.get(t, []), key=lambda k: (band_of_kw[k] != "partial", -weights[k]))
            anchor = vs.titles[kws[ks[0]]] if ks else title(own[t])
            partial_n = sum(1 for k in ks if band_of_kw[k] == "partial")
            why = (f"Best page for {len(ks)} quer{'y' if len(ks) == 1 else 'ies'}"
                   + (f" ({partial_n} under-optimized)" if partial_n else "") + ". " if ks else "")
            why += (f"{len(cands)} closely related page{'s' if len(cands) > 1 else ''} (similarity >= {th['link_min']:.2f}) "
                    f"{'don' if len(cands) > 1 else 'doesn'}'t link to it.")
            if not link_graph_loaded:
                why += " No internal link export is loaded, so confirm these links don't already exist."
            add({
                "key": _key("link", tu),
                "type": "internal_link",
                "title": f"Add {len(cands)} internal link{'s' if len(cands) > 1 else ''} to {short_url(tu)}",
                "why": why,
                "steps": [f"On each source page, link to {short_url(tu)} with anchor text \"{anchor}\" (vary it with the other queries listed)."
                          , "Place the link inside the passage that discusses the topic, not in navigation or footers."],
                "effort": "low", "primary_url": tu, "urls": [tu] + [vs.urls[own[s]] for s in cands],
                "links": [{"source_url": vs.urls[own[s]], "source_title": title(own[s]), "target_url": tu,
                           "anchor": anchor, "similarity": round(float(sims[s, t]), 4)} for s in cands],
                "keywords": [kw_entry(k) for k in ks[:20]] if KO is not None else [],
                "metrics": {"links": len(cands)},
                "lab": {"queries": [vs.titles[kws[k]] for k in ks[:5]], "url": tu, "compare_urls": []},
            }, (sum(weights[k] * (1.0 if band_of_kw[k] == "partial" else 0.4) for k in ks) * 0.6) if ks
               else nominal * 0.3 * float(np.mean([sims[s, t] for s in cands])))

    # ---- WEAK LINKS: existing internal links between unrelated pages ----------
    if link_graph_loaded and len(own) > 1:
        pos = {vs.urls[i]: n for n, i in enumerate(own)}
        weak_by_src: dict[str, list[tuple[str, float, str]]] = defaultdict(list)
        for lr in links:
            if lr["link_type"] != "internal":
                continue
            su, tu = lr["source_url"], lr["target_url"]
            if su in pos and tu in pos:
                s = float(PP[pos[su], pos[tu]])
                if s < th["weak_link"]:
                    weak_by_src[su].append((tu, s, lr["anchor_text"] or ""))
        for su, items in sorted(weak_by_src.items(), key=lambda kv: -len(kv[1]))[:25]:
            items.sort(key=lambda x: x[1])
            add({
                "key": _key("weak", su),
                "type": "weak_link",
                "title": f"Review {len(items)} low-relevance link{'s' if len(items) > 1 else ''} on {short_url(su)}",
                "why": f"These in-content links connect pages below the site's 10th-percentile similarity ({th['weak_link']:.2f}). Boilerplate nav links are fine; contextual ones dilute both pages.",
                "steps": ["Keep navigational links; remove or replace contextual links that point at unrelated pages.",
                          "Swap in links from the Internal links actions where the topic actually matches."],
                "effort": "low", "primary_url": su, "urls": [su],
                "links": [{"source_url": su, "target_url": t, "anchor": a, "similarity": round(s, 4)} for t, s, a in items[:20]],
                "metrics": {"links": len(items)},
                "lab": {"queries": [], "url": su, "compare_urls": []},
            }, nominal * 0.3 * len(items) ** 0.5)

    # ---- PRUNE / REFOCUS: off-topic pages with no query mapped ---------------
    if len(own) >= 8:
        c = M[own].mean(axis=0)
        c /= (np.linalg.norm(c) or 1.0)
        dist = 1.0 - (M[own] @ c)
        thr, zone_of = _iqr_zones(dist)
        mapped = set(best_page_of_kw.values())
        sims = PP.copy()
        np.fill_diagonal(sims, -1)
        for p in range(len(own)):
            if zone_of(float(dist[p])) != "Peripheral" or p in mapped:
                continue
            nb = int(np.argmax(sims[p]))
            pct = float((dist < dist[p]).mean() * 100)
            add({
                "key": _key("prune", vs.urls[own[p]]),
                "type": "prune",
                "title": f"Review off-topic page {short_url(vs.urls[own[p]])}",
                "why": (f"Farther from the site's topical center than {pct:.0f}% of pages (outside the IQR fence)"
                        + (" and no target query maps to it." if KO is not None else ".")),
                "steps": [f"If it still earns traffic or links, refresh it to connect to the site's core topics (nearest page: {short_url(vs.urls[own[nb]])}).",
                          f"If it overlaps {short_url(vs.urls[own[nb]])}, merge and 301 it there.",
                          "If it serves no search purpose, noindex or remove it."],
                "effort": "medium", "primary_url": vs.urls[own[p]], "urls": [vs.urls[own[p]], vs.urls[own[nb]]],
                "metrics": {"distance_from_center": round(float(dist[p]), 4), "percentile": round(pct, 1)},
                "lab": {"queries": [], "url": vs.urls[own[p]], "compare_urls": [vs.urls[own[nb]]]},
            }, nominal * 0.6)

    # ---- COMPETITOR GAPS ------------------------------------------------------
    if comp_ok and len(own) > 1:
        sims = PP.copy()
        np.fill_diagonal(sims, -1)
        nn_floor = float(np.percentile(sims.max(axis=1), 10))
        CO = M[comps] @ M[own].T
        best = CO.max(axis=1)
        arg = CO.argmax(axis=1)
        gaps = [j for j in range(len(comps)) if best[j] < nn_floor]
        gaps.sort(key=lambda j: best[j])
        for j in gaps[:30]:
            cu = vs.urls[comps[j]]
            add({
                "key": _key("compgap", cu),
                "type": "competitor_gap",
                "title": f"{vs.names[comps[j]]} covers \"{title(comps[j])}\"; you have nothing close",
                "why": f"Best match on your site is {short_url(vs.urls[own[arg[j]]])} at {best[j]:.2f}, below how close your own pages sit to each other ({nn_floor:.2f}).",
                "steps": [f"Review {cu} and decide whether the topic belongs on your site.",
                          "If it does, brief a page that does it better and score it against the competitor in the Lab."],
                "effort": "high", "primary_url": cu, "urls": [cu, vs.urls[own[arg[j]]]],
                "metrics": {"best_own_similarity": round(float(best[j]), 4)},
                "lab": {"queries": [title(comps[j])], "url": None, "compare_urls": [cu]},
            }, nominal * 0.8)

    # ---- scoring + status -----------------------------------------------------
    max_raw = max((a["raw_impact"] for a in actions), default=1.0) or 1.0
    for a in actions:
        a["impact"] = round(100 * math.log1p(a["raw_impact"]) / math.log1p(max_raw), 1) if max_raw > 0 else 0
        a["impact_label"] = "high" if a["impact"] >= 66 else ("medium" if a["impact"] >= 33 else "low")
        a["score"] = round(a["impact"] * EFFORT_FACTOR[a["effort"]], 1)
        a["quick_win"] = a["effort"] == "low" and a["impact"] >= 40
        st = states.get(a["key"])
        a["status"] = st["status"] if st else "open"
        a["note"] = st["note"] if st else ""
        a.pop("raw_impact", None)
    actions.sort(key=lambda a: (-a["score"], a["title"]))
    for rank, a in enumerate(actions, start=1):
        a["rank"] = rank

    by_type: dict[str, dict] = defaultdict(lambda: {"open": 0, "doing": 0, "done": 0, "skipped": 0})
    for a in actions:
        by_type[a["type"]][a["status"]] += 1

    blockers = []
    if health.get("needs_reembed") or health.get("foreign"):
        blockers.append(health.get("message"))
    if kws and own and not kw_ok:
        blockers.append("Keywords and pages were embedded with different models, so keyword actions are disabled until the project is re-embedded.")

    return {
        "project_id": project_id,
        "dim": vs.dim,
        "thresholds": th,
        "defaults": defaults,
        "vector_health": health,
        "link_graph_loaded": link_graph_loaded,
        "blockers": [b for b in blockers if b],
        "summary": {
            "pages": len(own), "keywords": len(kws), "competitor_pages": len(comps),
            "has_volume": has_volume, "coverage": coverage if KO is not None else None,
            "by_type": dict(by_type),
            "open": sum(1 for a in actions if a["status"] in ("open", "doing")),
            "done": sum(1 for a in actions if a["status"] == "done"),
            "quick_wins": sum(1 for a in actions if a["quick_win"] and a["status"] == "open"),
        },
        "histogram": histogram,
        "actions": actions,
    }

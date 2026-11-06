"""Focused, per-object analyses behind the upgraded views.

    target()            Query/page bullseye: every page's similarity to one target, with a verdict
    link_health()       Internal / external links aggregated per target page, with a status + action
    link_placement()    Where on a source page a suggested internal link should go
    compare_passages()  Which sections of two pages say the same thing (merge) or differ (keep)
    compare_pages()     Verdict + contested queries for the Intersection view
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict

import numpy as np

from services.analysis import load_links
from services.database import get_db
from services.embedder import embed_queries, truncate
from services.thresholds import suggest
from services.vectors import active_identity, is_own_page, load_project_vectors


def _short(u: str) -> str:
    from services.actions import short_url
    return short_url(u)


def _ctx(project_id: int, dim: int | None = None, include_external: bool = False):
    conn = get_db()
    vs = load_project_vectors(conn, project_id, dim, include_external=include_external)
    links = load_links(conn, project_id)
    conn.close()
    own = vs.indices(is_own_page)
    kws = vs.indices(lambda t: t == "keyword")
    comps = vs.indices(lambda t: t == "competitor")
    M = vs.matrix
    pp = None
    if len(own) > 1:
        P = M[own] @ M[own].T
        pp = P[np.triu_indices(len(own), 1)]
    kw_ok = bool(kws and own) and {vs.models[i] for i in kws} == {vs.models[i] for i in own}
    kb = (M[kws] @ M[own].T).max(axis=1) if kw_ok else None
    th = suggest(vs.health, kb, pp, None, vs.dim)
    return vs, links, own, kws, comps, th


# ---------------------------------------------------------------------------
# Bullseye target
# ---------------------------------------------------------------------------
def target(project_id: int, query: str | None = None, page_id: int | None = None) -> dict:
    vs, links, own, kws, comps, th = _ctx(project_id)
    if len(own) < 2:
        return {"error": "Not enough pages with vectors yet."}
    M = vs.matrix
    pos = {pid: i for i, pid in enumerate(vs.ids)}
    active = active_identity(vs.dim)

    if query:
        if not any(vs.models[i] == active for i in own):
            return {"error": f"This project's page vectors weren't made with {active}; re-embed before targeting a query."}
        t = truncate(embed_queries([query]), vs.dim)[0]
        mode, label = "query", query
        rings = [{"label": f"Clearly targets (≥ {th['strong']:.2f})", "similarity": th["strong"], "kind": "strong"},
                 {"label": f"Gap line ({th['gap']:.2f})", "similarity": th["gap"], "kind": "gap"}]
    elif page_id is not None and page_id in pos:
        t = M[pos[page_id]]
        mode, label = "page", vs.titles[pos[page_id]] or vs.urls[pos[page_id]]
        rings = [{"label": f"Near-duplicate (≥ {th['dup']:.2f})", "similarity": th["dup"], "kind": "dup"},
                 {"label": f"Should be linked (≥ {th['link_min']:.2f})", "similarity": th["link_min"], "kind": "link"}]
    else:
        return {"error": "Pick a query or a page to put in the center."}

    sims = M @ t
    idx = [i for i in own + comps if not (mode == "page" and vs.ids[i] == page_id)]
    idx.sort(key=lambda i: -sims[i])
    own_sorted = [i for i in idx if is_own_page(vs.types[i])]
    comp_sorted = [i for i in idx if vs.types[i] == "competitor"]

    linked = defaultdict(set)
    for lr in links:
        if lr["link_type"] == "internal":
            linked[lr["source_url"]].add(lr["target_url"])

    def item(i):
        return {"page_id": vs.ids[i], "url": vs.urls[i], "title": vs.titles[i], "source_type": vs.types[i],
                "dataset": vs.names[i], "similarity": round(float(sims[i]), 4)}

    verdict: dict
    if mode == "query":
        b = own_sorted[0]
        s1 = float(sims[b])
        s2 = float(sims[own_sorted[1]]) if len(own_sorted) > 1 else -1
        comp_best = item(comp_sorted[0]) if comp_sorted else None
        contenders = [item(i) for i in own_sorted[:6] if float(sims[i]) >= max(th["gap"], s1 - th["cannibal_margin"])]
        if s1 >= th["strong"]:
            if s2 >= th["gap"] and s1 - s2 <= th["cannibal_margin"]:
                verdict = {"status": "contested", "headline": f"Two pages compete: {_short(vs.urls[b])} and {_short(vs.urls[own_sorted[1]])}",
                           "text": (f"Both score within {th['cannibal_margin']:.3f} of each other ({s1:.3f} vs {s2:.3f}). Pick one as the primary page "
                                    "for this query, refocus the other, and link it to the primary.")}
            else:
                verdict = {"status": "covered", "headline": f"Covered by {_short(vs.urls[b])} ({s1:.3f})",
                           "text": "This page clearly targets the query. Protect it: keep it linked from its topic hub and check its passages in the Lab."}
        elif s1 >= th["gap"]:
            verdict = {"status": "partial", "headline": f"Under-optimized: best page is {_short(vs.urls[b])} ({s1:.3f})",
                       "text": (f"Nothing clears {th['strong']:.2f}. Optimize {_short(vs.urls[b])}: add a passage that answers the query directly, "
                                "then re-score in the Lab.")}
        else:
            verdict = {"status": "gap", "headline": f"Not covered: closest page is {_short(vs.urls[b])} ({s1:.3f})",
                       "text": f"Nothing on the site answers this. Create a page (or a section on {_short(vs.urls[b])}) and link to it from there."}
        if comp_best and comp_best["similarity"] > s1:
            verdict["text"] += f" {comp_best['dataset']} scores higher ({comp_best['similarity']:.3f}) with {_short(comp_best['url'])}."
        verdict.update({"best_url": vs.urls[b], "contenders": contenders, "competitor": comp_best})
    else:
        src_url = vs.urls[pos[page_id]]
        dups = [item(i) for i in own_sorted if float(sims[i]) >= th["dup"]]
        link_c = [dict(item(i), linked_out=vs.urls[i] in linked[src_url], linked_in=src_url in linked[vs.urls[i]])
                  for i in own_sorted if th["link_min"] <= float(sims[i]) < th["dup"]][:12]
        missing = [x for x in link_c if not x["linked_out"] and not x["linked_in"]]
        parts = []
        if dups:
            parts.append(f"{len(dups)} near-duplicate page{'s' if len(dups) > 1 else ''} (e.g. {_short(dups[0]['url'])}); consolidate.")
        if missing:
            parts.append(f"{len(missing)} closely related page{'s' if len(missing) > 1 else ''} with no link either way; link them"
                         f"{' (the link graph is not loaded, so verify)' if not linked else ''}.")
        verdict = {"status": "page", "headline": f"Neighborhood of {_short(src_url)}",
                   "text": " ".join(parts) or "No near-duplicates, and its closest pages are already linked.",
                   "duplicates": dups, "link_candidates": link_c}

    return {"mode": mode, "label": label, "dim": vs.dim, "thresholds": th, "rings": rings, "verdict": verdict,
            "points": [item(i) for i in idx[:600]]}


# ---------------------------------------------------------------------------
# Link health
# ---------------------------------------------------------------------------
def link_health(project_id: int, kind: str = "internal") -> dict:
    vs, links, own, kws, comps, th = _ctx(project_id, include_external=(kind == "external"))
    M = vs.matrix
    url_idx: dict[str, int] = {}
    for i, u in enumerate(vs.urls):
        url_idx.setdefault(u, i)
    own_set = {vs.urls[i] for i in own}
    rows = [lr for lr in links if lr["link_type"] == kind]
    if not rows:
        return {"kind": kind, "pages": [], "summary": {"links": 0}, "thresholds": th,
                "message": ("Upload a Screaming Frog 'All Inlinks' export to analyze internal links." if kind == "internal"
                            else "Upload a backlinks export (e.g. Ahrefs) to analyze external links.")}

    kw_ok = bool(kws and own) and {vs.models[i] for i in kws} == {vs.models[i] for i in own}
    best_for: Counter = Counter()
    partial_for: Counter = Counter()
    if kw_ok:
        KO = M[kws] @ M[own].T
        bp, bs = KO.argmax(axis=1), KO.max(axis=1)
        for k in range(len(kws)):
            if bs[k] >= th["gap"]:
                best_for[vs.urls[own[int(bp[k])]]] += 1
                if bs[k] < th["strong"]:
                    partial_for[vs.urls[own[int(bp[k])]]] += 1

    rels = []
    by_target: dict[str, list] = defaultdict(list)
    for lr in rows:
        s, t = lr["source_url"], lr["target_url"]
        if t not in own_set or s == t:
            continue
        rel = float(M[url_idx[s]] @ M[url_idx[t]]) if s in url_idx and t in url_idx else None
        if rel is not None:
            rels.append(rel)
        by_target[t].append({"source_url": s, "anchor": lr["anchor_text"] or "", "relevance": round(rel, 4) if rel is not None else None})
    if not rels:
        return {"kind": kind, "pages": [], "summary": {"links": len(rows)}, "thresholds": th,
                "message": "Links were imported but their pages have no vectors yet; re-embed the project."}
    weak_cut = float(np.percentile(rels, 15)) if kind == "external" else th["weak_link"]
    good_cut = float(np.percentile(rels, 60)) if kind == "external" else th["link_min"]

    # Relevant pages that don't link (internal only): top neighbors above link_min.
    suggestions: dict[str, list] = {}
    if kind == "internal" and len(own) > 1:
        O = M[own]
        PP = O @ O.T
        np.fill_diagonal(PP, -1)
        linked = defaultdict(set)
        for lr in rows:
            linked[lr["target_url"]].add(lr["source_url"])
        for j, i in enumerate(own):
            t = vs.urls[i]
            cands = [k for k in np.argsort(-PP[:, j])[:12] if PP[k, j] >= th["link_min"] and vs.urls[own[k]] not in linked[t]]
            suggestions[t] = [{"source_url": vs.urls[own[k]], "title": vs.titles[own[k]], "similarity": round(float(PP[k, j]), 4)}
                              for k in cands[:5]]

    pages = []
    targets = set(by_target) | ({vs.urls[i] for i in own} if kind == "internal" else set())
    for t in targets:
        items = by_target.get(t, [])
        r = [x["relevance"] for x in items if x["relevance"] is not None]
        n_src = len({x["source_url"] for x in items})
        weak = sum(1 for x in r if x < weak_cut)
        good = sum(1 for x in r if x >= good_cut)
        anchors = Counter(x["anchor"].strip().lower() for x in items if x["anchor"].strip())
        sugg = suggestions.get(t, [])
        q, qp = best_for.get(t, 0), partial_for.get(t, 0)
        if kind == "internal":
            if n_src == 0:
                status, sev, text = "Orphan", "high", ("No internal links point here" + (f", yet it's the best page for {q} queries" if q else "")
                                                      + (f". Link it from {_short(sugg[0]['source_url'])}." if sugg else "."))
            elif q and good < 2 and sugg:
                status, sev, text = "Under-linked", "medium", (f"Best page for {q} quer{'y' if q == 1 else 'ies'} ({qp} under-optimized) but only {good} "
                                                               f"relevant page{'s' if good != 1 else ''} link here. Add links from {_short(sugg[0]['source_url'])}"
                                                               + (f" and {len(sugg) - 1} more" if len(sugg) > 1 else "") + ".")
            elif r and weak / len(r) > 0.5 and len(r) >= 4:
                status, sev, text = "Diluted", "low", (f"{weak} of {len(r)} inbound links come from unrelated pages. Keep navigation links; "
                                                       "replace contextual ones with links from related pages.")
            elif sugg and len(sugg) >= 3:
                status, sev, text = "Missing related links", "low", f"{len(sugg)} closely related pages don't link here yet, e.g. {_short(sugg[0]['source_url'])}."
            else:
                status, sev, text = "Healthy", "none", "Linked from related pages."
        else:
            if q and good == 0:
                status, sev, text = "Priority, no topical backlinks", "high", (f"Best page for {q} queries but none of its {n_src} linking pages are "
                                                                               "topically close. Target outreach at sites covering this page's topic.")
            elif r and weak / len(r) > 0.5:
                status, sev, text = "Mostly off-topic backlinks", "low", f"{weak} of {len(r)} backlinks come from pages unrelated to this one."
            else:
                status, sev, text = "Topical backlinks", "none", f"{good} of {len(r)} backlinks come from closely related pages."
        pages.append({
            "url": t, "title": vs.titles[url_idx[t]] if t in url_idx else _short(t),
            "inbound": len(items), "sources": n_src, "avg_relevance": round(float(np.mean(r)), 4) if r else None,
            "weak": weak, "relevant": good, "queries": q, "partial_queries": qp,
            "top_anchors": [{"anchor": a, "count": c} for a, c in anchors.most_common(5)],
            "status": status, "severity": sev, "text": text,
            "links": sorted(items, key=lambda x: (x["relevance"] is None, x["relevance"] or 0))[:60],
            "suggested_sources": sugg,
        })
    sev_rank = {"high": 0, "medium": 1, "low": 2, "none": 3}
    pages.sort(key=lambda p: (sev_rank[p["severity"]], -p["queries"], -p["inbound"]))
    return {
        "kind": kind, "dim": vs.dim, "thresholds": th, "weak_cut": round(weak_cut, 4), "good_cut": round(good_cut, 4),
        "summary": {"links": len(rows), "scored": len(rels), "targets": len(pages),
                    "avg_relevance": round(float(np.mean(rels)), 4),
                    "status_counts": dict(Counter(p["status"] for p in pages))},
        "pages": pages,
    }


# ---------------------------------------------------------------------------
# Link placement + passage comparison (fetch page text, score passages)
# ---------------------------------------------------------------------------
_SENT = re.compile(r"(?<=[.!?])\s+")


def link_placement(project_id: int, source_url: str, target_url: str, anchor: str) -> dict:
    from services.lab import _cached, get_page_text, project_dim
    from services.passages import passage_embedding_text, split_passages

    dim = project_dim(project_id)
    s_title, s_body, _ = get_page_text(project_id, source_url)
    if not s_body:
        return {"error": f"Couldn't get the text of {source_url}."}
    t_title, t_body, _ = get_page_text(project_id, target_url)
    ps = split_passages(s_body)
    if not ps:
        return {"error": "The source page has no usable passages."}
    pv = truncate(_cached("d", [passage_embedding_text(p) for p in ps], s_title), dim)
    qv = truncate(_cached("q", [anchor or t_title]), dim)[0]
    tv = truncate(_cached("d", [t_body or t_title], t_title), dim)[0]
    score = 0.5 * (pv @ qv) + 0.5 * (pv @ tv)
    order = np.argsort(-score)[:3]
    already = anchor and anchor.lower() in s_body.lower()
    best = ps[int(order[0])]
    sents = [x for x in _SENT.split(best["text"].replace("\n", " ")) if len(x.split()) >= 5] or [best["text"]]
    sv = truncate(_cached("q", sents), dim) if len(sents) > 1 else None
    sent = sents[int(np.argmax(sv @ tv))] if sv is not None else sents[0]
    return {
        "source_url": source_url, "target_url": target_url, "anchor": anchor,
        "anchor_already_on_page": bool(already),
        "sentence": sent,
        "passages": [{"index": int(i), "heading": ps[int(i)]["heading"], "text": ps[int(i)]["text"],
                      "score": round(float(score[int(i)]), 4)} for i in order],
        "advice": ("The anchor phrase already appears on the page; link that occurrence." if already else
                   f"Add the link in §{int(order[0]) + 1}" + (f" (\"{best['heading']}\")" if best["heading"] else "")
                   + ", ideally by rewording the sentence below so the anchor reads naturally."),
    }


def compare_passages(project_id: int, url_a: str, url_b: str) -> dict:
    from services.lab import _cached, get_page_text, project_dim
    from services.passages import passage_embedding_text, split_passages

    dim = project_dim(project_id)
    a_title, a_body, _ = get_page_text(project_id, url_a)
    b_title, b_body, _ = get_page_text(project_id, url_b)
    if not a_body or not b_body:
        return {"error": "Couldn't get the text of one of the pages."}
    pa, pb = split_passages(a_body), split_passages(b_body)
    va = truncate(_cached("d", [passage_embedding_text(p) for p in pa], a_title), dim)
    vb = truncate(_cached("d", [passage_embedding_text(p) for p in pb], b_title), dim)
    S = va @ vb.T
    flat = np.dstack(np.unravel_index(np.argsort(-S.ravel()), S.shape))[0]
    pairs, used_a, used_b = [], set(), set()
    for i, j in flat:
        if i in used_a or j in used_b:
            continue
        pairs.append((int(i), int(j), float(S[i, j])))
        used_a.add(i); used_b.add(j)
        if len(pairs) >= 8:
            break
    within = np.concatenate([(va @ va.T)[np.triu_indices(len(pa), 1)], (vb @ vb.T)[np.triu_indices(len(pb), 1)]])
    dup_cut = float(max(np.percentile(within, 95), 0.85)) if len(within) else 0.9
    best_a, best_b = S.max(axis=1), S.max(axis=0)
    uniq_cut = float(np.percentile(S, 50))

    def p(ps, i):
        return {"index": i, "heading": ps[i]["heading"], "text": ps[i]["text"]}

    overlap = [dict(a=p(pa, i), b=p(pb, j), similarity=round(s, 4), duplicate=s >= dup_cut) for i, j, s in pairs]
    return {
        "a": {"url": url_a, "title": a_title, "passages": len(pa)}, "b": {"url": url_b, "title": b_title, "passages": len(pb)},
        "dup_cut": round(dup_cut, 4), "overlap": overlap,
        "unique_a": [dict(p(pa, int(i)), best=round(float(best_a[i]), 4)) for i in np.argsort(best_a)[:4] if best_a[i] < uniq_cut],
        "unique_b": [dict(p(pb, int(j)), best=round(float(best_b[j]), 4)) for j in np.argsort(best_b)[:4] if best_b[j] < uniq_cut],
        "duplicate_share_a": round(float((best_a >= dup_cut).mean()), 3),
        "duplicate_share_b": round(float((best_b >= dup_cut).mean()), 3),
    }


# ---------------------------------------------------------------------------
# Intersection verdict
# ---------------------------------------------------------------------------
def compare_pages(project_id: int, id_a: int, id_b: int) -> dict:
    vs, links, own, kws, comps, th = _ctx(project_id)
    pos = {pid: i for i, pid in enumerate(vs.ids)}
    if id_a not in pos or id_b not in pos:
        return {"error": "Pick two embedded items."}
    M = vs.matrix
    a, b = pos[id_a], pos[id_b]
    sim = float(M[a] @ M[b])

    def ent(i):
        return {"id": vs.ids[i], "url": vs.urls[i], "title": vs.titles[i], "source_type": vs.types[i]}

    ta, tb = vs.types[a], vs.types[b]
    nb = lambda i: [dict(ent(k), similarity=round(float(M[i] @ M[k]), 4)) for k in np.argsort(-(M @ M[i])) if k != i][:5]  # noqa: E731
    out = {"similarity": round(sim, 4), "entity_a": ent(a), "entity_b": ent(b), "neighbors_a": nb(a), "neighbors_b": nb(b),
           "thresholds": th, "dim": vs.dim}
    if "keyword" in (ta, tb):
        q, pg = (a, b) if ta == "keyword" else (b, a)
        if vs.types[pg] == "keyword":
            out["verdict"] = {"label": "Two queries", "text": f"Query-to-query similarity {sim:.3f}. Similar queries can usually share one page."}
            return out
        band = "covered" if sim >= th["strong"] else ("partial" if sim >= th["gap"] else "missing")
        out["verdict"] = {"label": {"covered": "Page targets this query", "partial": "Related, not targeted", "missing": "Doesn't answer it"}[band],
                          "text": f"{sim:.3f} against strong {th['strong']:.2f} / gap {th['gap']:.2f}. Open it in the Lab to see which passages carry the query.",
                          "band": band}
        out["lab"] = {"queries": [vs.titles[q]], "url": vs.urls[pg]}
        return out
    shared = []
    if kws:
        K = M[kws]
        sa, sb = K @ M[a], K @ M[b]
        others = M[own] @ K.T
        for k in range(len(kws)):
            top = float(others[:, k].max())
            if max(sa[k], sb[k]) >= th["gap"] and abs(sa[k] - sb[k]) <= th["cannibal_margin"] * 2 and max(sa[k], sb[k]) >= top - 1e-6:
                shared.append({"keyword": vs.titles[kws[k]], "a": round(float(sa[k]), 4), "b": round(float(sb[k]), 4)})
        shared.sort(key=lambda x: -max(x["a"], x["b"]))
    if sim >= th["dup"]:
        v = {"label": "Near-duplicates", "text": f"{sim:.3f} ≥ {th['dup']:.2f}. Retrieval treats these as the same document. Merge them or make each distinct; compare passages to see which sections overlap."}
    elif shared:
        v = {"label": "Competing for the same queries", "text": f"Both pages are the top candidates for {len(shared)} queries within a hair of each other. Assign each query to one page."}
    elif sim >= th["link_min"]:
        v = {"label": "Closely related", "text": f"{sim:.3f} is in the site's top 10% of page pairs. They should link to each other."}
    else:
        v = {"label": "Distinct", "text": "Different enough to coexist without cannibalizing each other."}
    linked_ab = any(lr["source_url"] == vs.urls[a] and lr["target_url"] == vs.urls[b] for lr in links)
    linked_ba = any(lr["source_url"] == vs.urls[b] and lr["target_url"] == vs.urls[a] for lr in links)
    out.update({"verdict": v, "shared_queries": shared[:25], "linked": {"a_to_b": linked_ab, "b_to_a": linked_ba}})
    return out

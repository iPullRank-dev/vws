"""Link graph with relevance scoring.

Every link is scored by how related its two pages are (cosine similarity of
their vectors) and banded against this site's own page pairs:

  relevant   more similar than 85% of page pairs on the site
  weak       between the median pair and that
  off-topic  less similar than the median pair (a random pair would do as well)

Links are split three ways, and only editorial links are scored:
  sitewide   nav/footer: the target is linked from at least half of all linking pages
  template   from an archive/listing page (blog index, author, category, tag) or to
             one (bylines, category tags): they follow dates and authors, not topics
  editorial  everything else: the links someone chose to put in the content

Graph-level score (0-100), equity-weighted with PageRank:

  score = (W - B) / (I - B)
  W  equity-weighted mean similarity of in-content links (each source counts by
     its PageRank)
  B  mean similarity of all page pairs (what linking at random would give)
  I  the same if every source linked to its k most similar pages instead
     (k = its in-content link count)

0 means in-content links are no more relevant than random; 100 means every
link goes to the source's most related pages.
"""
from __future__ import annotations

import json
from functools import lru_cache
from collections import Counter, defaultdict
from urllib.parse import urlparse

import numpy as np

from services.analysis import load_links
from services.database import get_db
from services.structure import build_structure
from services.vectors import load_project_vectors

SITEWIDE_SHARE = 0.5
BAND_ORDER = ("relevant", "weak", "off_topic")

# How much a backlink counts (its "value"), from the linking page's numbers in the
# backlink export. Authority: the linking page's referring domains (log scale, 1,000
# = full) blended with its site's DR. Quality: whether the linking page has search
# visibility, i.e. page traffic and ranking keywords (log scale, 10,000 visits /
# 1,000 keywords = full). Floors keep a page with no traffic from counting as zero.
BACKLINK_WEIGHTS = {
    "authority": "0.5 x log(referring domains of the linking page, 1,000 = 1) + 0.5 x DR/100",
    "quality": "0.5 x log(page traffic, 10,000 = 1) + 0.5 x log(keywords, 1,000 = 1)",
    "value": "(0.2 + 0.8 x authority) x (0.4 + 0.6 x quality) x follow (1 followed, 0.3 nofollow/UGC/sponsored, 0 spam)",
}
VIS_ORDER = {"none": 0, "ranks": 1, "traffic": 2}


def _log01(x, top: float) -> float:
    return float(min(1.0, np.log1p(max(0.0, float(x or 0))) / np.log1p(top)))


def score_backlinks(rows: list[dict], P: np.ndarray, vec_of: dict, content_cols: np.ndarray, band, rel_hi: float,
                    urls: list[str], no_suggest: set | None = None) -> dict:
    """Adds authority / quality / value to each backlink row and scores how well the
    backlinks land, 0-100, the same way as internal links: W = value-weighted mean
    similarity of each linking page to the page it links to; B = the same linking
    pages pointed at random pages of yours; I = each pointed at its most related page."""
    for r in rows:
        dr, rd = r.get("dr"), r.get("rd")
        auth = min(1.0, (dr or 0) / 100) if rd is None else 0.5 * _log01(rd, 1000) + 0.5 * min(1.0, (dr or 0) / 100)
        tr, kw = r.get("traffic"), r.get("kw")
        qual = None if tr is None and kw is None else 0.5 * _log01(tr, 10000) + 0.5 * _log01(kw, 1000)
        r["vis"] = None if qual is None else ("traffic" if (tr or 0) > 0 else "ranks" if (kw or 0) > 0 else "none")
        follow = 0.0 if r.get("spam") else (0.3 if r.get("nofollow") else 1.0)
        r["auth"] = round(auth, 3)
        r["qual"] = None if qual is None else round(qual, 3)
        r["w"] = round((0.2 + 0.8 * auth) * (0.4 + 0.6 * (0.5 if qual is None else qual)) * follow, 4)
    # A domain counts once, at its strongest link: 5,000 links from one blog network
    # weigh what its best link weighs, spread over all of them ("ew" = effective weight).
    dmax: dict[str, float] = defaultdict(float)
    dsum: dict[str, float] = defaultdict(float)
    for r in rows:
        dmax[r["domain"]] = max(dmax[r["domain"]], r["w"])
        dsum[r["domain"]] += r["w"]
    for r in rows:
        r["ew"] = r["w"] * dmax[r["domain"]] / dsum[r["domain"]] if dsum[r["domain"]] else 0.0

    cols = np.where(content_cols)[0] if content_cols.any() else np.arange(P.shape[0])
    # Brand links to the home page, nav pages (about, contact) and archives are normal;
    # no "better page" suggestion for those.
    skip = set(no_suggest or ()) | {j for j, u in enumerate(urls) if urlparse(u).path.strip("/") == "" or not content_cols[j]}
    srcs = sorted({_norm(r["source"]) for r in rows if r["sim"] is not None and _norm(r["source"]) in vec_of})
    stats = {}
    if srcs:
        S = np.vstack([vec_of[k] for k in srcs]) @ P[cols].T
        best = S.argmax(1)
        for i, k in enumerate(srcs):
            stats[k] = (float(S[i].mean()), float(S[i, best[i]]), int(cols[best[i]]))
    W = B = I = wsum = 0.0
    for r in rows:
        st = stats.get(_norm(r["source"]))
        if r["sim"] is None or st is None:
            continue
        mean_s, max_s, bj = st
        r["_b"], r["_i"] = mean_s, max(max_s, r["sim"])  # per-page scores reuse these
        if (bj != r["t"] and r["band"] != "relevant" and max_s >= rel_hi and max_s - r["sim"] >= 0.03
                and r["t"] not in skip):
            # The linking page is closer to another page of yours than to the one it links to.
            r["better"] = {"url": urls[bj], "sim": round(max_s, 4)}
        if r["ew"] <= 0:
            continue
        W += r["ew"] * r["sim"]
        B += r["ew"] * mean_s
        I += r["ew"] * max(max_s, r["sim"])
        wsum += r["ew"]
    if not wsum:
        return {"value": None, "links": 0}
    W, B, I = W / wsum, B / wsum, I / wsum
    value = float(np.clip((W - B) / (I - B), 0, 1) * 100) if I - B > 1e-6 else None
    return {"value": None if value is None else round(value, 1), "weighted_sim": round(W, 4), "baseline_sim": round(B, 4),
            "ideal_sim": round(I, 4), "links": sum(1 for r in rows if r["sim"] is not None and r["w"] > 0),
            "domains": len({r["domain"] for r in rows if r["sim"] is not None and r["w"] > 0})}
# Archive / listing pages link by date or author, not by topic: links from them,
# and byline/category links to them, are template links, not editorial choices.
_ARCHIVE = {"author", "authors", "category", "categories", "tag", "tags", "page", "topics", "topic"}
_INDEX_PATHS = {"/blog", "/news", "/articles", "/resources", "/insights", "/posts", "/learn"}


def _is_archive(u: str) -> bool:
    try:
        path = urlparse(u).path.rstrip("/").lower()
    except Exception:
        return False
    seg = [x for x in path.split("/") if x]
    return bool(seg) and (seg[0] in _ARCHIVE or path in _INDEX_PATHS or (len(seg) >= 2 and seg[-2] == "page" and seg[-1].isdigit()))


def _host(u: str) -> str:
    try:
        h = urlparse(u).netloc.lower()
    except Exception:
        return ""
    return h[4:] if h.startswith("www.") else h


def _short(u: str) -> str:
    try:
        p = urlparse(u)
        return (p.path or "/") + (f"?{p.query}" if p.query else "")
    except Exception:
        return u


@lru_cache(maxsize=200_000)
def _norm(u: str) -> str:
    # www-, scheme- and trailing-slash-insensitive: backlink tools report URL
    # variants (www., http://) that the crawl stored differently.
    from services.ingestion import url_key
    return url_key(u)


def _own(h: str, own_host: str) -> bool:
    return bool(h) and (h == own_host or h.endswith("." + own_host))


def _pagerank(n: int, edges: list[tuple[int, int]], d: float = 0.85, iters: int = 100) -> np.ndarray:
    if n == 0:
        return np.zeros(0)
    out_deg = np.zeros(n)
    for s, _ in edges:
        out_deg[s] += 1
    pr = np.full(n, 1.0 / n)
    src = np.array([s for s, _ in edges], dtype=int)
    tgt = np.array([t for _, t in edges], dtype=int)
    for _ in range(iters):
        new = np.full(n, (1 - d) / n)
        if len(src):
            np.add.at(new, tgt, d * pr[src] / out_deg[src])
        new += d * pr[out_deg == 0].sum() / n          # dangling pages spread evenly
        if np.abs(new - pr).sum() < 1e-10:
            pr = new
            break
        pr = new
    return pr / pr.sum()


def build_link_graph(project_id: int, dim: int | None = None) -> dict:
    s = build_structure(project_id, dim)
    if s.get("error"):
        return {"error": s["error"]}
    dim = s["dim"]
    pages = s["pages"]
    n = len(pages)

    conn = get_db()
    vs = load_project_vectors(conn, project_id, dim, include_external=True)
    links = load_links(conn, project_id)
    # How each referring page was scored: its fetched page, or its title + link context.
    basis_of = {_norm(r["url"]): ("page" if "fetched" in (r["source_name"] or "") else "context")
                for r in conn.execute("SELECT url, source_name FROM pages WHERE project_id = ? AND source_type = 'external_link'",
                                      (project_id,)).fetchall()}
    conn.close()

    vec_of = {}
    for i, u in enumerate(vs.urls):
        if vs.types[i] != "keyword":
            vec_of.setdefault(_norm(u), vs.matrix[i])
    idx = {_norm(p["url"]): j for j, p in enumerate(pages)}
    P = np.vstack([vec_of[_norm(p["url"])] for p in pages])
    PP = P @ P.T
    np.fill_diagonal(PP, np.nan)
    pairs = PP[np.triu_indices(n, 1)]
    rel_hi = float(np.nanpercentile(pairs, 85))
    rel_lo = float(np.nanpercentile(pairs, 50))
    baseline = float(np.nanmean(pairs))

    def band(sim: float | None) -> str | None:
        if sim is None:
            return None
        return "relevant" if sim >= rel_hi else ("weak" if sim >= rel_lo else "off_topic")

    own_host = Counter(_host(p["url"]) for p in pages).most_common(1)[0][0]

    # --- classify links ---------------------------------------------------------
    internal: list[tuple[int, int, str]] = []
    inbound_ext: list[dict] = []
    outbound_ext: list[dict] = []
    uncrawled: dict[str, dict] = {}
    seen = set()
    for lr in links:
        su, tu = lr["source_url"] or "", lr["target_url"] or ""
        a = (lr["anchor_text"] or "").strip()
        sj, tj = idx.get(_norm(su)), idx.get(_norm(tu))
        if sj is not None and tj is not None:
            if sj != tj and (sj, tj) not in seen:
                seen.add((sj, tj))
                internal.append((sj, tj, a))
        elif tj is not None and not _own(_host(su), own_host):
            v = vec_of.get(_norm(su))
            sim = float(v @ P[tj]) if v is not None else None
            try:
                m = json.loads(lr["meta"]) if lr["meta"] else {}
            except Exception:
                m = {}
            inbound_ext.append({"source": su, "domain": _host(su), "target": pages[tj]["url"], "t": tj, "anchor": a,
                                "sim": None if sim is None else round(sim, 4), "band": band(sim),
                                "dr": m.get("dr"), "rd": m.get("rd"), "traffic": m.get("traffic"), "kw": m.get("kw"),
                                "nofollow": bool(m.get("nofollow") or m.get("ugc") or m.get("sponsored")) if "nofollow" in m else None,
                                "spam": m.get("spam"), "in_content": m.get("in_content"), "basis": basis_of.get(_norm(su))})
        elif tj is None and lr["link_type"] == "external" and not _own(_host(su), own_host) and _own(_host(tu), own_host):
            # A backlink to one of your URLs that isn't in this crawl.
            u = uncrawled.setdefault(_norm(tu), {"url": tu, "backlinks": 0, "domains": set()})
            u["backlinks"] += 1
            u["domains"].add(_host(su))
        elif sj is not None and _host(tu) and _host(tu) != own_host:
            v = vec_of.get(_norm(tu))
            sim = float(P[sj] @ v) if v is not None else None
            outbound_ext.append({"source": pages[sj]["url"], "target": tu, "domain": _host(tu), "anchor": a,
                                 "sim": None if sim is None else round(sim, 4), "band": band(sim)})

    # --- sitewide (nav/footer) vs in-content --------------------------------------
    linking_sources = {s_ for s_, _, _ in internal}
    n_src = max(1, len(linking_sources))
    in_sources: dict[int, set] = defaultdict(set)
    for s_, t, _ in internal:
        in_sources[t].add(s_)
    sitewide_targets = {t for t, ss in in_sources.items() if len(ss) >= SITEWIDE_SHARE * n_src and n_src >= 10}

    archive = [_is_archive(p["url"]) for p in pages]
    edges = []
    for s_, t, a in internal:
        sim = float(PP[s_, t])
        kind = "sitewide" if t in sitewide_targets else ("template" if archive[s_] or archive[t] else "editorial")
        edges.append({"s": s_, "t": t, "anchor": a, "sim": round(sim, 4), "band": band(sim), "kind": kind,
                      "sitewide": kind == "sitewide"})

    # --- equity -------------------------------------------------------------------
    pr = _pagerank(n, [(e["s"], e["t"]) for e in edges])
    ctx = [e for e in edges if e["kind"] == "editorial"]
    ctx_out = Counter(e["s"] for e in ctx)
    all_out = Counter(e["s"] for e in edges)
    for e in edges:
        # Equity a link passes: the source's PageRank split over all its links.
        e["flow"] = float(pr[e["s"]] / all_out[e["s"]]) if all_out[e["s"]] else 0.0

    # graph score
    W_num = W_den = I_num = 0.0
    by_src: dict[int, list[float]] = defaultdict(list)
    for e in ctx:
        by_src[e["s"]].append(e["sim"])
    for s_, sims in by_src.items():
        k = len(sims)
        row = np.nan_to_num(PP[s_], nan=-1.0)
        top = np.sort(row)[::-1][:k]
        W_num += pr[s_] * float(np.mean(sims))
        I_num += pr[s_] * float(np.mean(top))
        W_den += pr[s_]
    W = W_num / W_den if W_den else None
    I = I_num / W_den if W_den else None
    score = None
    if W is not None and I is not None and I - baseline > 1e-6:
        score = float(np.clip((W - baseline) / (I - baseline), 0, 1) * 100)

    band_counts = Counter(e["band"] for e in ctx)
    flow_total = sum(e["flow"] for e in ctx) or 1.0
    band_equity = {b: round(sum(e["flow"] for e in ctx if e["band"] == b) / flow_total, 4) for b in BAND_ORDER}

    # --- backlinks: authority, quality and relevance to the page each one links to ---
    content_cols = np.array([not _is_archive(p["url"]) for p in pages]) if n else np.zeros(0, bool)
    bl = score_backlinks(inbound_ext, P, vec_of, content_cols, band, rel_hi, [p["url"] for p in pages], sitewide_targets)
    internal_value = score
    overall = None
    if internal_value is not None and bl["value"] is not None:
        overall = (internal_value + bl["value"]) / 2  # internal structure and backlinks weighted equally
    elif internal_value is not None:
        overall = internal_value
    elif bl["value"] is not None:
        overall = bl["value"]

    # --- per page --------------------------------------------------------------------
    inbound: dict[int, list[dict]] = defaultdict(list)
    outbound: dict[int, list[dict]] = defaultdict(list)
    for e in edges:
        inbound[e["t"]].append(e)
        outbound[e["s"]].append(e)
    rank = {j: r + 1 for r, j in enumerate(np.argsort(-pr))}

    def _rel(W: float, B: float, I: float) -> float | None:
        return None if I - B <= 1e-6 else round(float(np.clip((W - B) / (I - B), 0, 1) * 100), 1)

    content_idx = np.where(content_cols)[0] if content_cols.any() else np.arange(n)

    def page_scores(j: int) -> dict:
        """0-100 per page, same scale as the site score: 0 = no better than random
        pages, 100 = the most related pages. In: editorial links into the page
        (weighted by equity); out: its editorial links; backlinks: linking pages
        vs this page (weighted by value)."""
        out = {"in": None, "out": None, "backlinks": None}
        col = PP[content_idx, j]
        col = col[~np.isnan(col)]
        ins = [e for e in inbound[j] if e["kind"] == "editorial"]
        if ins and len(col):
            f = sum(e["flow"] for e in ins)
            W = sum(e["flow"] * e["sim"] for e in ins) / f if f > 0 else float(np.mean([e["sim"] for e in ins]))
            out["in"] = _rel(W, float(col.mean()), float(np.sort(col)[::-1][:len(ins)].mean()))
        outs = [e for e in outbound[j] if e["kind"] == "editorial"]
        row = PP[j, content_idx]
        row = row[~np.isnan(row)]
        if outs and len(row):
            out["out"] = _rel(float(np.mean([e["sim"] for e in outs])), float(row.mean()), float(np.sort(row)[::-1][:len(outs)].mean()))
        bl_rows = [r for r in by_target_all.get(j, []) if "_b" in r and r["ew"] > 0]
        if bl_rows:
            w = sum(r["ew"] for r in bl_rows)
            out["backlinks"] = _rel(sum(r["ew"] * r["sim"] for r in bl_rows) / w, sum(r["ew"] * r["_b"] for r in bl_rows) / w,
                                    sum(r["ew"] * r["_i"] for r in bl_rows) / w)
        parts = [v for v in out.values() if v is not None]
        out["score"] = round(float(np.mean(parts)), 1) if parts else None
        return out

    by_target_all: dict[int, list[dict]] = defaultdict(list)
    for r in inbound_ext:
        by_target_all[r["t"]].append(r)
    nodes = []
    for j, p in enumerate(pages):
        ins = [e for e in inbound[j] if e["kind"] == "editorial"]
        f_all = sum(e["flow"] for e in ins)
        f_rel = sum(e["flow"] for e in ins if e["band"] == "relevant")
        nodes.append({
            "id": j, "url": p["url"], "path": _short(p["url"]), "title": p["title"], "cluster": p["cluster"],
            "cluster_label": p["cluster_label"], "zone": p["zone"], "x": p["x"], "y": p["y"],
            "pr": round(float(pr[j]), 6), "pr_rank": rank[j],
            "in_ctx": len(ins), "out_ctx": sum(1 for e in outbound[j] if e["kind"] == "editorial"),
            "in_sitewide": sum(1 for e in inbound[j] if e["kind"] == "sitewide"),
            "in_template": sum(1 for e in inbound[j] if e["kind"] == "template"),
            "archive": archive[j],
            "in_bands": {b: sum(1 for e in ins if e["band"] == b) for b in BAND_ORDER},
            "relevant_equity_share": round(f_rel / f_all, 4) if f_all > 0 else None,
            "sitewide_target": j in sitewide_targets,
            "queries": p["query_counts"]["strong"] + p["query_counts"]["partial"],
            "link_score": page_scores(j),
        })

    # --- what to fix -----------------------------------------------------------------------
    def best_new_targets(s_: int, k: int = 1) -> list[dict]:
        linked = {e["t"] for e in outbound[s_]}
        order = np.argsort(-np.nan_to_num(PP[s_], nan=-1.0))
        out = []
        for t in order:
            t = int(t)
            if t == s_ or t in linked or t in sitewide_targets or archive[t]:
                continue
            out.append({"url": pages[t]["url"], "sim": round(float(PP[s_, t]), 4)})
            if len(out) >= k:
                break
        return out

    def best_new_sources(t: int, k: int = 3) -> list[dict]:
        linked = {e["s"] for e in inbound[t]}
        order = np.argsort(-np.nan_to_num(PP[:, t], nan=-1.0))
        out = []
        for s_ in order:
            s_ = int(s_)
            if s_ == t or s_ in linked or archive[s_]:
                continue
            out.append({"url": pages[s_]["url"], "sim": round(float(PP[s_, t]), 4)})
            if len(out) >= k:
                break
        return out

    # Off-topic links, grouped by source page: 4+ from one page is usually a menu or
    # template block on that page, fixed once rather than link by link.
    off_by_src: dict[int, list[dict]] = defaultdict(list)
    for e in sorted([e for e in ctx if e["band"] == "off_topic"], key=lambda e: -e["flow"]):
        off_by_src[e["s"]].append(e)
    off_links = []
    for s_, group in sorted(off_by_src.items(), key=lambda kv: -sum(e["flow"] for e in kv[1])):
        if len(group) >= 4:
            off_links.append({"source": pages[s_]["url"], "target": None, "block": len(group),
                              "targets": [pages[e["t"]]["url"] for e in group][:12],
                              "anchors": [e["anchor"] for e in group if e["anchor"]][:12],
                              "sim": round(float(np.mean([e["sim"] for e in group])), 4),
                              "equity": round(sum(e["flow"] for e in group) * 100 / flow_total, 3), "instead": None})
            continue
        alts = best_new_targets(s_, k=len(group))
        for i, e in enumerate(group):
            off_links.append({"source": pages[s_]["url"], "target": pages[e["t"]]["url"], "anchor": e["anchor"], "sim": e["sim"],
                              "equity": round(e["flow"] * 100 / flow_total, 3), "block": 0,
                              "instead": alts[i] if i < len(alts) else None})
    off_links.sort(key=lambda o: -o["equity"])
    off_links = off_links[:60]

    starved = []
    for nd in nodes:
        j = nd["id"]
        important = nd["queries"] > 0 or nd["zone"] in ("Core", "Focus")
        if not important or nd["sitewide_target"] or nd["archive"]:
            continue
        share = nd["relevant_equity_share"]
        if nd["in_bands"]["relevant"] == 0 or (share is not None and share < 0.3):
            starved.append({"url": nd["url"], "title": nd["title"], "in_ctx": nd["in_ctx"], "relevant_in": nd["in_bands"]["relevant"],
                            "relevant_equity_share": share, "queries": nd["queries"], "pr_rank": nd["pr_rank"],
                            "sources": best_new_sources(j)})
    starved.sort(key=lambda r: (-r["queries"], r["relevant_in"], r["pr_rank"]))

    # per topic
    topics = []
    for c in s["clusters"]:
        members = {idx[_norm(u)] for u in c["pages"] if _norm(u) in idx}
        out_e = [e for e in ctx if e["s"] in members]
        if not out_e:
            continue
        topics.append({"id": c["id"], "label": c["label"], "size": len(members), "links": len(out_e),
                       "within_topic": round(sum(1 for e in out_e if e["t"] in members) / len(out_e), 4),
                       "mean_sim": round(float(np.mean([e["sim"] for e in out_e])), 4),
                       "relevant": round(sum(1 for e in out_e if e["band"] == "relevant") / len(out_e), 4)})
    topics.sort(key=lambda t: t["relevant"])

    def ext_summary(rows: list[dict]) -> dict:
        scored = [r for r in rows if r["sim"] is not None]
        out = {"count": len(rows), "scored": len(scored), "domains": len({r["domain"] for r in rows}),
               "bands": {b: sum(1 for r in scored if r["band"] == b) for b in BAND_ORDER},
               "mean_sim": round(float(np.mean([r["sim"] for r in scored])), 4) if scored else None}
        if rows and "dr" in rows[0]:
            out["referring_pages"] = len({r["source"] for r in rows})
            out["dofollow"] = sum(1 for r in rows if r.get("nofollow") is False)
            out["spam"] = sum(1 for r in rows if r.get("spam"))
            out["basis"] = {"page": sum(1 for r in rows if r.get("basis") == "page"),
                            "context": sum(1 for r in rows if r.get("basis") == "context")}
            # Authority that is also on topic: DR-weighted share of followed, non-spam
            # backlinks that are relevant.
            good = [r for r in scored if r.get("nofollow") is not True and not r.get("spam")]
            w = sum((r.get("dr") or 0) + 1 for r in good)
            out["relevant_authority_share"] = round(sum((r.get("dr") or 0) + 1 for r in good if r["band"] == "relevant") / w, 4) if w else None
            # Share of backlink value (authority x quality x follow) that comes over relevant links.
            wv = sum(r["ew"] for r in scored)
            out["relevant_value_share"] = round(sum(r["ew"] for r in scored if r["band"] == "relevant") / wv, 4) if wv else None
            out["off_topic_value_share"] = round(sum(r["ew"] for r in scored if r["band"] == "off_topic") / wv, 4) if wv else None
            vis: dict[str, str | None] = {}
            for r in rows:
                vis[r["source"]] = max(vis.get(r["source"]) or "", r.get("vis") or "", key=lambda v: VIS_ORDER.get(v, -1)) or None
            out["visibility"] = {k: sum(1 for v in vis.values() if v == k) for k in ("traffic", "ranks", "none")}
            out["with_better_match"] = sum(1 for r in rows if r.get("better"))
        return out

    # Backlinks per page (for the side panel and node tooltips) and per referring
    # domain (the graph draws one diamond per domain, the strongest first).
    by_target: dict[int, list[dict]] = defaultdict(list)
    for r in inbound_ext:
        by_target[r["t"]].append(r)
    for j, nd in enumerate(nodes):
        lst = by_target.get(j, [])
        nd["backlinks"] = len(lst)
        nd["backlink_domains"] = len({r["domain"] for r in lst})
        nd["backlinks_relevant"] = sum(1 for r in lst if r["band"] == "relevant")
        sc_ = [r for r in lst if r["sim"] is not None and r["ew"] > 0]
        wsum = sum(r["ew"] for r in sc_)
        nd["backlink_value"] = round(sum(r["ew"] for r in lst), 3)
        # Relevance of this page's backlinks to this page, weighted by each link's value.
        nd["backlink_sim"] = round(sum(r["ew"] * r["sim"] for r in sc_) / wsum, 4) if wsum else None
        nd["backlink_band"] = band(nd["backlink_sim"])
    dom: dict[str, dict] = {}
    for r in inbound_ext:
        d = dom.setdefault(r["domain"], {"domain": r["domain"], "dr": r.get("dr") or 0, "links": 0, "followed": 0, "spam": 0,
                                         "auth": 0.0, "qual": None, "value": 0.0, "ws": 0.0, "wsum": 0.0, "targets": {},
                                         "rd": None, "traffic": None, "kw": None})
        for k in ("rd", "traffic", "kw"):
            if r.get(k) is not None:
                d[k] = max(d[k] or 0, r[k])
        d["dr"] = max(d["dr"], r.get("dr") or 0)
        d["links"] += 1
        d["followed"] += 1 if r.get("nofollow") is False and not r.get("spam") else 0
        d["spam"] += 1 if r.get("spam") else 0
        d["auth"] = max(d["auth"], r["auth"])
        if r["qual"] is not None:
            d["qual"] = max(d["qual"] or 0.0, r["qual"])
        d["value"] = max(d["value"], r["w"])
        if r["sim"] is not None and r["w"] > 0:
            d["ws"] += r["w"] * r["sim"]
            d["wsum"] += r["w"]
        tg = d["targets"].setdefault(r["t"], {"t": r["t"], "sim": None, "band": None, "links": 0, "value": 0.0})
        tg["links"] += 1
        tg["value"] = max(tg["value"], r["w"])
        if r["sim"] is not None and (tg["sim"] is None or r["sim"] > tg["sim"]):
            tg["sim"], tg["band"] = r["sim"], r["band"]
    top_domains = sorted(dom.values(), key=lambda d: (-d["value"], -d["dr"], -d["links"]))[:150]
    ext_domains = []
    for d in top_domains:
        sim_d = d["ws"] / d["wsum"] if d["wsum"] else None
        ext_domains.append({"domain": d["domain"], "dr": d["dr"], "links": d["links"], "followed": d["followed"], "spam": d["spam"],
                            "rd": d["rd"], "traffic": d["traffic"], "kw": d["kw"],
                            "auth": round(d["auth"], 3), "qual": None if d["qual"] is None else round(d["qual"], 3),
                            "value": round(d["value"], 3), "sim": None if sim_d is None else round(sim_d, 4), "band": band(sim_d),
                            "targets_total": len(d["targets"]),
                            "targets": sorted(({**t, "value": round(t["value"], 3)} for t in d["targets"].values()),
                                              key=lambda t: (-t["value"], -t["links"]))[:25]})
    rank_rows = lambda rows: sorted(rows, key=lambda r: (-r["w"], -(r.get("dr") or 0), r["source"]))
    uncrawled_list = sorted(({"url": u["url"], "backlinks": u["backlinks"], "domains": len(u["domains"])} for u in uncrawled.values()),
                            key=lambda u: (-u["domains"], -u["backlinks"]))

    return {
        "dim": dim,
        "own_host": own_host,
        "nodes": nodes,
        "edges": [{k: e[k] for k in ("s", "t", "sim", "band", "kind", "anchor")} | {"flow": round(e["flow"], 6)} for e in edges],
        "external": {"inbound": [{k: v for k, v in r.items() if k not in ("t", "ew", "_b", "_i")} for r in rank_rows(inbound_ext)[:4000]],
                     "outbound": outbound_ext[:3000],
                     "by_target": {pages[j]["url"]: [{k: v for k, v in r.items() if k not in ("t", "ew", "_b", "_i")} for r in rank_rows(lst)[:25]]
                                   for j, lst in by_target.items()},
                     "domains": ext_domains,
                     "uncrawled": uncrawled_list[:40],
                     "uncrawled_summary": {"targets": len(uncrawled), "backlinks": sum(u["backlinks"] for u in uncrawled.values())},
                     "inbound_summary": ext_summary(inbound_ext), "outbound_summary": ext_summary(outbound_ext)},
        "cutoffs": {"relevant": round(rel_hi, 4), "off_topic": round(rel_lo, 4), "baseline": round(baseline, 4)},
        "backlink_weights": BACKLINK_WEIGHTS,
        "score": {
            "value": None if overall is None else round(overall, 1),
            "internal_value": None if internal_value is None else round(internal_value, 1),
            "backlinks": {k: v for k, v in bl.items() if k != "rows"},
            "weighted_sim": None if W is None else round(W, 4),
            "ideal_sim": None if I is None else round(I, 4),
            "baseline_sim": round(baseline, 4),
            "links": len(ctx), "sitewide_links": sum(1 for e in edges if e["kind"] == "sitewide"),
            "template_links": sum(1 for e in edges if e["kind"] == "template"), "sitewide_targets": len(sitewide_targets),
            "band_counts": {b: band_counts.get(b, 0) for b in BAND_ORDER},
            "band_equity": band_equity,
            "pages_without_relevant_inlinks": sum(1 for nd in nodes if nd["in_bands"]["relevant"] == 0 and not nd["sitewide_target"] and not nd["archive"]),
            "content_pages": sum(1 for nd in nodes if not nd["archive"]),
        },
        "off_topic_links": off_links,
        "starved_pages": starved[:60],
        "topics": topics,
        "has_links": bool(edges),
    }

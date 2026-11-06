"""Similarity thresholds.

Raw cosine similarity is model-specific: with EmbeddingGemma 2 an unrelated
query/page pair still scores ~0.55 and a tight match ~0.80, so the old fixed
"distance > 0.3" style rules don't transfer between models. We ship thresholds
calibrated for EmbeddingGemma 2 (search-query prompt vs. titled documents,
measured on ~1,000 real keywords against ipullrank.com pages) and fall back to
percentiles of the project's own distribution for any other vector source.

Every threshold can be overridden per request from the Action Plan UI.
"""
from __future__ import annotations

import numpy as np

from services.embedder import MODEL_ID

# Query -> document cosine similarity (EmbeddingGemma 2, 768-d).
#   >= 0.76  page clearly targets the query
#   0.66-0.76 page is related but not optimized for it
#   < 0.66  nothing on the site really answers it
# Truncated sizes shift the whole similarity scale up, so each size gets the
# thresholds that keep the same share of queries in each band as 768-d
# (quantile-matched on 1,000 iPR queries x 156 ipullrank.com pages, Oct 2026).
CALIBRATED = {
    "google/embeddinggemma-2": {
        768: {"strong": 0.76, "gap": 0.66, "cannibal_margin": 0.010, "dup": 0.95, "cluster": 0.84},
        512: {"strong": 0.768, "gap": 0.667, "cannibal_margin": 0.010, "dup": 0.952, "cluster": 0.844},
        256: {"strong": 0.791, "gap": 0.694, "cannibal_margin": 0.009, "dup": 0.96, "cluster": 0.856},
        128: {"strong": 0.854, "gap": 0.791, "cannibal_margin": 0.007, "dup": 0.975, "cluster": 0.90},
    }
}

# How much each size changes the app's decisions vs 768-d on that same data.
DIM_EVAL = {
    768: {"best_page": 1.0, "best_page_clear": 1.0, "bands": 1.0, "link_neighbours": 1.0, "best_passage": 1.0, "gap_clusters": 1.0},
    512: {"best_page": 0.858, "best_page_clear": 1.0, "bands": 0.956, "link_neighbours": 0.908, "best_passage": 0.798, "gap_clusters": 1.0},
    256: {"best_page": 0.679, "best_page_clear": 0.976, "bands": 0.904, "link_neighbours": 0.816, "best_passage": 0.585, "gap_clusters": 0.889},
    128: {"best_page": 0.492, "best_page_clear": 0.793, "bands": 0.818, "link_neighbours": 0.635, "best_passage": 0.335, "gap_clusters": 0.763},
}


def calibrated_for(model: str, dim: int) -> dict | None:
    table = CALIBRATED.get(model)
    if not table:
        return None
    if dim in table:
        return dict(table[dim])
    return dict(table[768]) if dim > 768 else None


def _pct(arr, q, default):
    if arr is None:
        return default
    arr = np.asarray(arr, dtype=np.float32)
    arr = arr[np.isfinite(arr)]
    return float(np.percentile(arr, q)) if arr.size else default


def suggest(health: dict, kw_best: np.ndarray | None, page_pairs: np.ndarray | None,
            kw_pairs: np.ndarray | None, dim: int = 768) -> dict:
    """Return default thresholds + where they came from."""
    cal = calibrated_for(MODEL_ID, dim)
    calibrated = (
        not health.get("legacy") and not health.get("mixed") and not health.get("foreign") and cal is not None
    )
    if calibrated:
        t = cal
        t["basis"] = f"calibrated for {MODEL_ID} at {dim} dimensions"
    else:
        t = {
            "strong": round(_pct(kw_best, 75, 0.8), 3),
            "gap": round(_pct(kw_best, 25, 0.6), 3),
            "dup": round(max(_pct(page_pairs, 99.9, 0.95), 0.9), 3),
            "cluster": round(_pct(kw_pairs, 97, 0.85), 3),
            "basis": "percentiles of this project's vectors (unknown model)",
        }
        if t["gap"] >= t["strong"]:
            t["gap"] = round(t["strong"] - 0.05, 3)
        # Scale the "too close to call" margin with the spread between bands.
        t["cannibal_margin"] = round(max(0.002, 0.12 * (t["strong"] - t["gap"])), 3)
    # Internal-link candidates are always relative to the site's own spread.
    t["link_min"] = round(_pct(page_pairs, 90, 0.8), 3)
    t["weak_link"] = round(_pct(page_pairs, 10, 0.5), 3)
    return t


def merge(defaults: dict, overrides: dict) -> dict:
    out = dict(defaults)
    for k, v in (overrides or {}).items():
        if v is None or k not in out or k == "basis":
            continue
        try:
            out[k] = float(v)
        except (TypeError, ValueError):
            pass
    return out

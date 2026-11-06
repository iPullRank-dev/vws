"""On-demand single-page fetch for the AI Rewrite Brief endpoint.

If a target URL is not present in the project's pages table (or its content is
empty/very short), we fetch the page in real-time with Scrapling and extract
the body text with Trafilatura. The result is optionally cached back into the
pages table so subsequent rewrites are fast.

Why two libraries:
- Scrapling's `Fetcher` handles HTTP, redirects, anti-bot evasion, and timeouts
  better than a naked httpx.get(), and we can swap to StealthyFetcher for
  Cloudflare-protected pages without changing the call sites.
- Trafilatura is the same extractor the bulk crawler already uses, so on-demand
  fetched content is structurally consistent with crawled content.
"""

from __future__ import annotations

import html as _html
import re
import sqlite3
import traceback
from typing import Optional, Tuple

import trafilatura

# Sentinel-ish thresholds. If existing body content is < MIN_USEFUL_CHARS we
# treat it as "missing" and re-fetch.
MIN_USEFUL_CHARS = 200


def _scrapling_fetch(url: str, timeout_seconds: int = 12, allow_stealth: bool = False) -> Optional[str]:
    """Fetch a URL with Scrapling's plain (HTTP) Fetcher.

    StealthyFetcher escalation is gated behind `allow_stealth` because it spins
    up a Playwright browser, which on Windows + CPU adds 10-30s of overhead
    just for the launch. Most non-Cloudflare pages work fine with plain HTTP,
    so we keep the rewrite flow fast by default.
    """
    import time
    t0 = time.time()
    try:
        from scrapling.fetchers import Fetcher
    except Exception as e:
        print(f"[realtime_fetch] scrapling import failed: {e}")
        return None

    html: Optional[str] = None

    # Plain HTTP first — fast path, no browser launch.
    try:
        resp = Fetcher.get(url, timeout=timeout_seconds, stealthy_headers=True, follow_redirects=True)
        status = getattr(resp, "status", None)
        if status and 200 <= status < 400:
            html = getattr(resp, "html_content", None) or None
        print(f"[realtime_fetch] plain Fetcher {url} -> status={status} html_len={len(html) if html else 0} ({time.time()-t0:.1f}s)")
    except Exception as e:
        print(f"[realtime_fetch] plain Fetcher failed for {url}: {e} ({time.time()-t0:.1f}s)")

    # Only escalate to a real browser when explicitly allowed. Default off
    # because the browser launch dominates request time for cold starts.
    if allow_stealth and (not html or len(html) < 1000):
        t1 = time.time()
        try:
            from scrapling.fetchers import StealthyFetcher
            resp = StealthyFetcher.get(
                url,
                timeout=timeout_seconds * 1000,  # StealthyFetcher takes ms
                headless=True,
                humanize=False,
                network_idle=True,
            )
            status = getattr(resp, "status", None)
            if status and 200 <= status < 400:
                html = getattr(resp, "html_content", None) or html
            print(f"[realtime_fetch] StealthyFetcher {url} -> status={status} html_len={len(html) if html else 0} ({time.time()-t1:.1f}s)")
        except Exception as e:
            print(f"[realtime_fetch] StealthyFetcher failed for {url}: {e} ({time.time()-t1:.1f}s)")

    return html


_TITLE_TAG = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def _extract(html: str) -> Tuple[str, str]:
    """Return (title, body_text). Either may be empty."""
    title = ""
    body = ""
    try:
        # One pass for title + body. Trafilatura 1.x returns a dict; 2.x returns a
        # Document object and only fills `title` when metadata is requested
        # (without with_metadata=True every page came back untitled).
        try:
            meta = trafilatura.bare_extraction(html, include_comments=False, include_tables=False, with_metadata=True)
        except TypeError:
            meta = trafilatura.bare_extraction(html, include_comments=False, include_tables=False)
        if meta is not None:
            get = meta.get if isinstance(meta, dict) else (lambda k: getattr(meta, k, None))
            title = get("title") or ""
            body = get("text") or ""
        if not body:
            body = trafilatura.extract(html, include_comments=False, include_tables=False) or ""
    except Exception as e:
        print(f"[realtime_fetch] trafilatura extraction failed: {e}")
        try:
            body = trafilatura.extract(html, include_comments=False, include_tables=False) or ""
        except Exception:
            body = ""
    if not title:
        m = _TITLE_TAG.search(html[:200_000])
        if m:
            title = _html.unescape(re.sub(r"\s+", " ", m.group(1)))
    return title.strip(), (body or "").strip()


def _trafilatura_fetch(url: str) -> Optional[str]:
    try:
        return trafilatura.fetch_url(url) or None
    except Exception as e:
        print(f"[realtime_fetch] trafilatura fetch failed for {url}: {e}")
        return None


def fetch_and_extract(url: str) -> Optional[Tuple[str, str]]:
    """Fetch `url` and return (title, body_text). None if the fetch failed
    entirely or extraction produced no usable body. Falls back to
    trafilatura's own fetcher when Scrapling is unavailable or blocked."""
    html = _scrapling_fetch(url) or _trafilatura_fetch(url)
    if not html:
        return None
    title, body = _extract(html)
    if not body or len(body) < 50:
        return None
    return title, body


def fetch_many(urls: list[str], workers: int = 8, on_done=None) -> dict:
    """Fetch several URLs in parallel. Returns {url: (title, body) | None}.
    `on_done(n_done)` is called after each URL so callers can report progress."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    results: dict = {}
    if not urls:
        return results
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(fetch_and_extract, u): u for u in urls}
        for i, fut in enumerate(as_completed(futures), start=1):
            u = futures[fut]
            try:
                results[u] = fut.result()
            except Exception as e:
                print(f"[realtime_fetch] fetch_many error for {u}: {e}")
                results[u] = None
            if on_done:
                try:
                    on_done(i)
                except Exception:
                    pass
    return results


def fetch_iter(urls: list[str], workers: int = 8):
    """Fetch URLs in parallel and yield (url, (title, body) | None) as each one
    finishes, so the caller can process results while the rest download.
    Closing the generator early cancels the fetches that haven't started."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if not urls:
        return
    pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="vws-fetch")
    futures = {pool.submit(fetch_and_extract, u): u for u in urls}
    try:
        for fut in as_completed(futures):
            u = futures[fut]
            try:
                res = fut.result()
            except Exception as e:
                print(f"[realtime_fetch] fetch error for {u}: {e}")
                res = None
            yield u, res
    finally:
        for f in futures:
            f.cancel()
        pool.shutdown(wait=False)


def cache_into_pages(conn: sqlite3.Connection, project_id: int, url: str, title: str, content: str) -> None:
    """Upsert a freshly-fetched page into the pages table so subsequent rewrites
    don't pay the network/extraction cost. Marks source_type='realtime' so it's
    distinguishable from crawl-time rows."""
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM pages WHERE project_id = ? AND url = ?",
            (project_id, url),
        )
        row = cursor.fetchone()
        if row:
            cursor.execute(
                "UPDATE pages SET title = ?, content = ? WHERE id = ?",
                (title or "", content, row["id"]),
            )
        else:
            cursor.execute(
                "INSERT INTO pages (project_id, url, title, content, source_type, source_name) VALUES (?, ?, ?, ?, ?, ?)",
                (project_id, url, title or "", content, "realtime", "rewrite-fetch"),
            )
        conn.commit()
    except Exception as e:
        print(f"[realtime_fetch] cache_into_pages failed for {url}: {e}")
        traceback.print_exc()

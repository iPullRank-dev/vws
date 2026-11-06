import asyncio
import json
import re
import sys
import time

import advertools as adv
import numpy as np
from playwright.async_api import async_playwright
from playwright.async_api import TimeoutError as PlaywrightTimeout

from services.database import get_db
from services.embedder import (DEFAULT_ANALYSIS_DIM, MAX_TOKENS, MODEL_ID, clean_title,
                               embed_document_detailed, truncate)
from services.realtime_fetch import _extract
from services.thresholds import calibrated_for
from services.vectors import save_vectors

NAV_TIMEOUT_MS = 15000
# Headers CDNs / caches use to say whether the response came from cache.
_CACHE_STATUS_HEADERS = ("cf-cache-status", "x-cache", "x-vercel-cache", "x-cache-status",
                         "x-proxy-cache", "x-nf-cache-status", "x-served-by-cache", "akamai-cache-status")
_META_TAG = re.compile(r"<meta\b[^>]*>", re.I)
_LEVEL_RANK = {"error": 3, "skip": 2, "warn": 1, "info": 0}
_STATUS_FOR = {"error": "error", "skip": "skipped", "warn": "warning", "info": "embedded"}
# Minimum pages before the running "far from the core" fence means anything.
_MIN_FOR_FENCE = 20


def _attr(tag: str, name: str) -> str | None:
    m = re.search(rf"\b{name}\s*=\s*([\"'])(.*?)\1", tag, re.I | re.S)
    return m.group(2) if m else None


def _noindex(html: str, headers: dict) -> str | None:
    xr = headers.get("x-robots-tag", "")
    if "noindex" in xr.lower():
        return f"X-Robots-Tag: {xr}"
    for tag in _META_TAG.findall(html[:300_000]):
        name = (_attr(tag, "name") or "").lower()
        if name in ("robots", "googlebot"):
            content = _attr(tag, "content") or ""
            if "noindex" in content.lower():
                return f'meta {name}="{content}"'
    return None


def _short_error(e: Exception) -> str:
    msg = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
    m = re.search(r"net::ERR_[A-Z_]+", msg)
    if m:
        return m.group(0)
    if "Download is starting" in msg:
        return "download"
    return msg[:160]


def _ms(timing: dict, a: str, b: str) -> int | None:
    x, y = timing.get(a, -1), timing.get(b, -1)
    if x is None or y is None or x < 0 or y < 0 or y < x:
        return None
    return int(round(y - x))


class CrawlState:
    """Running vector comparisons for one crawl. Lives on the crawler's event
    loop thread, so updates need no locking (no await between read and write)."""

    def __init__(self, project_id: int, total: int, concurrency: int):
        self.project_id = project_id
        self.total = total
        self.concurrency = concurrency
        self.started = time.time()
        self.seq = 0
        self.done = 0
        self.dim = DEFAULT_ANALYSIS_DIM
        cal = calibrated_for(MODEL_ID, self.dim) or {}
        self.dup = float(cal.get("dup", 0.95))
        self.urls: list[str] = []
        self.mat = np.zeros((max(16, total), self.dim), dtype=np.float32)
        self.n = 0
        self.sum = np.zeros(self.dim, dtype=np.float32)
        self.dists: list[float] = []      # distance to the running center, per page
        self.final_urls: dict[str, str] = {}
        self.counts = {"embedded": 0, "warning": 0, "skipped": 0, "error": 0}

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def compare_and_add(self, url: str, vec: np.ndarray) -> dict:
        v = truncate(vec[None, :], self.dim)[0]
        out = {"center_sim": None, "closest_url": None, "closest_sim": None,
               "near_duplicate": False, "far_from_core": False, "compared_with": self.n,
               "core_fence_sim": None}
        if self.n:
            sims = self.mat[: self.n] @ v
            j = int(np.argmax(sims))
            out["closest_url"] = self.urls[j]
            out["closest_sim"] = round(float(sims[j]), 4)
            out["near_duplicate"] = bool(sims[j] >= self.dup)
            center = self.sum / (float(np.linalg.norm(self.sum)) or 1.0)
            cs = float(v @ center)
            out["center_sim"] = round(cs, 4)
            # Same rule as Site Focus' Peripheral zone (Q3 + 1.5 x IQR of distance
            # to the center), applied to the pages crawled so far.
            if len(self.dists) >= _MIN_FOR_FENCE:
                q1, q3 = np.percentile(self.dists, [25, 75])
                fence = q3 + 1.5 * (q3 - q1)
                out["core_fence_sim"] = round(1 - float(fence), 4)
                out["far_from_core"] = bool((1 - cs) > fence)
            self.dists.append(1 - cs)
        if self.n >= self.mat.shape[0]:
            self.mat = np.vstack([self.mat, np.zeros_like(self.mat)])
        self.mat[self.n] = v
        self.urls.append(url)
        self.n += 1
        self.sum += v
        return out


def _persist_event(cursor, project_id: int, event: dict) -> None:
    cursor.execute("INSERT OR REPLACE INTO crawl_log (project_id, seq, data) VALUES (?, ?, ?)",
                   (project_id, event["seq"], json.dumps(event)))


def _emit(state: CrawlState, event: dict, message_queue, main_loop, conn=None) -> None:
    """Persist the event (committing `conn`, which may hold the page insert too),
    then push it to the live stream, so a page refresh never misses a row."""
    event["seq"] = state.next_seq()
    own = conn is None
    try:
        if own:
            conn = get_db()
        _persist_event(conn.cursor(), state.project_id, event)
    except Exception as e:  # the live view must not die because the log write failed
        print(f"[crawl] could not persist log event: {e}")
    finally:
        try:
            conn.commit()
            if own:
                conn.close()
        except Exception as e:
            print(f"[crawl] commit failed: {e}")
    main_loop.call_soon_threadsafe(message_queue.put_nowait, event)


async def fetch_and_process(browser, url, state: CrawlState, semaphore, message_queue, main_loop):
    async with semaphore:
        print(f"Crawling: {url}")
        issues: list[dict] = []
        perf: dict = {"status_code": None, "final_url": url, "redirects": [], "ttfb_ms": None,
                      "dns_ms": None, "connect_ms": None, "tls_ms": None, "content_type": None,
                      "html_bytes": None, "transfer_bytes": None, "server": None,
                      "cache_control": None, "cache_status": None, "age": None}
        html_content = ""
        headers: dict = {}
        start_time = time.time()

        try:
            page = await browser.new_page()
            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                if response:
                    perf["status_code"] = response.status
                    perf["final_url"] = response.url
                    # Repeated headers arrive joined by newlines; show them comma-separated.
                    headers = {k: (v or "").replace("\n", ", ") for k, v in (response.headers or {}).items()}
                    perf["content_type"] = headers.get("content-type")
                    perf["server"] = headers.get("server")
                    perf["cache_control"] = headers.get("cache-control")
                    perf["age"] = headers.get("age")
                    for h in _CACHE_STATUS_HEADERS:
                        if headers.get(h):
                            perf["cache_status"] = f"{h}: {headers[h]}"
                            break
                    if headers.get("content-length", "").isdigit():
                        perf["transfer_bytes"] = int(headers["content-length"])
                    timing = response.request.timing or {}
                    rs = timing.get("responseStart", -1)
                    perf["ttfb_ms"] = int(round(rs)) if rs is not None and rs >= 0 else None
                    perf["dns_ms"] = _ms(timing, "domainLookupStart", "domainLookupEnd")
                    perf["connect_ms"] = _ms(timing, "connectStart", "connectEnd")
                    perf["tls_ms"] = _ms(timing, "secureConnectionStart", "connectEnd")
                    hops, req = [], response.request.redirected_from
                    while req is not None:
                        r = await req.response()
                        hops.append({"url": req.url, "status": r.status if r else None})
                        req = req.redirected_from
                    perf["redirects"] = list(reversed(hops))
                    try:
                        perf["html_bytes"] = len(await response.body())
                    except Exception:
                        pass
                    html_content = await page.content()
                    if perf["html_bytes"] is None and html_content:
                        perf["html_bytes"] = len(html_content.encode("utf-8", "ignore"))
                else:
                    issues.append({"level": "error", "code": "no_response", "text": "The browser got no response"})
            finally:
                await page.close()
        except PlaywrightTimeout:
            issues.append({"level": "error", "code": "timeout",
                           "text": f"Timed out after {NAV_TIMEOUT_MS // 1000} s waiting for the page"})
        except Exception as e:
            err = _short_error(e)
            if err == "download" or err == "net::ERR_ABORTED":
                issues.append({"level": "skip", "code": "not_html",
                               "text": "Not an HTML page (the browser treated it as a download)"})
            else:
                issues.append({"level": "error", "code": "fetch_failed", "text": f"Fetch failed: {err}"})
            print(f"FAILED fetching {url}: {e}")

        load_ms = int((time.time() - start_time) * 1000)
        code = perf["status_code"]
        ctype = (perf["content_type"] or "").lower()

        if code is not None and code >= 400:
            issues.append({"level": "error", "code": f"http_{code}", "text": f"HTTP {code}"})
        elif code is not None and ctype and "html" not in ctype and "xml" not in ctype:
            issues.append({"level": "skip", "code": "not_html", "text": f"Not an HTML page ({ctype.split(';')[0]})"})

        if perf["redirects"]:
            first = perf["redirects"][0]
            issues.append({"level": "warn", "code": "redirect",
                           "text": f"Redirected ({first.get('status') or '3xx'}, {len(perf['redirects'])} hop"
                                   f"{'s' if len(perf['redirects']) > 1 else ''}) to {perf['final_url']}. "
                                   "Stored under the requested URL; crawl the final URL instead."})
            if perf["final_url"] in state.final_urls:
                issues.append({"level": "warn", "code": "same_final_url",
                               "text": f"Lands on the same URL as {state.final_urls[perf['final_url']]}"})
        if code is not None and code < 400:
            state.final_urls.setdefault(perf["final_url"], url)

        # 1. Extraction (title + main content). Passages are derived on demand
        #    in the Relevance Lab, so we store the whole body here.
        title, text_content = ("", "")
        crawled_ok = code is not None and 200 <= code < 300 and not any(i["level"] in ("error", "skip") for i in issues)
        if crawled_ok and html_content:
            title, text_content = _extract(html_content)
            if not text_content:
                issues.append({"level": "skip", "code": "empty",
                               "text": "No main content found to embed (empty, script-rendered or boilerplate only)"})
            reason = _noindex(html_content, headers)
            if reason:
                issues.append({"level": "warn", "code": "noindex",
                               "text": f"noindex ({reason}). Still embedded, but Google won't index it"})
        title = clean_title(title, url)

        # 2. One document embedding per page: "title: {title} | text: {body}".
        vec, emb = None, {}
        if text_content:
            try:
                vec, emb = await asyncio.to_thread(embed_document_detailed, text_content, title)
            except Exception as e:
                issues.append({"level": "error", "code": "embed_failed", "text": f"Embedding failed: {_short_error(e)}"})
                print(f"Embedding error for {url}: {e}")

        vecinfo: dict = {}
        if vec is not None:
            if emb.get("truncated"):
                issues.append({"level": "warn", "code": "truncated",
                               "text": f"Cut off: only the first {emb['embedded_tokens']:,} of {emb['tokens']:,} tokens "
                                       "were embedded. Raise VWS_EMBED_MAX_TOKENS (max 8192) to cover the whole page"})
            vecinfo = state.compare_and_add(url, vec)
            if vecinfo["near_duplicate"]:
                issues.append({"level": "warn", "code": "near_duplicate",
                               "text": f"Near-duplicate of {vecinfo['closest_url']} (similarity {vecinfo['closest_sim']:.3f})"})
            if vecinfo["far_from_core"]:
                issues.append({"level": "info", "code": "far_from_core",
                               "text": f"Far from the core of the pages crawled so far (similarity to center "
                                       f"{vecinfo['center_sim']:.3f}, fence {vecinfo['core_fence_sim']:.3f})"})

        worst = max((i["level"] for i in issues), key=lambda lv: _LEVEL_RANK[lv], default="info")
        status = _STATUS_FOR[worst]
        state.counts[status] += 1
        state.done += 1

        # 3. Persist
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO pages (project_id, url, title, content, source_type, source_name) VALUES (?, ?, ?, ?, ?, ?)",
            (state.project_id, url, title, text_content, "base", "Base Crawl"),
        )
        page_id = cursor.lastrowid
        if vec is not None:
            save_vectors(cursor, [(page_id, vec)])

        # 4. Log + notify stream
        event = {
            "type": "page_crawled",
            "index": state.done,
            "t": round(time.time() - state.started, 2),
            "page_id": page_id,
            "url": url,
            "title": title,
            "status": status,
            "issues": issues,
            "response_time_ms": load_ms,  # kept for older clients
            "load_ms": load_ms,
            **perf,
            "tokens": emb.get("tokens"),
            "embedded_tokens": emb.get("embedded_tokens"),
            "truncated": emb.get("truncated", False),
            "embed_ms": emb.get("embed_ms"),
            "embed_queue_ms": emb.get("queue_ms"),
            "device": emb.get("device"),
            **vecinfo,
            "embedding_3d": [float(x) for x in vec[:3]] if vec is not None else [0, 0, 0],
        }
        _emit(state, event, message_queue, main_loop, conn)
        conn.close()


def execute_crawl_pipeline(project_id: int, urls: list[str], concurrency: int, message_queue: asyncio.Queue, main_loop: asyncio.AbstractEventLoop):
    print(f"Firing up True Crawler Pipeline for {len(urls)} URLs at concurrency {concurrency}")

    if sys.platform == 'win32':
        loop = asyncio.ProactorEventLoop()
    else:
        loop = asyncio.new_event_loop()

    asyncio.set_event_loop(loop)

    try:
        loop.run_until_complete(_async_crawl_pipeline(project_id, urls, concurrency, message_queue, main_loop))
    finally:
        loop.close()


async def _async_crawl_pipeline(project_id: int, urls: list[str], concurrency: int, message_queue: asyncio.Queue, main_loop: asyncio.AbstractEventLoop):
    semaphore = asyncio.Semaphore(concurrency)
    state = CrawlState(project_id, len(urls), concurrency)
    _emit(state, {
        "type": "start", "total": len(urls), "concurrency": concurrency, "model": MODEL_ID,
        "dim": state.dim, "dup_threshold": state.dup, "max_tokens": MAX_TOKENS,
        "timeout_s": NAV_TIMEOUT_MS // 1000,
    }, message_queue, main_loop)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)

        tasks = []
        for url in urls:
            tasks.append(fetch_and_process(browser, url, state, semaphore, message_queue, main_loop))

        results = await asyncio.gather(*tasks, return_exceptions=True)
        for url, r in zip(urls, results):
            if isinstance(r, Exception):
                print(f"[crawl] {url} crashed: {r}")
                state.done += 1
                state.counts["error"] += 1
                _emit(state, {
                    "type": "page_crawled", "index": state.done, "t": round(time.time() - state.started, 2),
                    "url": url, "title": "", "status": "error", "status_code": None,
                    "issues": [{"level": "error", "code": "crashed", "text": f"Crawler error: {_short_error(r)}"}],
                    "embedding_3d": [0, 0, 0],
                }, message_queue, main_loop)
        await browser.close()

    try:
        from services.analysis import store_project_stats
        store_project_stats(project_id)  # focus score + page count for the dashboard card
    except Exception as e:
        print(f"[crawl] project stats update failed: {e}")

    _emit(state, {
        "type": "complete",
        "message": "Crawl & Vector Injection Finished.",
        "counts": state.counts,
        "elapsed_s": round(time.time() - state.started, 1),
    }, message_queue, main_loop)

def extract_urls(crawl_mode: str, start_urls: str, max_urls: int = 100):
    urls_to_crawl = []

    if crawl_mode == "url":
        urls_to_crawl = [start_urls.strip()]
    elif crawl_mode == "list":
        urls_to_crawl = [u.strip() for u in start_urls.replace(',', '\n').split('\n') if u.strip()]
    elif crawl_mode == "sitemap":
        try:
            sitemap_df = adv.sitemap_to_df(start_urls.strip())
            if 'loc' in sitemap_df.columns:
                urls_to_crawl = sitemap_df['loc'].dropna().tolist()
        except Exception as e:
            print(f"Failed to parse sitemap: {e}")

    if max_urls > 0 and len(urls_to_crawl) > max_urls:
        urls_to_crawl = urls_to_crawl[:max_urls]

    return urls_to_crawl

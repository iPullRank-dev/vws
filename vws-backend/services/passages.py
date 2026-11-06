"""Split extracted page text into retrievable passages.

AI search systems retrieve and score passages, not pages, so the Lab works at
this level. The splitter is deliberately simple and deterministic:

* Trafilatura emits one paragraph per line. Short lines without terminal
  punctuation that are followed by a real paragraph are treated as headings and
  carried into the passages beneath them (they are part of what gets embedded).
* Paragraphs are packed into ~120-word passages, never across a heading.
* Very long paragraphs are cut on sentence boundaries.
"""
from __future__ import annotations

import re

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])")
_LIST_PREFIX = re.compile(r"^([-*•●]|\d+[.)])\s+")


def _looks_like_heading(line: str) -> bool:
    if not line or _LIST_PREFIX.match(line):
        return False
    words = line.split()
    return len(words) <= 12 and len(line) <= 110 and not re.search(r"[.!?;:,]$", line)


def _split_long(paragraph: str, max_words: int) -> list[str]:
    sentences = _SENT_SPLIT.split(paragraph)
    out, buf = [], []
    for s in sentences:
        if buf and len(" ".join(buf + [s]).split()) > max_words:
            out.append(" ".join(buf))
            buf = []
        buf.append(s)
    if buf:
        out.append(" ".join(buf))
    return out


def split_passages(text: str, target_words: int = 120, max_words: int = 220, min_words: int = 25) -> list[dict]:
    lines = [ln.strip() for ln in (text or "").replace("\r", "").split("\n")]
    lines = [ln for ln in lines if ln]

    passages: list[dict] = []
    heading = ""
    buf: list[str] = []

    def flush():
        nonlocal buf
        if not buf:
            return
        body = "\n".join(buf).strip()
        if body:
            passages.append({"heading": heading, "text": body})
        buf = []

    for i, line in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if _looks_like_heading(line) and nxt and not _looks_like_heading(nxt):
            flush()
            heading = line
            continue
        pieces = _split_long(line, max_words) if len(line.split()) > max_words else [line]
        for piece in pieces:
            if buf and len(" ".join(buf + [piece]).split()) > target_words:
                flush()
            buf.append(piece)
    flush()

    # Merge stubs into the previous passage when they share a heading.
    merged: list[dict] = []
    for p in passages:
        if merged and len(p["text"].split()) < min_words and merged[-1]["heading"] == p["heading"]:
            merged[-1]["text"] += "\n" + p["text"]
        else:
            merged.append(p)

    for idx, p in enumerate(merged):
        p["index"] = idx
        p["words"] = len(p["text"].split())
    return merged


def passage_embedding_text(p: dict) -> str:
    """What actually gets embedded for a passage: its heading + body."""
    h = (p.get("heading") or "").strip()
    return f"{h}\n{p['text']}" if h else p["text"]


def join_passages(passages: list[dict]) -> str:
    """Rebuild a page body from (possibly edited) passages for whole-page scoring."""
    out, last_heading = [], None
    for p in passages:
        h = (p.get("heading") or "").strip()
        if h and h != last_heading:
            out.append(h)
            last_heading = h
        out.append(p.get("text", ""))
    return "\n".join(out)

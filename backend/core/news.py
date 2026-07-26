"""
Science/AI news feed — ZERO model cost.

Pulls public RSS/Atom feeds (arXiv, ScienceDaily, Phys.org), filters for
AI-in-science relevance and tags a domain using plain keyword matching. No LLM
is involved at any point, so this costs nothing per request.

Results are cached in the DB with a TTL so the landing page is instant and we
stay polite to the upstream feeds (one refresh per TTL, not per visitor).
"""
import html
import json
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

from core.db import _conn, _PH

UA = {"User-Agent": "Samhita-LitReview/1.0 (research assistant; news reader)"}
TTL_SECONDS = 60 * 60 * 6          # refresh at most every 6 hours
MAX_ITEMS = 24
CACHE_KEY = "science_ai_news"

# Public feeds — all keyless and free.
FEEDS = [
    ("https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml", "ScienceDaily"),
    ("https://www.sciencedaily.com/rss/health_medicine/pharmacology.xml", "ScienceDaily"),
    ("https://www.sciencedaily.com/rss/matter_energy/materials_science.xml", "ScienceDaily"),
    ("https://phys.org/rss-feed/technology-news/machine-learning-ai/", "Phys.org"),
    ("https://phys.org/rss-feed/biology-news/biotechnology/", "Phys.org"),
    # arXiv's Atom query API (the RSS path is deprecated/blocked); same endpoint
    # the search agent already uses successfully.
    ("http://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate"
     "&sortOrder=descending&max_results=15", "arXiv"),
    ("http://export.arxiv.org/api/query?search_query=cat:q-bio.QM&sortBy=submittedDate"
     "&sortOrder=descending&max_results=15", "arXiv"),
]

# An item must mention AI/automation to be relevant at all.
_AI = ("artificial intelligence", " ai ", "ai-", "machine learning", "deep learning",
       "neural network", "llm", "large language model", "generative", "autonomous",
       "self-driving lab", "robot", "foundation model", "algorithm")

# Domain tags, checked in order — first match wins.
_DOMAINS = [
    ("Pharmaceutical", ("drug", "pharmac", "clinical trial", "therapeut", "compound",
                        "medicine", "fda", "antibiotic", "vaccine")),
    ("Biomedical", ("protein", "gene", "genom", "cell", "cancer", "disease", "patient",
                    "biolog", "neuro", "molecular", "rna", "dna", "enzyme", "biomedical")),
    ("Materials", ("material", "catalyst", "semiconductor", "polymer", "battery",
                   "nanomaterial", "alloy", "crystal", "solar")),
    ("Chemistry", ("chemist", "chemical", "synthesis", "reaction", "molecule", "compound")),
    ("Engineering", ("robot", "engineer", "manufactur", "device", "sensor", "hardware")),
]


def init_news_table() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS news_cache (
                key        TEXT PRIMARY KEY,
                payload    TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            )
            """
        )


# ── helpers (pure string work — no model calls) ────────────────────────────

def _clean(text: str) -> str:
    # Feeds often double-escape (&lt;p&gt;), so unescape first, then strip tags,
    # then unescape again for entities revealed by the first pass (&amp;nbsp;).
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _is_relevant(blob: str) -> bool:
    low = f" {blob.lower()} "
    return any(k in low for k in _AI)


def _domain_of(blob: str) -> str:
    low = blob.lower()
    for name, keys in _DOMAINS:
        if any(k in low for k in keys):
            return name
    return "Methods"


def _parse_date(raw: str):
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw)               # RSS: RFC-822
    except Exception:
        pass
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))   # Atom: ISO
    except Exception:
        return None


def _fetch_feed(spec) -> list[dict]:
    url, source = spec
    out: list[dict] = []
    try:
        with httpx.Client(timeout=12, headers=UA, follow_redirects=True) as client:
            r = client.get(url)
            if r.status_code != 200:
                return out
            root = ET.fromstring(r.content)
    except Exception:                                    # noqa: BLE001 — never break the page
        return out

    ns = {"a": "http://www.w3.org/2005/Atom"}
    nodes = root.findall(".//item") or root.findall(".//a:entry", ns)
    for n in nodes[:30]:
        title = _clean(n.findtext("title") or n.findtext("a:title", "", ns))
        desc = _clean(n.findtext("description") or n.findtext("a:summary", "", ns))
        link = n.findtext("link") or ""
        if not link:                                     # Atom puts it in an attribute
            el = n.find("a:link", ns)
            link = (el.get("href") if el is not None else "") or ""
        pub = n.findtext("pubDate") or n.findtext("a:updated", "", ns) or ""
        if not title or not link:
            continue
        blob = f"{title} {desc}"
        if not _is_relevant(blob):
            continue
        dt = _parse_date(pub)
        out.append({
            "title": title[:180],
            "desc": (desc[:260] + "…") if len(desc) > 260 else desc,
            "href": link.strip(),
            "source": source,
            "domain": _domain_of(blob),
            "at": dt.astimezone(timezone.utc).isoformat() if dt else None,
        })
    return out


def _collect() -> list[dict]:
    items: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(FEEDS)) as ex:
        for res in ex.map(_fetch_feed, FEEDS):
            items.extend(res)

    seen, uniq = set(), []
    for it in items:
        key = it["title"].lower()[:90]
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)

    uniq.sort(key=lambda i: i["at"] or "", reverse=True)
    return uniq[:MAX_ITEMS]


# ── public API ─────────────────────────────────────────────────────────────

def get_news(force: bool = False) -> dict:
    """Cached news list. Refetches only when the cache is older than TTL."""
    now = datetime.now(timezone.utc)
    cached, fetched_at = None, None
    try:
        with _conn() as conn:
            row = conn.execute(
                f"SELECT payload, fetched_at FROM news_cache WHERE key = {_PH}", (CACHE_KEY,)
            ).fetchone()
        if row:
            cached = json.loads(row["payload"])
            fetched_at = datetime.fromisoformat(row["fetched_at"])
    except Exception:                                    # noqa: BLE001
        cached = None

    fresh_enough = (
        cached and fetched_at and (now - fetched_at).total_seconds() < TTL_SECONDS
    )
    if fresh_enough and not force:
        return {"items": cached, "fetched_at": fetched_at.isoformat(), "cached": True}

    items = _collect()
    if not items:                                        # upstream down — serve stale
        return {"items": cached or [], "fetched_at": fetched_at.isoformat() if fetched_at else None,
                "cached": True, "stale": True}

    try:
        with _conn() as conn:
            conn.execute(
                f"INSERT INTO news_cache (key, payload, fetched_at) VALUES ({_PH},{_PH},{_PH}) "
                f"ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, "
                f"fetched_at = excluded.fetched_at",
                (CACHE_KEY, json.dumps(items), now.isoformat()),
            )
    except Exception:                                    # noqa: BLE001
        pass
    return {"items": items, "fetched_at": now.isoformat(), "cached": False}

"""
Pre-indexed paper corpus — Phase 1 of the pre-indexing plan.

This is deliberately the smallest useful slice: a local metadata cache that
grows for free, as a byproduct of searches that already happen, rather than a
bulk-ingested index. Every live search result gets written here once
(`upsert_papers`); nothing is fetched or indexed proactively yet.

This does NOT change search behavior today — `academic_search.py` still calls
the live APIs on every search, same as before. This module only backfills the
corpus so it's already warm by the time Phase 2 (bulk PubMed/bioRxiv ingest)
and Phase 5 (checking the corpus before live APIs) land — see the pre-indexing
plan for the full phased rollout.

Schema is intentionally storage-light: metadata + abstract only (a few KB per
paper), never full text — full text stays fetched-on-demand exactly as it
already works in core/paper_text.py.
"""
import hashlib
import re
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH


def init_corpus_table() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS papers (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                authors     TEXT,
                year        INTEGER,
                venue       TEXT,
                abstract    TEXT,
                url         TEXT,
                source      TEXT,
                domain      TEXT DEFAULT 'other',
                first_seen  TEXT NOT NULL,
                last_seen   TEXT NOT NULL,
                hit_count   INTEGER DEFAULT 1
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_papers_domain ON papers(domain)")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_papers_year ON papers(year)")

        # Phase 3: tracks the last successful incremental sync per source, so
        # the daily job knows to pull only what's new since last time instead
        # of re-fetching (and re-parsing) everything on every run.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_state (
                source        TEXT PRIMARY KEY,
                last_synced   TEXT,
                last_run_at   TEXT,
                last_status   TEXT,
                records_added INTEGER DEFAULT 0
            )
            """
        )


def _norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()


def _paper_key(paper: dict) -> Optional[str]:
    """Stable id for a paper — prefer a DOI/URL if present (most stable across
    sources), fall back to the normalized title (catches the same paper found
    via two different APIs with slightly different metadata)."""
    url = (paper.get("url") or "").strip().lower()
    basis = url or _norm_title(paper.get("title") or "")
    if not basis:
        return None
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


def upsert_papers(papers: list[dict], domain: str = "other") -> None:
    """Write/refresh a batch of live-search results into the local corpus.
    Best-effort — a cache-write failure must never break an actual search."""
    if not papers:
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        with _conn() as conn:
            for p in papers:
                pid = _paper_key(p)
                if not pid:
                    continue
                authors = p.get("authors")
                if isinstance(authors, list):
                    authors = ", ".join(authors)
                conn.execute(
                    f"""
                    INSERT INTO papers (id, title, authors, year, venue, abstract, url,
                                        source, domain, first_seen, last_seen, hit_count)
                    VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},1)
                    ON CONFLICT(id) DO UPDATE SET
                        last_seen = excluded.last_seen,
                        hit_count = papers.hit_count + 1,
                        abstract  = CASE WHEN length(excluded.abstract) > length(papers.abstract)
                                         THEN excluded.abstract ELSE papers.abstract END
                    """,
                    (pid, p.get("title") or "", authors, p.get("year"), p.get("venue"),
                     p.get("abstract") or "", p.get("url"), p.get("source") or "",
                     domain, now, now),
                )
    except Exception:  # noqa: BLE001 — corpus is a cache, never a hard dependency
        pass


def get_last_sync(source: str) -> Optional[str]:
    """ISO date the given source (e.g. 'pubmed', 'biorxiv') was last
    successfully synced through, or None if it's never been run."""
    with _conn() as conn:
        row = conn.execute(
            f"SELECT last_synced FROM sync_state WHERE source = {_PH}", (source,)
        ).fetchone()
    return row["last_synced"] if row else None


def set_last_sync(source: str, synced_through: str, status: str = "ok",
                   records_added: int = 0) -> None:
    """Record a completed (or failed) sync attempt. `synced_through` is the
    date (YYYY-MM-DD) the pull covered up to — next run resumes from here."""
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as conn:
        conn.execute(
            f"""
            INSERT INTO sync_state (source, last_synced, last_run_at, last_status, records_added)
            VALUES ({_PH},{_PH},{_PH},{_PH},{_PH})
            ON CONFLICT(source) DO UPDATE SET
                last_synced   = excluded.last_synced,
                last_run_at   = excluded.last_run_at,
                last_status   = excluded.last_status,
                records_added = excluded.records_added
            """,
            (source, synced_through, now, status, records_added),
        )


def sync_status() -> list[dict]:
    """All sources' sync state, for a status page / CLI check."""
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM sync_state ORDER BY source").fetchall()
    return [dict(r) for r in rows]


def corpus_stats(domain: Optional[str] = None) -> dict:
    """Quick visibility into how warm the local corpus is, per domain."""
    with _conn() as conn:
        if domain:
            row = conn.execute(
                f"SELECT COUNT(*) n, MIN(first_seen) since FROM papers WHERE domain = {_PH}",
                (domain,),
            ).fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) n, MIN(first_seen) since FROM papers").fetchone()
    return {"count": row["n"] if row else 0, "since": row["since"] if row else None}

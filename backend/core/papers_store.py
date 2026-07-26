"""
Papers store — persisted, UUID-keyed paper records + an append-only decision
audit trail (included / maybe / excluded), scoped to a run.

Samhita has no separate "project" resource — one literature review run IS
the unit of work (run_id), so `run_id` plays the role a `project_id` would
in a multi-run system. Ownership is enforced the same way every other
per-run write already is: callers pass the run's owning user_id and it's
verified against `sessions` before any paper write, so a user can only
resolve/add papers into runs they own.

Two tables:
  • papers           — one row per unique paper *within a run*, keyed by a
                        stable UUID (not a list index — indexes shift/aren't
                        stable across edits, UUIDs are permanent).
  • paper_decisions  — append-only log of every included/maybe/excluded
                        decision made about a paper, who made it, and when.
                        The papers page reads the LATEST decision per paper
                        for its current status, but nothing is ever deleted,
                        so the full history is always recoverable.
"""
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH, _PK_AUTOINC


def init_papers_tables() -> None:
    with _conn() as conn:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS papers (
                id               TEXT PRIMARY KEY,
                run_id           TEXT NOT NULL,
                doi              TEXT,
                pmid             TEXT,
                pmcid            TEXT,
                arxiv_id         TEXT,
                openalex_id      TEXT,
                title            TEXT NOT NULL,
                title_norm       TEXT NOT NULL,
                authors          TEXT,
                year             INTEGER,
                venue            TEXT,
                landing_url      TEXT,
                pdf_url          TEXT,
                abstract         TEXT,
                source           TEXT,
                full_text_status TEXT DEFAULT 'unknown',
                idx              INTEGER,
                added_by         TEXT,
                added_from       TEXT,
                created_at       TEXT NOT NULL
            )
        """)
    with _conn() as conn:
        conn.execute("CREATE INDEX IF NOT EXISTS ix_papers_run ON papers (run_id)")
    with _conn() as conn:
        conn.execute("CREATE INDEX IF NOT EXISTS ix_papers_run_title ON papers (run_id, title_norm)")

    with _conn() as conn:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS paper_decisions (
                id          {_PK_AUTOINC},
                paper_id    TEXT NOT NULL,
                run_id      TEXT NOT NULL,
                user_id     TEXT NOT NULL,
                decision    TEXT NOT NULL,
                reason      TEXT,
                created_at  TEXT NOT NULL
            )
        """)
    with _conn() as conn:
        conn.execute("CREATE INDEX IF NOT EXISTS ix_decisions_paper ON paper_decisions (paper_id)")
    with _conn() as conn:
        conn.execute("CREATE INDEX IF NOT EXISTS ix_decisions_run ON paper_decisions (run_id)")


def _norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Duplicate detection ────────────────────────────────────────────────────

def find_duplicate(run_id: str, *, doi: str = "", pmid: str = "", pmcid: str = "",
                    arxiv_id: str = "", title: str = "") -> Optional[dict]:
    """Look for an existing paper in this run matching by canonical identifier
    first (doi/pmid/pmcid/arxiv_id — cheap and unambiguous), falling back to
    normalized-title match only if no identifier matched anything."""
    with _conn() as conn:
        for col, val in (("doi", doi), ("pmid", pmid), ("pmcid", pmcid), ("arxiv_id", arxiv_id)):
            if not val:
                continue
            row = conn.execute(
                f"SELECT * FROM papers WHERE run_id = {_PH} AND {col} = {_PH} LIMIT 1",
                (run_id, val),
            ).fetchone()
            if row:
                return dict(row)
        if title:
            row = conn.execute(
                f"SELECT * FROM papers WHERE run_id = {_PH} AND title_norm = {_PH} LIMIT 1",
                (run_id, _norm_title(title)),
            ).fetchone()
            if row:
                return dict(row)
    return None


# ── Writes ──────────────────────────────────────────────────────────────────

def create_paper(run_id: str, paper: dict, *, added_by: str, added_from: str, idx: int) -> dict:
    """Insert a new canonical paper row and return it (with its new id)."""
    pid = str(uuid.uuid4())
    now = _now()
    row = {
        "id": pid, "run_id": run_id,
        "doi": paper.get("doi") or "", "pmid": paper.get("pmid") or "",
        "pmcid": paper.get("pmcid") or "", "arxiv_id": paper.get("arxiv_id") or "",
        "openalex_id": paper.get("openalex_id") or "",
        "title": paper.get("title") or "", "title_norm": _norm_title(paper.get("title")),
        "authors": paper.get("authors") or "", "year": paper.get("year"),
        "venue": paper.get("venue") or "",
        "landing_url": paper.get("url") or paper.get("landing_url") or "",
        "pdf_url": paper.get("pdf_url") or "",
        "abstract": paper.get("abstract") or "", "source": paper.get("source") or "",
        "full_text_status": "pending", "idx": idx,
        "added_by": added_by, "added_from": added_from, "created_at": now,
    }
    cols = list(row.keys())
    placeholders = ", ".join([_PH] * len(cols))
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO papers ({', '.join(cols)}) VALUES ({placeholders})",
            tuple(row[c] for c in cols),
        )
    return row


def set_full_text_status(paper_id: str, status: str) -> None:
    """'pending' -> 'fetched' | 'unavailable', set by the background retrieval
    task once it finishes trying. Best-effort — never raises into the caller."""
    try:
        with _conn() as conn:
            conn.execute(
                f"UPDATE papers SET full_text_status = {_PH} WHERE id = {_PH}",
                (status, paper_id),
            )
    except Exception:
        pass


def get_paper(paper_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(f"SELECT * FROM papers WHERE id = {_PH}", (paper_id,)).fetchone()
    return dict(row) if row else None


def list_papers(run_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM papers WHERE run_id = {_PH} ORDER BY idx ASC", (run_id,)
        ).fetchall()
    return [dict(r) for r in rows]


# ── Decisions (audit trail) ─────────────────────────────────────────────────

VALID_DECISIONS = ("included", "maybe", "excluded")


def record_decision(paper_id: str, run_id: str, user_id: str, decision: str,
                     reason: str = "") -> dict:
    if decision not in VALID_DECISIONS:
        raise ValueError(f"decision must be one of {VALID_DECISIONS}")
    now = _now()
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO paper_decisions (paper_id, run_id, user_id, decision, reason, created_at) "
            f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
            (paper_id, run_id, user_id, decision, reason or "", now),
        )
    return {"paper_id": paper_id, "run_id": run_id, "user_id": user_id,
            "decision": decision, "reason": reason, "created_at": now}


def latest_decisions(run_id: str) -> dict[str, dict]:
    """Latest decision per paper_id for a run — this is what current status
    (included/maybe/excluded) means; the full history stays in the table."""
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM paper_decisions WHERE run_id = {_PH} ORDER BY created_at ASC",
            (run_id,),
        ).fetchall()
    latest: dict[str, dict] = {}
    for r in rows:
        d = dict(r)
        latest[d["paper_id"]] = d  # later rows overwrite — ORDER BY created_at ASC
    return latest


def decision_history(paper_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM paper_decisions WHERE paper_id = {_PH} ORDER BY created_at ASC",
            (paper_id,),
        ).fetchall()
    return [dict(r) for r in rows]

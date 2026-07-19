"""
Persistent per-paper extraction cache.

Keyed by (paper url, full_text flag), it stores the structured extraction for a
paper so a later run that includes the same paper can skip BOTH the PDF fetch
and the LLM call. Abstract-level and full-text extractions are cached separately
(the flag is part of the key), since Deep mode reads more than Lite/Medium.

Lives in the same SQLite DB as sessions/usage.
"""
import json
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH


def init_paper_cache_table() -> None:
    """Create the cache table if absent. Called from db.init_db()."""
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS paper_cache (
                url         TEXT NOT NULL,
                full_text   INTEGER NOT NULL,   -- 0 = abstract, 1 = full text
                extraction  TEXT NOT NULL,       -- JSON extraction (no idx)
                created_at  TEXT,
                PRIMARY KEY (url, full_text)
            )
            """
        )


def _strip(e: dict) -> dict:
    """Cache extraction fields but not the run-specific idx."""
    e = dict(e)
    e.pop("idx", None)
    return e


def get_cached(url: Optional[str], full_text: bool) -> Optional[dict]:
    """Return a cached extraction (without idx) for this paper, or None."""
    if not url:
        return None
    try:
        with _conn() as conn:
            row = conn.execute(
                f"SELECT extraction FROM paper_cache WHERE url = {_PH} AND full_text = {_PH}",
                (url, 1 if full_text else 0),
            ).fetchone()
        if row:
            return json.loads(row["extraction"])
    except Exception:  # noqa: BLE001 — cache must never break extraction
        pass
    return None


def put_cached(url: Optional[str], full_text: bool, extraction: dict) -> None:
    """Store/refresh an extraction for a paper. Best-effort (never raises)."""
    if not url or not isinstance(extraction, dict):
        return
    try:
        with _conn() as conn:
            conn.execute(
                f"INSERT INTO paper_cache (url, full_text, extraction, created_at) "
                f"VALUES ({_PH},{_PH},{_PH},{_PH}) "
                f"ON CONFLICT(url, full_text) DO UPDATE SET "
                f"extraction = excluded.extraction, created_at = excluded.created_at",
                (url, 1 if full_text else 0, json.dumps(_strip(extraction)),
                 datetime.now(timezone.utc).isoformat()),
            )
    except Exception:  # noqa: BLE001
        pass

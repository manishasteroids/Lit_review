"""
Usage & cost ledger.

Every LLM call is recorded here (one row in `llm_calls`) with its session,
stage, model, token counts, dollar cost and latency.  Aggregation for the
Usage tab is a couple of GROUP BY queries — no LLM needed.

This is deliberately the ONE place cost is computed, so the number the user
sees always matches what actually went over the wire.
"""
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH
from core.pricing import cost_usd, tier_of, PRICES_EFFECTIVE


# extra columns added after the first version — migrated in on startup
_EXTRA_COLS = [
    ("cache_write_tok", "INTEGER DEFAULT 0"),
    ("cache_read_tok", "INTEGER DEFAULT 0"),
    ("web_searches", "INTEGER DEFAULT 0"),
]


def init_usage_table() -> None:
    """Create the llm_calls table if absent, and add any new columns to an
    existing (older-schema) table. Called from db.init_db()."""
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_calls (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id     TEXT,
                stage          TEXT,
                model          TEXT,
                tier           TEXT,
                in_tok         INTEGER DEFAULT 0,
                out_tok        INTEGER DEFAULT 0,
                cache_write_tok INTEGER DEFAULT 0,
                cache_read_tok  INTEGER DEFAULT 0,
                web_searches    INTEGER DEFAULT 0,
                cost_usd       REAL DEFAULT 0,
                latency_ms     INTEGER DEFAULT 0,
                created_at     TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_llm_calls_session ON llm_calls(session_id)")
        # migrate DBs created before these columns existed
        existing = {row[1] for row in conn.execute("PRAGMA table_info(llm_calls)").fetchall()}
        for col, decl in _EXTRA_COLS:
            if col not in existing:
                conn.execute(f"ALTER TABLE llm_calls ADD COLUMN {col} {decl}")


def record_call(
    session_id: Optional[str],
    stage: str,
    model: str,
    in_tok: int,
    out_tok: int,
    latency_ms: int = 0,
    cache_write: int = 0,
    cache_read: int = 0,
    web_searches: int = 0,
) -> None:
    """Log a single model call including cache tokens and server-side
    web_search requests. Never raises into the caller — tracking must not
    break the pipeline, so DB errors are swallowed (best-effort ledger)."""
    if not session_id:
        return
    try:
        c = cost_usd(model, in_tok or 0, out_tok or 0,
                     cache_write or 0, cache_read or 0, web_searches or 0)
        with _conn() as conn:
            conn.execute(
                f"INSERT INTO llm_calls "
                f"(session_id,stage,model,tier,in_tok,out_tok,cache_write_tok,cache_read_tok,"
                f"web_searches,cost_usd,latency_ms,created_at) "
                f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
                (session_id, stage, model, tier_of(model), in_tok or 0, out_tok or 0,
                 cache_write or 0, cache_read or 0, web_searches or 0,
                 c, latency_ms or 0, datetime.now(timezone.utc).isoformat()),
            )
    except Exception:  # noqa: BLE001 — a broken ledger must never break a run
        pass


def get_usage(session_id: str) -> dict:
    """Totals + per-stage + per-model breakdown for one session."""
    with _conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) calls, "
            "COALESCE(SUM(in_tok),0) in_tok, COALESCE(SUM(out_tok),0) out_tok, "
            "COALESCE(SUM(cache_write_tok),0) cache_write_tok, "
            "COALESCE(SUM(cache_read_tok),0) cache_read_tok, "
            "COALESCE(SUM(web_searches),0) web_searches, "
            "COALESCE(SUM(cost_usd),0) cost_usd, COALESCE(SUM(latency_ms),0) latency_ms "
            f"FROM llm_calls WHERE session_id = {_PH}",
            (session_id,),
        ).fetchone()

        by_stage = conn.execute(
            "SELECT stage, "
            "COUNT(*) calls, COALESCE(SUM(in_tok),0) in_tok, COALESCE(SUM(out_tok),0) out_tok, "
            "COALESCE(SUM(web_searches),0) web_searches, "
            "COALESCE(SUM(cost_usd),0) cost_usd, COALESCE(SUM(latency_ms),0) latency_ms "
            f"FROM llm_calls WHERE session_id = {_PH} GROUP BY stage ORDER BY SUM(cost_usd) DESC",
            (session_id,),
        ).fetchall()

        by_model = conn.execute(
            "SELECT model, tier, "
            "COUNT(*) calls, COALESCE(SUM(in_tok),0) in_tok, COALESCE(SUM(out_tok),0) out_tok, "
            "COALESCE(SUM(cost_usd),0) cost_usd "
            f"FROM llm_calls WHERE session_id = {_PH} GROUP BY model, tier ORDER BY SUM(cost_usd) DESC",
            (session_id,),
        ).fetchall()

    def d(row):
        return dict(row)

    return {
        "session_id": session_id,
        "prices_effective": PRICES_EFFECTIVE,
        "total": d(total) if total else {"calls": 0, "in_tok": 0, "out_tok": 0,
                                         "cost_usd": 0, "latency_ms": 0},
        "by_stage": [d(r) for r in by_stage],
        "by_model": [d(r) for r in by_model],
    }


def get_usage_trend(user_id: str, days: int = 30, tz_offset_min: int = 0) -> dict:
    """Per-day token + cost totals for one USER (across all their sessions),
    plus an all-time total. Joins llm_calls -> sessions by user_id.

    `tz_offset_min` is the browser's Date.getTimezoneOffset() (minutes; +480 for
    PST). created_at is stored in UTC, so we shift by -offset to group calls by
    the user's LOCAL calendar day instead of the UTC day.
    """
    shift = -int(tz_offset_min)              # local = utc - offset
    tz_mod = f"{shift:+d} minutes"           # e.g. "-480 minutes" (PST), "+330 minutes" (IST)
    with _conn() as conn:
        by_day = conn.execute(
            "SELECT substr(datetime(c.created_at, ?), 1, 10) AS day, "
            "COUNT(*) calls, COALESCE(SUM(c.in_tok),0) in_tok, "
            "COALESCE(SUM(c.out_tok),0) out_tok, COALESCE(SUM(c.cost_usd),0) cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH} "
            "GROUP BY day ORDER BY day DESC "
            f"LIMIT {int(days)}",
            (tz_mod, user_id),
        ).fetchall()
        total = conn.execute(
            "SELECT COUNT(*) calls, COALESCE(SUM(c.in_tok),0) in_tok, "
            "COALESCE(SUM(c.out_tok),0) out_tok, COALESCE(SUM(c.cost_usd),0) cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH}",
            (user_id,),
        ).fetchone()
        # Per-run time-series points (each review = one point at its date+time).
        # `at` is the raw UTC ISO timestamp; the frontend renders it in local time.
        by_session = conn.execute(
            "SELECT s.id, s.topic, MIN(c.created_at) AS at, "
            "COUNT(*) calls, COALESCE(SUM(c.in_tok),0) in_tok, "
            "COALESCE(SUM(c.out_tok),0) out_tok, COALESCE(SUM(c.cost_usd),0) cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH} "
            "GROUP BY s.id ORDER BY at DESC LIMIT 60",
            (user_id,),
        ).fetchall()

    days_asc = [dict(r) for r in by_day][::-1]   # oldest -> newest for charting
    sessions_asc = [dict(r) for r in by_session][::-1]
    return {
        "prices_effective": PRICES_EFFECTIVE,
        "total": dict(total) if total else {"calls": 0, "in_tok": 0, "out_tok": 0, "cost_usd": 0},
        "by_day": days_asc,
        "by_session": sessions_asc,
    }

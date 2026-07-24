"""
Session persistence layer.

Auto-selects the backend by environment:
  • DATABASE_URL set   → PostgreSQL (cloud; e.g. Supabase)   — via psycopg 3
  • DATABASE_URL unset → SQLite (local dev)                  — zero setup

Every other module (usage, paper_cache, chat_history) imports `_conn` and
`_PH` from here, so this is the ONLY file that knows which database is in use.
The SQL is written to work on both (shared `CREATE TABLE IF NOT EXISTS`,
`ON CONFLICT ... DO UPDATE SET x = excluded.x`, `%s`/`?` placeholders).

Cloud setup:
  1. pip install "psycopg[binary]>=3.1"   (add to requirements.txt)
  2. DATABASE_URL=postgresql://USER:PASSWORD@HOST:6543/postgres  in the env
     (use Supabase's *connection pooling* string, port 6543, for Cloud Run)
"""
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings

_DATABASE_URL = getattr(settings, "database_url", "") or os.environ.get("DATABASE_URL", "")

# True when running on Postgres (cloud); lets sibling modules pick dialect-
# specific SQL (e.g. date bucketing in usage.py) without re-detecting.
IS_POSTGRES = bool(_DATABASE_URL)


if _DATABASE_URL:
    # ══ PostgreSQL (cloud) ══════════════════════════════════════════════════
    import psycopg
    from psycopg.rows import dict_row

    _PH = "%s"
    # Auto-incrementing primary key type (Postgres).
    _PK_AUTOINC = "BIGSERIAL PRIMARY KEY"

    @contextmanager
    def _conn():
        # prepare_threshold=None keeps us compatible with Supabase's pgbouncer
        # pooler (transaction mode), which doesn't support prepared statements.
        conn = psycopg.connect(_DATABASE_URL, row_factory=dict_row, prepare_threshold=None)
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _row_to_dict(row) -> dict:
        return dict(row)

else:
    # ══ SQLite (local dev) ══════════════════════════════════════════════════
    import sqlite3

    _PH = "?"
    # Auto-incrementing primary key type (SQLite).
    _PK_AUTOINC = "INTEGER PRIMARY KEY AUTOINCREMENT"

    @contextmanager
    def _conn():
        db_path = Path(settings.db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _row_to_dict(row) -> dict:
        return dict(row)


# ── Schema ──────────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create tables if they don't exist. Called once at server startup.

    Each DDL that might fail runs in its OWN connection/transaction, so a
    duplicate-column error on Postgres (which aborts the current transaction)
    can't poison the statements that follow — a difference from SQLite."""
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id          TEXT PRIMARY KEY,
                user_id     TEXT,
                topic       TEXT NOT NULL,
                stage       TEXT NOT NULL,
                paper_count INTEGER DEFAULT 0,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                data        TEXT NOT NULL
            )
        """)

    # Upgrade older databases that predate the user_id column (own transaction).
    try:
        with _conn() as conn:
            conn.execute("ALTER TABLE sessions ADD COLUMN user_id TEXT")
    except Exception:
        pass

    with _conn() as conn:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)")

    # sibling tables (share this DB + the _conn/_PH picked above)
    from core.usage import init_usage_table
    init_usage_table()
    from core.paper_cache import init_paper_cache_table
    init_paper_cache_table()
    from core.chat_history import init_chat_history_table
    init_chat_history_table()


# ── Write ───────────────────────────────────────────────────────────────────

def save_session(
    session_id: str,
    topic: str,
    stage: str,
    paper_count: int,
    data: dict,
    user_id: str,
    created_at: Optional[str] = None,
) -> None:
    """Insert or update a session owned by user_id. No LLM calls to restore."""
    now = datetime.now(timezone.utc).isoformat()
    created = created_at or now
    ph = _PH
    sql = f"""
        INSERT INTO sessions (id, user_id, topic, stage, paper_count, created_at, updated_at, data)
        VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})
        ON CONFLICT(id) DO UPDATE SET
            stage       = excluded.stage,
            paper_count = excluded.paper_count,
            updated_at  = excluded.updated_at,
            data        = excluded.data
    """
    with _conn() as conn:
        conn.execute(sql, (session_id, user_id, topic, stage, paper_count, created, now, json.dumps(data)))


def delete_session(session_id: str, user_id: str) -> None:
    with _conn() as conn:
        conn.execute(
            f"DELETE FROM sessions WHERE id = {_PH} AND user_id = {_PH}",
            (session_id, user_id),
        )


def delete_all_for_user(user_id: str) -> int:
    """Delete every session owned by a user (data-deletion control)."""
    with _conn() as conn:
        cur = conn.execute(f"DELETE FROM sessions WHERE user_id = {_PH}", (user_id,))
        return cur.rowcount if cur.rowcount is not None else 0


# ── Read ────────────────────────────────────────────────────────────────────

def list_sessions(user_id: str) -> list[dict]:
    """Summary rows for one user only — no data blob. No LLM calls."""
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT id, topic, stage, paper_count, created_at, updated_at "
            f"FROM sessions WHERE user_id = {_PH} ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_session(session_id: str, user_id: str) -> Optional[dict]:
    """Full session data for UI restore — only if owned by user_id. No LLM calls."""
    with _conn() as conn:
        row = conn.execute(
            f"SELECT * FROM sessions WHERE id = {_PH} AND user_id = {_PH}",
            (session_id, user_id),
        ).fetchone()
    if not row:
        return None
    result = _row_to_dict(row)
    result["data"] = json.loads(result["data"])
    return result
"""
Session persistence layer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 LOCAL  →  SQLite  (active now — zero extra dependencies)
 CLOUD  →  PostgreSQL  (see migration block below)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HOW TO SWITCH TO POSTGRESQL WHEN DEPLOYING TO A SERVER
───────────────────────────────────────────────────────
1. pip install psycopg2-binary
2. Add DATABASE_URL=postgresql://user:password@host:5432/samhita to .env
3. Comment out the SQLITE BLOCK and uncomment the POSTGRESQL BLOCK below.
   That is the ONLY change needed — no other files touch the DB.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings


# ══════════════════════════════════════════════════════════════════════════════
# SQLITE BLOCK — active locally  (comment this out when deploying to cloud)
# ══════════════════════════════════════════════════════════════════════════════
import sqlite3

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

_PH = "?"

def _row_to_dict(row) -> dict:
    return dict(row)

# ══════════════════════════════════════════════════════════════════════════════
# END SQLITE BLOCK
# ══════════════════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════════════════
# POSTGRESQL BLOCK — uncomment when deploying to cloud
# (also comment out the SQLITE BLOCK above)
# ══════════════════════════════════════════════════════════════════════════════
#
# import os
# import psycopg2
#
# @contextmanager
# def _conn():
#     conn = psycopg2.connect(os.environ["DATABASE_URL"])
#     try:
#         yield conn
#         conn.commit()
#     except Exception:
#         conn.rollback()
#         raise
#     finally:
#         conn.close()
#
# _PH = "%s"
#
# def _row_to_dict(row) -> dict:
#     return dict(row)
#
# ══════════════════════════════════════════════════════════════════════════════
# END POSTGRESQL BLOCK
# ══════════════════════════════════════════════════════════════════════════════


# ── Schema ──────────────────────────────────────────────────────────────────

def init_db() -> None:
    """Create tables if they don't exist. Called once at server startup."""
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
        # Upgrade older databases that predate the user_id column.
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN user_id TEXT")
        except Exception:
            pass
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)")
        except Exception:
            pass


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

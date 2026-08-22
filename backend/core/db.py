"""
Session persistence layer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Engine is chosen AUTOMATICALLY at import time:
   • DATABASE_URL set   →  PostgreSQL   (cloud / Supabase)
   • DATABASE_URL unset →  SQLite       (local dev)
 No commenting/uncommenting — set the env var and deploy.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every other core module imports `_conn` and `_PH` from here, so this single
switch flips the whole app between engines. For PostgreSQL you must also have
`psycopg2-binary` installed (add it to requirements.txt).
"""
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings


# ══════════════════════════════════════════════════════════════════════════════
# ENGINE SELECTION  — Postgres if DATABASE_URL is present, else SQLite
# ══════════════════════════════════════════════════════════════════════════════
_DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
_ENGINE = "postgres" if _DATABASE_URL else "sqlite"



if _ENGINE == "postgres":
    # ── PostgreSQL ────────────────────────────────────────────────────────────
    import psycopg2
    import psycopg2.extras

    _PH = "%s"
    _AUTO_ID = "SERIAL PRIMARY KEY"

    class _Cursor:
        """Thin adapter so call sites can keep doing conn.execute(...).fetchone()."""
        def __init__(self, cur):
            self._cur = cur

        def execute(self, sql, params=()):
            self._cur.execute(sql, params)
            return self._cur  # RealDictCursor: has fetchone/fetchall/rowcount

    @contextmanager
    def _conn():
        conn = psycopg2.connect(
            _DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor
        )
        try:
            with conn.cursor() as cur:
                yield _Cursor(cur)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _row_to_dict(row) -> dict:
        return dict(row)  # RealDictRow -> plain dict

else:
    # ── SQLite ────────────────────────────────────────────────────────────────
    import sqlite3

    _PH = "?"
    _AUTO_ID = "INTEGER PRIMARY KEY AUTOINCREMENT"

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


def _add_column(conn, table: str, col: str, coltype: str) -> None:
    """Add a column if missing, in an engine-safe way.

    Postgres aborts the whole transaction on a failed statement, so we can't
    lean on try/except there — we use ADD COLUMN IF NOT EXISTS. SQLite doesn't
    support that clause, so we fall back to try/except.
    """
    if _ENGINE == "postgres":
        conn.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {coltype}")
    else:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}")
        except Exception:
            pass


def _existing_columns(conn, table: str) -> set:
    """Return the set of column names on a table, engine-agnostic."""
    if _ENGINE == "postgres":
        rows = conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
            (table,),
        ).fetchall()
        return {r["column_name"] for r in rows}
    else:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return {r[1] for r in rows}

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
        # Backfill columns that older databases may lack. project_id is read by
        # list_sessions(), so it MUST exist even before the projects migration.
        _add_column(conn, "sessions", "user_id", "TEXT")
        _add_column(conn, "sessions", "project_id", "TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)"
        )

    # sibling tables (share this DB via the same _conn)
    from core.usage import init_usage_table
    init_usage_table()
    from core.paper_cache import init_paper_cache_table
    init_paper_cache_table()
    from core.chat_history import init_chat_history_table
    init_chat_history_table()
    from core.studio_history import init_studio_history_table
    init_studio_history_table()
    from core.profile import init_profile_table
    init_profile_table()
    from core.news import init_news_table
    init_news_table()
    from core.projects import init_projects_tables
    init_projects_tables()
    from core.corpus import init_corpus_table
    init_corpus_table()
    from core.annotations import init_annotations_table
    init_annotations_table()
    from core.known_users import init_known_users_table
    init_known_users_table()
    from core.project_sharing import init_sharing_tables
    init_sharing_tables()


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
        ON CONFLICT (id) DO UPDATE SET
            stage       = EXCLUDED.stage,
            paper_count = EXCLUDED.paper_count,
            updated_at  = EXCLUDED.updated_at,
            data        = EXCLUDED.data
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
            f"SELECT id, topic, stage, paper_count, created_at, updated_at, project_id "
            f"FROM sessions WHERE user_id = {_PH} ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_session(session_id: str, user_id: str) -> Optional[dict]:
    """Full session data for UI restore — owned by user_id, OR filed under a
    project this user collaborates on (a shared project's runs are visible to
    every collaborator, not just whoever ran them — see core/project_sharing.py).
    No LLM calls."""
    with _conn() as conn:
        row = conn.execute(
            f"SELECT * FROM sessions WHERE id = {_PH} AND user_id = {_PH}",
            (session_id, user_id),
        ).fetchone()
        owned_directly = row is not None
        if not row:
            row = conn.execute(
                f"SELECT * FROM sessions WHERE id = {_PH}", (session_id,),
            ).fetchone()
    if not row:
        return None
    result = _row_to_dict(row)
    if not owned_directly:
        project_id = result.get("project_id")
        allowed = False
        if project_id:
            from core.project_sharing import user_has_project_access
            allowed = user_has_project_access(project_id, user_id)
        if not allowed:
            return None
    result["data"] = json.loads(result["data"])
    return result

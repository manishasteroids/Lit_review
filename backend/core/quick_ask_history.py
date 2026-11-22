"""
Short-lived history of "Discuss with Sift AI" quick-ask searches (Home
page). Not a chat log and not meant to be permanent -- just enough so a
user who asked something a few minutes/hours/days ago can reopen it
instead of retyping and re-paying for the same answer. Entries older than
_RETENTION_DAYS are purged lazily (on the next list/record call) rather
than via a background job -- simplest thing that keeps the table small.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from core.db import _conn, _PH

_RETENTION_DAYS = 3
_MAX_PER_USER = 50  # hard cap regardless of age, so one chatty session can't bloat the table


def init_quick_ask_history_table() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS quick_ask_history (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                scope      TEXT NOT NULL,
                question   TEXT NOT NULL,
                answer     TEXT NOT NULL,
                sources    TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_quick_ask_history_user "
            "ON quick_ask_history (user_id, created_at)"
        )


def _cutoff_iso() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=_RETENTION_DAYS)).isoformat()


def _purge_expired(conn, user_id: str) -> None:
    conn.execute(
        f"DELETE FROM quick_ask_history WHERE user_id = {_PH} AND created_at < {_PH}",
        (user_id, _cutoff_iso()),
    )


def record_quick_ask(user_id: Optional[str], scope: str, question: str, answer: str,
                      sources: Optional[list[dict]] = None) -> None:
    if not user_id or not question:
        return
    try:
        with _conn() as conn:
            _purge_expired(conn, user_id)
            conn.execute(
                f"INSERT INTO quick_ask_history (id, user_id, scope, question, answer, sources, created_at) "
                f"VALUES ({_PH}, {_PH}, {_PH}, {_PH}, {_PH}, {_PH}, {_PH})",
                (str(uuid.uuid4()), user_id, scope, question.strip(), answer or "",
                 json.dumps(sources or []), datetime.now(timezone.utc).isoformat()),
            )
            # keep only the most recent _MAX_PER_USER rows for this user
            ids = [r["id"] for r in conn.execute(
                f"SELECT id FROM quick_ask_history WHERE user_id = {_PH} "
                f"ORDER BY created_at DESC",
                (user_id,),
            ).fetchall()]
            for stale_id in ids[_MAX_PER_USER:]:
                conn.execute(f"DELETE FROM quick_ask_history WHERE id = {_PH}", (stale_id,))
    except Exception:  # noqa: BLE001 -- history is a convenience, never block the answer on it
        pass


def list_recent(user_id: Optional[str], limit: int = 20) -> list[dict]:
    if not user_id:
        return []
    try:
        with _conn() as conn:
            _purge_expired(conn, user_id)
            rows = conn.execute(
                f"SELECT id, scope, question, answer, sources, created_at "
                f"FROM quick_ask_history WHERE user_id = {_PH} "
                f"ORDER BY created_at DESC LIMIT {_PH}",
                (user_id, limit),
            ).fetchall()
        out = []
        for r in rows:
            r = dict(r)
            try:
                r["sources"] = json.loads(r["sources"]) or []
            except Exception:  # noqa: BLE001
                r["sources"] = []
            out.append(r)
        return out
    except Exception:  # noqa: BLE001
        return []


def delete_entry(user_id: Optional[str], entry_id: str) -> None:
    if not user_id or not entry_id:
        return
    try:
        with _conn() as conn:
            conn.execute(
                f"DELETE FROM quick_ask_history WHERE id = {_PH} AND user_id = {_PH}",
                (entry_id, user_id),
            )
    except Exception:  # noqa: BLE001
        pass

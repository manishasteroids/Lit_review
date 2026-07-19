"""
Per-paper chat history.

Keyed by (user_id, paper_key) where paper_key is the paper's URL — so a chat
follows the PAPER, not a particular run/session, and persists across runs and
devices. The message list is stored as JSON (text only; image data is stripped
before saving to keep the DB small).
"""
import json
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH

_MAX_JSON = 400_000   # safety cap on stored history size


def init_chat_history_table() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_history (
                user_id    TEXT NOT NULL,
                paper_key  TEXT NOT NULL,
                messages   TEXT NOT NULL,
                updated_at TEXT,
                PRIMARY KEY (user_id, paper_key)
            )
            """
        )


def get_chat(user_id: Optional[str], paper_key: Optional[str]) -> list[dict]:
    if not user_id or not paper_key:
        return []
    try:
        with _conn() as conn:
            row = conn.execute(
                f"SELECT messages FROM chat_history WHERE user_id = {_PH} AND paper_key = {_PH}",
                (user_id, paper_key),
            ).fetchone()
        return json.loads(row["messages"]) if row else []
    except Exception:  # noqa: BLE001
        return []


def save_chat(user_id: Optional[str], paper_key: Optional[str], messages: list[dict]) -> None:
    if not user_id or not paper_key:
        return
    # strip image blobs — keep role + content only
    compact = [{"role": m.get("role"), "content": m.get("content")}
               for m in (messages or []) if m.get("content")]
    payload = json.dumps(compact)
    if len(payload) > _MAX_JSON:  # drop oldest until it fits
        while compact and len(json.dumps(compact)) > _MAX_JSON:
            compact.pop(0)
        payload = json.dumps(compact)
    try:
        with _conn() as conn:
            conn.execute(
                f"INSERT INTO chat_history (user_id, paper_key, messages, updated_at) "
                f"VALUES ({_PH},{_PH},{_PH},{_PH}) "
                f"ON CONFLICT(user_id, paper_key) DO UPDATE SET "
                f"messages = excluded.messages, updated_at = excluded.updated_at",
                (user_id, paper_key, payload, datetime.now(timezone.utc).isoformat()),
            )
    except Exception:  # noqa: BLE001
        pass

"""
Studio (multi-paper) chat history.

Keyed by (user_id, run_id) — Studio is presented as one conversation per
run, unlike single-paper chat (core/chat_history.py) which follows a paper
across runs. Mirrors that module's shape/limits closely on purpose so the
two stay easy to reason about together.
"""
import json
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH

_MAX_JSON = 400_000   # safety cap on stored history size


def init_studio_history_table() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS studio_history (
                user_id    TEXT NOT NULL,
                run_id     TEXT NOT NULL,
                messages   TEXT NOT NULL,
                updated_at TEXT,
                PRIMARY KEY (user_id, run_id)
            )
            """
        )


def get_studio_chat(user_id: Optional[str], run_id: Optional[str]) -> list[dict]:
    if not user_id or not run_id:
        return []
    try:
        with _conn() as conn:
            row = conn.execute(
                f"SELECT messages FROM studio_history WHERE user_id = {_PH} AND run_id = {_PH}",
                (user_id, run_id),
            ).fetchone()
        return json.loads(row["messages"]) if row else []
    except Exception:  # noqa: BLE001
        return []


def save_studio_chat(user_id: Optional[str], run_id: Optional[str], messages: list[dict]) -> None:
    if not user_id or not run_id:
        return
    # strip anything beyond role + content — followups/sources are cheap to
    # regenerate on the next question and don't need to survive a reload.
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
                f"INSERT INTO studio_history (user_id, run_id, messages, updated_at) "
                f"VALUES ({_PH},{_PH},{_PH},{_PH}) "
                f"ON CONFLICT(user_id, run_id) DO UPDATE SET "
                f"messages = excluded.messages, updated_at = excluded.updated_at",
                (user_id, run_id, payload, datetime.now(timezone.utc).isoformat()),
            )
    except Exception:  # noqa: BLE001
        pass

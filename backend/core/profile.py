"""
User profile.

Researcher-facing identity that belongs to the app rather than the auth
provider: display name plus scholarly identifiers (ORCID, Google Scholar).
Keyed by the same user_id the rest of the app scopes data with, so it works in
local mode today and per-user once Supabase auth is configured.
"""
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH

FIELDS = ("display_name", "orcid", "scholar_url", "affiliation")


def init_profile_table() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_profile (
                user_id      TEXT PRIMARY KEY,
                display_name TEXT,
                orcid        TEXT,
                scholar_url  TEXT,
                affiliation  TEXT,
                updated_at   TEXT
            )
            """
        )


def get_profile(user_id: str) -> dict:
    try:
        with _conn() as conn:
            row = conn.execute(
                f"SELECT * FROM user_profile WHERE user_id = {_PH}", (user_id,)
            ).fetchone()
        return dict(row) if row else {}
    except Exception:  # noqa: BLE001
        return {}


def save_profile(user_id: str, data: dict) -> dict:
    """Upsert the editable fields. Unknown keys are ignored."""
    vals = {k: (data.get(k) or "").strip() for k in FIELDS}
    now = datetime.now(timezone.utc).isoformat()
    cols = ", ".join(FIELDS)
    ph = ", ".join([_PH] * len(FIELDS))
    updates = ", ".join(f"{k} = excluded.{k}" for k in FIELDS)
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO user_profile (user_id, {cols}, updated_at) "
            f"VALUES ({_PH}, {ph}, {_PH}) "
            f"ON CONFLICT(user_id) DO UPDATE SET {updates}, updated_at = excluded.updated_at",
            (user_id, *[vals[k] for k in FIELDS], now),
        )
    return get_profile(user_id)

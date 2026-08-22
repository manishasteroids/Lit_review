"""
User profile.

Researcher-facing identity that belongs to the app rather than the auth
provider: display name plus scholarly identifiers (ORCID, Google Scholar).
Keyed by the same user_id the rest of the app scopes data with, so it works in
local mode today and per-user once Supabase auth is configured.
"""
from datetime import datetime, timezone
from typing import Optional

from core.db import _add_column, _conn, _PH

# `timezone_pref` (not `timezone`, to avoid shadowing the stdlib import above)
# is an IANA zone name (e.g. "America/Los_Angeles"), used to render absolute
# timestamps (History list, etc.) in the researcher's own timezone rather
# than whatever the browser happens to guess. Empty string = "use the
# browser's local timezone", the same default as before this field existed.
FIELDS = ("display_name", "orcid", "scholar_url", "affiliation", "timezone_pref")


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
        # Backfill for databases created before timezone_pref existed.
        _add_column(conn, "user_profile", "timezone_pref", "TEXT")


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

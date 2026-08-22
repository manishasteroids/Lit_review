"""
Known users — a lightweight (user_id -> email) directory.

Supabase JWTs carry an `email` claim, but the backend never persisted it
anywhere: every table keys off the opaque `sub` (user id) only. Project
sharing needs to turn "invite jane@lab.edu" into a user id, and there's no
Supabase service-role key configured in this app (see core/auth.py), so we
can't call the Supabase Admin API to look a user up by email.

Instead, this fills in opportunistically: every time a request is
authenticated (core/auth.py's `_remember`), we upsert (user_id, email) here.
So a user becomes "known" the first time they sign into Sift at all — which
in practice means by the time anyone shares a project with them, they've
already logged in at least once. If they haven't, `lookup_user_id_by_email`
returns None and the caller surfaces a clear "ask them to sign in once first"
message rather than failing silently.
"""
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH


def init_known_users_table() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS known_users (
                user_id    TEXT PRIMARY KEY,
                email      TEXT NOT NULL,
                last_seen  TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_known_users_email ON known_users(email)")


def remember_user(user_id: str, email: str) -> None:
    email = (email or "").strip().lower()
    if not user_id or not email:
        return
    now = datetime.now(timezone.utc).isoformat()
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO known_users (user_id, email, last_seen) VALUES ({_PH},{_PH},{_PH}) "
            f"ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, last_seen = excluded.last_seen",
            (user_id, email, now),
        )


def lookup_user_id_by_email(email: str) -> Optional[str]:
    email = (email or "").strip().lower()
    if not email:
        return None
    with _conn() as conn:
        row = conn.execute(
            f"SELECT user_id FROM known_users WHERE email = {_PH} ORDER BY last_seen DESC",
            (email,),
        ).fetchone()
    return (dict(row)["user_id"]) if row else None

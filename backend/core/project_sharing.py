"""
Project sharing — two independent mechanisms:

  1. Collaborators: another registered Sift user gets full read/write access
     to a project (papers, notes, runs filed under it — same as the owner,
     except they can't delete the project or manage sharing). Invited by
     email, resolved to a user id via core/known_users.py (opportunistic
     directory — see that module's docstring for why there's no Supabase
     admin lookup here).

  2. Share links: a read-only link scoped to a list of allowed emails, for
     people who don't have (or don't need) a Sift account. The owner
     generates the link and sends it themselves — there's no mailer wired up,
     so this is "copy and share", not an automated invite email. A visitor
     confirms their email matches the allowlist before seeing anything.

`user_has_project_access()` is the single choke point both project CRUD
(core/projects.py) and run access (core/db.py's get_session) call through, so
"can this user see this project" has one definition everywhere.
"""
import json
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH


def init_sharing_tables() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_collaborators (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL,
                user_id     TEXT NOT NULL,
                email       TEXT,
                added_by    TEXT NOT NULL,
                added_at    TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_collab_project ON project_collaborators(project_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_collab_user ON project_collaborators(user_id)")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_share_links (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL,
                token           TEXT NOT NULL,
                allowed_emails  TEXT NOT NULL,
                created_by      TEXT NOT NULL,
                created_at      TEXT NOT NULL,
                revoked_at      TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_share_project ON project_share_links(project_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_share_token ON project_share_links(token)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_project_owner(project_id: str, user_id: str) -> bool:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT id FROM projects WHERE id = {_PH} AND user_id = {_PH}",
            (project_id, user_id),
        ).fetchone()
    return row is not None


def user_has_project_access(project_id: str, user_id: str) -> bool:
    """Owner OR collaborator. This is the one function every other module
    should call to decide "can this user see this project's stuff"."""
    if not project_id or not user_id:
        return False
    if is_project_owner(project_id, user_id):
        return True
    with _conn() as conn:
        row = conn.execute(
            f"SELECT id FROM project_collaborators WHERE project_id = {_PH} AND user_id = {_PH}",
            (project_id, user_id),
        ).fetchone()
    return row is not None


# ── Collaborators ────────────────────────────────────────────────────────────

def list_collaborators(project_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM project_collaborators WHERE project_id = {_PH} ORDER BY added_at",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def add_collaborator(project_id: str, added_by: str, email: str) -> dict:
    """Owner-only (enforced by the route). Raises ValueError with a
    user-facing message on any failure — no invited user found, already the
    owner, already a collaborator."""
    from core.known_users import lookup_user_id_by_email

    email = (email or "").strip().lower()
    if not email:
        raise ValueError("Enter an email address.")
    target_user_id = lookup_user_id_by_email(email)
    if not target_user_id:
        raise ValueError(
            f"{email} hasn't signed into Sift yet. Ask them to log in once, then try sharing again."
        )
    if target_user_id == added_by:
        raise ValueError("That's your own account.")
    with _conn() as conn:
        existing = conn.execute(
            f"SELECT id FROM project_collaborators WHERE project_id = {_PH} AND user_id = {_PH}",
            (project_id, target_user_id),
        ).fetchone()
        if existing:
            raise ValueError(f"{email} already has access to this project.")
        cid = uuid.uuid4().hex[:12]
        now = _now()
        conn.execute(
            f"INSERT INTO project_collaborators (id, project_id, user_id, email, added_by, added_at) "
            f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
            (cid, project_id, target_user_id, email, added_by, now),
        )
    return {"id": cid, "project_id": project_id, "user_id": target_user_id, "email": email, "added_at": now}


def remove_collaborator(project_id: str, user_id: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            f"DELETE FROM project_collaborators WHERE project_id = {_PH} AND user_id = {_PH}",
            (project_id, user_id),
        )
        return cur.rowcount > 0


# ── Share links (read-only, email-gated) ────────────────────────────────────

def create_share_link(project_id: str, created_by: str, emails: list[str]) -> dict:
    emails = sorted({(e or "").strip().lower() for e in (emails or []) if (e or "").strip()})
    if not emails:
        raise ValueError("Add at least one email address to share with.")
    token = secrets.token_urlsafe(20)
    now = _now()
    lid = uuid.uuid4().hex[:12]
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO project_share_links "
            f"(id, project_id, token, allowed_emails, created_by, created_at) "
            f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
            (lid, project_id, token, json.dumps(emails), created_by, now),
        )
    return {"id": lid, "project_id": project_id, "token": token, "allowed_emails": emails,
            "created_at": now, "revoked_at": None}


def list_share_links(project_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM project_share_links WHERE project_id = {_PH} ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["allowed_emails"] = json.loads(d["allowed_emails"])
        out.append(d)
    return out


def revoke_share_link(project_id: str, link_id: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE project_share_links SET revoked_at = {_PH} "
            f"WHERE id = {_PH} AND project_id = {_PH} AND revoked_at IS NULL",
            (_now(), link_id, project_id),
        )
        return cur.rowcount > 0


def get_share_link_by_token(token: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT * FROM project_share_links WHERE token = {_PH}", (token,),
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["allowed_emails"] = json.loads(d["allowed_emails"])
    return d


def verify_share_access(token: str, email: str) -> Optional[dict]:
    """Returns the (unrevoked) share-link row if `email` is on its allowlist,
    else None. Callers should treat None as a 403/404 — don't distinguish
    "bad token" from "wrong email" in the response, to avoid leaking which
    emails were invited."""
    link = get_share_link_by_token(token)
    if not link or link.get("revoked_at"):
        return None
    email = (email or "").strip().lower()
    if email not in link["allowed_emails"]:
        return None
    return link

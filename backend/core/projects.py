"""
Projects — a user-organized folder for a line of research.

A project groups together:
  - runs/sessions (literature reviews) the user chose to file under it
  - a standalone paper library (papers saved on purpose, independent of any
    one run — e.g. imported from Zotero, or pinned from Sources)
  - free-form notes

Everything here is plain CRUD against SQLite; no LLM calls anywhere in this
module, so opening/browsing a project never costs tokens.
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH, _existing_columns


def init_projects_tables() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                name        TEXT NOT NULL,
                description TEXT,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_projects_user ON projects(user_id)")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_papers (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL,
                user_id     TEXT NOT NULL,
                paper       TEXT NOT NULL,
                source      TEXT DEFAULT 'manual',
                added_at    TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_pp_project ON project_papers(project_id)")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_notes (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL,
                user_id     TEXT NOT NULL,
                title       TEXT,
                body        TEXT,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_pn_project ON project_notes(project_id)")

        # sessions.project_id — a run can (optionally) be filed under a project.
        # existing = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
        existing = _existing_columns(conn, "sessions")
        if "project_id" not in existing:
            conn.execute("ALTER TABLE sessions ADD COLUMN project_id TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project_id)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Projects ────────────────────────────────────────────────────────────────

def create_project(user_id: str, name: str, description: str = "") -> dict:
    pid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO projects (id, user_id, name, description, created_at, updated_at) "
            f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
            (pid, user_id, name.strip() or "Untitled project", (description or "").strip(), now, now),
        )
    return get_project(pid, user_id)


def list_projects(user_id: str) -> list[dict]:
    """Projects the user owns, plus projects they've been added to as a
    collaborator (full access — see core/project_sharing.py). `role` tells
    the frontend whether to show owner-only controls (delete, sharing)."""
    with _conn() as conn:
        owned = conn.execute(
            "SELECT p.*, 'owner' AS role, "
            "(SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS run_count, "
            "(SELECT COUNT(*) FROM project_papers pp WHERE pp.project_id = p.id) AS paper_count, "
            "(SELECT COUNT(*) FROM project_notes pn WHERE pn.project_id = p.id) AS note_count "
            f"FROM projects p WHERE p.user_id = {_PH}",
            (user_id,),
        ).fetchall()
        shared = conn.execute(
            "SELECT p.*, 'collaborator' AS role, "
            "(SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS run_count, "
            "(SELECT COUNT(*) FROM project_papers pp WHERE pp.project_id = p.id) AS paper_count, "
            "(SELECT COUNT(*) FROM project_notes pn WHERE pn.project_id = p.id) AS note_count "
            "FROM projects p JOIN project_collaborators c ON c.project_id = p.id "
            f"WHERE c.user_id = {_PH}",
            (user_id,),
        ).fetchall()
    rows = [dict(r) for r in owned] + [dict(r) for r in shared]
    rows.sort(key=lambda r: r["updated_at"], reverse=True)
    return rows


def get_project(project_id: str, user_id: str) -> Optional[dict]:
    from core.project_sharing import user_has_project_access

    with _conn() as conn:
        row = conn.execute(f"SELECT * FROM projects WHERE id = {_PH}", (project_id,)).fetchone()
        if not row:
            return None
        proj = dict(row)
        if not user_has_project_access(project_id, user_id):
            return None
        # Every run filed under a shared project is visible to every
        # collaborator, not just whoever ran it — that's the point of sharing.
        runs = conn.execute(
            "SELECT id, user_id, topic, stage, paper_count, created_at, updated_at "
            f"FROM sessions WHERE project_id = {_PH} ORDER BY updated_at DESC",
            (project_id,),
        ).fetchall()
        papers = conn.execute(
            f"SELECT * FROM project_papers WHERE project_id = {_PH} ORDER BY added_at DESC",
            (project_id,),
        ).fetchall()
        notes = conn.execute(
            f"SELECT * FROM project_notes WHERE project_id = {_PH} ORDER BY updated_at DESC",
            (project_id,),
        ).fetchall()
    proj["role"] = "owner" if proj["user_id"] == user_id else "collaborator"
    proj["runs"] = [dict(r) for r in runs]
    proj["papers"] = [{**dict(r), "paper": json.loads(r["paper"])} for r in papers]
    proj["notes"] = [dict(r) for r in notes]
    return proj


def update_project(project_id: str, user_id: str, name: Optional[str] = None,
                    description: Optional[str] = None) -> Optional[dict]:
    from core.project_sharing import user_has_project_access

    if not user_has_project_access(project_id, user_id):
        return None
    sets, vals = [], []
    if name is not None:
        sets.append("name = " + _PH); vals.append(name.strip() or "Untitled project")
    if description is not None:
        sets.append("description = " + _PH); vals.append(description.strip())
    if not sets:
        return get_project(project_id, user_id)
    sets.append("updated_at = " + _PH); vals.append(_now())
    vals += [project_id]
    with _conn() as conn:
        conn.execute(
            f"UPDATE projects SET {', '.join(sets)} WHERE id = {_PH}", vals,
        )
    return get_project(project_id, user_id)


def delete_project(project_id: str, user_id: str, keep_runs: bool = True) -> bool:
    """Delete a project and its papers/notes. Runs filed under it are kept
    (just unlinked) by default, since a review is valuable on its own."""
    with _conn() as conn:
        owner = conn.execute(
            f"SELECT id FROM projects WHERE id = {_PH} AND user_id = {_PH}", (project_id, user_id),
        ).fetchone()
        if not owner:
            return False
        if keep_runs:
            conn.execute(
                f"UPDATE sessions SET project_id = NULL WHERE project_id = {_PH} AND user_id = {_PH}",
                (project_id, user_id),
            )
        else:
            conn.execute(
                f"DELETE FROM sessions WHERE project_id = {_PH} AND user_id = {_PH}",
                (project_id, user_id),
            )
        conn.execute(f"DELETE FROM project_papers WHERE project_id = {_PH}", (project_id,))
        conn.execute(f"DELETE FROM project_notes WHERE project_id = {_PH}", (project_id,))
        conn.execute(f"DELETE FROM project_collaborators WHERE project_id = {_PH}", (project_id,))
        conn.execute(f"DELETE FROM project_share_links WHERE project_id = {_PH}", (project_id,))
        conn.execute(f"DELETE FROM projects WHERE id = {_PH}", (project_id,))
    return True


def assign_session(session_id: str, user_id: str, project_id: Optional[str]) -> bool:
    """File (or unfile, if project_id is None) a run under a project. The run
    must be your own; the project just needs to be one you have access to
    (owner or collaborator) — a collaborator can file their own runs into a
    shared project."""
    from core.project_sharing import user_has_project_access

    if project_id and not user_has_project_access(project_id, user_id):
        return False
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE sessions SET project_id = {_PH} WHERE id = {_PH} AND user_id = {_PH}",
            (project_id, session_id, user_id),
        )
        return cur.rowcount > 0


# ── Saved papers ────────────────────────────────────────────────────────────

def add_paper(project_id: str, user_id: str, paper: dict, source: str = "manual") -> dict:
    pid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO project_papers (id, project_id, user_id, paper, source, added_at) "
            f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
            (pid, project_id, user_id, json.dumps(paper), source, now),
        )
        conn.execute(f"UPDATE projects SET updated_at = {_PH} WHERE id = {_PH}", (now, project_id))
    return {"id": pid, "project_id": project_id, "paper": paper, "source": source, "added_at": now}


def remove_paper(project_id: str, user_id: str, paper_id: str) -> bool:
    """No user_id filter on the row itself — any collaborator with access to
    the project can remove a paper someone else added (full edit access).
    The route already gates on get_project(project_id, user_id) first."""
    with _conn() as conn:
        cur = conn.execute(
            f"DELETE FROM project_papers WHERE id = {_PH} AND project_id = {_PH}",
            (paper_id, project_id),
        )
        return cur.rowcount > 0


# ── Notes ───────────────────────────────────────────────────────────────────

def add_note(project_id: str, user_id: str, title: str, body: str) -> dict:
    nid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO project_notes (id, project_id, user_id, title, body, created_at, updated_at) "
            f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
            (nid, project_id, user_id, title or "", body or "", now, now),
        )
        conn.execute(f"UPDATE projects SET updated_at = {_PH} WHERE id = {_PH}", (now, project_id))
    return {"id": nid, "project_id": project_id, "title": title, "body": body,
            "created_at": now, "updated_at": now}


def update_note(project_id: str, user_id: str, note_id: str,
                 title: Optional[str] = None, body: Optional[str] = None) -> Optional[dict]:
    """No user_id filter on the row — any collaborator can edit a note
    someone else wrote (full edit access). Route gates on project access."""
    sets, vals = [], []
    if title is not None:
        sets.append("title = " + _PH); vals.append(title)
    if body is not None:
        sets.append("body = " + _PH); vals.append(body)
    if not sets:
        return None
    sets.append("updated_at = " + _PH); vals.append(_now())
    vals += [note_id, project_id]
    with _conn() as conn:
        conn.execute(
            f"UPDATE project_notes SET {', '.join(sets)} "
            f"WHERE id = {_PH} AND project_id = {_PH}", vals,
        )
        row = conn.execute(f"SELECT * FROM project_notes WHERE id = {_PH}", (note_id,)).fetchone()
    return dict(row) if row else None


def remove_note(project_id: str, user_id: str, note_id: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            f"DELETE FROM project_notes WHERE id = {_PH} AND project_id = {_PH}",
            (note_id, project_id),
        )
        return cur.rowcount > 0

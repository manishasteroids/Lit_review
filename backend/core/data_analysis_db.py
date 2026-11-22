"""
Persistence for Data Analysis Agent runs -- its own table, mirroring
core/hypothesis_db.py's pattern exactly: a run here is never coupled to
`sessions`, and nothing in api/routes.py reads this table. A run is
created standalone by default (project_id is nullable) -- per
data_analysis_agent_architecture.md SS9.1 decision 3, this tool is usable
without ever having a Sift/Hypothesis project, and only attaches to one
when the researcher explicitly opens it from an existing project.

One row per uploaded dataset: the profile computed at upload time (column
stats, detected structure) plus every figure rendered against it so far,
both inside `data` exactly as core/data_ingest.py and
pipeline/plot_renderer.py produce them.
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from core.db import _add_column, _conn, _PH


def init_data_analysis_table() -> None:
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS data_analysis_runs (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                project_id  TEXT,
                filename    TEXT NOT NULL,
                status      TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                data        TEXT NOT NULL
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_data_analysis_runs_user "
            "ON data_analysis_runs (user_id)"
        )
        # Defensive backfill for any pre-existing table from an earlier dev
        # run of this migration, same pattern core/db.py uses everywhere.
        _add_column(conn, "data_analysis_runs", "project_id", "TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_data_analysis_runs_project "
            "ON data_analysis_runs (project_id)"
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_data_analysis_run(
    user_id: str, filename: str, data: dict,
    project_id: Optional[str] = None, status: str = "profiled",
) -> dict:
    run_id = uuid.uuid4().hex
    now = _now()
    ph = _PH
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO data_analysis_runs "
            f"(id, user_id, project_id, filename, status, created_at, updated_at, data) "
            f"VALUES ({ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph})",
            (run_id, user_id, project_id, filename, status, now, now, json.dumps(data)),
        )
    return {
        "id": run_id, "user_id": user_id, "project_id": project_id,
        "filename": filename, "status": status,
        "created_at": now, "updated_at": now, "data": data,
    }


def get_data_analysis_run(run_id: str, user_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT * FROM data_analysis_runs WHERE id = {_PH} AND user_id = {_PH}",
            (run_id, user_id),
        ).fetchone()
    if not row:
        return None
    result = dict(row)
    result["data"] = json.loads(result["data"])
    return result


def update_data_analysis_run_data(
    run_id: str, user_id: str, data: dict, status: Optional[str] = None,
) -> Optional[dict]:
    """Overwrite a run's `data` blob in place -- used after every render so
    the figure list grows across calls. Scoped to user_id, same as every
    other lookup here, so one user can never touch another's run."""
    ph = _PH
    now = _now()
    with _conn() as conn:
        if status:
            cur = conn.execute(
                f"UPDATE data_analysis_runs SET data = {ph}, status = {ph}, updated_at = {ph} "
                f"WHERE id = {ph} AND user_id = {ph}",
                (json.dumps(data), status, now, run_id, user_id),
            )
        else:
            cur = conn.execute(
                f"UPDATE data_analysis_runs SET data = {ph}, updated_at = {ph} "
                f"WHERE id = {ph} AND user_id = {ph}",
                (json.dumps(data), now, run_id, user_id),
            )
        if cur.rowcount == 0:
            return None
    return get_data_analysis_run(run_id, user_id)


def set_data_analysis_run_project(
    run_id: str, user_id: str, project_id: Optional[str],
) -> Optional[dict]:
    """Attach (or detach, when project_id is None) this run to a project
    after the fact -- lets a researcher start standalone and file the
    analysis under a project later, or move it back out, mirroring
    `assign_run_project` for Sift/Hypothesis runs (core/projects.py)."""
    ph = _PH
    now = _now()
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE data_analysis_runs SET project_id = {ph}, updated_at = {ph} "
            f"WHERE id = {ph} AND user_id = {ph}",
            (project_id, now, run_id, user_id),
        )
        if cur.rowcount == 0:
            return None
    return get_data_analysis_run(run_id, user_id)


def list_data_analysis_runs(
    user_id: str, project_id: Optional[str] = None,
) -> list[dict]:
    """Summary rows only (no `data` blob) -- for a run picker / history
    list. Newest first. `project_id` filters to runs opened from that
    project; omitted, returns every run this user has (standalone included)."""
    ph = _PH
    with _conn() as conn:
        if project_id:
            rows = conn.execute(
                f"SELECT id, filename, status, created_at, updated_at, project_id "
                f"FROM data_analysis_runs WHERE user_id = {ph} AND project_id = {ph} "
                f"ORDER BY updated_at DESC",
                (user_id, project_id),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT id, filename, status, created_at, updated_at, project_id "
                f"FROM data_analysis_runs WHERE user_id = {ph} ORDER BY updated_at DESC",
                (user_id,),
            ).fetchall()
    return [dict(r) for r in rows]


def delete_data_analysis_run(run_id: str, user_id: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            f"DELETE FROM data_analysis_runs WHERE id = {_PH} AND user_id = {_PH}",
            (run_id, user_id),
        )
        return cur.rowcount > 0

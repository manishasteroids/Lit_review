"""
Persistence for Hypothesis Agent runs -- deliberately its OWN table, separate
from `sessions` (Sift's own run storage). Nothing in this module writes to
`sessions`, and nothing in api/routes.py (Sift's own routes) reads this
table -- the only thing shared right now is the physical database file (see
hypothesis_agent_architecture.md SS1.2: the service split is deferred, but
starting the data boundary here means moving this table to its own database
later is a config change, not a rewrite).

One row per hypothesis run: which Sift run it was built from (`source_run_id`),
and the full pipeline output (topic, bridge candidates, plan, critique) in
`data`, exactly as returned by hypothesis_agent/pipeline.py.
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH


def init_hypothesis_table() -> None:
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS hypothesis_runs (
                id             TEXT PRIMARY KEY,
                user_id        TEXT NOT NULL,
                source_run_id  TEXT NOT NULL,
                source_topic   TEXT,
                status         TEXT NOT NULL,
                created_at     TEXT NOT NULL,
                data           TEXT NOT NULL
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_hypothesis_runs_user "
            "ON hypothesis_runs (user_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_hypothesis_runs_source "
            "ON hypothesis_runs (source_run_id)"
        )
        # project_id -- snapshotted from the source Sift session at creation
        # time (core/projects.py's unified Project model). Lets a hypothesis
        # run be tied to a *project*, not just the one Sift session it was
        # generated from, so get_staleness() below can notice ANY newer
        # completed Lit Review session filed under the same project -- not
        # only edits to the exact session it was built from.
        from core.db import _add_column
        _add_column(conn, "hypothesis_runs", "project_id", "TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_hypothesis_runs_project "
            "ON hypothesis_runs (project_id)"
        )


def create_hypothesis_run(
    user_id: str, source_run_id: str, source_topic: str, status: str, data: dict,
    project_id: Optional[str] = None,
) -> dict:
    """project_id is a snapshot of the source Sift session's project at the
    moment this run was created (looked up by the caller via core.db.get_session
    -- this module doesn't reach into sessions itself, same one-directional-read
    boundary the rest of this file already keeps). None if that session wasn't
    filed under a project. See get_staleness() for what this unlocks."""
    run_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    ph = _PH
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO hypothesis_runs "
            f"(id, user_id, source_run_id, source_topic, status, created_at, data, project_id) "
            f"VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})",
            (run_id, user_id, source_run_id, source_topic, status, now, json.dumps(data), project_id),
        )
    return {
        "id": run_id, "user_id": user_id, "source_run_id": source_run_id,
        "source_topic": source_topic, "status": status, "created_at": now, "data": data,
        "project_id": project_id,
    }


def get_hypothesis_run(run_id: str, user_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT * FROM hypothesis_runs WHERE id = {_PH} AND user_id = {_PH}",
            (run_id, user_id),
        ).fetchone()
    if not row:
        return None
    result = dict(row)
    result["data"] = json.loads(result["data"])
    return result


def update_hypothesis_run_data(run_id: str, user_id: str, data: dict) -> Optional[dict]:
    """Overwrite a run's `data` blob in place -- used by the user-supplied-
    results check (api/hypothesis_routes.py's /check-results and
    /apply-refinement) to append a validation record or apply a refined
    hypothesis back onto the saved run. Scoped to user_id same as every
    other lookup here, so one user can never touch another's run. Returns
    the updated row (same shape as get_hypothesis_run), or None if no row
    matched (wrong id, or not this user's)."""
    ph = _PH
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE hypothesis_runs SET data = {ph} WHERE id = {ph} AND user_id = {ph}",
            (json.dumps(data), run_id, user_id),
        )
        if cur.rowcount == 0:
            return None
    return get_hypothesis_run(run_id, user_id)


def list_hypothesis_runs(
    user_id: str, source_run_id: Optional[str] = None, project_id: Optional[str] = None,
) -> list[dict]:
    """Summary rows only (no `data` blob) -- for the run picker / history
    list. Newest first. `project_id` is the Flow-B sidebar picker's filter:
    every hypothesis run ever generated from ANY Lit Review session filed
    under that project, regardless of which specific session each one used
    -- source_run_id narrows to one exact session instead, when the caller
    already knows which one."""
    ph = _PH
    with _conn() as conn:
        if project_id:
            rows = conn.execute(
                f"SELECT id, source_run_id, source_topic, status, created_at, project_id "
                f"FROM hypothesis_runs WHERE user_id = {ph} AND project_id = {ph} "
                f"ORDER BY created_at DESC",
                (user_id, project_id),
            ).fetchall()
        elif source_run_id:
            rows = conn.execute(
                f"SELECT id, source_run_id, source_topic, status, created_at, project_id "
                f"FROM hypothesis_runs WHERE user_id = {ph} AND source_run_id = {ph} "
                f"ORDER BY created_at DESC",
                (user_id, source_run_id),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT id, source_run_id, source_topic, status, created_at, project_id "
                f"FROM hypothesis_runs WHERE user_id = {ph} ORDER BY created_at DESC",
                (user_id,),
            ).fetchall()
    return [dict(r) for r in rows]


def get_staleness(hyp_run: dict) -> dict:
    """Is there a more-recently-completed Literature Review this hypothesis
    run should probably be regenerated from?

    - If the run has a project_id: staleness looks at the WHOLE project --
      any Sift session filed under it (stage='done') with updated_at newer
      than this run's created_at counts, whether that's the exact session
      this run was built from being edited/re-run, or a different session
      in the same project finishing later.
    - If the run has no project_id (its source session was never filed under
      a project): falls back to just that one source session.

    Returns {"stale": bool, "latest_source_updated_at": str | None} -- the
    route layer decides what UI message to show; this module only computes
    the comparison, per its own "no LLM calls, plain persistence" boundary.
    """
    ph = _PH
    created_at = hyp_run["created_at"]
    project_id = hyp_run.get("project_id")
    with _conn() as conn:
        if project_id:
            row = conn.execute(
                f"SELECT MAX(updated_at) AS latest FROM sessions "
                f"WHERE project_id = {ph} AND stage = 'done'",
                (project_id,),
            ).fetchone()
        else:
            row = conn.execute(
                f"SELECT updated_at AS latest FROM sessions WHERE id = {ph}",
                (hyp_run["source_run_id"],),
            ).fetchone()
    latest = dict(row)["latest"] if row else None
    return {
        "stale": bool(latest and latest > created_at),
        "latest_source_updated_at": latest,
    }

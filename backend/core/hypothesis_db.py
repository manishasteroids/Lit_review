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


def create_hypothesis_run(
    user_id: str, source_run_id: str, source_topic: str, status: str, data: dict,
) -> dict:
    run_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    ph = _PH
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO hypothesis_runs "
            f"(id, user_id, source_run_id, source_topic, status, created_at, data) "
            f"VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})",
            (run_id, user_id, source_run_id, source_topic, status, now, json.dumps(data)),
        )
    return {
        "id": run_id, "user_id": user_id, "source_run_id": source_run_id,
        "source_topic": source_topic, "status": status, "created_at": now, "data": data,
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


def list_hypothesis_runs(user_id: str, source_run_id: Optional[str] = None) -> list[dict]:
    """Summary rows only (no `data` blob) -- for the run picker / history
    list. Newest first."""
    ph = _PH
    with _conn() as conn:
        if source_run_id:
            rows = conn.execute(
                f"SELECT id, source_run_id, source_topic, status, created_at "
                f"FROM hypothesis_runs WHERE user_id = {ph} AND source_run_id = {ph} "
                f"ORDER BY created_at DESC",
                (user_id, source_run_id),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT id, source_run_id, source_topic, status, created_at "
                f"FROM hypothesis_runs WHERE user_id = {ph} ORDER BY created_at DESC",
                (user_id,),
            ).fetchall()
    return [dict(r) for r in rows]

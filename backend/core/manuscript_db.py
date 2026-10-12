"""
Persistence for the Publish step -- its own two tables, same boundary the
Hypothesis Agent keeps (core/hypothesis_db.py): nothing here writes to
`sessions` or `hypothesis_runs`.

  manuscripts       one row per manuscript: which Sift run (and, optionally,
                    which Infinity run) it is built from, and a JSON `data`
                    blob holding paper type, author details, the format spec
                    read from the template, and the generated text.
  manuscript_files  the uploaded template and any results files, stored as
                    base64 text so the same code works on SQLite and Postgres
                    and survives Cloud Run's throwaway disk.
"""
import base64
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH


def init_manuscript_tables() -> None:
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS manuscripts (
                id             TEXT PRIMARY KEY,
                user_id        TEXT NOT NULL,
                source_run_id  TEXT NOT NULL,
                hyp_run_id     TEXT,
                created_at     TEXT NOT NULL,
                updated_at     TEXT NOT NULL,
                data           TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_manuscripts_user ON manuscripts (user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_manuscripts_source ON manuscripts (source_run_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS manuscript_files (
                id             TEXT PRIMARY KEY,
                manuscript_id  TEXT NOT NULL,
                user_id        TEXT NOT NULL,
                role           TEXT NOT NULL,
                filename       TEXT NOT NULL,
                size           INTEGER DEFAULT 0,
                created_at     TEXT NOT NULL,
                meta           TEXT NOT NULL,
                content        TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_manuscript_files_ms ON manuscript_files (manuscript_id)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(row) -> dict:
    out = dict(row)
    out["data"] = json.loads(out["data"])
    return out


def create_manuscript(user_id: str, source_run_id: str, hyp_run_id: Optional[str], data: dict) -> dict:
    mid, now, ph = str(uuid.uuid4()), _now(), _PH
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO manuscripts (id, user_id, source_run_id, hyp_run_id, created_at, updated_at, data) "
            f"VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})",
            (mid, user_id, source_run_id, hyp_run_id, now, now, json.dumps(data)),
        )
    return get_manuscript(mid, user_id)


def get_manuscript(mid: str, user_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT * FROM manuscripts WHERE id = {_PH} AND user_id = {_PH}", (mid, user_id),
        ).fetchone()
    return _row(row) if row else None


def latest_manuscript_for_run(user_id: str, source_run_id: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT * FROM manuscripts WHERE user_id = {_PH} AND source_run_id = {_PH} "
            f"ORDER BY created_at DESC LIMIT 1", (user_id, source_run_id),
        ).fetchone()
    return _row(row) if row else None


def update_manuscript(mid: str, user_id: str, data: dict, hyp_run_id: Optional[str] = None) -> Optional[dict]:
    ph = _PH
    with _conn() as conn:
        if hyp_run_id is not None:
            conn.execute(
                f"UPDATE manuscripts SET data = {ph}, updated_at = {ph}, hyp_run_id = {ph} "
                f"WHERE id = {ph} AND user_id = {ph}",
                (json.dumps(data), _now(), hyp_run_id, mid, user_id),
            )
        else:
            conn.execute(
                f"UPDATE manuscripts SET data = {ph}, updated_at = {ph} WHERE id = {ph} AND user_id = {ph}",
                (json.dumps(data), _now(), mid, user_id),
            )
    return get_manuscript(mid, user_id)


# ── Files ───────────────────────────────────────────────────────────────────

def add_file(mid: str, user_id: str, role: str, filename: str, content: bytes, meta: dict) -> dict:
    fid, ph = str(uuid.uuid4()), _PH
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO manuscript_files (id, manuscript_id, user_id, role, filename, size, created_at, meta, content) "
            f"VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})",
            (fid, mid, user_id, role, filename, len(content), _now(), json.dumps(meta),
             base64.b64encode(content).decode("ascii")),
        )
    return {"id": fid, "role": role, "filename": filename, "size": len(content), "meta": meta}


def list_files(mid: str, user_id: str, role: Optional[str] = None) -> list[dict]:
    """Metadata only -- never the content column."""
    ph = _PH
    sql = (f"SELECT id, role, filename, size, created_at, meta FROM manuscript_files "
           f"WHERE manuscript_id = {ph} AND user_id = {ph}")
    params = [mid, user_id]
    if role:
        sql += f" AND role = {ph}"
        params.append(role)
    with _conn() as conn:
        rows = conn.execute(sql + " ORDER BY created_at", tuple(params)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["meta"] = json.loads(d["meta"])
        out.append(d)
    return out


def get_file_content(fid: str, user_id: str) -> Optional[bytes]:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT content FROM manuscript_files WHERE id = {_PH} AND user_id = {_PH}", (fid, user_id),
        ).fetchone()
    return base64.b64decode(dict(row)["content"]) if row else None


def update_file_meta(fid: str, user_id: str, meta: dict) -> None:
    with _conn() as conn:
        conn.execute(
            f"UPDATE manuscript_files SET meta = {_PH} WHERE id = {_PH} AND user_id = {_PH}",
            (json.dumps(meta), fid, user_id),
        )


def delete_file(fid: str, user_id: str) -> None:
    with _conn() as conn:
        conn.execute(
            f"DELETE FROM manuscript_files WHERE id = {_PH} AND user_id = {_PH}", (fid, user_id),
        )


def delete_files_by_role(mid: str, user_id: str, role: str) -> None:
    with _conn() as conn:
        conn.execute(
            f"DELETE FROM manuscript_files WHERE manuscript_id = {_PH} AND user_id = {_PH} AND role = {_PH}",
            (mid, user_id, role),
        )

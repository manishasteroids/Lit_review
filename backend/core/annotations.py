"""
Paper annotations — Phase 2 of in-app PDF reading (see core/paper_text.py /
api/routes.py's paper_pdf for Phase 1, the read-only viewer).

Highlights, underlines, and inline comments a user makes while reading a
paper in the PDF viewer. Keyed by (user_id, paper_key) the same way
core.chat_history keys chat by paper, not by run — paper_key is the paper's
URL when it has one, or its uploaded file path when it doesn't (see
`paper_key_of()`), so annotations follow the PAPER across runs/sessions
instead of disappearing if the same paper is re-added to a different run.

Rects are stored in PDF-point space at scale=1 (i.e. divided by whatever
on-screen zoom was active when the selection was made), so they redraw
correctly regardless of the viewer's current zoom level.

This module only stores and returns annotations — nothing here feeds them
into the LLM pipeline yet. That's Phase 3 (deliberately deferred, see the
phased plan agreed with the user).
"""
import json
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH, _AUTO_ID

_MAX_RECTS_JSON = 20_000  # sanity cap — a selection spanning this many rects is not real usage


def init_annotations_table() -> None:
    with _conn() as conn:
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS paper_annotations (
                id         {_AUTO_ID},
                user_id    TEXT NOT NULL,
                paper_key  TEXT NOT NULL,
                kind       TEXT NOT NULL,
                page       INTEGER NOT NULL,
                color      TEXT,
                snippet    TEXT,
                comment    TEXT,
                rects      TEXT NOT NULL,
                created_at TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_paper_annotations_user_paper "
            "ON paper_annotations(user_id, paper_key)"
        )


def paper_key_of(paper: dict) -> str:
    """The identity an annotation is filed under — a paper's URL if it has
    one, else its uploaded file path (see api/routes.py upload_paper), else
    a title-based fallback so hand-entered/duplicate-ish papers still get
    a stable (if weaker) key rather than crashing."""
    return (paper.get("url") or "").strip() or (paper.get("local_file") or "").strip() \
        or f"title:{(paper.get('title') or '').strip().lower()}"


def list_annotations(user_id: str, paper_key: str) -> list[dict]:
    if not user_id or not paper_key:
        return []
    try:
        with _conn() as conn:
            rows = conn.execute(
                f"SELECT id, kind, page, color, snippet, comment, rects, created_at "
                f"FROM paper_annotations WHERE user_id = {_PH} AND paper_key = {_PH} "
                f"ORDER BY page ASC, id ASC",
                (user_id, paper_key),
            ).fetchall()
    except Exception:  # noqa: BLE001
        return []
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["rects"] = json.loads(d["rects"])
        except Exception:
            d["rects"] = []
        out.append(d)
    return out


def add_annotation(user_id: str, paper_key: str, kind: str, page: int,
                    rects: list[dict], color: Optional[str] = None,
                    snippet: Optional[str] = None, comment: Optional[str] = None) -> Optional[dict]:
    if not user_id or not paper_key or kind not in (
        "highlight", "underline", "comment", "drawing", "text", "shape",
    ):
        return None
    rects = rects or []
    payload = json.dumps(rects)
    if len(payload) > _MAX_RECTS_JSON or not rects:
        return None
    created_at = datetime.now(timezone.utc).isoformat()
    with _conn() as conn:
        cur = conn.execute(
            f"INSERT INTO paper_annotations "
            f"(user_id, paper_key, kind, page, color, snippet, comment, rects, created_at) "
            f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
            (user_id, paper_key, kind, int(page), color,
             (snippet or "")[:2000], (comment or "")[:4000], payload, created_at),
        )
        new_id = cur.lastrowid
        if new_id is None:  # Postgres path — SERIAL id isn't on the cursor
            row = conn.execute(
                f"SELECT id FROM paper_annotations WHERE user_id = {_PH} AND paper_key = {_PH} "
                f"AND created_at = {_PH} ORDER BY id DESC LIMIT 1",
                (user_id, paper_key, created_at),
            ).fetchone()
            new_id = row["id"] if row else None
    return {
        "id": new_id, "kind": kind, "page": int(page), "color": color,
        "snippet": (snippet or "")[:2000], "comment": (comment or "")[:4000],
        "rects": rects, "created_at": created_at,
    }


def update_annotation_rects(user_id: str, paper_key: str, annotation_id: int,
                             rects: list[dict]) -> bool:
    """Move an existing annotation to a new position (drag-to-reposition —
    currently used for text notes). Only `rects` changes; everything else
    about the mark (kind, color, snippet, comment) is untouched."""
    if not user_id or not paper_key or not rects:
        return False
    payload = json.dumps(rects)
    if len(payload) > _MAX_RECTS_JSON:
        return False
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE paper_annotations SET rects = {_PH} "
            f"WHERE id = {_PH} AND user_id = {_PH} AND paper_key = {_PH}",
            (payload, annotation_id, user_id, paper_key),
        )
        return (cur.rowcount or 0) > 0


def delete_annotation(user_id: str, paper_key: str, annotation_id: int) -> bool:
    if not user_id or not paper_key:
        return False
    try:
        with _conn() as conn:
            cur = conn.execute(
                f"DELETE FROM paper_annotations WHERE id = {_PH} AND user_id = {_PH} AND paper_key = {_PH}",
                (annotation_id, user_id, paper_key),
            )
            return (cur.rowcount or 0) > 0
    except Exception:  # noqa: BLE001
        return False

"""Watch list: follow researchers and laboratories, see their new papers (core/watch.py)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core import watch
from core.auth import require_user

router = APIRouter(prefix="/api/watch")


class FollowIn(BaseModel):
    kind: str
    openalex_id: str
    name: str
    subtitle: str = ""
    keywords: list[str] = []
    scope: str = ""


@router.get("")
def get_watchlist(refresh: bool = False, user_id: str = Depends(require_user)):
    return watch.watchlist(user_id, refresh=refresh)


@router.get("/search")
def search(kind: str, q: str, user_id: str = Depends(require_user)):
    try:
        return {"results": watch.search(kind, q)}
    except Exception:  # noqa: BLE001
        raise HTTPException(502, "Couldn't reach OpenAlex just now -- try again in a moment.")


@router.post("")
def follow(body: FollowIn, user_id: str = Depends(require_user)):
    try:
        f = watch.add_follow(user_id, body.kind, body.openalex_id, body.name, body.subtitle,
                             body.keywords, body.scope)
    except ValueError as e:
        raise HTTPException(400, str(e))
    f.pop("seen", None)
    return f


@router.delete("/{fid}")
def unfollow(fid: str, user_id: str = Depends(require_user)):
    watch.remove_follow(user_id, fid)
    return {"ok": True}


@router.post("/seen")
def seen(fid: str | None = None, user_id: str = Depends(require_user)):
    watch.mark_seen(user_id, fid)
    return {"ok": True}

"""
Supabase auth
-------------
Verifies the JWT the frontend sends (Authorization: Bearer <token>) using the
project's JWT secret, and returns the signed-in user's id. Every per-user
endpoint depends on `current_user_id`, so a user only ever sees their own
sessions (tenant isolation).

`optional_user_id` is the same but returns None instead of raising — used for
endpoints that should work signed-out during local dev.
"""
from fastapi import Header, HTTPException
import jwt

from core.config import settings


def _decode(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    if not settings.supabase_jwt_secret:
        # Auth not configured (local dev without Supabase) — treat as anonymous.
        return None
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except Exception:
        raise HTTPException(401, "Invalid or expired session. Please sign in again.")
    return payload.get("sub")


def current_user_id(authorization: str | None = Header(default=None)) -> str:
    """Require a valid signed-in user; raise 401 otherwise."""
    uid = _decode(authorization)
    if not uid:
        raise HTTPException(401, "Not authenticated.")
    return uid


def optional_user_id(authorization: str | None = Header(default=None)) -> str | None:
    """Return the user id if present/valid, else None (no error)."""
    try:
        return _decode(authorization)
    except HTTPException:
        return None


def require_user(authorization: str | None = Header(default=None)) -> str:
    """Scope key for the current user.

    - Auth NOT configured (local dev, no SUPABASE_JWT_SECRET): everything is
      owned by a single "local" user, so the app works with no login.
    - Auth configured (production): a valid Supabase token is required, and the
      returned id isolates each user's sessions.
    """
    if not settings.supabase_jwt_secret:
        return "local"
    return current_user_id(authorization)

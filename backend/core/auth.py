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
from functools import lru_cache

from fastapi import Header, HTTPException
import jwt

from core.config import settings


def _auth_configured() -> bool:
    """Auth is on if we can verify tokens either way: a shared secret (HS256)
    or a project URL for the JWKS endpoint (asymmetric ES256/RS256)."""
    return bool(settings.supabase_jwt_secret or settings.supabase_url)


@lru_cache(maxsize=1)
def _jwks_client():
    """PyJWKClient for the project's public signing keys (asymmetric tokens).
    Cached — it fetches and caches the JWKS itself. None if no URL configured."""
    url = (settings.supabase_url or "").rstrip("/")
    if not url:
        return None
    return jwt.PyJWKClient(f"{url}/auth/v1/.well-known/jwks.json")


def _decode(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    if not _auth_configured():
        # Auth not configured (local dev without Supabase) — treat as anonymous.
        return None
    token = authorization.split(" ", 1)[1]
    try:
        alg = (jwt.get_unverified_header(token) or {}).get("alg", "")
        if alg == "HS256":
            # Legacy: symmetric shared secret.
            if not settings.supabase_jwt_secret:
                raise ValueError("HS256 token but no SUPABASE_JWT_SECRET configured")
            payload = jwt.decode(
                token, settings.supabase_jwt_secret,
                algorithms=["HS256"], audience="authenticated",
            )
        else:
            # Modern: asymmetric keys — verify against the project's JWKS.
            client = _jwks_client()
            if client is None:
                raise ValueError("asymmetric token but no SUPABASE_URL configured")
            signing_key = client.get_signing_key_from_jwt(token).key
            payload = jwt.decode(
                token, signing_key,
                algorithms=["ES256", "RS256", "EdDSA"], audience="authenticated",
            )
    except HTTPException:
        raise
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
    if not _auth_configured():
        return "local"
    return current_user_id(authorization)

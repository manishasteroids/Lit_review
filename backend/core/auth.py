"""
Supabase auth
-------------
Verifies the JWT the frontend sends (Authorization: Bearer <token>) and
returns the signed-in user's id. Every per-user endpoint depends on
`require_user`, so a user only ever sees their own sessions (tenant
isolation).

Supabase projects can sign tokens two different ways, and a project can be
migrated from one to the other without warning:
  • Legacy: HS256 with a shared secret (SUPABASE_JWT_SECRET).
  • Current default: asymmetric keys (ES256/RS256), verified via the
    project's public JWKS endpoint — no shared secret needed.

We verify against the JWKS endpoint first (works for both new tokens and
covers key rotation automatically), and fall back to the legacy HS256 secret
only if JWKS verification isn't possible (e.g. SUPABASE_URL not set). This
way the backend keeps working whichever signing mode the Supabase project
is actually using, including if it changes later.
"""
import logging

from fastapi import Header, HTTPException
import jwt

from core.config import settings

logger = logging.getLogger("uvicorn.error")

_JWKS_URL = None
_jwks_client = None

if getattr(settings, "supabase_url", ""):
    _JWKS_URL = settings.supabase_url.rstrip("/") + "/auth/v1/.well-known/jwks.json"
    try:
        _jwks_client = jwt.PyJWKClient(_JWKS_URL)
        logger.warning("auth: JWKS client configured for %s", _JWKS_URL)
    except Exception as e:
        logger.warning("auth: failed to configure JWKS client (%r)", e)
        _jwks_client = None
else:
    logger.warning("auth: SUPABASE_URL not set — JWKS verification disabled")


def _decode(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1]

    # 1) Try JWKS (asymmetric — current Supabase default).
    if _jwks_client is not None:
        try:
            signing_key = _jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256", "RS256"],
                audience="authenticated",
            )
            return payload.get("sub")
        except jwt.PyJWKClientError as e:
            logger.warning("JWKS: no matching key (%s) — falling back to legacy secret", e)
        except Exception as e:
            logger.warning("JWKS verification failed: %r", e)
            raise HTTPException(401, "Invalid or expired session. Please sign in again.")

    # 2) Fall back to legacy HS256 shared secret, if configured.
    if settings.supabase_jwt_secret:
        try:
            payload = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
            )
            return payload.get("sub")
        except Exception as e:
            logger.warning("Legacy HS256 verification failed: %r", e)
            raise HTTPException(401, "Invalid or expired session. Please sign in again.")

    # Neither JWKS nor a legacy secret is configured — auth not set up.
    return None


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
    if _jwks_client is None and not settings.supabase_jwt_secret:
        return "local"
    return current_user_id(authorization)

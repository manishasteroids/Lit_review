"""
Entrypoint. Run with:  uvicorn main:app --reload --port 8015
"""
import os

# Some Python installs (notably python.org's macOS installer, and some pyenv
# builds) ship without wiring into the OS trust store, so any plain-urllib
# HTTPS call — e.g. PyJWT's PyJWKClient fetching Supabase's JWKS to verify
# ES256/RS256 tokens — fails with "CERTIFICATE_VERIFY_FAILED: unable to get
# local issuer certificate" even though the site's certificate is fine.
# Point OpenSSL at certifi's bundled CA file instead, before anything else
# in the process makes an HTTPS request. Safe no-op if already set.
import certifi
os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

from api.routes import router
from core.config import settings
from core.db import init_db

MAX_BODY_BYTES = 55 * 1024 * 1024  # cap on request bodies
# Was 15 MB, then 27 MB, but figure-heavy academic PDFs (lots of embedded
# raster images/diagrams) routinely land in the 30-50 MB range — well above
# the route's advertised "25MB" but still a completely normal single-paper
# upload. /runs/{id}/upload_paper's own check (api/routes.py) is the real
# limit at 50 MB; this middleware runs before the body is even read, so it
# needs enough headroom above that for multipart boundary/header overhead,
# hence 55 MB here.

app = FastAPI(title="Sift — multi-agent literature review pipeline")


@app.on_event("startup")
def startup():
    init_db()


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
            return JSONResponse({"detail": "Request too large."}, status_code=413)
        return await call_next(request)


limiter = Limiter(key_func=get_remote_address, default_limits=["240/minute", "10/second"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(SlowAPIMiddleware)
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.cors_origin, "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/api/health")
def health():
    return {"ok": True}

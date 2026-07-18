"""
Entrypoint. Run with:  uvicorn main:app --reload --port 8015
"""
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

MAX_BODY_BYTES = 15 * 1024 * 1024  # 15 MB cap on request bodies

app = FastAPI(title="Saṃhitā — multi-agent literature review pipeline")


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

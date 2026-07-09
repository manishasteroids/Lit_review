"""
Entrypoint. Run with:  uvicorn main:app --reload --port 8015
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import router
from core.config import settings
from core.db import init_db

app = FastAPI(title="Saṃhitā — multi-agent literature review pipeline")


@app.on_event("startup")
def startup():
    init_db()


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

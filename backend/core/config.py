"""
Centralized settings. The Anthropic API key lives only here, server-side —
it never reaches the browser.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

from core import model_policy as _policy

from core import model_policy as _policy
# Load backend/.env so keys in that file reach os.environ.
load_dotenv(Path(__file__).parent.parent / ".env")


class Settings:
    anthropic_api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")
    model: str = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    
    # Gemini
    gemini_api_key: str = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
    gemini_model: str = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    
    # ── Pipeline routing & limits ────────────────────────────────────────
    # Defaults live in the version-controlled core/model_policy.py (so they
    # survive .env resets); .env vars below override them per-environment.
    # Routing: mechanical stages → FAST_MODEL, synthesis/eval → MID_MODEL,
    # and the model the USER selects is reserved for the Writer.
    search_limit: int = int(os.environ.get("SEARCH_LIMIT", str(_policy.SEARCH_LIMIT)))
    per_purpose_routing: bool = (
        os.environ.get("PER_PURPOSE_ROUTING", "1" if _policy.PER_PURPOSE_ROUTING else "0")
        not in ("0", "false", "False")
    )
    fast_model: str = os.environ.get("FAST_MODEL", _policy.FAST_MODEL)
    mid_model: str = os.environ.get("MID_MODEL", _policy.MID_MODEL)
    # Empty = use the user-selected model for the Writer; set to pin it.
    write_model: str = os.environ.get("WRITE_MODEL", _policy.WRITE_MODEL)

    cors_origin: str = os.environ.get("CORS_ORIGIN", "http://localhost:5173")
    # SQLite path — overridable via DB_PATH env var for cloud deployment
    db_path: str = os.environ.get("DB_PATH", str(Path(__file__).parent.parent / "samhita.db"))
    
    # Semantic Scholar
    s2_api_key: str = os.environ.get("S2_API_KEY", "")
    
    # Unpaywall
    unpaywall_email: str = os.environ.get("UNPAYWALL_EMAIL", "research@example.com")
    
    # PubMed
    ncbi_api_key: str = os.environ.get("NCBI_API_KEY", "")
    ncbi_email: str = os.environ.get("NCBI_EMAIL", "")
    ncbi_tool: str = os.environ.get("NCBI_TOOL", "samhita")
    
    # Supabase auth — JWT secret used to verify the token the frontend sends
    supabase_jwt_secret: str = os.environ.get("SUPABASE_JWT_SECRET", "")
    cors_origin: str = os.environ.get("CORS_ORIGIN", "http://localhost:5173")
    
    # SQLite path — overridable via DB_PATH env var for cloud deployment
    db_path: str = os.environ.get("DB_PATH", str(Path(__file__).parent.parent / "samhita.db"))


settings = Settings()

"""
Centralized settings. The Anthropic API key lives only here, server-side —
it never reaches the browser.
"""
import os
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).parent.parent / ".env")

class Settings:
    anthropic_api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")
    model: str = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    
    # Gemini (Google) — used when a Gemini model is selected
    gemini_api_key: str = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
    gemini_model: str = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    
    cors_origin: str = os.environ.get("CORS_ORIGIN", "http://localhost:5173")
    # SQLite path — overridable via DB_PATH env var for cloud deployment
    db_path: str = os.environ.get("DB_PATH", str(Path(__file__).parent.parent / "samhita.db"))


settings = Settings()

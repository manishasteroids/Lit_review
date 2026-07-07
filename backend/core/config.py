"""
Centralized settings. The Anthropic API key lives only here, server-side —
it never reaches the browser.
"""
import os
from pathlib import Path


class Settings:
    anthropic_api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")
    model: str = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    cors_origin: str = os.environ.get("CORS_ORIGIN", "http://localhost:5173")
    # SQLite path — overridable via DB_PATH env var for cloud deployment
    db_path: str = os.environ.get("DB_PATH", str(Path(__file__).parent.parent / "samhita.db"))


settings = Settings()

"""
Centralized settings. The Anthropic API key lives only here, server-side —
it never reaches the browser.
"""
import os


class Settings:
    anthropic_api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")
    model: str = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    cors_origin: str = os.environ.get("CORS_ORIGIN", "http://localhost:5173")


settings = Settings()

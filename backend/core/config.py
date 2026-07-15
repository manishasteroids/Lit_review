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
    
    # Semantic Scholar
    s2_api_key: str = os.environ.get("S2_API_KEY", "")
    
    # Unpaywall requires a contact email (any works) to resolve open-access PDFs
    unpaywall_email: str = os.environ.get("UNPAYWALL_EMAIL", "research@example.com")
    
    # PubMed (NCBI E-utilities) — all optional; keyless works, key raises the rate limit
    ncbi_api_key: str = os.environ.get("NCBI_API_KEY", "")
    ncbi_email: str = os.environ.get("NCBI_EMAIL", "")
    ncbi_tool: str = os.environ.get("NCBI_TOOL", "samhita")


settings = Settings()

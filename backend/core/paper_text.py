from __future__ import annotations

import io
import re
from html.parser import HTMLParser

import httpx

_CACHE: dict[str, str | None] = {}
_PDF_CACHE: dict[str, bytes | None] = {}
MAX_CHARS = 40_000          # ~10k tokens; keeps text prompts affordable
MAX_PDF_BYTES = 25_000_000  # stay under Anthropic's PDF request limit
TIMEOUT = 25.0
HEADERS = {"User-Agent": "Samhita-LitReview/1.0 (research assistant)"}


def _arxiv_pdf_url(url: str) -> str:
    """Turn an arXiv abstract link into its PDF link (full text lives there)."""
    m = re.search(r"arxiv\.org/abs/([\w.\-/]+)", url)
    if m:
        return f"https://arxiv.org/pdf/{m.group(1)}.pdf"
    return url


class _TextExtractor(HTMLParser):
    """Minimal HTML -> visible-text stripper (no external deps)."""

    def __init__(self) -> None:
        super().__init__()
        self._skip = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if self._skip == 0:
            t = data.strip()
            if t:
                self.parts.append(t)


def _html_to_text(html: str) -> str:
    p = _TextExtractor()
    try:
        p.feed(html)
    except Exception:
        pass
    return re.sub(r"\n{3,}", "\n\n", "\n".join(p.parts)).strip()


def _pdf_to_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except Exception:
        return ""
    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n".join((page.extract_text() or "") for page in reader.pages).strip()
    except Exception:
        return ""


def fetch_paper_pdf(url: str | None) -> bytes | None:
    """Return the raw PDF bytes for a paper URL (open-access only), or None.

    Used to hand the actual PDF to a vision model so it can read figures and
    tables — not just extracted text. Cached per-URL for the process lifetime."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    if url in _PDF_CACHE:
        return _PDF_CACHE[url]

    target = _arxiv_pdf_url(url)
    data: bytes | None = None
    try:
        with httpx.Client(follow_redirects=True, timeout=TIMEOUT, headers=HEADERS) as client:
            resp = client.get(target)
            resp.raise_for_status()
            ctype = resp.headers.get("content-type", "").lower()
            if "pdf" in ctype or target.lower().endswith(".pdf"):
                data = resp.content
    except Exception:
        data = None

    if data and len(data) > MAX_PDF_BYTES:
        data = None
    _PDF_CACHE[url] = data
    return data


def fetch_paper_text(url: str | None) -> str | None:
    """Return extracted full text for a paper URL, or None if unavailable."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    if url in _CACHE:
        return _CACHE[url]

    target = _arxiv_pdf_url(url)
    text: str | None = None
    try:
        with httpx.Client(follow_redirects=True, timeout=TIMEOUT, headers=HEADERS) as client:
            resp = client.get(target)
            resp.raise_for_status()
            ctype = resp.headers.get("content-type", "").lower()
            if "pdf" in ctype or target.lower().endswith(".pdf"):
                text = _pdf_to_text(resp.content)
            else:
                text = _html_to_text(resp.text)
    except Exception:
        text = None

    if text:
        text = text.strip()
        if len(text) > MAX_CHARS:
            text = text[:MAX_CHARS] + "\n\n[...truncated...]"
    result = text or None
    _CACHE[url] = result
    return result

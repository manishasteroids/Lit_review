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


_DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>&]+", re.I)


def _fetch_pdf_bytes(url: str) -> bytes | None:
    """GET a URL and return the bytes only if it's actually a PDF."""
    try:
        with httpx.Client(follow_redirects=True, timeout=TIMEOUT, headers=HEADERS) as client:
            resp = client.get(url)
            resp.raise_for_status()
            ctype = resp.headers.get("content-type", "").lower()
            if "pdf" in ctype or url.lower().split("?")[0].endswith(".pdf"):
                return resp.content
    except Exception:
        return None
    return None


def _extract_doi(url: str) -> str | None:
    m = _DOI_RE.search(url or "")
    return m.group(0).rstrip(").,;") if m else None


def _unpaywall_pdf_url(doi: str) -> str | None:
    """Ask Unpaywall for an open-access PDF for a DOI (any repository / PMC / publisher OA)."""
    email = getattr(settings, "unpaywall_email", "") or "research@example.com"
    try:
        with httpx.Client(follow_redirects=True, timeout=TIMEOUT, headers=HEADERS) as client:
            r = client.get(f"https://api.unpaywall.org/v2/{doi}", params={"email": email})
            r.raise_for_status()
            j = r.json()
    except Exception:
        return None
    best = j.get("best_oa_location") or {}
    if best.get("url_for_pdf"):
        return best["url_for_pdf"]
    for loc in (j.get("oa_locations") or []):
        if loc.get("url_for_pdf"):
            return loc["url_for_pdf"]
    return None


def fetch_paper_pdf(url: str | None) -> bytes | None:
    """Return the raw PDF bytes for a paper (open-access), or None.

    Tries the link directly (handles arXiv abs→pdf and any .pdf); if that isn't
    a PDF, resolves an open-access copy via Unpaywall using the DOI. Lets the
    chat read the WHOLE paper (figures + tables) for far more papers, falling
    back to text/abstract only when no OA PDF exists anywhere."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    if url in _PDF_CACHE:
        return _PDF_CACHE[url]

    data = _fetch_pdf_bytes(_arxiv_pdf_url(url))

    if not data:
        doi = _extract_doi(url)
        if doi:
            oa = _unpaywall_pdf_url(doi)
            if oa:
                data = _fetch_pdf_bytes(oa)

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

from __future__ import annotations

import io
import ipaddress
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urlparse, urljoin

import httpx

from core.config import settings

_CACHE: dict[str, str | None] = {}
_PDF_CACHE: dict[str, bytes | None] = {}
MAX_CHARS = 40_000          # ~10k tokens; keeps text prompts affordable
MAX_PDF_BYTES = 25_000_000  # stay under Anthropic's PDF request limit
MAX_DOWNLOAD_BYTES = 30_000_000  # hard cap while streaming, before any parsing
MAX_REDIRECTS = 5
TIMEOUT = 25.0
HEADERS = {"User-Agent": "Samhita-LitReview/1.0 (research assistant)"}

# Many publishers (Wiley, Elsevier, Springer, OUP, Silverchair) reject requests
# from non-browser user agents with a 403 or a bot challenge, which would leave
# us with nothing to scrape. Reference managers (Zotero, Mendeley) send
# browser-like headers for exactly this reason when reading public citation
# metadata. Used only for metadata lookups, not bulk downloading.
BROWSER_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

_ALLOWED_PDF_CTYPES = ("application/pdf", "application/x-pdf", "application/octet-stream")
_ALLOWED_HTML_CTYPES = ("text/html", "application/xhtml+xml", "text/plain")


# ── SSRF guard ────────────────────────────────────────────────────────────

def _is_safe_url(url: str | None) -> bool:
    """Allow only http(s) URLs whose host resolves to a public IP. Checked on
    every hop we follow, not just the URL the caller originally supplied —
    resolving DNS ourselves (rather than trusting the string) also blocks
    DNS-rebinding tricks where a hostname later resolves to a private IP."""
    if not url:
        return False
    try:
        p = urlparse(url)
    except Exception:
        return False
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    try:
        infos = socket.getaddrinfo(p.hostname, None)
    except Exception:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_reserved or addr.is_multicast or addr.is_unspecified):
            return False
    return True


def _safe_stream_get(url: str, headers: dict | None = None) -> httpx.Response | None:
    """GET a URL with SSRF-safe manual redirect handling and a hard cap on
    downloaded bytes. Every redirect hop is re-validated (redirects are the
    classic bypass for a check that only inspects the original URL) and the
    body is capped while streaming, so a malicious/huge response can't be
    fully buffered into memory before we notice.

    Returns a Response with `.content` populated (already read, capped), or
    None if the URL/any hop is unsafe, too large, or the request fails.
    """
    current = url
    with httpx.Client(follow_redirects=False, timeout=TIMEOUT, headers=headers or HEADERS) as client:
        for _ in range(MAX_REDIRECTS + 1):
            if not _is_safe_url(current):
                return None
            try:
                with client.stream("GET", current) as resp:
                    if resp.is_redirect:
                        location = resp.headers.get("location")
                        if not location:
                            return None
                        current = urljoin(current, location)
                        continue
                    if resp.status_code >= 400:
                        return None
                    chunks = bytearray()
                    for chunk in resp.iter_bytes():
                        chunks += chunk
                        if len(chunks) > MAX_DOWNLOAD_BYTES:
                            return None  # abort — response too large
                    resp._content = bytes(chunks)  # populate .content for callers below
                    return resp
            except Exception:
                return None
    return None  # too many redirects


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
    """GET a URL and return the bytes only if it's actually a PDF (checked via
    Content-Type against an allowlist, not just trusted from the URL string)."""
    # Same bot-blocking problem as HTML: publisher PDF endpoints (e.g.
    # Silverchair watermark links) often reject non-browser agents.
    resp = _safe_stream_get(url, headers=BROWSER_HEADERS) or _safe_stream_get(url)
    if resp is None:
        return None
    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
    looks_pdf = url.lower().split("?")[0].endswith(".pdf")
    if ctype in _ALLOWED_PDF_CTYPES or (looks_pdf and ctype in ("", *_ALLOWED_PDF_CTYPES)):
        return resp.content
    return None


def fetch_html(url: str | None, max_chars: int = 200_000) -> str | None:
    """Fetch a page's raw HTML (SSRF-safe, size-capped) for metadata scraping.

    Used by paper_resolver to read publisher pages' <meta name="citation_doi">
    tags when a URL carries no recognizable identifier of its own. Returns None
    for anything that isn't HTML, so we never hand binary data to a parser."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    # Browser-like headers: publishers commonly 403 non-browser agents, which
    # would leave no HTML to scrape. Retry with the default UA if that fails.
    resp = _safe_stream_get(url, headers=BROWSER_HEADERS) or _safe_stream_get(url)
    if resp is None:
        return None
    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype and ctype not in _ALLOWED_HTML_CTYPES:
        return None
    try:
        html = resp.content.decode(resp.encoding or "utf-8", errors="replace")
    except Exception:
        return None
    return html[:max_chars]


def fetch_pdf_head_text(url: str | None, pages: int = 3, max_chars: int = 20_000) -> str | None:
    """Fetch a PDF and return text from its first few pages only.

    Used to recover a DOI from publisher PDF-delivery links (Silverchair
    watermark URLs, direct .pdf links, etc.) whose path carries no identifier
    and whose response is binary, so HTML meta-tag scraping can't apply.
    Virtually every published PDF prints its DOI on the first page."""
    data = _fetch_pdf_bytes(url) if url else None
    if not data:
        return None
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        chunks = []
        for page in reader.pages[:pages]:
            chunks.append(page.extract_text() or "")
        return "\n".join(chunks)[:max_chars].strip() or None
    except Exception:
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
    if not _is_safe_url(target):
        _CACHE[url] = None
        return None

    text: str | None = None
    resp = _safe_stream_get(target)
    if resp is not None:
        ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        looks_pdf = target.lower().endswith(".pdf")
        try:
            if ctype in _ALLOWED_PDF_CTYPES or (looks_pdf and ctype in ("", *_ALLOWED_PDF_CTYPES)):
                text = _pdf_to_text(resp.content)
            elif ctype in _ALLOWED_HTML_CTYPES or ctype == "":
                text = _html_to_text(resp.content.decode(resp.encoding or "utf-8", errors="replace"))
            # else: unrecognized content-type — refuse to parse it as either.
        except Exception:
            text = None

    if text:
        text = text.strip()
        if len(text) > MAX_CHARS:
            text = text[:MAX_CHARS] + "\n\n[...truncated...]"
    result = text or None
    _CACHE[url] = result
    return result

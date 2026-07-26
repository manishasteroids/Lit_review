"""
Paper resolver — turns a user-supplied DOI / PMID / PMCID / arXiv id / URL /
title into candidate canonical paper records, flagged for duplicates against
what's already in the run.

Layered on top of AcademicSearchAgent.resolve() (which does the per-source
network calls — OpenAlex/PubMed/arXiv). This module adds three things:

  1. Canonical identifier extraction from the user's *input*, so a DOI/PMID/
     arXiv id the user pasted is trusted directly rather than re-derived from
     whatever a search API happened to return.

  2. **Publisher-URL resolution.** The identifier classifier only recognizes
     URLs that literally embed a DOI/PMID/PMCID/arXiv id. Most publisher
     article URLs don't — e.g.
         nature.com/articles/s41588-026-02...        (internal article slug)
         academic.oup.com/gpb/article/20/5/836/...    (volume/issue/page)
         genesdev.cshlp.org/content/13/10/1211        (volume/issue/page)
         biorxiv.org/content/biorxiv/early/2023/...   (date-based path)
     For these we fetch the page and read the standard Google-Scholar
     citation meta tags (`citation_doi`, `citation_pmid`, `citation_arxiv_id`)
     that essentially every academic publisher embeds, then resolve from that
     identifier normally. A direct PDF URL is handled too, by looking for a
     DOI in the PDF's landing-page URL patterns and, failing that, the bytes.

  3. Duplicate detection against the persisted `papers` table for the run, so
     the UI can flag "already in your sources" before the user commits.

All page fetches go through core.paper_text's SSRF-hardened helper — the URL
here is fully user-supplied, so it's exactly the input an attacker would use
to try to make the server request an internal address.
"""
import re

import httpx

from agents.academic_search import AcademicSearchAgent, _classify_identifier
from core.config import settings
from core.paper_text import fetch_html, fetch_pdf_head_text
from core.papers_store import find_duplicate

CROSSREF_API = "https://api.crossref.org/works"
_UA = {"User-Agent": "Samhita-LitReview/1.0 (research assistant)"}

_DOI_URL_RE = re.compile(r"10\.\d{4,9}/[^\s\"&?#]+", re.I)
_ARXIV_URL_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/([^\s?#]+)", re.I)

# <meta name="citation_doi" content="10.1234/xyz">  — order matters: the
# citation_* tags are the Google Scholar standard and by far the most reliable;
# dc.identifier is a looser fallback some older platforms use.
_META_KEYS = (
    ("citation_doi", "doi"),
    ("citation_pmid", "pmid"),
    ("citation_arxiv_id", "arxiv_id"),
    ("dc.identifier", "doi"),
    ("dc.Identifier", "doi"),
    ("prism.doi", "doi"),
)


def _meta_content(html: str, name: str) -> str:
    """Pull one <meta name="..." content="..."> value. Attribute order varies
    between publishers (name-then-content vs content-then-name), so try both."""
    for pattern in (
        rf'<meta[^>]+name=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']{re.escape(name)}["\']',
    ):
        m = re.search(pattern, html, re.I)
        if m:
            return m.group(1).strip()
    return ""


def identifiers_from_page(url: str) -> dict:
    """Fetch a publisher page and extract whatever canonical identifiers its
    citation meta tags advertise. Returns {} when the page can't be fetched or
    carries no usable identifier — callers fall back to a title search."""
    html = fetch_html(url)
    if not html:
        return {}

    found: dict[str, str] = {}
    for meta_name, key in _META_KEYS:
        if key in found:
            continue
        val = _meta_content(html, meta_name)
        if not val:
            continue
        if key == "doi":
            m = _DOI_URL_RE.search(val)
            if m:
                found["doi"] = m.group(0).lower().rstrip(").,;")
        elif key == "pmid" and val.isdigit():
            found["pmid"] = val
        elif key == "arxiv_id":
            found["arxiv_id"] = re.sub(r"^arxiv:", "", val, flags=re.I).strip()

    # Last resort: a DOI sitting anywhere in the page head (some publishers
    # only put it in a <link> or JSON-LD block rather than a meta tag).
    if not found.get("doi"):
        m = _DOI_URL_RE.search(html[:20_000])
        if m:
            found["doi"] = m.group(0).lower().rstrip(").,;")

    # A title is a useful fallback for search even when no id was found.
    title = _meta_content(html, "citation_title") or _meta_content(html, "og:title")
    if title:
        found["title"] = title
    return found


def identifiers_from_pdf(url: str) -> dict:
    """Recover a DOI from a PDF-delivery URL by reading the DOI printed on the
    paper's own first page. Covers publisher PDF links whose response is
    binary (so meta tags don't exist) and whose path has no identifier —
    e.g. Silverchair watermark links like watermark02.silverchair.com/bbad333.pdf.

    Ignores DOIs belonging to *cited* works by only reading the opening pages,
    where the article's own DOI appears in the header/footer."""
    text = fetch_pdf_head_text(url, pages=2)
    if not text:
        return {}
    # Prefer a DOI that appears next to an explicit label, which is almost
    # always the article's own rather than one from its reference list.
    m = re.search(r"(?:doi|DOI)[:\s/]*\s*(10\.\d{4,9}/[^\s\"<>,;]+)", text)
    if not m:
        m = _DOI_URL_RE.search(text)
    if not m:
        return {}
    return {"doi": m.group(1 if m.lastindex else 0).lower().rstrip(").,;")}


def doi_from_publisher_url(url: str) -> str:
    """Derive a DOI directly from URL patterns where the mapping is exact.

    Some publishers put the DOI suffix straight in the path, so no network
    call is needed (and no ambiguity):
      nature.com/articles/s41467-019-09234-6[.pdf] -> 10.1038/s41467-019-09234-6
      biorxiv.org/content/10.1101/2023.01.15.5     -> 10.1101/2023.01.15.5
    Returns "" when the URL isn't a recognized deterministic pattern."""
    u = (url or "").split("?")[0].split("#")[0]

    # Nature portfolio: every article id maps to 10.1038/<id>.
    m = re.search(r"nature\.com/articles/([a-z0-9\-.]+?)(?:\.pdf)?/?$", u, re.I)
    if m:
        slug = m.group(1)
        # Older Nature URLs use 'nature12373'-style ids, which also map to 10.1038.
        return f"10.1038/{slug}".lower()

    return ""


def _crossref_by_doi(doi: str) -> list[dict]:
    """Resolve a DOI via Crossref — the DOI registry itself, so it has
    essentially every published DOI, including ones OpenAlex hasn't indexed.
    Returns [] (never garbage) when the DOI genuinely isn't found."""
    if not doi:
        return []
    mailto = getattr(settings, "unpaywall_email", "") or "research@example.com"
    try:
        with httpx.Client(timeout=20, headers=_UA, follow_redirects=True) as client:
            r = client.get(f"{CROSSREF_API}/{doi}", params={"mailto": mailto})
            if r.status_code != 200:
                return []
            msg = (r.json() or {}).get("message") or {}
    except Exception:
        return []

    title = " ".join((msg.get("title") or [""])[0].split())
    if not title:
        return []
    authors = []
    for a in (msg.get("author") or []):
        name = " ".join(p for p in (a.get("given"), a.get("family")) if p)
        if name:
            authors.append(name)
    parts = ((msg.get("issued") or {}).get("date-parts") or [[None]])[0]
    year = parts[0] if parts and isinstance(parts[0], int) else None
    abstract = re.sub(r"<[^>]+>", " ", msg.get("abstract") or "")
    return [{
        "title": title,
        "authors": (authors[0] if len(authors) == 1 else f"{authors[0]} et al.") if authors else "",
        "year": year,
        "venue": " ".join((msg.get("container-title") or [""])[0].split()),
        "url": msg.get("URL") or f"https://doi.org/{doi}",
        "abstract": " ".join(abstract.split()),
        "cites": msg.get("is-referenced-by-count") or 0,
        "source": "crossref",
    }]


def _resolve_exact(searcher: AcademicSearchAgent, kind: str, value: str) -> list[dict]:
    """Resolve a KNOWN identifier with NO title-search fallback.

    AcademicSearchAgent.resolve() falls back to a free-text title search when
    an id lookup throws — which, given a DOI string as the "title", returns a
    confidently-wrong unrelated paper rather than nothing. When we already
    know exactly which identifier we hold, that fallback is never what we
    want: a failed lookup must return [] so the caller can try the next
    strategy (or honestly report "not found")."""
    try:
        if kind == "doi":
            found = searcher._resolve_doi(value) or []
            # Crossref is the DOI registry — authoritative when OpenAlex misses.
            return found or _crossref_by_doi(value)
        if kind == "pmid":
            return searcher._resolve_pmid(value) or []
        if kind == "pmcid":
            return searcher._resolve_pmcid(value) or []
        if kind == "arxiv_id":
            return searcher._resolve_arxiv(value) or []
    except Exception:
        # Even on error, fall back only to Crossref for DOIs — never to a
        # text search that can invent an unrelated match.
        if kind == "doi":
            return _crossref_by_doi(value)
        return []
    return []


def resolve_candidates(searcher: AcademicSearchAgent, run_id: str, identifier: str) -> list[dict]:
    """Resolve `identifier` into 0..n candidate paper dicts. Each candidate is
    annotated with doi/pmid/pmcid/arxiv_id and a `duplicate` flag (plus
    `existing_paper_id` when it is one) so the frontend can show a clear
    "already in your sources" state instead of silently re-adding it."""
    identifier = (identifier or "").strip()
    if not identifier:
        return []

    kind, value = _classify_identifier(identifier)

    # Identifiers we can trust straight from what the user typed.
    input_ids = {"doi": "", "pmid": "", "pmcid": "", "arxiv_id": ""}
    if kind == "doi":
        input_ids["doi"] = value.lower().rstrip(").,;")
    elif kind == "pmid":
        input_ids["pmid"] = value
    elif kind == "pmcid":
        input_ids["pmcid"] = value
    elif kind == "arxiv":
        input_ids["arxiv_id"] = value

    is_url = identifier.lower().startswith(("http://", "https://"))

    # ── Publisher-URL resolution ─────────────────────────────────────────
    # kind == "title" means the classifier found no id in the input. If the
    # input is a URL, we must NOT hand it to a title search: searching for a
    # URL string doesn't return nothing, it returns confident-looking garbage
    # (fuzzy text matches on url fragments). So for URLs we resolve to a real
    # identifier first, and only fall back to a title search using the page's
    # ACTUAL title — never the raw URL.
    if kind == "title" and is_url:
        candidates = []

        # 1) Deterministic URL patterns (no network call needed).
        guessed = doi_from_publisher_url(identifier)
        if guessed:
            candidates = _resolve_exact(searcher, "doi", guessed)
            if candidates:
                input_ids["doi"] = guessed

        # 2) HTML landing page → citation meta tags.
        page_title = ""
        if not candidates:
            page_ids = identifiers_from_page(identifier)
            page_title = page_ids.pop("title", "")
            for key in ("doi", "pmid", "arxiv_id"):
                if page_ids.get(key):
                    found = _resolve_exact(searcher, key, page_ids[key])
                    if found:
                        input_ids[key] = page_ids[key]
                        candidates = found
                        break

        # 3) PDF link (binary, no meta tags) → DOI printed on page 1.
        if not candidates:
            pdf_ids = identifiers_from_pdf(identifier)
            if pdf_ids.get("doi"):
                found = _resolve_exact(searcher, "doi", pdf_ids["doi"])
                if found:
                    input_ids["doi"] = pdf_ids["doi"]
                    candidates = found

        # 4) Last resort: search the page's real title (never the URL string).
        if not candidates and page_title:
            candidates = searcher.resolve(page_title)
    elif kind in ("doi", "pmid", "pmcid", "arxiv"):
        # User pasted a bare identifier: resolve it exactly. A miss must stay
        # a miss rather than degrading into an unrelated text-search match.
        candidates = _resolve_exact(
            searcher, "arxiv_id" if kind == "arxiv" else kind, value
        )
    else:
        candidates = searcher.resolve(identifier)

    out = []
    for c in candidates:
        c = dict(c)
        url = c.get("url") or ""
        c["doi"] = input_ids["doi"] or _doi_from_url(url)
        c["pmid"] = input_ids["pmid"]
        c["pmcid"] = input_ids["pmcid"]
        c["arxiv_id"] = input_ids["arxiv_id"] or _arxiv_from_url(url)

        dupe = find_duplicate(
            run_id,
            doi=c["doi"], pmid=c["pmid"], pmcid=c["pmcid"], arxiv_id=c["arxiv_id"],
            title=c.get("title") or "",
        )
        c["duplicate"] = dupe is not None
        c["existing_paper_id"] = dupe["id"] if dupe else None
        out.append(c)
    return out


def _doi_from_url(url: str) -> str:
    m = _DOI_URL_RE.search(url or "")
    return m.group(0).lower() if m else ""


def _arxiv_from_url(url: str) -> str:
    m = _ARXIV_URL_RE.search(url or "")
    return re.sub(r"\.pdf$", "", m.group(1)) if m else ""

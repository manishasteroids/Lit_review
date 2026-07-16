"""
Academic Search Agent — real sources
------------------------------------
Diagram node: "Semantic Scholar · arXiv · PubMed"

Pulls REAL paper records from academic APIs instead of asking the model to
recall papers, then merges + de-duplicates them and maps everything onto the
{idx,title,authors,year,venue,url,abstract} shape the rest of the pipeline
already expects — so nothing downstream changes.

Sources:
  - Semantic Scholar Graph API (200M+ papers; real abstract, DOI, OA PDF,
    citation count). Free but rate-limited without a key (S2_API_KEY).
  - arXiv API (keyless, reliable; abstract + PDF link for preprints).

If both sources come up empty (offline / throttled), it falls back to the
model's web search (the previous behaviour) so the pipeline never hard-fails.
"""
import time
import xml.etree.ElementTree as ET

import httpx

from agents.base import Agent
from core.config import settings

S2_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"
S2_FIELDS = "title,abstract,year,venue,authors,externalIds,openAccessPdf,citationCount,url"
ARXIV_API = "http://export.arxiv.org/api/query"
UA = {"User-Agent": "Samhita-LitReview/1.0 (research assistant)"}

PUBMED_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
PUBMED_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

OPENALEX_API = "https://api.openalex.org/works"


class AcademicSearchAgent(Agent):
    name = "academic_search"

    def run(self, topic: str, queries: list[str], limit: int = 8) -> list[dict]:
        terms = _uniq([topic, *(queries or [])])[:3]

        merged: dict[str, dict] = {}
        for source in (self._openalex, self._semantic_scholar, self._pubmed, self._arxiv):
            try:
                for p in source(terms):
                    key = (p.get("title") or "").strip().lower()
                    if key and key not in merged:
                        merged[key] = p
            except Exception:
                continue
            
        papers = list(merged.values())
        if not papers:
            return self._llm_fallback(topic, queries)

        papers.sort(key=lambda p: (bool(p.get("abstract")), p.get("cites") or 0), reverse=True)
        papers = papers[:limit]
        for i, p in enumerate(papers):
            p["idx"] = i
            p.pop("cites", None)
        return papers
    
    def _openalex(self, terms: list[str]) -> list[dict]:
        email = getattr(settings, "unpaywall_email", "") or "research@example.com"
        out = []
        with httpx.Client(timeout=25, headers=UA) as client:
            for q in terms[:2]:
                try:
                    r = client.get(OPENALEX_API, params={"search": q, "per_page": 15, "mailto": email})
                    r.raise_for_status()
                    results = r.json().get("results") or []
                except Exception:
                    continue
                for w in results:
                    title = _clean(w.get("title") or w.get("display_name") or "")
                    if not title:
                        continue
                    names = [(a.get("author") or {}).get("display_name") for a in (w.get("authorships") or [])]
                    src = (w.get("primary_location") or {}).get("source") or {}
                    oa = w.get("open_access") or {}
                    out.append({
                        "title": title,
                        "authors": _fmt_authors(names),
                        "year": w.get("publication_year"),
                        "venue": _clean(src.get("display_name") or ""),
                        "url": oa.get("oa_url") or w.get("doi") or w.get("id") or "",
                        "abstract": _reconstruct_abstract(w.get("abstract_inverted_index")),
                        "cites": w.get("cited_by_count") or 0,
                        "source": "openalex",
                    })
        return out

    def _semantic_scholar(self, terms: list[str]) -> list[dict]:
        headers = dict(UA)
        if getattr(settings, "s2_api_key", ""):
            headers["x-api-key"] = settings.s2_api_key

        out = []
        with httpx.Client(timeout=25, headers=headers) as client:
            for q in terms:
                for p in self._s2_once(client, q):
                    if not p.get("title"):
                        continue
                    out.append({
                        "title": p.get("title", ""),
                        "authors": _fmt_authors([a.get("name") for a in (p.get("authors") or [])]),
                        "year": p.get("year"),
                        "venue": p.get("venue") or "",
                        "url": _s2_url(p),
                        "abstract": p.get("abstract") or "",
                        "cites": p.get("citationCount") or 0,
                        "source": "semantic_scholar",
                    })
        return out

    def _s2_once(self, client: httpx.Client, query: str) -> list[dict]:
        for _ in range(2):
            try:
                r = client.get(S2_SEARCH, params={"query": query, "limit": 20, "fields": S2_FIELDS})
                if r.status_code == 429:
                    time.sleep(1.5)
                    continue
                r.raise_for_status()
                return r.json().get("data") or []
            except Exception:
                time.sleep(0.4)
        return []

    def _arxiv(self, terms: list[str]) -> list[dict]:
        ns = {"a": "http://www.w3.org/2005/Atom"}
        out = []
        with httpx.Client(timeout=25, headers=UA) as client:
            for q in terms[:2]:
                try:
                    r = client.get(ARXIV_API, params={"search_query": f"all:{q}", "start": 0, "max_results": 10})
                    if r.status_code != 200:
                        continue
                    root = ET.fromstring(r.text)
                except Exception:
                    continue
                for e in root.findall("a:entry", ns):
                    title = _clean(e.findtext("a:title", "", ns))
                    if not title:
                        continue
                    published = e.findtext("a:published", "", ns) or ""
                    year = int(published[:4]) if published[:4].isdigit() else None
                    names = [a.findtext("a:name", "", ns) for a in e.findall("a:author", ns)]
                    url = ""
                    for link in e.findall("a:link", ns):
                        if link.get("title") == "pdf" or link.get("type") == "application/pdf":
                            url = link.get("href") or ""
                            break
                    if not url:
                        url = e.findtext("a:id", "", ns) or ""
                    out.append({
                        "title": title,
                        "authors": _fmt_authors(names),
                        "year": year,
                        "venue": "arXiv",
                        "url": url,
                        "abstract": _clean(e.findtext("a:summary", "", ns)),
                        "cites": 0,
                        "source": "arxiv",
                    })
        return out
    
    def _pubmed(self, terms: list[str]) -> list[dict]:
        base = {"tool": getattr(settings, "ncbi_tool", "") or "samhita"}
        email = getattr(settings, "ncbi_email", "") or getattr(settings, "unpaywall_email", "")
        if email:
            base["email"] = email
        if getattr(settings, "ncbi_api_key", ""):
            base["api_key"] = settings.ncbi_api_key

        pmids: list[str] = []
        out = []
        with httpx.Client(timeout=25, headers=UA) as client:
            for q in terms[:2]:
                try:
                    r = client.get(PUBMED_ESEARCH, params={
                        **base, "db": "pubmed", "term": q, "retmax": 12, "retmode": "json"})
                    r.raise_for_status()
                    for pid in r.json().get("esearchresult", {}).get("idlist", []):
                        if pid not in pmids:
                            pmids.append(pid)
                except Exception:
                    continue

            if not pmids:
                return []
            try:
                r = client.get(PUBMED_EFETCH, params={
                    **base, "db": "pubmed", "id": ",".join(pmids[:20]), "retmode": "xml"})
                r.raise_for_status()
                root = ET.fromstring(r.text)
            except Exception:
                return []

        for art in root.findall(".//PubmedArticle"):
            rec = _parse_pubmed_article(art)
            if rec and rec.get("title"):
                out.append(rec)
        return out

    def _llm_fallback(self, topic: str, queries: list[str]) -> list[dict]:
        user_text = (
            "Search the web for real, recent academic papers on this topic, preferring "
            "arXiv, PubMed, bioRxiv and Semantic Scholar. Topic: " + topic + ". "
            "Use these queries: " + " | ".join(queries or []) + ". "
            "Find 6 distinct, real papers. Then respond with ONLY a JSON array (no prose, "
            'no markdown) of objects: {"title","authors":"First Author et al.","year":number,'
            '"venue","url","abstract":"2-sentence summary of contribution"}. '
            "Only include papers you actually found in the search results."
        )
        try:
            out = self.llm.call(
                user_text=user_text,
                tools=[{"type": "web_search_20250305", "name": "web_search"}],
                max_tokens=1800,
            )
            data = self.llm.parse_json(out)
            papers = data if isinstance(data, list) else data.get("papers", [])
        except Exception:
            papers = []
        for i, p in enumerate(papers):
            p["idx"] = i
            p["source"] = "model"  # unverified - model web search, not a database
        return papers


def _uniq(items: list[str]) -> list[str]:
    seen, out = set(), []
    for q in items:
        k = (q or "").strip().lower()
        if k and k not in seen:
            seen.add(k)
            out.append(q.strip())
    return out


def _clean(s: str) -> str:
    return " ".join((s or "").split())

def _reconstruct_abstract(inv: dict) -> str:
    """OpenAlex returns abstracts as an inverted index {word: [positions]}."""
    if not inv:
        return ""
    positions = [(pos, word) for word, idxs in inv.items() for pos in idxs]
    positions.sort()
    return _clean(" ".join(word for _, word in positions))


def _parse_pubmed_article(art) -> dict | None:
    def _itext(el) -> str:
        return _clean("".join(el.itertext())) if el is not None else ""

    title = _itext(art.find(".//ArticleTitle"))
    abstract = _clean(" ".join(_itext(ab) for ab in art.findall(".//Abstract/AbstractText")))

    names = []
    for a in art.findall(".//AuthorList/Author"):
        last = (a.findtext("LastName") or "").strip()
        init = (a.findtext("Initials") or "").strip()
        if last:
            names.append(f"{last} {init}".strip())

    year = None
    y = art.findtext(".//JournalIssue/PubDate/Year") or art.findtext(".//PubDate/Year")
    if not y:
        md = art.findtext(".//PubDate/MedlineDate") or ""
        y = md[:4]
    if y and y[:4].isdigit():
        year = int(y[:4])

    venue = art.findtext(".//Journal/ISOAbbreviation") or art.findtext(".//Journal/Title") or ""
    pmid = art.findtext(".//PMID") or ""
    doi = ""
    for aid in art.findall(".//ArticleIdList/ArticleId"):
        if aid.get("IdType") == "doi":
            doi = (aid.text or "").strip()
            break
    url = f"https://doi.org/{doi}" if doi else (f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else "")

    return {
        "title": title,
        "authors": _fmt_authors(names),
        "year": year,
        "venue": _clean(venue),
        "url": url,
        "abstract": abstract,
        "cites": 0,
        "source": "pubmed",
    }

def _fmt_authors(names) -> str:
    names = [n for n in (names or []) if n]
    if not names:
        return ""
    return names[0] if len(names) == 1 else f"{names[0]} et al."


def _s2_url(p: dict) -> str:
    oa = p.get("openAccessPdf") or {}
    if oa.get("url"):
        return oa["url"]
    ext = p.get("externalIds") or {}
    if ext.get("ArXiv"):
        return f"https://arxiv.org/abs/{ext['ArXiv']}"
    if ext.get("DOI"):
        return f"https://doi.org/{ext['DOI']}"
    return p.get("url") or ""

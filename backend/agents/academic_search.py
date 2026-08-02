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
 
`resolve(identifier)` is a second entry point used by the Sources page: it
turns a single DOI / PMID / arXiv id / URL / free-text title into candidate
papers so a user can add a specific paper by hand.
"""
import math
import re
import time
import xml.etree.ElementTree as ET
 
import httpx
 
from agents.base import Agent
from core.config import settings
 
S2_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"
S2_FIELDS = "title,abstract,year,venue,authors,externalIds,openAccessPdf,citationCount,url"
ARXIV_API = "http://export.arxiv.org/api/query"
UA = {"User-Agent": "Sift-LitReview/1.0 (research assistant)"}
 
PUBMED_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
PUBMED_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
 
OPENALEX_API = "https://api.openalex.org/works"


# ── Relevance ranking ─────────────────────────────────────────────────────────
# Words that carry no topical signal — command phrasing ("find papers about…"),
# generic research boilerplate, and ordinary stopwords. Stripped before scoring
# so "Find papers related to token optimization" scores on "token optimization".
_RANK_STOP = {
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
    "with", "by", "as", "at", "be", "this", "that", "from", "into", "about",
    "we", "our", "their", "using", "used", "based", "via", "toward", "towards",
    "find", "paper", "papers", "article", "articles", "study", "studies",
    "review", "reviews", "research", "related", "relating", "literature",
    "approach", "approaches", "method", "methods", "analysis", "role", "use",
    "new", "novel", "recent", "survey", "work", "works", "result", "results",
}


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", (text or "").lower())
            if len(t) > 2 and t not in _RANK_STOP]


def _relevance_keywords(topic: str, terms, scope: str) -> dict:
    """Weighted keyword set the search results are scored against. The user's
    topic weighs most, the reformulator's key terms next, the scope sentence
    least — so on-topic vocabulary dominates the score."""
    kw: dict = {}
    for w in _tokens(topic):
        kw[w] = kw.get(w, 0) + 3.0
    for t in (terms or []):
        for w in _tokens(t):
            kw[w] = kw.get(w, 0) + 2.0
    for w in _tokens(scope or ""):
        kw[w] = kw.get(w, 0) + 1.0
    return kw


def _score(paper: dict, kw: dict) -> tuple:
    """Return (score, keyword_hits). Relevance dominates; recency, having an
    abstract, and citations only break ties — so a heavily-cited but off-topic
    paper can never outrank an on-topic one."""
    title_toks = set(_tokens(paper.get("title") or ""))
    body_toks = set(_tokens(paper.get("abstract") or ""))
    hits = 0
    rel = 0.0
    for w, wt in kw.items():
        in_title = w in title_toks
        in_body = w in body_toks
        if in_title or in_body:
            hits += 1
            rel += wt * (2.0 if in_title else 1.0)   # title match worth ~2x body
    rel += 1.5 * hits                                  # reward breadth of coverage
    year = paper.get("year") or 0
    recency = min(4.0, max(0.0, (year - 2015) * 0.5)) if year else 0.0
    has_abs = 1.5 if paper.get("abstract") else 0.0
    cites = min(3.0, math.log10((paper.get("cites") or 0) + 1))   # capped tiebreak
    return rel + recency + has_abs + cites, hits
 
 
class AcademicSearchAgent(Agent):
    name = "academic_search"

    def run(self, topic: str, queries: list[str], limit: int = 50,
            terms: list[str] | None = None, scope: str | None = None,
            domain: str | None = None) -> list[dict]:
        # `search_terms` selects the candidate POOL (topic + first 2 queries);
        # the reformulator's `terms`/`scope` are used only to RANK.
        search_terms = _uniq([topic, *(queries or [])])[:3]
 
        merged: dict[str, dict] = {}
        for source in (self._openalex, self._semantic_scholar, self._pubmed, self._arxiv):
            try:
                for p in source(search_terms):
                    key = (p.get("title") or "").strip().lower()
                    if key and key not in merged:
                        merged[key] = p
            except Exception:
                continue
 
        papers = list(merged.values())
        if not papers:
            return self._llm_fallback(topic, queries)
 
        # Rank by RELEVANCE to the topic, not raw citations. Score each candidate
        # against the reformulator's key terms + scope; recency, an abstract and
        # citations only break ties. Then, if we have enough genuinely on-topic
        # papers, drop the zero-match ones so generic high-citation papers that
        # merely share a stopword don't fill the shortlist.
        kw = _relevance_keywords(topic, terms or queries, scope)
        scored = [(p, *_score(p, kw)) for p in papers]        # (paper, score, hits)
        on_topic = [t for t in scored if t[2] > 0]
        pool = on_topic if len(on_topic) >= min(limit, 10) else scored
        pool.sort(key=lambda t: t[1], reverse=True)

        papers = [t[0] for t in pool[:limit]]
        for i, p in enumerate(papers):
            p["idx"] = i
            p.pop("cites", None)

        # Phase 1 of pre-indexing: opportunistically backfill the local corpus
        # with whatever this live search already found — free (no extra API
        # calls), and warms the index for the fast local-search path that
        # later phases will add. Never blocks or breaks the actual search.
        try:
            from core.corpus import upsert_papers
            upsert_papers(papers, domain=domain or "other")
        except Exception:
            pass

        return papers
 
    # ── Single-paper resolution (Sources page "Add paper") ────────────────
    def resolve(self, identifier: str) -> list[dict]:
        """Resolve a DOI / PMID / arXiv id / URL / free-text title into a list
        of candidate papers (0..n). Never raises — returns [] on failure."""
        q = (identifier or "").strip()
        if not q:
            return []
        kind, value = _classify_identifier(q)
        try:
            if kind == "arxiv":
                return self._resolve_arxiv(value)
            if kind == "doi":
                return self._resolve_doi(value)
            if kind == "pmid":
                return self._resolve_pmid(value)
            if kind == "pmcid":
                return self._resolve_pmcid(value)
            return self._resolve_title(q)
        except Exception:
            # For an id lookup that failed, fall back to a title search so the
            # user still gets something to pick from.
            try:
                return self._resolve_title(q)
            except Exception:
                return []
 
    def _resolve_arxiv(self, arxiv_id: str) -> list[dict]:
        arxiv_id = re.sub(r"v\d+$", "", arxiv_id.strip())
        ns = {"a": "http://www.w3.org/2005/Atom"}
        with httpx.Client(timeout=25, headers=UA) as client:
            r = client.get(ARXIV_API, params={"id_list": arxiv_id, "max_results": 1})
            if r.status_code != 200:
                return []
            root = ET.fromstring(r.text)
        out = []
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
                "title": title, "authors": _fmt_authors(names), "year": year,
                "venue": "arXiv", "url": url,
                "abstract": _clean(e.findtext("a:summary", "", ns)),
                "cites": 0, "source": "arxiv",
            })
        return out
 
    def _resolve_doi(self, doi: str) -> list[dict]:
        doi = doi.strip().lower()
        with httpx.Client(timeout=25, headers=UA) as client:
            r = client.get(f"{OPENALEX_API}/doi:{doi}",
                           params={"mailto": _mailto()})
            if r.status_code != 200:
                return []
            w = r.json()
        rec = _map_openalex(w)
        return [rec] if rec else []
 
    def _resolve_pmcid(self, pmcid: str) -> list[dict]:
        """PMC id -> PMID/DOI, then resolve that. Tries the id converter API
        (whose URL now 301-redirects), then falls back to a PubMed esearch."""
        base = _pubmed_base()
        # 1) id converter (new URL; follow_redirects covers the 301 either way)
        try:
            with httpx.Client(timeout=25, headers=UA, follow_redirects=True) as client:
                r = client.get(
                    "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/",
                    params={**base, "ids": f"PMC{pmcid}", "format": "json"},
                )
                if r.status_code == 200:
                    recs = (r.json() or {}).get("records") or []
                    if recs:
                        rec = recs[0]
                        # pmid comes back as an int — cast before resolving.
                        if rec.get("pmid"):
                            return self._resolve_pmid(str(rec["pmid"]))
                        if rec.get("doi"):
                            return self._resolve_doi(str(rec["doi"]))
        except Exception:
            pass
        return []
 
    def _resolve_pmid(self, pmid: str) -> list[dict]:
        base = _pubmed_base()
        with httpx.Client(timeout=25, headers=UA) as client:
            r = client.get(PUBMED_EFETCH, params={
                **base, "db": "pubmed", "id": pmid.strip(), "retmode": "xml"})
            if r.status_code != 200:
                return []
            root = ET.fromstring(r.text)
        out = []
        for art in root.findall(".//PubmedArticle"):
            rec = _parse_pubmed_article(art)
            if rec and rec.get("title"):
                out.append(rec)
        return out
 
    def _resolve_title(self, title: str) -> list[dict]:
        out = []
        with httpx.Client(timeout=25, headers=UA) as client:
            r = client.get(OPENALEX_API, params={
                "search": title, "per_page": 6, "mailto": _mailto()})
            if r.status_code != 200:
                return []
            for w in (r.json().get("results") or []):
                rec = _map_openalex(w)
                if rec:
                    out.append(rec)
        return out
 
    def _openalex(self, terms: list[str]) -> list[dict]:
        out = []
        with httpx.Client(timeout=25, headers=UA) as client:
            for q in terms[:3]:
                try:
                    r = client.get(OPENALEX_API, params={"search": q, "per_page": 30, "mailto": _mailto()})
                    r.raise_for_status()
                    results = r.json().get("results") or []
                except Exception:
                    continue
                for w in results:
                    rec = _map_openalex(w)
                    if rec:
                        out.append(rec)
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
                r = client.get(S2_SEARCH, params={"query": query, "limit": 40, "fields": S2_FIELDS})
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
            for q in terms[:3]:
                try:
                    r = client.get(ARXIV_API, params={"search_query": f"all:{q}", "start": 0, "max_results": 25})
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
        base = _pubmed_base()
        pmids: list[str] = []
        out = []
        with httpx.Client(timeout=25, headers=UA) as client:
            for q in terms[:3]:
                try:
                    r = client.get(PUBMED_ESEARCH, params={
                        **base, "db": "pubmed", "term": q, "retmax": 25, "retmode": "json"})
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
                    **base, "db": "pubmed", "id": ",".join(pmids[:50]), "retmode": "xml"})
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
 
 
# ── Identifier classification ──────────────────────────────────────────────
 
def _classify_identifier(q: str) -> tuple[str, str]:
    """Return (kind, value) where kind is arxiv|doi|pmid|title."""
    s = q.strip()
    low = s.lower()
 
    m = re.search(r"arxiv\.org/(?:abs|pdf)/([^\s?#]+)", low)
    if m:
        return "arxiv", m.group(1).replace(".pdf", "")
    m = re.match(r"arxiv:\s*(\S+)", low)
    if m:
        return "arxiv", m.group(1)
    if re.fullmatch(r"\d{4}\.\d{4,5}(v\d+)?", s):
        return "arxiv", s
 
    # PMC id (e.g. PMC11006387, or a pmc.ncbi.nlm.nih.gov/articles/PMC… URL)
    m = re.search(r"pmc(\d{5,})", low)
    if m:
        return "pmcid", m.group(1)
 
    # DOI — bare (10.xxxx/…), a doi.org URL, or embedded in any publisher URL
    m = re.search(r"(10\.\d{4,9}/[^\s\"<>]+)", s)
    if m and ("doi" in low or s.startswith("10.") or low.startswith("http")):
        return "doi", m.group(1).rstrip(").,;")
 
    m = re.search(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d+)", low)
    if m:
        return "pmid", m.group(1)
    if re.fullmatch(r"\d{1,8}", s):
        return "pmid", s
 
    return "title", s
 
 
# ── Shared helpers ─────────────────────────────────────────────────────────
 
def _mailto() -> str:
    return getattr(settings, "unpaywall_email", "") or "research@example.com"
 
 
def _pubmed_base() -> dict:
    base = {"tool": getattr(settings, "ncbi_tool", "") or "sift"}
    email = getattr(settings, "ncbi_email", "") or getattr(settings, "unpaywall_email", "")
    if email:
        base["email"] = email
    if getattr(settings, "ncbi_api_key", ""):
        base["api_key"] = settings.ncbi_api_key
    return base
 
 
def _map_openalex(w: dict) -> dict | None:
    title = _clean(w.get("title") or w.get("display_name") or "")
    if not title:
        return None
    names = [(a.get("author") or {}).get("display_name") for a in (w.get("authorships") or [])]
    src = (w.get("primary_location") or {}).get("source") or {}
    oa = w.get("open_access") or {}
    return {
        "title": title,
        "authors": _fmt_authors(names),
        "year": w.get("publication_year"),
        "venue": _clean(src.get("display_name") or ""),
        "url": oa.get("oa_url") or w.get("doi") or w.get("id") or "",
        "abstract": _reconstruct_abstract(w.get("abstract_inverted_index")),
        "cites": w.get("cited_by_count") or 0,
        "source": "openalex",
    }
 
 
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
 
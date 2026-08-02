"""
Bulk PubMed ingestion — Phase 2 of the pre-indexing plan.

Pulls metadata + abstracts for a set of biomedical queries via NCBI's
E-utilities (esearch with the history server, then efetch in batches),
respecting NCBI's documented rate limits (3 req/s without a key, 10 req/s
with NCBI_API_KEY set in .env), and writes them into the local `papers`
corpus table (core/corpus.py) tagged domain="biomedical".

This is a ONE-TIME (or periodically re-run) OFFLINE job — it does not run as
part of a normal search request, and makes no LLM calls, so it costs nothing
beyond your time and NCBI's free rate limit.

Run from backend/:
    python scripts/ingest_pubmed.py --query "CRISPR" --query "gene therapy" --max 2000
    python scripts/ingest_pubmed.py --terms-file mesh_terms.txt --max 5000
    python scripts/ingest_pubmed.py                                  # uses default seed queries
"""
import argparse
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))  # so `agents.` / `core.` resolve

from agents.academic_search import PUBMED_ESEARCH, PUBMED_EFETCH, UA, _pubmed_base, _parse_pubmed_article  # noqa: E402
from core.config import settings  # noqa: E402
from core.corpus import upsert_papers  # noqa: E402

BATCH = 200  # efetch batch size per request


def _rate_sleep():
    # NCBI: 3 req/s without an API key, 10 req/s with one configured.
    time.sleep(0.11 if settings.ncbi_api_key else 0.34)


def fetch_pmids(query: str, max_records: int, client: httpx.Client,
                 mindate: str | None = None, maxdate: str | None = None) -> list[str]:
    """esearch with the history server so we can page past the small default
    limit, capped at NCBI's documented 10,000-record ceiling per query.

    `mindate`/`maxdate` (YYYY/MM/DD or YYYY-MM-DD) scope the search to PubMed's
    "date added" (EDAT) field — this is what makes an incremental sync
    possible: pass the last sync date instead of re-pulling the whole query
    every time. Omit both for a full (unscoped) pull, as Phase 2 does."""
    base = _pubmed_base()
    cap = min(max_records, 10_000)
    params = {**base, "db": "pubmed", "term": query, "retmax": 0, "usehistory": "y", "retmode": "json"}
    if mindate or maxdate:
        params["datetype"] = "edat"  # EDAT = date the record was added to PubMed
        if mindate:
            params["mindate"] = mindate.replace("-", "/")
        if maxdate:
            params["maxdate"] = maxdate.replace("-", "/")
    r = client.get(PUBMED_ESEARCH, params=params)
    r.raise_for_status()
    es = r.json().get("esearchresult", {})
    webenv, query_key = es.get("webenv"), es.get("querykey")
    total = min(int(es.get("count", 0) or 0), cap)
    if not webenv or not query_key or total == 0:
        return []

    pmids: list[str] = []
    retstart = 0
    while retstart < total:
        _rate_sleep()
        r = client.get(PUBMED_ESEARCH, params={
            **base, "db": "pubmed", "term": query, "retmode": "json",
            "retstart": retstart, "retmax": min(BATCH, total - retstart),
            "webenv": webenv, "query_key": query_key,
        })
        r.raise_for_status()
        ids = r.json().get("esearchresult", {}).get("idlist", [])
        if not ids:
            break
        pmids.extend(ids)
        retstart += len(ids)
    return pmids


def fetch_and_store(pmids: list[str], client: httpx.Client) -> int:
    base = _pubmed_base()
    stored = 0
    for i in range(0, len(pmids), BATCH):
        batch = pmids[i:i + BATCH]
        _rate_sleep()
        try:
            r = client.get(PUBMED_EFETCH, params={
                **base, "db": "pubmed", "id": ",".join(batch), "retmode": "xml"})
            r.raise_for_status()
            root = ET.fromstring(r.text)
        except Exception as e:
            print(f"  ! efetch batch failed ({i}-{i + len(batch)}): {e}")
            continue
        papers = []
        for art in root.findall(".//PubmedArticle"):
            rec = _parse_pubmed_article(art)
            if rec and rec.get("title"):
                rec["source"] = "pubmed"
                papers.append(rec)
        upsert_papers(papers, domain="biomedical")
        stored += len(papers)
        print(f"  ingested {stored}/{len(pmids)}")
    return stored


# A reasonably broad starting set if the caller doesn't provide their own —
# swap for a real MeSH term list (via --terms-file) for production coverage.
DEFAULT_QUERIES = [
    "CRISPR", "gene therapy", "cancer immunotherapy", "biomarker discovery",
    "clinical trial machine learning", "protein structure prediction",
    "single cell RNA sequencing", "drug repurposing", "genomics",
    "neurodegenerative disease", "microbiome", "vaccine development",
]


def ingest(queries: list[str], max_records: int = 2000,
           mindate: str | None = None, maxdate: str | None = None) -> int:
    """Importable entry point (used by scripts/sync_corpus.py for the daily
    incremental pull) as well as by main() below for manual/bulk runs."""
    total_stored = 0
    with httpx.Client(timeout=30, headers=UA) as client:
        for q in queries:
            label = f"{q!r} (up to {max_records} records"
            label += f", {mindate or '…'}→{maxdate or '…'})" if (mindate or maxdate) else ")"
            print(f"\n=== {label} ===")
            try:
                pmids = fetch_pmids(q, max_records, client, mindate=mindate, maxdate=maxdate)
            except Exception as e:
                print(f"  ! esearch failed: {e}")
                continue
            print(f"  found {len(pmids)} PMIDs")
            if not pmids:
                continue
            total_stored += fetch_and_store(pmids, client)
    return total_stored


def main():
    ap = argparse.ArgumentParser(description="Bulk-ingest PubMed metadata into the local corpus.")
    ap.add_argument("--query", action="append", default=[], help="query/MeSH term (repeatable)")
    ap.add_argument("--terms-file", type=str, default=None, help="file with one query per line")
    ap.add_argument("--max", type=int, default=2000, help="max records PER query (NCBI caps at 10,000)")
    ap.add_argument("--since", type=str, default=None, help="YYYY-MM-DD — only records added on/after this date")
    ap.add_argument("--until", type=str, default=None, help="YYYY-MM-DD — only records added on/before this date")
    args = ap.parse_args()

    queries = list(args.query)
    if args.terms_file:
        queries += [ln.strip() for ln in Path(args.terms_file).read_text().splitlines() if ln.strip()]
    if not queries:
        queries = DEFAULT_QUERIES
        print(f"No --query given — using {len(queries)} default biomedical seed queries.")

    total_stored = ingest(queries, args.max, mindate=args.since, maxdate=args.until)
    print(f"\nDone. Ingested/updated {total_stored} paper records into the local corpus.")


if __name__ == "__main__":
    main()

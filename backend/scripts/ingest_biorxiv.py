"""
Bulk bioRxiv ingestion — Phase 2 of the pre-indexing plan.

Pulls preprint metadata + abstracts from bioRxiv's free public "details" API
(no key, no auth, no formal rate limit published) over a date range,
paginating via its cursor, and writes them into the local `papers` corpus
table (core/corpus.py) tagged domain="biomedical".

This is a ONE-TIME (or periodically re-run) OFFLINE job — no LLM calls, so it
costs nothing beyond your time and bandwidth.

Run from backend/:
    python scripts/ingest_biorxiv.py --start 2026-01-01 --end 2026-07-31
    python scripts/ingest_biorxiv.py --days 180     # last 180 days, ending today
    python scripts/ingest_biorxiv.py                # defaults to the last 30 days
"""
import argparse
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))  # so `core.` resolves

from core.corpus import upsert_papers  # noqa: E402

BASE = "https://api.biorxiv.org/details/biorxiv"
PAGE = 100     # bioRxiv returns up to 100 records per cursor page
SLEEP_S = 0.2  # polite pacing even without a published hard limit
UA = {"User-Agent": "Sift-LitReview/1.0 (research assistant; bulk ingest)"}


def _to_paper(rec: dict) -> dict | None:
    title = (rec.get("title") or "").strip()
    if not title:
        return None
    doi = rec.get("doi") or ""
    year = None
    date_str = rec.get("date") or ""
    if date_str[:4].isdigit():
        year = int(date_str[:4])
    return {
        "title": title,
        "authors": rec.get("authors") or "",
        "year": year,
        "venue": "bioRxiv",
        "url": f"https://doi.org/{doi}" if doi else "",
        "abstract": rec.get("abstract") or "",
        "source": "biorxiv",
    }


def ingest_range(start: str, end: str, client: httpx.Client) -> int:
    cursor = 0
    stored = 0
    while True:
        url = f"{BASE}/{start}/{end}/{cursor}/json"
        try:
            r = client.get(url)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f"  ! request failed at cursor {cursor}: {e}")
            break

        collection = data.get("collection") or []
        if not collection:
            break

        papers = [p for p in (_to_paper(rec) for rec in collection) if p]
        upsert_papers(papers, domain="biomedical")
        stored += len(papers)

        msgs = data.get("messages") or [{}]
        total = int(msgs[0].get("total", msgs[0].get("count", 0)) or 0)
        cursor += len(collection)
        print(f"  ingested {stored} (cursor {cursor}/{total or '?'})")
        if len(collection) < PAGE or (total and cursor >= total):
            break
        time.sleep(SLEEP_S)
    return stored


def main():
    ap = argparse.ArgumentParser(description="Bulk-ingest bioRxiv metadata into the local corpus.")
    ap.add_argument("--start", type=str, default=None, help="YYYY-MM-DD")
    ap.add_argument("--end", type=str, default=None, help="YYYY-MM-DD (default: today)")
    ap.add_argument("--days", type=int, default=None, help="ingest the last N days instead of --start/--end")
    args = ap.parse_args()

    end = args.end or date.today().isoformat()
    if args.days:
        start = (date.today() - timedelta(days=args.days)).isoformat()
    elif args.start:
        start = args.start
    else:
        start = (date.today() - timedelta(days=30)).isoformat()
        print(f"No range given — defaulting to the last 30 days ({start} to {end}).")

    print(f"Ingesting bioRxiv preprints from {start} to {end}...")
    with httpx.Client(timeout=30, headers=UA) as client:
        total = ingest_range(start, end, client)
    print(f"\nDone. Ingested/updated {total} paper records into the local corpus.")


if __name__ == "__main__":
    main()

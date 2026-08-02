"""
Phase 3 — incremental corpus sync.

Meant to run once a day (via cron/launchd, see bottom of this docstring), not
on every request. Each run:
  1. Reads the last-synced date per source from `sync_state` (core/corpus.py).
     First run ever: defaults to FIRST_RUN_LOOKBACK_DAYS ago, not "everything"
     — a full backfill is what scripts/ingest_pubmed.py / ingest_biorxiv.py
     with a wide --max /--days are for; this script is for staying current.
  2. Pulls only records added since that date (PubMed: EDAT-scoped esearch;
     bioRxiv: its native date-range API — both already support this natively,
     no new API surface needed).
  3. Writes them into the same `papers` table everything else uses.
  4. Advances the stored last-synced date to "today", so tomorrow's run picks
     up from here — never reprocesses the same window twice.

No LLM calls anywhere in this file — same zero-marginal-cost property as the
rest of ingestion, just spread out daily instead of done once in bulk.

Run manually:
    python scripts/sync_corpus.py
    python scripts/sync_corpus.py --pubmed-only
    python scripts/sync_corpus.py --dry-run       # shows what it WOULD pull, doesn't write

Schedule it (macOS/Linux cron — runs daily at 3am):
    crontab -e
    0 3 * * *  cd /path/to/sift/backend && /path/to/venv/bin/python scripts/sync_corpus.py >> logs/sync.log 2>&1
"""
import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.corpus import get_last_sync, set_last_sync, sync_status  # noqa: E402
from scripts.ingest_pubmed import DEFAULT_QUERIES, ingest as ingest_pubmed  # noqa: E402
from scripts.ingest_biorxiv import ingest_range as ingest_biorxiv_range  # noqa: E402
import httpx  # noqa: E402
from scripts.ingest_biorxiv import UA as BIORXIV_UA  # noqa: E402

FIRST_RUN_LOOKBACK_DAYS = 7   # if a source has never synced, start this far back — not "all time"
MAX_PER_QUERY_DAILY = 500     # a daily window should be small; this is a generous ceiling, not a target


def sync_pubmed(dry_run: bool = False) -> None:
    since = get_last_sync("pubmed")
    if not since:
        since = (date.today() - timedelta(days=FIRST_RUN_LOOKBACK_DAYS)).isoformat()
        print(f"[pubmed] no previous sync recorded — first run, looking back to {since}")
    until = date.today().isoformat()

    if since == until:
        print(f"[pubmed] already synced through {since} — nothing to do")
        return

    print(f"[pubmed] syncing {since} → {until} across {len(DEFAULT_QUERIES)} seed queries")
    if dry_run:
        print("[pubmed] --dry-run: skipping actual fetch")
        return

    try:
        stored = ingest_pubmed(DEFAULT_QUERIES, MAX_PER_QUERY_DAILY, mindate=since, maxdate=until)
        set_last_sync("pubmed", until, status="ok", records_added=stored)
        print(f"[pubmed] done — {stored} records added/updated, synced through {until}")
    except Exception as e:
        set_last_sync("pubmed", since, status=f"error: {e}", records_added=0)  # don't advance on failure
        print(f"[pubmed] ! sync failed, will retry this window next run: {e}")


def sync_biorxiv(dry_run: bool = False) -> None:
    since = get_last_sync("biorxiv")
    if not since:
        since = (date.today() - timedelta(days=FIRST_RUN_LOOKBACK_DAYS)).isoformat()
        print(f"[biorxiv] no previous sync recorded — first run, looking back to {since}")
    until = date.today().isoformat()

    if since == until:
        print(f"[biorxiv] already synced through {since} — nothing to do")
        return

    print(f"[biorxiv] syncing {since} → {until}")
    if dry_run:
        print("[biorxiv] --dry-run: skipping actual fetch")
        return

    try:
        with httpx.Client(timeout=30, headers=BIORXIV_UA) as client:
            stored = ingest_biorxiv_range(since, until, client)
        set_last_sync("biorxiv", until, status="ok", records_added=stored)
        print(f"[biorxiv] done — {stored} records added/updated, synced through {until}")
    except Exception as e:
        set_last_sync("biorxiv", since, status=f"error: {e}", records_added=0)
        print(f"[biorxiv] ! sync failed, will retry this window next run: {e}")


def main():
    ap = argparse.ArgumentParser(description="Daily incremental sync of the pre-indexed corpus.")
    ap.add_argument("--pubmed-only", action="store_true")
    ap.add_argument("--biorxiv-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="show what would be pulled, don't write")
    ap.add_argument("--status", action="store_true", help="just print current sync state and exit")
    args = ap.parse_args()

    if args.status:
        for row in sync_status():
            print(row)
        return

    if not args.biorxiv_only:
        sync_pubmed(dry_run=args.dry_run)
    if not args.pubmed_only:
        sync_biorxiv(dry_run=args.dry_run)


if __name__ == "__main__":
    main()

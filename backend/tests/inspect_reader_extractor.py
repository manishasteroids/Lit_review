"""
Inspect the Reader & Extractor stage in isolation — real calls, with timing.

This is the "understand how it works and why it's slow" tool. It runs a small
real pipeline slice:  reformulate -> search (a few papers) -> EXTRACT, then
prints each paper's extracted fields AND the per-batch latency so you can see
exactly where the time goes.

Usage (from backend/, with your .venv active):
    python tests/inspect_reader_extractor.py "on-board charging for EVs"
    python tests/inspect_reader_extractor.py "topic" --n 20        # fetch/extract 20 papers
    python tests/inspect_reader_extractor.py "topic" --batch 5     # batch size
    python tests/inspect_reader_extractor.py "topic" --model claude-haiku-4-5

Needs ANTHROPIC_API_KEY (from backend/.env). Search hits the free public APIs.
"""
import os
import sys
import time
import json
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from dotenv import load_dotenv
load_dotenv(BACKEND_ROOT / ".env", override=True)

from core.llm_client import LLMClient
from agents.query_reformulator import QueryReformulator
from agents.academic_search import AcademicSearchAgent
from agents.reader_extractor import ReaderExtractorAgent


def main() -> int:
    args = list(sys.argv[1:])

    def take(flag, default=None, cast=str):
        if flag in args:
            i = args.index(flag); val = args[i + 1]; del args[i:i + 2]
            return cast(val)
        return default

    model = take("--model")
    n = take("--n", 10, int)
    batch = take("--batch", None, int)
    topic = args[0] if args else "on-board charging for electric vehicles"

    api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not api_key:
        print("ERROR: no ANTHROPIC_API_KEY (put it in backend/.env)."); return 1

    llm = LLMClient(api_key=api_key, model=model)

    print("=" * 74)
    print("READER & EXTRACTOR — single-stage inspection")
    print("=" * 74)
    print(f"topic : {topic}")

    # --- upstream: get some real papers to feed the extractor ---
    reform = QueryReformulator(llm).run(topic)
    t = time.perf_counter()
    papers = AcademicSearchAgent(llm).run(topic, reform.get("queries", []), limit=n)
    print(f"search: {len(papers)} papers in {time.perf_counter()-t:.1f}s")
    if not papers:
        print("No papers found — aborting."); return 2

    size = batch or ReaderExtractorAgent.BATCH_SIZE
    n_batches = (len(papers) + size - 1) // size
    print(f"extract: {len(papers)} papers, batch_size={size} -> {n_batches} batch(es), "
          f"up to {ReaderExtractorAgent.MAX_WORKERS} concurrent")
    print("-" * 74)

    # --- the stage under inspection, timed ---
    t = time.perf_counter()
    extractions = ReaderExtractorAgent(llm).run(papers, batch_size=batch)
    elapsed = time.perf_counter() - t

    print(f"DONE: {len(extractions)} extractions in {elapsed:.1f}s "
          f"({elapsed / max(1, len(extractions)):.1f}s per paper)\n")

    by_idx = {e.get("idx"): e for e in extractions}
    for p in papers:
        e = by_idx.get(p["idx"], {})
        print(f"[#{p['idx']}] {p.get('title')}")
        if not e:
            print("     (no extraction returned — batch may have failed)\n"); continue
        print(f"     method     : {e.get('method')}")
        print(f"     finding    : {e.get('finding')}")
        print(f"     metrics    : {e.get('metrics')}")
        print(f"     limitation : {e.get('limitation')}")
        print(f"     concepts   : {', '.join(e.get('concepts') or [])}")
        print()

    print("-" * 74)
    print(f"missing extractions: {len(papers) - len(extractions)} "
          f"(dropped batches, if any)")
    print("tip: --model claude-haiku-4-5 is much faster/cheaper for this stage")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

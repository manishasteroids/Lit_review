"""
Tests for the Reader & Extractor stage.

HOW THIS STAGE WORKS
--------------------
    input  : approved_papers -> [{idx, title, year, abstract, ...}, ...]
    output : extractions     -> [{idx, method, finding, data, metrics,
                                   limitation, contribution, excerpt,
                                   relevance, concepts[]}, ...]

For each approved paper it asks the model to pull structured fields out of the
title + abstract. To stay within one call's output budget (and to run fast) it
splits the papers into BATCHES of `BATCH_SIZE` (default 10) and processes the
batches CONCURRENTLY, then merges the results. Each extraction carries the
paper's `idx`, so order across batches doesn't matter.

These tests mock the model, so they're fast, free, and deterministic.

Run:
    cd backend
    pytest tests/test_reader_extractor.py -v
"""
import json
import threading

from agents.reader_extractor import ReaderExtractorAgent
from core.llm_client import LLMClient


# ── Fake model: echoes one extraction per "[#idx]" it sees in the batch ────
class FakeLLM:
    def __init__(self, fail_on: set[int] | None = None):
        self.fail_on = fail_on or set()   # batch numbers whose output is broken JSON
        self.calls = 0
        self._lock = threading.Lock()     # run() is concurrent, so guard the counter

    def call(self, user_text=None, system=None, max_tokens=1200, **kw):
        import re
        with self._lock:
            self.calls += 1
            this_call = self.calls
        idxs = [int(x) for x in re.findall(r"\[#(\d+)\]", user_text)]
        payload = [{"idx": i, "method": "m", "finding": "f", "concepts": ["c"]} for i in idxs]
        out = json.dumps(payload)
        if this_call in self.fail_on:
            out = out[: len(out) // 2]    # truncate -> invalid JSON, like a max_tokens cut-off
        return out

    parse_json = staticmethod(LLMClient.parse_json)


def _papers(n):
    return [{"idx": i, "title": f"Paper {i}", "year": 2020 + i % 5, "abstract": "abstract"}
            for i in range(n)]


# ──────────────────────────────────────────────────────────────────────────
# 1. Contract: every approved paper gets an extraction, keyed by idx
# ──────────────────────────────────────────────────────────────────────────
def test_extracts_one_row_per_paper():
    out = ReaderExtractorAgent(FakeLLM()).run(_papers(6))
    assert len(out) == 6
    assert sorted(e["idx"] for e in out) == list(range(6))
    assert all("method" in e and "concepts" in e for e in out)


# ──────────────────────────────────────────────────────────────────────────
# 2. Batching: 50 papers are split into ceil(50/10)=5 calls, none dropped
# ──────────────────────────────────────────────────────────────────────────
def test_batches_large_shortlist():
    fake = FakeLLM()
    out = ReaderExtractorAgent(fake).run(_papers(50))
    assert fake.calls == 5, f"expected 5 batched calls, got {fake.calls}"
    assert len(out) == 50
    assert sorted(e["idx"] for e in out) == list(range(50))


# ──────────────────────────────────────────────────────────────────────────
# 3. Custom batch size is honoured
# ──────────────────────────────────────────────────────────────────────────
def test_custom_batch_size():
    fake = FakeLLM()
    ReaderExtractorAgent(fake).run(_papers(20), batch_size=5)
    assert fake.calls == 4        # 20 / 5


# ──────────────────────────────────────────────────────────────────────────
# 4. Robustness: one truncated/broken batch doesn't kill the others
#    (this is the failure mode that used to crash the whole stage)
# ──────────────────────────────────────────────────────────────────────────
def test_one_bad_batch_does_not_fail_the_rest():
    fake = FakeLLM(fail_on={2})       # 2nd batch returns invalid JSON
    out = ReaderExtractorAgent(fake).run(_papers(30))   # 3 batches
    assert fake.calls == 3
    # the two good batches (20 papers) still come through; no exception raised
    assert 15 <= len(out) <= 20
    assert out, "should still return the papers from the healthy batches"


# ──────────────────────────────────────────────────────────────────────────
# 5. Empty input is a no-op
# ──────────────────────────────────────────────────────────────────────────
def test_empty_input():
    fake = FakeLLM()
    assert ReaderExtractorAgent(fake).run([]) == []
    assert fake.calls == 0

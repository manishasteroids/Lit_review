"""
Reader & Extractor
--------------------
Diagram node: "Parses full text, extracts key info"

Pulls structured signal (method, finding, dataset, limitation, concept tags)
out of each approved paper. Reads from title + abstract by default; in Deep mode
it fetches each paper's full text (PDF/HTML) and extracts from that instead.

Robustness/scale:
  - papers are processed in BATCHES (fewer, larger calls — matters on rate-
    limited providers), run concurrently;
  - each batch is parsed defensively (a malformed batch yields nothing rather
    than crashing the stage);
  - a persistent per-paper cache (core.paper_cache) skips the fetch AND the LLM
    call for any paper already extracted at the same read depth;
  - an optional `on_progress` callback fires as each batch completes, so the UI
    can show papers being read one group at a time.
"""
from concurrent.futures import ThreadPoolExecutor

from agents.base import Agent


class ReaderExtractorAgent(Agent):
    name = "reader_extractor"

    SYSTEM = (
        "You are a reader/extractor agent. For each paper, extract structured info from "
        "its title and summary for a SciSpace-style paper table. "
        "Respond ONLY with a JSON array (no markdown): "
        '[{"idx":number,'
        '"method":"approach in <=10 words",'
        '"finding":"key result in <=14 words",'
        '"data":"dataset/system or n/a",'
        '"metrics":"key quantitative results (scores, AUROC, sample sizes) or n/a",'
        '"limitation":"one limitation",'
        '"contribution":"the paper\'s main contribution in one sentence",'
        '"relevance":"one sentence on why this paper matters to the review topic",'
        '"concepts":[2-3 short concept tags]}]. '
        "Keep every field grounded in the provided text; use \"n/a\" if truly unknown."
    )

    # Deep mode reads the FULL paper text, not just the abstract — so the
    # output has to be allowed to actually be longer, or all that extra
    # signal gets thrown away at this step and Synthesizer/Writer never see
    # it (this was the root cause of Deep-mode reviews reading almost
    # identically to Medium: same model tier improvements downstream, but
    # fed from an equally terse extraction either way).
    DEEP_SYSTEM = (
        "You are a reader/extractor agent doing a DEEP read of the full paper text (not just "
        "the abstract) for a systematic literature review. Extract substantive, detailed "
        "structured info per paper — use the extra material you were given; don't compress it "
        "down to the same length you'd use for an abstract-only skim. "
        "Respond ONLY with a JSON array (no markdown): "
        '[{"idx":number,'
        '"method":"the methodology/approach in detail, <=40 words — include model/technique '
        'names, key parameters or design choices",'
        '"finding":"the key result(s) in detail, <=45 words — include specific numbers where given",'
        '"data":"dataset/system/cohort used, with size if stated, or n/a",'
        '"metrics":"quantitative results (scores, AUROC, p-values, sample sizes, effect sizes) or n/a",'
        '"limitation":"1-2 substantive limitations the authors note or that are evident",'
        '"contribution":"the paper\'s main contribution, 2 sentences",'
        '"relevance":"why this paper matters to the review topic, 1-2 sentences",'
        '"concepts":[3-5 short concept tags]}]. '
        "Keep every field grounded in the provided text; use \"n/a\" if truly unknown. Do not "
        "pad with filler — every extra word should carry real information from the paper."
    )

    # Larger batches = fewer model calls, which matters on free/rate-limited
    # providers (e.g. Gemini) whose limit is requests-per-minute.
    BATCH_SIZE = 20
    # Concurrency cap — kept low so we don't burst past a free tier's RPM limit.
    MAX_WORKERS = 3
    # Chars of full text to feed per paper in Deep mode (~1.5k tokens).
    FULL_TEXT_CHARS = 6000

    full_text_stats = None   # {total, fetched, fell_back, cached} after a Deep run

    def _extract_batch(self, batch: list[dict], full_text: bool = False) -> list[dict]:
        corpus = "\n".join(
            # `_text` (fetched full text) is used in Deep mode; else the abstract.
            f"[#{p['idx']}] {p['title']} ({p.get('year', '?')}). "
            f"{p.get('_text') or p.get('abstract', '')}"
            for p in batch
        )
        # Output budget scales with batch size so extractions don't truncate.
        # Deep mode's fields are allowed to run much longer (see DEEP_SYSTEM),
        # so it needs a proportionally bigger per-paper output budget too.
        per_paper = 900 if full_text else 400
        max_tokens = min(8000, per_paper * len(batch))
        system = self.DEEP_SYSTEM if full_text else self.SYSTEM
        try:
            out = self.llm.call(user_text=f"Papers:\n{corpus}", system=system, max_tokens=max_tokens)
            parsed = self.llm.parse_json(out)
        except Exception:
            parsed = []
        return _as_list(parsed)

    def _attach_full_text(self, papers: list[dict]) -> list[dict]:
        """Deep mode: fetch each paper's full text (PDF/HTML) in parallel and
        attach it as `_text`. Falls back to the abstract when no OA copy exists."""
        from core.paper_text import fetch_paper_text

        def fetch(p: dict) -> dict:
            p = dict(p)
            try:
                txt = fetch_paper_text(p.get("url"))
            except Exception:
                txt = None
            if txt:
                p["_text"] = txt[: self.FULL_TEXT_CHARS]
            return p

        with ThreadPoolExecutor(max_workers=8) as ex:
            return list(ex.map(fetch, papers))

    def run(self, approved_papers: list[dict], batch_size: int | None = None,
            full_text: bool = False, on_progress=None) -> list[dict]:
        from core.paper_cache import get_cached, put_cached

        def emit(paper: dict, note: str = ""):
            if not on_progress:
                return
            title = (paper.get("title") or "")[:72]
            on_progress({
                "step": "extract",
                "message": f"✓ {title}" + (f" · {note}" if note else ""),
                "title": paper.get("title"),
            })

        # 1. Reuse any paper we've already extracted (same url + read depth) —
        #    skips both the PDF fetch and the LLM call.
        cached_results: list[dict] = []
        todo: list[dict] = []
        for p in approved_papers:
            hit = get_cached(p.get("url"), full_text)
            if hit is not None:
                hit = dict(hit)
                hit["idx"] = p["idx"]           # re-key to this run's paper
                cached_results.append(hit)
                emit(p, "cached")
            else:
                todo.append(p)

        # 2. Deep mode: fetch full text for the papers that still need extracting.
        fetched = fell_back = 0
        if full_text and todo:
            todo = self._attach_full_text(todo)
            for p in todo:
                if p.get("_text"):
                    fetched += 1
                else:
                    fell_back += 1

        # 3. Batch-extract the uncached papers (concurrently), emitting per batch.
        fresh: list[dict] = []
        if todo:
            size = batch_size or self.BATCH_SIZE
            batches = [todo[i:i + size] for i in range(0, len(todo), size)]
            if len(batches) <= 1:
                for b in batches:
                    fresh.extend(self._extract_batch(b, full_text=full_text))
                    for p in b:
                        emit(p)
            else:
                from functools import partial
                with ThreadPoolExecutor(max_workers=min(self.MAX_WORKERS, len(batches))) as ex:
                    # zip pairs each batch with its result (map preserves order),
                    # so we can emit the titles as each batch finishes.
                    extract_fn = partial(self._extract_batch, full_text=full_text)
                    for b, batch_result in zip(batches, ex.map(extract_fn, batches)):
                        fresh.extend(batch_result)
                        for p in b:
                            emit(p)

        # 3b. Retry papers the model silently dropped. A batch reply can come
        #     back with fewer objects than papers sent (truncation, or Gemini
        #     rate-limiting/omitting some) — those papers would otherwise vanish
        #     with no extraction. Retry them once, then stub any still missing so
        #     every approved paper keeps a row downstream.
        if todo:
            got = {e.get("idx") for e in fresh if e.get("idx") is not None}
            missing = [p for p in todo if p["idx"] not in got]
            if missing:
                size = batch_size or self.BATCH_SIZE
                for b in [missing[i:i + size] for i in range(0, len(missing), size)]:
                    fresh.extend(self._extract_batch(b, full_text=full_text))
                    for p in b:
                        emit(p, "retried")
                got = {e.get("idx") for e in fresh if e.get("idx") is not None}
                for p in todo:                       # last resort: keep the paper
                    if p["idx"] not in got:
                        fresh.append({"idx": p["idx"]})

        # 4. Cache the fresh extractions, keyed by paper url.
        by_idx = {p["idx"]: p for p in todo}
        for e in fresh:
            p = by_idx.get(e.get("idx"))
            # only cache real extractions — never the empty stubs from 3b, or a
            # failed paper would be permanently remembered as "no data".
            if p and any(k != "idx" for k in e):
                put_cached(p.get("url"), full_text, e)

        # 5. Coverage stats (surfaced in the UI for Deep runs).
        self.full_text_stats = {
            "total": len(approved_papers),
            "fetched": fetched,             # newly read from full text
            "fell_back": fell_back,         # newly fell back to abstract
            "cached": len(cached_results),  # reused from cache (no fetch/LLM)
        } if full_text else None

        return cached_results + fresh


def _as_list(parsed) -> list[dict]:
    """Accept the model's reply whether it's a bare JSON array (Claude) or an
    array wrapped in an object like {"extractions":[...]} / {"papers":[...]}
    (Gemini sometimes does this), or a single object."""
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("extractions", "papers", "results", "data", "items"):
            v = parsed.get(key)
            if isinstance(v, list):
                return v
        if "idx" in parsed:      # a single extraction object
            return [parsed]
    return []

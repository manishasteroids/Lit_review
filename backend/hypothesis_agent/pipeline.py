"""
Hypothesis Agent -- pipeline (best-outcome: raised cap + ranking bracket + meta-review)
=========================================================================================
Runs the Hypothesis Agent against a Literature Package pulled from an
existing, completed Sift run. Reuses Sift's own agents
(ExperimentDesignerAgent, HypothesisCriticAgent, find_bridge_candidates)
directly -- this is the "same process, reuse now, extract later" phase from
hypothesis_agent_architecture.md SS1.1/SS1.2, not the finished two-service
design. A Sift session is only ever READ here, never written to -- this
module has no way to modify a Sift run, matching the one-directional
dependency the architecture doc calls for.

Stages: bridge lookup -> Generation (up to BEST_OUTCOME_MAX_HYPOTHESES
hypotheses, genuinely distinct per the Designer's system prompt) -> Critique
(every hypothesis scored against THIS run's own corpus) -> Novelty
verification (agents/hypothesis_novelty.py: a REAL literature search per
hypothesis via agents/academic_search.py, checked for actual prior art --
closes the gap the Critic's corpus-only novelty score can't, see
hypothesis_critic.py's own docstring) -> single-elimination ranking bracket
(agents/hypothesis_ranker.py judges each match, with the novelty verdict as
extra context) -> Meta-Review (agents/hypothesis_meta_review.py writes the
closing recommendation from the champion + runner-up) -> Plausibility check
(agents/hypothesis_plausibility.py: a literature-grounded sanity check on
the CHAMPION's own numeric target(s), run once against this run's own
extracted metrics/findings -- the closest thing to "empirical validation"
this tool can do without a dataset or code execution to actually run the
experiment against; see that module's docstring for exactly what it does
and doesn't check). This is the architecture doc's SS5 "best-outcome
pipeline" -- MVP version: no per-hypothesis refine/debate loop yet (that's a
further enhancement, not required for "raise the cap and pick the best
one"). Methods (the Sift-embedded panel) is untouched -- it still calls
ExperimentDesignerAgent.run() with the default max_hypotheses=2 and never
reaches the novelty check/ranker/meta-reviewer/plausibility check at all.

Every LLM call this run makes (Designer, Critic, each ranker match,
Meta-Review, Plausibility) is captured into an `audit_log` -- see
_wrap_llm_for_audit below -- and saved alongside the structured output, per
hypothesis_agent_architecture.md SS6.4. This is what makes a run
inspectable/reproducible after the fact: the structured plan/critique/
bracket/meta_review/plausibility_check are the parsed results; audit_log is
the raw prompt/response underneath each of them.
"""
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable, Optional

from agents.academic_search import AcademicSearchAgent
from agents.experiment_designer import ExperimentDesignerAgent
from agents.hypothesis_critic import HypothesisCriticAgent
from agents.hypothesis_meta_review import HypothesisMetaReviewAgent
from agents.hypothesis_novelty import HypothesisNoveltyAgent
from agents.hypothesis_plausibility import HypothesisPlausibilityAgent
from agents.hypothesis_ranker import HypothesisRankerAgent
from core.config import settings
from core.llm_client import LLMClient
from pipeline.knowledge_graph import find_bridge_candidates

# Raised from the Phase-1 cap of 2 per the "build it now" decision on
# hypothesis_agent_architecture.md SS5 -- more real alternatives for the
# bracket to actually choose between, at the cost of more LLM calls/run.
BEST_OUTCOME_MAX_HYPOTHESES = 6

# How many candidate papers a novelty check's live search pulls in per
# hypothesis -- small on purpose: this only needs enough to catch a real
# near-duplicate, not a full literature survey (that's Sift's own search
# stage). Real API calls (not LLM cost), but still one round-trip per
# hypothesis, so kept modest.
NOVELTY_SEARCH_LIMIT = 6


def _next_pow2(n: int) -> int:
    p = 1
    while p < n:
        p *= 2
    return p


def _seed_order(size: int) -> list[int]:
    """Standard tournament bracket seeding order for a power-of-two `size`,
    e.g. size=8 -> [1, 8, 4, 5, 2, 7, 3, 6] -- consecutive pairs are the
    round-1 matches, and the strongest seeds (1, 2, ...) end up paired
    against the weakest (size, size-1, ...) so they get the "byes" when the
    real field is smaller than `size` (see _run_bracket)."""
    order = [1]
    while len(order) < size:
        half = len(order)
        order = [x for s in order for x in (s, 2 * half + 1 - s)]
    return order


def _run_bracket(rank_fn: Callable[[int, int], tuple[str, str]],
                  seeds: list[int]) -> tuple[int, Optional[int], list[dict]]:
    """Single-elimination bracket over `seeds` (a list of hypothesis indices,
    ordered strongest-seed-first -- typically by critique overall score).
    Byes go to the strongest seeds when len(seeds) isn't a power of two, so
    a field of 6 plays exactly 5 real matches (2 first-round + 2 semifinal +
    1 final), matching hypothesis_agent_architecture.md Fig. 4.

    `rank_fn(a_idx, b_idx)` judges one real match and returns
    (winner_side, reason) where winner_side is "a" or "b".

    Returns (champion_idx, runner_up_idx, history) where history is a list
    of per-match dicts in bracket order (byes included, marked bye=True) --
    saved alongside the run so the portal can show the actual bracket, and
    so the Meta-Reviewer gets the real reasoning behind each result, not
    just the final two hypotheses in isolation."""
    n = len(seeds)
    if n == 0:
        return None, None, []  # noqa: this shouldn't happen — caller guards len(hyps) >= 2
    if n == 1:
        return seeds[0], None, []

    size = _next_pow2(n)
    order = _seed_order(size)
    seed_to_idx = {i + 1: seeds[i] for i in range(n)}  # 1-based seed number -> hypothesis idx
    current = [seed_to_idx.get(s) for s in order]      # None = bye slot

    history: list[dict] = []
    round_num = 1
    runner_up = None
    while len(current) > 1:
        is_final = len(current) == 2
        nxt = []
        for i in range(0, len(current), 2):
            a, b = current[i], current[i + 1]
            if a is None and b is None:
                nxt.append(None)
                continue
            if a is None or b is None:
                winner = a if b is None else b
                nxt.append(winner)
                history.append({"round": round_num, "a": a, "b": b, "winner": winner,
                                "reason": "bye — no opponent this round", "bye": True})
                continue
            side, reason = rank_fn(a, b)
            winner = a if side == "a" else b
            loser = b if side == "a" else a
            history.append({"round": round_num, "a": a, "b": b, "winner": winner,
                             "reason": reason, "bye": False})
            nxt.append(winner)
            if is_final:
                runner_up = loser
        current = nxt
        round_num += 1
    return current[0], runner_up, history


def _wrap_llm_for_audit(llm: LLMClient, audit_log: list[dict]) -> None:
    """Wrap `llm.call` so every raw prompt/response this run makes is
    captured into `audit_log`, in call order -- one entry per actual LLM
    call (so the ranker's 5 matches each get their own entry, not one
    combined "ranking" entry). This is the audit-artifact layer from
    hypothesis_agent_architecture.md SS6.4: the structured `plan`/`critique`/
    `bracket`/`meta_review` in the saved run are the AGENT'S post-parse
    output; this is the raw exchange underneath each of them, kept
    specifically so a run can be inspected or reproduced later without
    re-running it -- e.g. to see exactly what the Critic was shown when it
    scored a hypothesis, not just the score it produced.

    Reads `llm.stage` at CALL time (not wrap time) -- pipeline code sets
    `llm.stage` right before each agent's .run(), so each entry is correctly
    attributed even though every stage shares one LLMClient instance."""
    original_call = llm.call

    def recording_call(*args, **kwargs):
        started_at = datetime.now(timezone.utc).isoformat()
        t0 = time.monotonic()
        output = original_call(*args, **kwargs)
        latency_ms = int((time.monotonic() - t0) * 1000)
        audit_log.append({
            "stage": llm.stage,
            "model": llm.model,
            "started_at": started_at,
            "latency_ms": latency_ms,
            "system": kwargs.get("system"),
            "user_text": kwargs.get("user_text"),
            "output": output,
        })
        return output

    llm.call = recording_call


def run_hypothesis_pipeline(
    run_id: str,
    topic: str,
    extractions: list[dict],
    synthesis: Optional[dict],
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    on_progress: Optional[Callable[[dict], None]] = None,
    max_hypotheses: int = BEST_OUTCOME_MAX_HYPOTHESES,
) -> dict:
    """The best-outcome pipeline: bridge lookup -> Generation -> Critique ->
    ranking bracket -> Meta-Review, run against a Literature Package snapshot
    read from an existing Sift run. `run_id` here is only used to tag the
    LLM-usage ledger (see core/usage.py's record_call) -- it's the SOURCE
    Sift run's id, not a hypothesis run's own id, which the caller assigns
    separately when persisting the result (core/hypothesis_db.py).

    `on_progress`, if given, is called synchronously with
    {"stage": "fetch"|"designer"|"critic"|"novelty"|"ranking"|"meta_review",
    "status": "start"|"done", ...} at each stage boundary -- lets a caller
    (api/hypothesis_routes.py's SSE stream) surface live progress in the
    portal instead of one opaque spinner. Two stages attach extra detail on
    top of the plain start/done pair, both surfaced in HypothesisPipelineRail:
    "critic" start includes "hypotheses" (how many it's about to score, all
    in one LLM call); "ranking" start includes "total" (n-1 real matches,
    always, for an n-hypothesis field) and each match additionally emits
    status "match_start" (a, b: the two hypothesis indices being judged) then
    "match_done" (a, b, winner, reason) before the next match starts -- this
    is normally the slowest stage since matches run one at a time (each
    match's winner decides who plays next). Runs on whatever thread calls
    this function (the route wraps this whole call in asyncio.to_thread and
    bridges progress back via a thread-safe queue).

    "novelty" is skipped when the Designer produced zero hypotheses.
    "ranking" and "meta_review" are skipped (never emitted) when the
    Designer produced fewer than 2 hypotheses -- there's nothing to rank.
    "plausibility" runs once a champion exists (whether from a single
    hypothesis or the bracket) and is skipped only when the Designer
    produced zero hypotheses.

    Returns a dict ready to persist as one hypothesis_runs row's `data`,
    including `audit_log`: every LLM call this run made, in order, with its
    stage, model, raw system/user prompt, raw output, and latency."""
    def emit(stage: str, status: str, **extra) -> None:
        # `extra` carries optional sub-progress detail (e.g. ranking's
        # match_start/match_done events include which two hypotheses are
        # being judged and, once done, the winner) -- api/hypothesis_routes.py's
        # SSE handler spreads the whole event dict through as-is, so any key
        # added here reaches the portal's HypothesisPipelineRail unchanged.
        if on_progress:
            on_progress({"stage": stage, "status": status, **extra})

    if not extractions:
        raise ValueError(
            "No extractions to build hypotheses from -- run this topic "
            "through Sift's Reader & Extractor first."
        )

    # IMPORTANT: run_id here must be the real Sift session id, unprefixed —
    # core/usage.get_usage_trend() and get_usage() both roll llm_calls up by
    # JOINing on sessions.id, so a synthetic id (the old "hyp-<id>" scheme)
    # silently orphaned every Hypothesis Agent call from both the per-run
    # Usage tab AND the account-wide Token usage dashboard: the calls were
    # still recorded, just invisible everywhere costs are shown. Distinct
    # stage tags (set per-call below, not fixed at construction) are what
    # separate this agent's cost from Methods' own "experiments" /
    # "experiments_critique" stages on the same session — not a separate id.
    llm = LLMClient(
        api_key=api_key,
        model=model or settings.mid_model or settings.model,
        run_id=run_id,
        stage="hypothesis_designer",
    )
    audit_log: list[dict] = []
    _wrap_llm_for_audit(llm, audit_log)

    emit("fetch", "start")
    bridges = find_bridge_candidates(extractions)
    emit("fetch", "done")

    emit("designer", "start")
    llm.stage = "hypothesis_designer"
    designer = ExperimentDesignerAgent(llm)
    plan = designer.run(topic, synthesis or {}, extractions, kg_bridges=bridges,
                         max_hypotheses=max_hypotheses)
    emit("designer", "done")

    # Computed here (not after the critic call) so its "start" event can
    # report how many hypotheses it's about to score -- the Critic scores
    # ALL of them in a single LLM call (not one call per hypothesis), which
    # is exactly why it can take a while for a run with 5-6 hypotheses: one
    # big structured-JSON response covering 4 axes x N hypotheses, not N
    # small fast ones.
    hyps = (plan or {}).get("hypotheses") or []

    emit("critic", "start", hypotheses=len(hyps))
    llm.stage = "hypothesis_critic"
    critic = HypothesisCriticAgent(llm)
    critique = critic.run(topic, plan, extractions)
    emit("critic", "done")

    critiques_by_index = {
        c["index"]: c for c in (critique.get("critiques") or [])
        if isinstance(c, dict) and isinstance(c.get("index"), int)
    }

    novelty_checks: dict[int, dict] = {}
    if hyps:
        emit("novelty", "start")
        llm.stage = "hypothesis_novelty"
        searcher = AcademicSearchAgent(llm)
        novelty_agent = HypothesisNoveltyAgent(llm)

        def _check_one(item: tuple[int, dict]) -> tuple[int, dict]:
            i, h = item
            query = (h.get("hypothesis") or "").strip()
            try:
                candidates = searcher.run(
                    topic=query or topic, queries=[topic], limit=NOVELTY_SEARCH_LIMIT,
                ) if query else []
            except Exception:
                candidates = []
            return i, novelty_agent.run(topic, h, candidates)

        # Each hypothesis's check is a real multi-source HTTP search (see
        # agents/academic_search.py -- each source has its own 25s timeout)
        # plus one LLM call, and every hypothesis's check is independent of
        # every other's -- running them one at a time (the old behavior)
        # meant a 6-hypothesis field could serialize into several minutes of
        # wait for this stage alone. Concurrent instead, capped like
        # reader_extractor.py's own worker pool so this stays polite to
        # rate-limited providers rather than bursting 6 searches at once.
        with ThreadPoolExecutor(max_workers=min(3, len(hyps))) as ex:
            for i, result in ex.map(_check_one, enumerate(hyps)):
                novelty_checks[i] = result
        emit("novelty", "done")

    # A shallow per-hypothesis copy carrying its novelty verdict, used ONLY
    # as input to the ranker/meta-reviewer below -- both agents just
    # json.dumps() whatever hypothesis dict they're given, so folding the
    # literature check in here means their prompts see it without either
    # agent's code needing to know this stage exists. The `hyps` list
    # returned in `plan` (what the UI reads) is untouched.
    hyps_with_lit = [
        {**h, "literature_check": novelty_checks.get(i)} for i, h in enumerate(hyps)
    ]

    bracket = None
    meta_review = None
    champion_index = None
    runner_up_index = None

    if len(hyps) == 1:
        champion_index = 0
    elif len(hyps) >= 2:
        # A single-elimination bracket over n entrants always plays exactly
        # n-1 real matches (every match eliminates one hypothesis; byes
        # eliminate none) -- see _run_bracket's docstring. Reported up front
        # so the rail can show "match 2 of 5" instead of an opaque spinner
        # for what's usually the slowest stage (one sequential LLM call per
        # match, since each match's outcome decides the next one).
        emit("ranking", "start", total=len(hyps) - 1)
        llm.stage = "hypothesis_ranker"
        ranker = HypothesisRankerAgent(llm)

        def rank_fn(a_idx: int, b_idx: int) -> tuple[str, str]:
            emit("ranking", "match_start", a=a_idx, b=b_idx)
            result = ranker.run(
                topic, hyps_with_lit[a_idx], critiques_by_index.get(a_idx),
                hyps_with_lit[b_idx], critiques_by_index.get(b_idx), extractions,
            )
            side = result.get("winner", "a")
            reason = result.get("reason", "")
            winner_idx = a_idx if side == "a" else b_idx
            emit("ranking", "match_done", a=a_idx, b=b_idx, winner=winner_idx, reason=reason)
            return side, reason

        # Seed by critique overall score (best first) so stronger hypotheses
        # get the early-round byes when the field isn't a power of two.
        seeds = sorted(range(len(hyps)),
                        key=lambda i: -(critiques_by_index.get(i, {}).get("overall") or 0))
        champion_index, runner_up_index, history = _run_bracket(rank_fn, seeds)
        bracket = {"seeds": seeds, "matches": history}
        emit("ranking", "done")

        if runner_up_index is not None:
            emit("meta_review", "start")
            llm.stage = "hypothesis_meta_review"
            meta_reviewer = HypothesisMetaReviewAgent(llm)
            meta_review = meta_reviewer.run(
                topic, hyps_with_lit[champion_index], critiques_by_index.get(champion_index),
                hyps_with_lit[runner_up_index], critiques_by_index.get(runner_up_index),
                history, extractions,
            )
            emit("meta_review", "done")

    # Plausibility check: the closest thing to "empirical validation" this
    # tool can do without a dataset or code execution -- a literature-
    # grounded sanity check on the CHAMPION's own numeric target(s) against
    # what comparable methods in this run's own extractions actually
    # reported (see agents/hypothesis_plausibility.py's docstring). Runs
    # once, on the champion only, after it's been decided -- there's no
    # value in checking every hypothesis's numbers when only one is being
    # recommended. Skipped along with everything above when the Designer
    # produced zero hypotheses (champion_index stays None).
    plausibility_check = None
    if champion_index is not None:
        emit("plausibility", "start")
        llm.stage = "hypothesis_plausibility"
        plausibility_agent = HypothesisPlausibilityAgent(llm)
        plausibility_check = plausibility_agent.run(topic, hyps[champion_index], extractions)
        emit("plausibility", "done")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": llm.model,
        "topic": topic,
        "kg_bridges": bridges,
        "plan": plan,
        "critique": critique,
        "novelty_checks": novelty_checks,
        "bracket": bracket,
        "champion_index": champion_index,
        "runner_up_index": runner_up_index,
        "meta_review": meta_review,
        "plausibility_check": plausibility_check,
        "audit_log": audit_log,
    }

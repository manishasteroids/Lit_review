"""
Hypothesis Agent routes -- its own router, its own table, its own API
surface, mirroring the "separate tool" decision in
hypothesis_agent_architecture.md. This module only ever READS a Sift run
(via api.routes.get_run) to pull its Literature Package -- it never calls
into anything that writes back to a Sift session. That one-directional
read is the entire coupling between the two tools right now.

Phase 1 scope: create a hypothesis run from a completed Sift run, fetch one,
list past ones. No refine/rank/meta-review endpoints yet -- see
hypothesis_agent/pipeline.py's docstring for what's deliberately deferred.
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agents.hypothesis_critic import HypothesisCriticAgent
from agents.hypothesis_meta_review import HypothesisMetaReviewAgent
from agents.hypothesis_ranker import HypothesisRankerAgent
from agents.hypothesis_results_check import HypothesisResultsCheckAgent
from api.routes import get_run
from core.auth import require_user
from core.config import settings
from core.hypothesis_db import (create_hypothesis_run, get_hypothesis_run,
                                 list_hypothesis_runs, update_hypothesis_run_data)
from core.llm_client import LLMClient
from hypothesis_agent.pipeline import run_hypothesis_pipeline

router = APIRouter(prefix="/api/hypothesis")


class CreateHypothesisRunBody(BaseModel):
    source_run_id: str
    api_key: str | None = None
    model: str | None = None


# ── Streaming variant (SSE) ─────────────────────────────────────────────────
# Same request/response shape as POST /runs below, but streams a 'progress'
# event at each pipeline stage boundary (fetch/designer/critic — see
# hypothesis_agent/pipeline.py's on_progress) before the final 'done' event,
# so the portal's Hypothesis pipeline rail can show live progress instead of
# one opaque spinner. Mirrors api/routes.py's /runs/stream and
# /runs/{run_id}/synthesize/stream — same asyncio.Queue + thread-safe
# call_soon_threadsafe bridge, since the actual pipeline call is sync/blocking
# and runs in a worker thread via asyncio.to_thread.
@router.post("/runs/stream")
async def create_run_stream(body: CreateHypothesisRunBody, user_id: str = Depends(require_user)):
    source = get_run(body.source_run_id, user_id)  # fast, no LLM — validates ownership first

    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def on_progress(event: dict):
        """Called from the worker thread running run_hypothesis_pipeline —
        pushes into the async queue via the thread-safe scheduling call."""
        loop.call_soon_threadsafe(queue.put_nowait, {"type": "progress", **event})

    async def work():
        try:
            result = await asyncio.to_thread(
                run_hypothesis_pipeline,
                run_id=source.run_id,
                topic=source.topic,
                extractions=source.extractions,
                synthesis=source.synthesis,
                api_key=body.api_key,
                model=body.model,
                on_progress=on_progress,
            )
            saved = create_hypothesis_run(
                user_id=user_id,
                source_run_id=source.run_id,
                source_topic=source.topic,
                status="done",
                data=result,
            )
            await queue.put({"type": "done", "run": saved})
        except ValueError as e:
            await queue.put({"type": "error", "message": str(e)})
        except Exception as e:  # noqa: BLE001
            await queue.put({"type": "error", "message": f"Hypothesis Agent failed: {e}"})

    asyncio.create_task(work())

    async def generate():
        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                break

    return StreamingResponse(
        generate(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/runs")
def create_run(body: CreateHypothesisRunBody, user_id: str = Depends(require_user)):
    """Kick off a new Hypothesis Agent run against an existing, completed
    Sift session. Reads that session's topic/extractions/synthesis once;
    never touches the Sift session again."""
    source = get_run(body.source_run_id, user_id)

    try:
        result = run_hypothesis_pipeline(
            run_id=source.run_id,
            topic=source.topic,
            extractions=source.extractions,
            synthesis=source.synthesis,
            api_key=body.api_key,
            model=body.model,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Hypothesis Agent failed: {e}")

    saved = create_hypothesis_run(
        user_id=user_id,
        source_run_id=source.run_id,
        source_topic=source.topic,
        status="done",
        data=result,
    )
    return saved


@router.get("/runs/{hyp_run_id}")
def get_run_detail(hyp_run_id: str, user_id: str = Depends(require_user)):
    run = get_hypothesis_run(hyp_run_id, user_id)
    if not run:
        raise HTTPException(404, "Hypothesis run not found.")
    return run


@router.get("/runs")
def list_runs(source_run_id: str | None = None, user_id: str = Depends(require_user)):
    return {"runs": list_hypothesis_runs(user_id, source_run_id)}


# ── User-supplied results: the human-in-the-loop path ──────────────────────
# The plausibility check (hypothesis_agent/pipeline.py's automatic stage) is
# the tool's own literature-only sanity check. This is the counterpart a
# researcher reaches for deliberately, after actually running (a version of)
# the experiment: paste in what happened, get a verdict against the
# hypothesis's specific claim, and — unless it was fully supported — a
# revised hypothesis that accounts for what was actually observed (see
# agents/hypothesis_results_check.py's docstring). Every check is appended
# to the run's own `data.user_validations`, never overwriting a prior one;
# nothing here is applied to the hypothesis itself unless a person explicitly
# calls /apply-refinement on it.
class CheckResultsBody(BaseModel):
    hypothesis_index: int
    results_text: str
    api_key: str | None = None
    model: str | None = None


@router.post("/runs/{hyp_run_id}/check-results")
def check_results(hyp_run_id: str, body: CheckResultsBody, user_id: str = Depends(require_user)):
    run = get_hypothesis_run(hyp_run_id, user_id)
    if not run:
        raise HTTPException(404, "Hypothesis run not found.")

    hyps = ((run["data"] or {}).get("plan") or {}).get("hypotheses") or []
    if not (0 <= body.hypothesis_index < len(hyps)):
        raise HTTPException(400, "hypothesis_index is out of range for this run.")
    if not body.results_text.strip():
        raise HTTPException(400, "results_text is required.")

    # Re-read the SOURCE Sift run for its extractions -- the hypothesis run's
    # own saved `data` never stores them (they're an input, not an output;
    # see hypothesis_agent/pipeline.py). Same one-directional read every
    # other route in this file already does via get_run.
    source = get_run(run["source_run_id"], user_id)

    llm = LLMClient(
        api_key=body.api_key,
        model=body.model or settings.mid_model or settings.model,
        run_id=run["source_run_id"],
        stage="hypothesis_results_check",
    )
    agent = HypothesisResultsCheckAgent(llm)
    result = agent.run(run["data"]["topic"], hyps[body.hypothesis_index],
                        body.results_text, source.extractions)

    validation = {
        "id": str(uuid.uuid4()),
        "hypothesis_index": body.hypothesis_index,
        "results_text": body.results_text,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "applied": False,
        **result,
    }
    data = dict(run["data"])
    data["user_validations"] = [*(data.get("user_validations") or []), validation]
    updated = update_hypothesis_run_data(hyp_run_id, user_id, data)
    if not updated:
        raise HTTPException(404, "Hypothesis run not found.")
    return updated


class ApplyRefinementBody(BaseModel):
    validation_id: str


@router.post("/runs/{hyp_run_id}/apply-refinement")
def apply_refinement(hyp_run_id: str, body: ApplyRefinementBody, user_id: str = Depends(require_user)):
    """Swaps hypothesis_index's text for that validation's refined_hypothesis
    — the one place a user-supplied-results check actually changes the saved
    run, and only when a person explicitly asks for it (never automatic).
    Deliberately does NOT re-run the critic/bracket/meta-review/plausibility
    check against the new text — those would need real re-computation to stay
    honest, not a silent carry-forward, and that's more than this endpoint
    scopes to; the UI marks them as stale until the pipeline is re-run."""
    run = get_hypothesis_run(hyp_run_id, user_id)
    if not run:
        raise HTTPException(404, "Hypothesis run not found.")

    validations = (run["data"] or {}).get("user_validations") or []
    match = next((v for v in validations if v.get("id") == body.validation_id), None)
    if not match:
        raise HTTPException(404, "Validation record not found on this run.")
    if not match.get("refined_hypothesis"):
        raise HTTPException(400, "This validation has no refined hypothesis to apply.")

    hyps = ((run["data"] or {}).get("plan") or {}).get("hypotheses") or []
    idx = match["hypothesis_index"]
    if not (0 <= idx < len(hyps)):
        raise HTTPException(400, "hypothesis_index is out of range for this run.")

    data = dict(run["data"])
    data["plan"] = dict(data["plan"])
    data["plan"]["hypotheses"] = list(data["plan"]["hypotheses"])
    data["plan"]["hypotheses"][idx] = match["refined_hypothesis"]
    data["user_validations"] = [
        {**v, "applied": True} if v.get("id") == body.validation_id else v
        for v in validations
    ]
    updated = update_hypothesis_run_data(hyp_run_id, user_id, data)
    if not updated:
        raise HTTPException(404, "Hypothesis run not found.")
    return updated


# ── Closing the loop: hypothesis_agent_architecture.md §7 ──────────────────
# An applied refinement (above) swaps in new hypothesis text but never gets a
# chance to actually beat the current champion — it just sits at its old
# bracket position. This is the "champion challenge" from §7.1/§7.2: instead
# of a full bracket replay (expensive, and the exact thing §6.3/§6.5 already
# deferred once for ranker-match disputes), the refined hypothesis gets a
# fresh Critic score, then up to two head-to-head matches (vs the champion,
# and — only if it loses that one — vs the runner-up) reusing
# HypothesisRankerAgent.run() unchanged. Scoped to refinements only per §7.4:
# a Meta-Review dispute that already swapped the champion via /apply-dispute
# doesn't get a second re-verification pass on top of the swap it just did.
class ReverifyRefinementBody(BaseModel):
    validation_id: str
    api_key: str | None = None
    model: str | None = None


@router.post("/runs/{hyp_run_id}/reverify-refinement")
def reverify_refinement(hyp_run_id: str, body: ReverifyRefinementBody, user_id: str = Depends(require_user)):
    run = get_hypothesis_run(hyp_run_id, user_id)
    if not run:
        raise HTTPException(404, "Hypothesis run not found.")

    d = run["data"] or {}
    validations = d.get("user_validations") or []
    match = next((v for v in validations if v.get("id") == body.validation_id), None)
    if not match:
        raise HTTPException(404, "Validation record not found on this run.")
    if not match.get("applied"):
        raise HTTPException(400, "Apply this refinement before re-verifying it against the champion.")

    idx = match["hypothesis_index"]
    hyps = ((d.get("plan") or {}).get("hypotheses")) or []
    champion_index, runner_up_index = d.get("champion_index"), d.get("runner_up_index")
    if champion_index is None or runner_up_index is None:
        raise HTTPException(400, "This run has no champion/runner-up yet to challenge.")
    if not (0 <= idx < len(hyps)) or not (0 <= champion_index < len(hyps)) or not (0 <= runner_up_index < len(hyps)):
        raise HTTPException(400, "hypothesis_index/champion_index/runner_up_index out of range for this run.")
    if idx in (champion_index, runner_up_index):
        raise HTTPException(
            400,
            "This hypothesis is already the champion or runner-up — nothing to challenge it against.",
        )

    source = get_run(run["source_run_id"], user_id)
    llm = LLMClient(
        api_key=body.api_key,
        model=body.model or settings.mid_model or settings.model,
        run_id=run["source_run_id"],
        stage="hypothesis_reverify_critic",
    )
    challenger = hyps[idx]
    critique_out = HypothesisCriticAgent(llm).run(d["topic"], {"hypotheses": [challenger]}, source.extractions)
    challenger_critique = next(
        (c for c in (critique_out.get("critiques") or []) if c.get("index") == 0), None,
    )
    if challenger_critique:
        challenger_critique = {**challenger_critique, "index": idx}

    critiques_by_index = {
        c["index"]: c for c in ((d.get("critique") or {}).get("critiques") or [])
        if isinstance(c, dict) and isinstance(c.get("index"), int)
    }

    ranker = HypothesisRankerAgent(llm)
    llm.stage = "hypothesis_reverify_ranker"

    def _match(opponent_label: str, opponent_idx: int) -> dict:
        result = ranker.run(
            d["topic"], challenger, challenger_critique,
            hyps[opponent_idx], critiques_by_index.get(opponent_idx), source.extractions,
        )
        won = result.get("winner") == "a"
        return {
            "opponent": opponent_label,
            "opponent_index": opponent_idx,
            "winner": "challenger" if won else "opponent",
            "reason": result.get("reason", ""),
        }, won

    matches = []
    champion_match, beat_champion = _match("champion", champion_index)
    matches.append(champion_match)

    outcome = "no_change"
    new_champion_index, new_runner_up_index = champion_index, runner_up_index
    if beat_champion:
        outcome = "new_champion"
        new_champion_index, new_runner_up_index = idx, champion_index
    else:
        runner_up_match, beat_runner_up = _match("runner_up", runner_up_index)
        matches.append(runner_up_match)
        if beat_runner_up:
            outcome = "new_runner_up"
            new_runner_up_index = idx

    reverification = {
        "id": str(uuid.uuid4()),
        "validation_id": body.validation_id,
        "hypothesis_index": idx,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "critic": challenger_critique,
        "matches": matches,
        "outcome": outcome,
        "previous_champion_index": champion_index,
        "previous_runner_up_index": runner_up_index,
    }

    data = dict(d)
    data["reverifications"] = [*(data.get("reverifications") or []), reverification]
    if challenger_critique:
        existing = list((data.get("critique") or {}).get("critiques") or [])
        data["critique"] = dict(data.get("critique") or {})
        data["critique"]["critiques"] = [
            challenger_critique if c.get("index") == idx else c for c in existing
        ]
        if not any(c.get("index") == idx for c in existing):
            data["critique"]["critiques"].append(challenger_critique)
    if outcome != "no_change":
        data["champion_index"] = new_champion_index
        data["runner_up_index"] = new_runner_up_index
        data["meta_review_stale"] = True
        if outcome == "new_champion":
            data["plausibility_stale"] = True

    updated = update_hypothesis_run_data(hyp_run_id, user_id, data)
    if not updated:
        raise HTTPException(404, "Hypothesis run not found.")
    return updated


# ── Argument/dispute flow: hypothesis_agent_architecture.md §6 ─────────────
# v1 scope per §6.5: Meta-Review dispute only ("I don't think the champion
# is the right call") -- arguing with a specific bracket match is a designed
# but deliberately deferred mechanism (§6.1/§6.3), not built here. Same
# propose-then-explicit-apply shape as /check-results and /apply-refinement
# above: a dispute always gets a response; nothing about the saved run
# changes until /apply-dispute is called on it.
class DisputeMetaReviewBody(BaseModel):
    objection: str
    api_key: str | None = None
    model: str | None = None


@router.post("/runs/{hyp_run_id}/dispute-meta-review")
def dispute_meta_review(hyp_run_id: str, body: DisputeMetaReviewBody, user_id: str = Depends(require_user)):
    run = get_hypothesis_run(hyp_run_id, user_id)
    if not run:
        raise HTTPException(404, "Hypothesis run not found.")
    if not body.objection.strip():
        raise HTTPException(400, "objection is required.")

    d = run["data"] or {}
    meta_review = d.get("meta_review")
    champion_index, runner_up_index = d.get("champion_index"), d.get("runner_up_index")
    hyps = ((d.get("plan") or {}).get("hypotheses")) or []
    if not meta_review or champion_index is None or runner_up_index is None:
        raise HTTPException(
            400,
            "This run has no Meta-Review recommendation to argue with yet "
            "(needs at least 2 hypotheses ranked through the bracket).",
        )
    if not (0 <= champion_index < len(hyps)) or not (0 <= runner_up_index < len(hyps)):
        raise HTTPException(400, "champion_index/runner_up_index out of range for this run.")

    critiques_by_index = {
        c["index"]: c for c in ((d.get("critique") or {}).get("critiques") or [])
        if isinstance(c, dict) and isinstance(c.get("index"), int)
    }
    bracket_history = ((d.get("bracket") or {}).get("matches")) or []

    source = get_run(run["source_run_id"], user_id)
    llm = LLMClient(
        api_key=body.api_key,
        model=body.model or settings.mid_model or settings.model,
        run_id=run["source_run_id"],
        stage="hypothesis_meta_review_dispute",
    )
    agent = HypothesisMetaReviewAgent(llm)
    result = agent.dispute(
        d["topic"], hyps[champion_index], critiques_by_index.get(champion_index),
        hyps[runner_up_index], critiques_by_index.get(runner_up_index),
        bracket_history, meta_review, body.objection, source.extractions,
    )

    dispute = {
        "id": str(uuid.uuid4()),
        "objection": body.objection,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "applied": False,
        **result,
    }
    data = dict(d)
    data["disputes"] = [*(data.get("disputes") or []), dispute]
    updated = update_hypothesis_run_data(hyp_run_id, user_id, data)
    if not updated:
        raise HTTPException(404, "Hypothesis run not found.")
    return updated


class ApplyDisputeBody(BaseModel):
    dispute_id: str


@router.post("/runs/{hyp_run_id}/apply-dispute")
def apply_dispute(hyp_run_id: str, body: ApplyDisputeBody, user_id: str = Depends(require_user)):
    """Swaps the saved meta_review for the dispute's revised one and, if the
    agent's revision prefers the runner-up, swaps champion_index/
    runner_up_index too. Per hypothesis_agent_architecture.md §6.3, this
    never touches the bracket's own match history or re-runs the ranker —
    only the closing write-up and, when the champion changes, which
    hypothesis that write-up is about. If the champion changes, the saved
    plausibility_check (computed for the OLD champion) is marked stale
    rather than silently left looking current — see `plausibility_stale`."""
    run = get_hypothesis_run(hyp_run_id, user_id)
    if not run:
        raise HTTPException(404, "Hypothesis run not found.")

    disputes = (run["data"] or {}).get("disputes") or []
    match = next((v for v in disputes if v.get("id") == body.dispute_id), None)
    if not match:
        raise HTTPException(404, "Dispute record not found on this run.")
    if match.get("stance") != "revised" or not match.get("recommendation"):
        raise HTTPException(400, "This dispute has no revision to apply.")

    data = dict(run["data"])
    data["meta_review"] = match["recommendation"]
    if match.get("prefer") == "runner_up":
        old_champion, old_runner_up = data.get("champion_index"), data.get("runner_up_index")
        data["champion_index"], data["runner_up_index"] = old_runner_up, old_champion
        data["plausibility_stale"] = True
    data["disputes"] = [
        {**v, "applied": True} if v.get("id") == body.dispute_id else v
        for v in disputes
    ]
    updated = update_hypothesis_run_data(hyp_run_id, user_id, data)
    if not updated:
        raise HTTPException(404, "Hypothesis run not found.")
    return updated

"""
API routes — one endpoint per pipeline stage, mirroring the diagram so the
frontend's pipeline rail can light up node by node as each call returns.
"""
import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.db import delete_session, get_session, list_sessions, save_session
from core.llm_client import LLMClient
from pipeline.orchestrator import RUNS, SamhitaPipeline

router = APIRouter(prefix="/api")


def get_run(run_id: str):
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found. Start a new run from the topic screen.")
    return run


# ── Pydantic bodies ────────────────────────────────────────────────────────

class CreateRunBody(BaseModel):
    topic: str
    api_key: str | None = None
    model: str | None = None


class FilterBody(BaseModel):
    approved_indices: list[int]


class SynthesizeBody(BaseModel):
    api_key: str | None = None
    model: str | None = None


# ── Streaming search endpoint (SSE) ───────────────────────────────────────

@router.post("/runs/stream")
async def create_run_stream(body: CreateRunBody):
    """
    SSE endpoint. Streams progress events during reformulate+search, then
    emits a final 'done' event with the full run data.

    Frontend consumes with fetch() + ReadableStream — no EventSource needed
    (EventSource doesn't support POST).
    """
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def on_progress(event: dict):
        """Called from a worker thread — pushes into the async queue."""
        loop.call_soon_threadsafe(queue.put_nowait, {"type": "progress", **event})

    async def run_pipeline():
        try:
            pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
            run = await asyncio.to_thread(
                pipeline.reformulate_and_search, body.topic, on_progress
            )
            # Persist session
            ap = {p["idx"]: True for p in run.papers}
            save_session(
                session_id=run.run_id,
                topic=run.topic,
                stage="filter",
                paper_count=len(run.papers),
                created_at=datetime.now(timezone.utc).isoformat(),
                data={
                    "runId": run.run_id,
                    "topic": run.topic,
                    "reform": run.reform,
                    "papers": run.papers,
                    "approved": ap,
                },
            )
            await queue.put({
                "type": "done",
                "run_id": run.run_id,
                "reform": run.reform,
                "papers": run.papers,
                "stage": run.stage,
            })
        except Exception as e:  # noqa: BLE001
            await queue.put({"type": "error", "message": str(e)})

    asyncio.create_task(run_pipeline())

    async def generate():
        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Non-streaming search (kept for compatibility) ─────────────────────────

@router.post("/runs")
def create_run(body: CreateRunBody):
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        run = pipeline.reformulate_and_search(body.topic)
    except Exception as e:
        raise HTTPException(502, f"Query Reformulator / Academic Search failed: {e}")
    ap = {p["idx"]: True for p in run.papers}
    save_session(
        session_id=run.run_id,
        topic=run.topic,
        stage="filter",
        paper_count=len(run.papers),
        created_at=datetime.now(timezone.utc).isoformat(),
        data={"runId": run.run_id, "topic": run.topic, "reform": run.reform,
              "papers": run.papers, "approved": ap},
    )
    return {"run_id": run.run_id, "reform": run.reform, "papers": run.papers, "stage": run.stage}


# ── Remaining pipeline stages ──────────────────────────────────────────────

@router.post("/runs/{run_id}/filter")
def filter_papers(run_id: str, body: FilterBody):
    run = get_run(run_id)
    if len(body.approved_indices) < 2:
        raise HTTPException(400, "Approve at least 2 papers to build a review.")
    SamhitaPipeline().apply_filter(run, body.approved_indices)
    return {"run_id": run.run_id, "approved_count": len(run.approved_papers), "stage": run.stage}


@router.post("/runs/{run_id}/synthesize")
def synthesize(run_id: str, body: SynthesizeBody):
    run = get_run(run_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        pipeline.extract_and_synthesize(run)
    except Exception as e:
        raise HTTPException(502, f"Reader & Extractor / Critic & Synthesizer failed: {e}")
    return {"run_id": run.run_id, "extractions": run.extractions,
            "synthesis": run.synthesis, "stage": run.stage}


@router.post("/runs/{run_id}/write")
def write(run_id: str, body: SynthesizeBody):
    run = get_run(run_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        pipeline.write(run)
    except Exception as e:
        raise HTTPException(502, f"Writer Agent failed: {e}")
    side = pipeline.side_modules(run)
    approved_map = {p["idx"]: True for p in run.approved_papers}
    save_session(
        session_id=run.run_id,
        topic=run.topic,
        stage="done",
        paper_count=len(run.approved_papers),
        data={
            "runId": run.run_id, "topic": run.topic, "reform": run.reform,
            "papers": run.papers, "approved": approved_map,
            "extractions": run.extractions, "synth": run.synthesis,
            "sections": run.sections, "sideModules": side,
        },
    )
    return {"run_id": run.run_id, "sections": run.sections,
            "side_modules": side, "stage": run.stage}


@router.post("/runs/{run_id}/evaluate")
def evaluate(run_id: str, body: SynthesizeBody):
    run = get_run(run_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        result = pipeline.evaluate(run)
    except Exception as e:
        raise HTTPException(502, f"Evaluator failed: {e}")
    return {"run_id": run.run_id, "eval_result": result}


@router.get("/runs/{run_id}")
def get_run_state(run_id: str):
    run = get_run(run_id)
    pipeline = SamhitaPipeline()
    return {
        "run_id": run.run_id, "topic": run.topic, "reform": run.reform,
        "papers": run.papers, "approved_papers": run.approved_papers,
        "extractions": run.extractions, "synthesis": run.synthesis,
        "sections": run.sections, "eval_result": run.eval_result, "stage": run.stage,
        "side_modules": pipeline.side_modules(run) if run.synthesis else None,
    }


# ── Session history endpoints (no LLM) ───────────────────────────────────

@router.get("/sessions")
def sessions_list():
    return list_sessions()


@router.get("/sessions/{session_id}")
def session_get(session_id: str):
    s = get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    return s


@router.delete("/sessions/{session_id}")
def session_delete(session_id: str):
    delete_session(session_id)
    return {"ok": True}

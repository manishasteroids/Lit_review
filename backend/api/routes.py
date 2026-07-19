"""
API routes — one endpoint per pipeline stage, mirroring the diagram so the
frontend's pipeline rail can light up node by node as each call returns.
"""
import asyncio
import base64
import json
import re
from datetime import datetime, timezone
 
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
 
from core.auth import require_user
from core.config import settings
from core.db import (delete_all_for_user, delete_session, get_session,
                     list_sessions, save_session)
from core.llm_client import LLMClient
from core.paper_text import fetch_paper_pdf, fetch_paper_text
from core.usage import get_usage
from pipeline.orchestrator import RUNS, RunState, SamhitaPipeline
 
router = APIRouter(prefix="/api")
 
 
def get_run(run_id: str, user_id: str):
    run = RUNS.get(run_id)
    if run:
        return run
    # Rehydrate from a saved session — survives restarts and restore-from-History,
    # so /write, /evaluate, etc. work on a run that isn't in memory anymore.
    s = get_session(run_id, user_id)
    if not s:
        raise HTTPException(404, "Run not found. Start a new run from the topic screen.")
    d = s.get("data") or {}
    approved = d.get("approved") or {}
    papers = d.get("papers") or []
 
    def _approved(idx):
        return bool(approved.get(str(idx)) or approved.get(idx))
 
    run = RunState(
        run_id=run_id,
        topic=d.get("topic", ""),
        reform=d.get("reform"),
        papers=papers,
        approved_papers=[p for p in papers if _approved(p.get("idx"))],
        extractions=d.get("extractions") or [],
        synthesis=d.get("synth"),
        sections=d.get("sections") or {},
        stage=s.get("stage", "done"),
    )
    RUNS[run_id] = run
    return run
 
 
# ── Pydantic bodies ────────────────────────────────────────────────────────
 
class CreateRunBody(BaseModel):
    topic: str
    api_key: str | None = None
    model: str | None = None
    mode: str | None = None      # lite | medium | deep (drives papers + models + depth)


class FilterBody(BaseModel):
    approved_indices: list[int]
 
 
class SynthesizeBody(BaseModel):
    api_key: str | None = None
    model: str | None = None
    mode: str | None = None
    notes: dict | None = None
 
 
class ChatBody(BaseModel):
    paper_idx: int | None = None
    paper: dict | None = None
    question: str
    history: list[dict] = []
    images: list[dict] = []  # [{media_type, data(base64)}]
    api_key: str | None = None
    model: str | None = None
 
 
class AssessBody(BaseModel):
    paper_idx: int | None = None
    paper: dict | None = None
    scope: str | None = None
    api_key: str | None = None
    model: str | None = None
 
 
class ResolveBody(BaseModel):
    identifier: str
 
 
class AddPaperBody(BaseModel):
    paper: dict
    api_key: str | None = None
    model: str | None = None
    notes: dict | None = None
 
 
class ReanalyzeBody(BaseModel):
    included_indices: list[int]
    api_key: str | None = None
    model: str | None = None
    notes: dict | None = None
 
 
# ── Streaming search endpoint (SSE) ───────────────────────────────────────
 
@router.post("/runs/stream")
async def create_run_stream(body: CreateRunBody, user_id: str = Depends(require_user)):
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
            pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model, mode=body.mode)
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
                user_id=user_id,
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
def create_run(body: CreateRunBody, user_id: str = Depends(require_user)):
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model, mode=body.mode)
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
        user_id=user_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        data={"runId": run.run_id, "topic": run.topic, "reform": run.reform,
              "papers": run.papers, "approved": ap},
    )
    return {"run_id": run.run_id, "reform": run.reform, "papers": run.papers, "stage": run.stage}
 
 
# ── Remaining pipeline stages ──────────────────────────────────────────────
 
@router.post("/runs/{run_id}/filter")
def filter_papers(run_id: str, body: FilterBody, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    if len(body.approved_indices) < 2:
        raise HTTPException(400, "Approve at least 2 papers to build a review.")
    SamhitaPipeline().apply_filter(run, body.approved_indices)
    return {"run_id": run.run_id, "approved_count": len(run.approved_papers), "stage": run.stage}
 
 
def _persist_done(run, user_id, notes=None, side=None):
    """Save a run in its 'done' state (post-synthesis / post-write)."""
    pipeline = SamhitaPipeline()
    if side is None:
        side = pipeline.side_modules(run)
    approved_map = {p["idx"]: True for p in run.approved_papers}
    save_session(
        session_id=run.run_id,
        topic=run.topic,
        stage="done",
        paper_count=len(run.approved_papers),
        user_id=user_id,
        data={
            "runId": run.run_id, "topic": run.topic, "reform": run.reform,
            "papers": run.papers, "approved": approved_map,
            "extractions": run.extractions, "synth": run.synthesis,
            "sections": run.sections, "sideModules": side, "notes": notes or {},
        },
    )
    return side
 
 
@router.post("/runs/{run_id}/synthesize")
def synthesize(run_id: str, body: SynthesizeBody, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        pipeline.extract_and_synthesize(run)
    except Exception as e:
        raise HTTPException(502, f"Reader & Extractor / Critic & Synthesizer failed: {e}")
    side = _persist_done(run, user_id, notes=body.notes)
    return {"run_id": run.run_id, "extractions": run.extractions,
            "synthesis": run.synthesis, "side_modules": side, "stage": run.stage,
            "extract_stats": run.extract_stats}


@router.post("/runs/{run_id}/write")
def write(run_id: str, body: SynthesizeBody, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model, mode=run.mode or body.mode)
    try:
        pipeline.write(run)
    except Exception as e:
        raise HTTPException(502, f"Writer Agent failed: {e}")
    side = _persist_done(run, user_id, notes=body.notes)
    return {"run_id": run.run_id, "sections": run.sections,
            "side_modules": side, "stage": run.stage}
 
 
# ── Editable source set (Sources page) ─────────────────────────────────────
 
def _norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()
 
 
def _url_doi(url: str) -> str:
    m = re.search(r"10\.\d{4,9}/[^\s\"&?#]+", url or "")
    return m.group(0).lower() if m else ""
 
 
def _is_duplicate(run: RunState, paper: dict) -> bool:
    nt = _norm_title(paper.get("title"))
    pd = _url_doi(paper.get("url"))
    for p in run.papers:
        if nt and _norm_title(p.get("title")) == nt:
            return True
        if pd and _url_doi(p.get("url")) == pd:
            return True
    return False
 
 
@router.post("/runs/{run_id}/resolve")
def resolve_paper(run_id: str, body: ResolveBody, user_id: str = Depends(require_user)):
    """Look up a DOI / PMID / arXiv id / URL / title and return candidate
    papers, each flagged if it duplicates a paper already in the run."""
    run = get_run(run_id, user_id)
    try:
        candidates = SamhitaPipeline().resolve_candidates(body.identifier)
    except Exception as e:
        raise HTTPException(502, f"Lookup failed: {e}")
    existing_titles = {_norm_title(p.get("title")) for p in run.papers}
    existing_dois = {_url_doi(p.get("url")) for p in run.papers if _url_doi(p.get("url"))}
    for c in candidates:
        dupe = _norm_title(c.get("title")) in existing_titles
        cd = _url_doi(c.get("url"))
        if cd and cd in existing_dois:
            dupe = True
        c["duplicate"] = dupe
    return {"candidates": candidates}
 
 
@router.post("/runs/{run_id}/add_paper")
def add_paper(run_id: str, body: AddPaperBody, user_id: str = Depends(require_user)):
    """Add one resolved paper and run extraction on it. Marks downstream
    analysis stale (frontend), so the user runs Update analysis afterwards."""
    run = get_run(run_id, user_id)
    if not (body.paper or {}).get("title"):
        raise HTTPException(400, "That paper has no title — pick a different result.")
    if _is_duplicate(run, body.paper):
        raise HTTPException(409, "This paper is already in your sources.")
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        res = pipeline.add_paper(run, body.paper)
    except Exception as e:
        raise HTTPException(502, f"Adding paper failed: {e}")
    _persist_done(run, user_id, notes=body.notes)
    return res
 
 
@router.post("/runs/{run_id}/reanalyze")
def reanalyze(run_id: str, body: ReanalyzeBody, user_id: str = Depends(require_user)):
    """Recompute synthesis + side modules for the current included set,
    without re-searching or re-extracting. Clears the draft review."""
    run = get_run(run_id, user_id)
    if len(body.included_indices) < 1:
        raise HTTPException(400, "Include at least one source before updating the analysis.")
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        pipeline.reanalyze(run, body.included_indices)
    except Exception as e:
        raise HTTPException(502, f"Update analysis failed: {e}")
    side = _persist_done(run, user_id, notes=body.notes)
    return {"run_id": run.run_id, "extractions": run.extractions,
            "synthesis": run.synthesis, "sections": run.sections,
            "side_modules": side, "stage": run.stage}
 
 
@router.post("/runs/{run_id}/evaluate")
def evaluate(run_id: str, body: SynthesizeBody, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model, mode=run.mode or body.mode)
    try:
        result = pipeline.evaluate(run)
    except Exception as e:
        raise HTTPException(502, f"Evaluator failed: {e}")
    return {"run_id": run.run_id, "eval_result": result}
 
 
@router.post("/runs/{run_id}/assess")
def assess_paper(run_id: str, body: AssessBody, user_id: str = Depends(require_user)):
    """Quick triage of a single paper against the review scope: extract key
    fields and judge relevance so the reviewer can decide keep/drop fast.
    On-demand and abstract-based (cheap); full-text chat is for deep dives."""
    run = RUNS.get(run_id)
    idx = body.paper_idx if body.paper_idx is not None else (body.paper or {}).get("idx")
    paper = body.paper
    if paper is None and run:
        paper = next((p for p in run.papers if p.get("idx") == idx), None)
    if not paper:
        raise HTTPException(404, "Paper not found. Reopen and try again.")
    scope = body.scope or ((run.reform or {}).get("scope") if run else None) or "(no explicit scope provided)"
 
    system = (
        "You are a triage assistant for a literature review. Given the review SCOPE and one "
        "paper's title + abstract, (1) extract key fields and (2) judge how relevant the paper "
        "is to the scope. Respond with ONLY JSON (no markdown): "
        '{"method":"approach in <=10 words","finding":"key result in <=14 words",'
        '"metrics":"key numbers or n/a","contribution":"one sentence",'
        '"verdict":"keep|maybe|skip","reason":"one sentence on relevance to the scope"}. '
        "Ground everything in the abstract; use \"n/a\" if unknown."
    )
    user = (
        f"SCOPE: {scope}\n\n"
        f"PAPER: {paper.get('title', '')} ({paper.get('year', '?')})\n"
        f"ABSTRACT: {paper.get('abstract', '') or 'n/a'}"
    )
    llm = LLMClient(api_key=body.api_key, model=body.model, run_id=run_id, stage="assess")
    try:
        data = LLMClient.parse_json(llm.call(user_text=user, system=system, max_tokens=400))
    except Exception as e:
        raise HTTPException(502, f"Assessment failed: {e}")
    return {"assessment": data}
 
 
@router.post("/runs/{run_id}/chat")
def chat_about_paper(run_id: str, body: ChatBody, user_id: str = Depends(require_user)):
    """Answer questions about a single paper, grounded in what we know about it
    (abstract/summary, plus extracted fields if extraction has already run).
 
    The paper data can be sent in the request body, so chat works even when the
    run is no longer in memory (e.g. a session restored from History)."""
    run = RUNS.get(run_id)
    idx = body.paper_idx if body.paper_idx is not None else (body.paper or {}).get("idx")
    paper = body.paper
    if paper is None and run:
        paper = next((p for p in run.papers if p.get("idx") == idx), None)
    if not paper:
        raise HTTPException(404, "Paper not found. Reopen the paper and try again.")
    ext = None
    if run:
        ext = next((e for e in (run.extractions or []) if e.get("idx") == idx), None)
 
    lines = [
        f"Title: {paper.get('title', '')}",
        f"Authors: {paper.get('authors', '')}",
        f"Year: {paper.get('year', '')}",
        f"Venue: {paper.get('venue', '')}",
        f"Abstract / summary: {paper.get('abstract', '') or 'n/a'}",
    ]
    if ext:
        for k in ("method", "finding", "data", "metrics", "limitation",
                  "contribution", "excerpt", "relevance"):
            v = ext.get(k)
            if v and v != "n/a":
                lines.append(f"{k.capitalize()}: {v}")
    context = "\n".join(lines)
 
    convo = ""
    for m in (body.history or []):
        role = "User" if m.get("role") == "user" else "Assistant"
        convo += f"{role}: {m.get('content', '')}\n"
    convo += f"User: {body.question}\nAssistant:"
 
    llm = LLMClient(api_key=body.api_key, model=body.model, run_id=run_id, stage="chat")
    pdf_bytes = fetch_paper_pdf(paper.get("url"))
 
    image_blocks = []
    for img in (body.images or [])[:6]:  # cap count
        mt, data = img.get("media_type"), img.get("data")
        if mt and data and len(data) < 9_000_000:  # ~6.5 MB decoded per image
            image_blocks.append({"type": "image",
                "source": {"type": "base64", "media_type": mt, "data": data}})
 
    try:
        if pdf_bytes or image_blocks:
            # Multimodal: attach the PDF (figures/tables) and/or the user's images.
            blocks, parts = [], []
            if pdf_bytes:
                b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")
                blocks.append({"type": "document", "source": {"type": "base64",
                    "media_type": "application/pdf", "data": b64}})
                parts.append("full_pdf")
            blocks.extend(image_blocks)
            if image_blocks:
                parts.append("image")
 
            text = f"PAPER METADATA:\n{context}\n\n"
            if not pdf_bytes:
                full_text = fetch_paper_text(paper.get("url"))
                if full_text:
                    text += "FULL PAPER TEXT (extracted; figures not included):\n" + full_text + "\n\n"
                    parts.append("full_text")
                else:
                    parts.append("abstract")
            if image_blocks:
                text += ("The user attached the image(s) shown above — use them to answer "
                         "(e.g. explain a figure or compare it with the paper). ")
            text += f"\nCONVERSATION:\n{convo}"
            blocks.append({"type": "text", "text": text})
 
            system = (
                "You are a research assistant helping a reviewer understand a paper. "
                + ("The full paper is attached as a PDF — read all of it, including figures, "
                   "tables and equations. " if pdf_bytes else "")
                + ("The user also attached image(s) — explain or compare them in the context of "
                   "the paper as asked. " if image_blocks else "")
                + "Answer thoroughly and ground every claim in the paper (or the attached "
                "images); don't invent facts. When asked for a summary, cover objective, method, "
                "data, key results (with numbers), and limitations."
            )
            answer = llm.call(content=blocks, system=system, max_tokens=1500)
            source = "+".join(parts) or "abstract"
        else:
            # No PDF or images — fall back to text/abstract.
            full_text = fetch_paper_text(paper.get("url"))
            if full_text:
                context += "\n\nFULL PAPER TEXT (extracted; figures not included, may be truncated):\n" + full_text
                source = "full_text"
                note = ("You have the full text of this paper below. Answer from it and cite "
                        "specific sections/results when relevant.")
            else:
                source = "abstract"
                note = ("Only the abstract/summary is available (the full paper couldn't be "
                        "fetched — it may be paywalled). Answer from the abstract and say plainly "
                        "when it doesn't cover the question rather than guessing.")
            system = (
                "You are a research assistant helping a reviewer understand a paper. " + note +
                " Be concise and specific.\n\nPAPER INFORMATION:\n" + context
            )
            answer = llm.call(user_text=convo, system=system, max_tokens=800)
    except Exception as e:
        raise HTTPException(502, f"Chat failed: {e}")
    return {"answer": answer, "source": source}
 
 
@router.get("/runs/{run_id}")
def get_run_state(run_id: str, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
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
def sessions_list(user_id: str = Depends(require_user)):
    return list_sessions(user_id)


@router.get("/sessions/{session_id}/usage")
def session_usage(session_id: str, user_id: str = Depends(require_user)):
    """Token counts + dollar cost for one session, by stage and model. DB read."""
    return get_usage(session_id)


@router.get("/usage/trend")
def usage_trend(days: int = 30, tz_offset: int = 0, user_id: str = Depends(require_user)):
    """Per-day token + cost totals for the signed-in user, plus an all-time
    total — for the trendline chart. `tz_offset` is the browser's
    getTimezoneOffset() so days are grouped in the user's local time. DB read."""
    from core.usage import get_usage_trend
    return get_usage_trend(user_id, days, tz_offset)


@router.get("/modes")
def list_modes():
    """The search modes (Lite / Medium / Deep) for the UI selector. No auth."""
    from core.modes import public_list, DEFAULT_MODE
    return {"default": DEFAULT_MODE, "modes": public_list()}


@router.get("/pipeline/models")
def pipeline_models(model: str | None = None, mode: str | None = None):
    """Which model each pipeline stage runs on, for the UI rail. If a mode is
    given it drives the routing; otherwise falls back to the model_policy preset.
    Pure config read — no user data, so no auth required."""
    if mode:
        from core.modes import resolve
        m = resolve(mode)
        fast, mid, write_model = m["fast"], m["mid"], m["write"]
        per_purpose = True
    else:
        selected = model or settings.model
        pipeline_model = settings.model if (selected and "gemini" in selected.lower()) else selected
        write_model = settings.write_model or pipeline_model
        per_purpose = settings.per_purpose_routing
        fast, mid = (settings.fast_model, settings.mid_model) if per_purpose else (write_model, write_model)
    return {
        "per_purpose_routing": per_purpose,
        "stages": {
            "reformulate": fast, "search": fast, "extract": fast,
            "synthesize": mid, "evaluate": mid, "write": write_model,
        },
    }


@router.get("/sessions/{session_id}")
def session_get(session_id: str, user_id: str = Depends(require_user)):
    s = get_session(session_id, user_id)
    if not s:
        raise HTTPException(404, "Session not found.")
    return s
 
 
@router.delete("/sessions/{session_id}")
def session_delete(session_id: str, user_id: str = Depends(require_user)):
    delete_session(session_id, user_id)
    return {"ok": True}
 
 
@router.delete("/sessions")
def sessions_delete_all(user_id: str = Depends(require_user)):
    """Data-deletion control: wipe every session owned by the signed-in user."""
    deleted = delete_all_for_user(user_id)
    return {"ok": True, "deleted": deleted}
 
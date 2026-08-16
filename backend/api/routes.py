"""
API routes — one endpoint per pipeline stage, mirroring the diagram so the
frontend's pipeline rail can light up node by node as each call returns.
"""
import asyncio
import base64
import json
import re
from datetime import datetime, timezone
 
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
 
from core.auth import require_user
from core.config import settings
from core.db import (delete_all_for_user, delete_session, get_session,
                     list_sessions, save_session)
from core.llm_client import LLMClient
from core.paper_text import fetch_paper_pdf, fetch_paper_text
from core.usage import get_usage
from pipeline.orchestrator import RUNS, RunState, SiftPipeline
 
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
        mode=d.get("mode"),          # keep the search mode so later stages reuse its models
        experiment_plan=d.get("experimentPlan"),
        experiment_critique=d.get("experimentCritique"),
        experiment_iterations=d.get("experimentIterations") or [],
        experiment_debate=d.get("experimentDebate") or {},
    )
    RUNS[run_id] = run
    return run
 
 
# ── Pydantic bodies ────────────────────────────────────────────────────────
 
class CreateRunBody(BaseModel):
    topic: str
    api_key: str | None = None
    model: str | None = None
    mode: str | None = None      # lite | medium | deep (drives papers + models + depth)
    project_id: str | None = None  # optionally file this run under a project


class FilterBody(BaseModel):
    approved_indices: list[int]
 
 
class SynthesizeBody(BaseModel):
    api_key: str | None = None
    model: str | None = None
    mode: str | None = None
    notes: dict | None = None


class DisputeBody(BaseModel):
    api_key: str | None = None
    model: str | None = None
    mode: str | None = None
    argument: str


class HypothesisEditBody(BaseModel):
    edits: dict


class ChatBody(BaseModel):
    paper_idx: int | None = None
    paper: dict | None = None
    question: str
    history: list[dict] = []
    images: list[dict] = []  # [{media_type, data(base64)}]
    api_key: str | None = None
    model: str | None = None
    chat_mode: str | None = None  # "quick" (Gemini, cheap) | "deep" (Sonnet)
 
 
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
            pipeline = SiftPipeline(api_key=body.api_key, model=body.model, mode=body.mode)
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
                    "mode": run.mode,
                },
            )
            if body.project_id:
                from core.projects import assign_session
                assign_session(run.run_id, user_id, body.project_id)
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
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model, mode=body.mode)
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
              "papers": run.papers, "approved": ap, "mode": run.mode},
    )
    if body.project_id:
        from core.projects import assign_session
        assign_session(run.run_id, user_id, body.project_id)
    return {"run_id": run.run_id, "reform": run.reform, "papers": run.papers, "stage": run.stage}


class BlankRunBody(BaseModel):
    topic: str | None = None
    project_id: str | None = None


@router.post("/runs/blank")
def create_blank_run(body: BlankRunBody, user_id: str = Depends(require_user)):
    """Start a Studio-only session with no search — just a place to upload
    your own PDFs/DOCX/PPTX and analyze them (chat, report, deck) via Studio
    without running the search -> filter -> write pipeline. Skips straight to
    stage="done" (papers=[]) so Sources/Studio are immediately usable; the
    normal Sources page + "Upload a file" flow (see upload_paper()) fills it
    in, and if the user later wants a full written review, "Update analysis"
    -> "Generate literature review" on the Sources page already works from
    here too — nothing about this path is a dead end."""
    import uuid as _uuid

    run = RunState(
        run_id=str(_uuid.uuid4()),
        topic=(body.topic or "").strip() or "Untitled documents",
        papers=[], approved_papers=[], stage="done",
    )
    RUNS[run.run_id] = run
    save_session(
        session_id=run.run_id,
        topic=run.topic,
        stage="done",
        paper_count=0,
        user_id=user_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        data={"runId": run.run_id, "topic": run.topic, "reform": None,
              "papers": [], "approved": {}, "extractions": [], "synth": None,
              "sections": {}, "sideModules": None, "notes": {}, "mode": None},
    )
    if body.project_id:
        from core.projects import assign_session
        assign_session(run.run_id, user_id, body.project_id)
    return {"run_id": run.run_id, "topic": run.topic, "stage": "done"}


# ── Remaining pipeline stages ──────────────────────────────────────────────
 
@router.post("/runs/{run_id}/filter")
def filter_papers(run_id: str, body: FilterBody, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    if len(body.approved_indices) < 2:
        raise HTTPException(400, "Approve at least 2 papers to build a review.")
    SiftPipeline().apply_filter(run, body.approved_indices)
    return {"run_id": run.run_id, "approved_count": len(run.approved_papers), "stage": run.stage}
 
 
def _persist_done(run, user_id, notes=None, side=None):
    """Save a run in its 'done' state (post-synthesis / post-write)."""
    pipeline = SiftPipeline()
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
            "mode": run.mode,
            "experimentPlan": run.experiment_plan, "experimentCritique": run.experiment_critique,
            "experimentIterations": run.experiment_iterations, "experimentDebate": run.experiment_debate,
        },
    )
    return side


def _persist_experiments(run, user_id) -> None:
    """Merge the experiment plan/critique/iteration/debate state into the
    saved session, without touching anything else — `data` is one JSON blob
    per session (see core/db.py: save_session), so this is a read-merge-write
    rather than a plain overwrite. Called after every experiments-related
    route so a hypothesis survives navigating away, a reload, or a backend
    restart, the same way the rest of the run already does. Best-effort: a
    save failure here shouldn't break the response the user is waiting on."""
    try:
        existing = get_session(run.run_id, user_id)
        data = dict(existing["data"]) if existing else {
            "runId": run.run_id, "topic": run.topic, "reform": run.reform,
            "papers": run.papers,
            "approved": {p["idx"]: True for p in run.approved_papers},
            "extractions": run.extractions, "synth": run.synthesis,
            "sections": run.sections, "mode": run.mode,
        }
        data["experimentPlan"] = run.experiment_plan
        data["experimentCritique"] = run.experiment_critique
        data["experimentIterations"] = run.experiment_iterations
        data["experimentDebate"] = run.experiment_debate
        save_session(
            session_id=run.run_id, topic=run.topic,
            stage=(existing.get("stage") if existing else run.stage) or run.stage,
            paper_count=(existing.get("paper_count") if existing else len(run.approved_papers)) or 0,
            user_id=user_id, data=data,
            created_at=existing.get("created_at") if existing else None,
        )
    except Exception:  # noqa: BLE001 — never break the experiments response over a save hiccup
        import traceback; traceback.print_exc()

 
@router.post("/runs/{run_id}/synthesize")
def synthesize(run_id: str, body: SynthesizeBody, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model, mode=run.mode or body.mode)
    try:
        pipeline.extract_and_synthesize(run)
    except Exception as e:
        raise HTTPException(502, f"Reader & Extractor / Critic & Synthesizer failed: {e}")
    side = _persist_done(run, user_id, notes=body.notes)
    return {"run_id": run.run_id, "extractions": run.extractions,
            "synthesis": run.synthesis, "side_modules": side, "stage": run.stage,
            "extract_stats": run.extract_stats}
    
@router.post("/runs/{run_id}/synthesize/stream")
async def synthesize_stream(run_id: str, body: SynthesizeBody, user_id: str = Depends(require_user)):
    """SSE version of /synthesize — streams a 'progress' event as each batch of
    papers is read, then the synthesizer, then a final 'done' event."""
    run = get_run(run_id, user_id)  # fast, no LLM — validates ownership first
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def on_progress(event: dict):
        loop.call_soon_threadsafe(queue.put_nowait, {"type": "progress", **event})

    async def work():
        try:
            pipeline = SiftPipeline(api_key=body.api_key, model=body.model,
                                       mode=run.mode or body.mode)
            await asyncio.to_thread(pipeline.extract_and_synthesize, run, on_progress)
            side = _persist_done(run, user_id, notes=body.notes)
            await queue.put({
                "type": "done", "run_id": run.run_id,
                "extractions": run.extractions, "synthesis": run.synthesis,
                "side_modules": side, "stage": run.stage,
                "extract_stats": run.extract_stats,
            })
        except Exception as e:  # noqa: BLE001
            await queue.put({"type": "error", "message": str(e)})

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


@router.post("/runs/{run_id}/write")
def write(run_id: str, body: SynthesizeBody, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model, mode=run.mode or body.mode)
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
        candidates = SiftPipeline().resolve_candidates(body.identifier)
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


@router.get("/runs/{run_id}/papers/{idx}/pdf")
def paper_pdf(run_id: str, idx: int, user_id: str = Depends(require_user)):
    """Serve a paper's raw PDF bytes for the in-app read-only viewer (Phase 1
    of paper annotation — see core/paper_text.py). Same open-access lookup
    Paper Chat already uses server-side (direct link, or Unpaywall via DOI);
    this just exposes it to the browser instead of only feeding it to a
    model. 404 if the paper has no reachable open-access copy — same
    "fell back to abstract" cases already surfaced elsewhere in the UI."""
    from fastapi.responses import Response
    from core.paper_text import fetch_paper_pdf

    run = get_run(run_id, user_id)
    paper = next((p for p in run.papers if p.get("idx") == idx), None)
    if not paper:
        raise HTTPException(404, "Paper not found in this run.")

    # Locally-uploaded sources (Sources > "Upload a file") have their own file
    # on disk instead of a fetchable URL — serve that directly. A .docx upload
    # has no PDF to show; say so explicitly rather than a generic 404.
    local_path = paper.get("local_file")
    if local_path:
        import os
        full_path = os.path.join(settings.uploads_dir, local_path)
        if not local_path.lower().endswith(".pdf"):
            raise HTTPException(404, "This source was uploaded as a Word or PowerPoint file — in-app PDF preview isn't available for it yet.")
        if not os.path.isfile(full_path):
            raise HTTPException(404, "The uploaded file for this source is missing.")
        with open(full_path, "rb") as f:
            data = f.read()
        return Response(content=data, media_type="application/pdf")

    data = fetch_paper_pdf(paper.get("url"))
    if not data:
        raise HTTPException(404, "No open-access PDF found for this paper.")
    return Response(content=data, media_type="application/pdf")


class AnnotationBody(BaseModel):
    kind: str            # "highlight" | "underline" | "comment"
    page: int
    rects: list[dict]    # [{x,y,w,h}, ...] in PDF-point space at scale=1
    color: str | None = None
    snippet: str | None = None   # the selected text
    comment: str | None = None   # only for kind == "comment"


def _paper_or_404(run, idx: int) -> dict:
    paper = next((p for p in run.papers if p.get("idx") == idx), None)
    if not paper:
        raise HTTPException(404, "Paper not found in this run.")
    return paper


@router.get("/runs/{run_id}/papers/{idx}/annotations")
def get_annotations(run_id: str, idx: int, user_id: str = Depends(require_user)):
    """List saved highlights/underlines/comments for one paper (Phase 2 of
    in-app PDF reading). Annotations are keyed by paper identity, not run —
    see core.annotations.paper_key_of — so they follow the paper if it's
    re-added to a different run."""
    from core.annotations import list_annotations, paper_key_of

    run = get_run(run_id, user_id)
    paper = _paper_or_404(run, idx)
    return {"annotations": list_annotations(user_id, paper_key_of(paper))}


@router.post("/runs/{run_id}/papers/{idx}/annotations")
def create_annotation(run_id: str, idx: int, body: AnnotationBody, user_id: str = Depends(require_user)):
    from core.annotations import add_annotation, paper_key_of

    run = get_run(run_id, user_id)
    paper = _paper_or_404(run, idx)
    if body.kind not in ("highlight", "underline", "comment"):
        raise HTTPException(400, "kind must be highlight, underline, or comment.")
    if not body.rects:
        raise HTTPException(400, "An annotation needs at least one rect.")
    ann = add_annotation(
        user_id, paper_key_of(paper), body.kind, body.page, body.rects,
        color=body.color, snippet=body.snippet, comment=body.comment,
    )
    if not ann:
        raise HTTPException(500, "Couldn't save that annotation.")
    return ann


@router.delete("/runs/{run_id}/papers/{idx}/annotations/{annotation_id}")
def remove_annotation(run_id: str, idx: int, annotation_id: int, user_id: str = Depends(require_user)):
    from core.annotations import delete_annotation, paper_key_of

    run = get_run(run_id, user_id)
    paper = _paper_or_404(run, idx)
    ok = delete_annotation(user_id, paper_key_of(paper), annotation_id)
    if not ok:
        raise HTTPException(404, "Annotation not found.")
    return {"ok": True}


@router.post("/runs/{run_id}/upload_paper")
async def upload_paper(
    run_id: str,
    file: UploadFile = File(...),
    title: str | None = Form(None),
    api_key: str | None = Form(None),
    model: str | None = Form(None),
    notes: str | None = Form(None),  # JSON-encoded {idx: note} — same shape as SynthesizeBody.notes
    user_id: str = Depends(require_user),
):
    """Add a source from a locally-uploaded PDF, DOCX, or PPTX file — for
    material that isn't discoverable through the search/lookup path
    (unpublished drafts, paywalled scans the user already has, internal
    reports, a colleague's slide deck). Text is extracted locally, run
    through the same Reader & Extractor as every other source, and the
    original file is kept on disk so the in-app PDF viewer can show it back
    (PDFs only; DOCX/PPTX have no in-app preview yet)."""
    import os
    import re as _re
    from core.paper_text import docx_bytes_to_text, pdf_bytes_to_text, pptx_bytes_to_text

    run = get_run(run_id, user_id)
    name = file.filename or "upload"
    ext = os.path.splitext(name)[1].lower()
    if ext not in (".pdf", ".docx", ".pptx"):
        raise HTTPException(400, "Only PDF, DOCX, and PPTX files are supported.")

    data = await file.read()
    if not data:
        raise HTTPException(400, "That file appears to be empty.")
    max_bytes = 25_000_000
    if len(data) > max_bytes:
        raise HTTPException(400, "File is too large (25MB limit).")

    if ext == ".pdf":
        text = pdf_bytes_to_text(data)
    elif ext == ".pptx":
        text = pptx_bytes_to_text(data)
    else:
        text = docx_bytes_to_text(data)
    if not text or not text.strip():
        raise HTTPException(400, "Couldn't extract any text from that file — it may be a scanned image without a text layer.")

    guessed_title = (title or "").strip()
    if not guessed_title:
        # Fall back to the first non-trivial line of the extracted text, else the filename.
        for line in text.splitlines():
            line = line.strip()
            if 8 <= len(line) <= 200:
                guessed_title = line
                break
        if not guessed_title:
            guessed_title = os.path.splitext(name)[0]

    paper = {
        "title": guessed_title,
        "authors": "",
        "year": None,
        "venue": "uploaded file",
        "abstract": text[:1500],
        "url": None,
        "source": "upload",
    }
    if _is_duplicate(run, paper):
        raise HTTPException(409, "A source with this title is already in your sources.")

    pipeline = SiftPipeline(api_key=api_key, model=model, mode=run.mode)
    # Assign the idx the same way add_paper() does, so the saved file can be
    # named after it and matched back up after pipeline.add_paper() appends.
    new_idx = max((p.get("idx", -1) for p in run.papers), default=-1) + 1
    # Feed the full extracted text straight to the extractor (reader_extractor
    # reads `_text` before falling back to `abstract`) — skips a re-fetch that
    # would fail anyway since there's no URL, and Deep mode gets full-text
    # depth on this source too instead of only the excerpt above.
    paper["_text"] = text[:6000]

    try:
        res = pipeline.add_paper(run, paper)
    except Exception as e:
        raise HTTPException(502, f"Adding paper failed: {e}")

    # Persist the raw file to disk, named by this run + the idx add_paper()
    # just assigned, so paper_pdf() can serve it back for the PDF viewer.
    safe_name = _re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[-80:]
    run_dir = os.path.join(settings.uploads_dir, run_id)
    os.makedirs(run_dir, exist_ok=True)
    stored_name = f"{new_idx}_{safe_name}"
    with open(os.path.join(run_dir, stored_name), "wb") as f:
        f.write(data)
    res["paper"]["local_file"] = os.path.join(run_id, stored_name)
    # add_paper() appended `paper` (the same dict object) into run.papers, so
    # updating res["paper"] in place keeps run.papers / run.approved_papers in sync.

    try:
        notes_dict = json.loads(notes) if notes else None
    except Exception:
        notes_dict = None
    _persist_done(run, user_id, notes=notes_dict)
    return res


@router.post("/runs/{run_id}/add_paper")
def add_paper(run_id: str, body: AddPaperBody, user_id: str = Depends(require_user)):
    """Add one resolved paper and run extraction on it. Marks downstream
    analysis stale (frontend), so the user runs Update analysis afterwards."""
    run = get_run(run_id, user_id)
    if not (body.paper or {}).get("title"):
        raise HTTPException(400, "That paper has no title — pick a different result.")
    if _is_duplicate(run, body.paper):
        raise HTTPException(409, "This paper is already in your sources.")
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model,
                               mode=run.mode or getattr(body, "mode", None))
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
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model,
                               mode=run.mode or getattr(body, "mode", None))
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
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model, mode=run.mode or body.mode)
    try:
        result = pipeline.evaluate(run)
    except Exception as e:
        raise HTTPException(502, f"Evaluator failed: {e}")
    return {"run_id": run.run_id, "eval_result": result}

@router.post("/runs/{run_id}/experiments")
def design_experiments(run_id: str, body: SynthesizeBody, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model, mode=run.mode or body.mode)
    try:
        result = pipeline.design_experiments(run)
    except Exception as e:
        raise HTTPException(502, f"Experiment designer failed: {e}")
    _persist_experiments(run, user_id)
    return {"run_id": run.run_id, "experiment_plan": result}


@router.post("/runs/{run_id}/experiments/refine")
def refine_experiments(run_id: str, body: SynthesizeBody, user_id: str = Depends(require_user)):
    """Recursive self-improvement pass: critique the current experiment plan
    and revise any hypothesis that scores below the bar, up to a couple of
    rounds. Designs a plan first if this run doesn't have one yet."""
    run = get_run(run_id, user_id)
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model, mode=run.mode or body.mode)
    try:
        result = pipeline.refine_experiments(run)
    except Exception as e:
        raise HTTPException(502, f"Hypothesis refinement failed: {e}")
    _persist_experiments(run, user_id)
    return {
        "run_id": run.run_id,
        "experiment_plan": result["plan"],
        "experiment_critique": result["critique"],
        "iterations": result["iterations"],
    }


@router.patch("/runs/{run_id}/experiments/{index}")
def update_hypothesis(run_id: str, index: int, body: HypothesisEditBody, user_id: str = Depends(require_user)):
    """Direct human edit to one hypothesis — no LLM call. `edits` is the set
    of fields to overwrite, e.g. {"hypothesis": "...", "risks": "..."}."""
    run = get_run(run_id, user_id)
    pipeline = SiftPipeline()
    try:
        hyp = pipeline.update_hypothesis(run, index, body.edits)
    except ValueError as e:
        raise HTTPException(404, str(e))
    _persist_experiments(run, user_id)
    return {"run_id": run.run_id, "hypothesis": hyp}


@router.post("/runs/{run_id}/experiments/{index}/dispute")
def dispute_hypothesis(run_id: str, index: int, body: DisputeBody, user_id: str = Depends(require_user)):
    """A human argues with one hypothesis. The designer either revises it to
    address the objection or defends it with a specific counter-reason —
    see agents/experiment_designer.py: respond_to_challenge."""
    run = get_run(run_id, user_id)
    argument = (body.argument or "").strip()
    if not argument:
        raise HTTPException(400, "Provide your objection in `argument`.")
    pipeline = SiftPipeline(api_key=body.api_key, model=body.model, mode=run.mode or body.mode)
    try:
        result = pipeline.dispute_hypothesis(run, index, argument)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(502, f"Dispute failed: {e}")
    _persist_experiments(run, user_id)
    return {"run_id": run.run_id, **result}


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
 
 
_STOP = {"the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
         "was", "were", "this", "that", "these", "those", "it", "its", "with", "by",
         "as", "at", "be", "how", "what", "why", "which", "does", "do", "did", "can",
         "paper", "study", "authors", "their", "they", "from", "into", "about"}


def _keywords(question: str) -> list[str]:
    toks = re.findall(r"[a-z0-9][a-z0-9\-]{2,}", (question or "").lower())
    return [t for t in toks if t not in _STOP]


def select_passages(full_text: str, question: str, max_chars: int = 22000) -> str:
    """Cheap local retrieval: split the paper into paragraph chunks, score each by
    how many question keywords it contains, and return the top chunks (in original
    order) up to max_chars. Avoids sending the whole paper for a specific question.
    Falls back to the head of the text if nothing scores."""
    kws = _keywords(question)
    # paragraph-ish chunks
    raw = re.split(r"\n\s*\n", full_text)
    chunks, buf = [], ""
    for para in raw:
        para = para.strip()
        if not para:
            continue
        if len(buf) + len(para) < 1400:
            buf = f"{buf}\n\n{para}" if buf else para
        else:
            if buf:
                chunks.append(buf)
            buf = para
    if buf:
        chunks.append(buf)
    if not kws or not chunks:
        return full_text[:max_chars]

    def score(c: str) -> int:
        low = c.lower()
        return sum(low.count(k) for k in kws)

    ranked = sorted(range(len(chunks)), key=lambda i: score(chunks[i]), reverse=True)
    keep, total = set(), 0
    for i in ranked:
        if score(chunks[i]) == 0:
            break
        if total + len(chunks[i]) > max_chars:
            continue
        keep.add(i)
        total += len(chunks[i])
    if not keep:                       # no keyword hits — send the opening
        return full_text[:max_chars]
    return "\n\n[…]\n\n".join(chunks[i] for i in sorted(keep))


# Questions that need the whole paper rather than a few passages.
_BROAD = ("summar", "overview", "overall", "tl;dr", "tldr", "everything", "whole paper",
          "entire paper", "main point", "main contribution", "key point", "key finding",
          "limitation", "in detail", "walk me through", "what is this paper")


def _needs_pdf(question: str) -> bool:
    q = (question or "").lower()
    return any(w in q for w in ("figure", "fig.", "fig ", "table", "chart", "plot",
                                "graph", "diagram", "equation", "panel", "image", "photo"))


CHAT_FORMAT = (
    "\n\nFORMAT — you are writing into a narrow chat panel, so keep it tight and "
    "scannable:\n"
    "- Open with one plain-sentence direct answer. No title, no 'Here is…' preamble.\n"
    "- For structure use bold lead-ins (**Method.** …) or level-4 headings (#### ), "
    "NEVER # or ## — big headers look broken here.\n"
    "- Prefer short bullet points over long paragraphs; keep bullets to 1–2 lines.\n"
    "- Put metrics, numbers and short quotes inline; bold the key figures.\n"
    "- Don't pad. Aim for the shortest answer that fully covers the question.\n"
    "\nDIAGRAMS — you CAN draw. When a flow, pipeline, architecture, timeline, "
    "comparison or set of relationships would be clearer visually (or the user asks "
    "for a diagram/flowchart/figure), emit a Mermaid code block and it will be "
    "rendered as a real diagram:\n"
    "```mermaid\nflowchart TD\n  A[Input] --> B[Step]\n  B --> C[Result]\n```\n"
    "Use flowchart TD/LR, sequenceDiagram, or timeline. Keep node labels short and "
    "put them in square brackets; avoid parentheses, quotes and special characters "
    "inside labels (they break parsing). Follow the diagram with a brief explanation."
)


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
 
    # Chat mode picks the model: Quick = Gemini (cheap), Deep = Sonnet (stronger
    # reasoning). Grounding source (text/excerpts/PDF) is chosen below by cost.
    chat_models = {"quick": settings.gemini_model or "gemini-2.5-flash", "deep": "claude-sonnet-4-6"}
    chat_model = chat_models.get(body.chat_mode) if body.chat_mode else body.model
    llm = LLMClient(api_key=body.api_key, model=chat_model, run_id=run_id, stage="chat")
 
    image_blocks = []
    for img in (body.images or [])[:6]:  # cap count
        mt, data = img.get("media_type"), img.get("data")
        if mt and data and len(data) < 9_000_000:  # ~6.5 MB decoded per image
            image_blocks.append({"type": "image",
                "source": {"type": "base64", "media_type": mt, "data": data}})
 
    # Cost strategy: prefer cheap extracted TEXT over the token-heavy PDF (only
    # attach the PDF for images or figure/table questions); RETRIEVE only the
    # relevant passages for specific questions; CACHE the paper block so
    # multi-turn follow-ups reuse it at 0.1x input.
    q = body.question or ""
    broad = (len(q.strip()) < 40) or any(w in q.lower() for w in _BROAD)
    want_pdf = bool(image_blocks) or _needs_pdf(q)
    # Locally-uploaded sources (Sources > "Upload a file") have no URL to
    # fetch — fetch_paper_text/fetch_paper_pdf would silently return nothing
    # for them, collapsing grounding down to the abstract only (and never
    # attaching a PDF even for a figure/diagram question). Read straight off
    # the uploaded file on disk instead.
    if paper.get("local_file"):
        from core.paper_text import local_paper_full_text, local_paper_pdf_bytes
        full_text = local_paper_full_text(paper) or ""
        pdf_bytes = local_paper_pdf_bytes(paper) if want_pdf else None
    else:
        full_text = fetch_paper_text(paper.get("url")) or ""
        pdf_bytes = fetch_paper_pdf(paper.get("url")) if want_pdf else None

    try:
        blocks, parts = [], []
        if pdf_bytes:
            b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")
            blocks.append({"type": "document", "source": {"type": "base64",
                "media_type": "application/pdf", "data": b64}})
            parts.append("full_pdf")
        blocks.extend(image_blocks)
        if image_blocks:
            parts.append("image")
 
        paper_text = f"PAPER METADATA:\n{context}\n\n"
        cache_paper = False
        if not pdf_bytes:
            if full_text and broad:
                paper_text += ("FULL PAPER TEXT (extracted; figures not included):\n"
                               + full_text[:60000] + "\n\n")
                parts.append("full_text")
                cache_paper = True            # stable across turns → cacheable
            elif full_text:
                paper_text += ("RELEVANT EXCERPTS (passages most relevant to the question; "
                               "ask for a summary to read the whole paper):\n"
                               + select_passages(full_text, q) + "\n\n")
                parts.append("retrieved")
            else:
                parts.append("abstract")
        paper_block = {"type": "text", "text": paper_text}
        if cache_paper:
            paper_block["cache_control"] = {"type": "ephemeral"}
        blocks.append(paper_block)
        convo_text = ""
        if image_blocks:
            convo_text += ("The user attached the image(s) above — use them to answer "
                           "(e.g. explain a figure or compare it with the paper).\n\n")
        convo_text += f"CONVERSATION:\n{convo}"
        blocks.append({"type": "text", "text": convo_text})
 
        grounding = ("the attached PDF (read figures, tables and equations)" if pdf_bytes
                     else "the full paper text below" if (full_text and broad)
                     else "the excerpts below (say so if they don't cover the question; do not guess)" if full_text
                     else "the abstract below (say plainly when it doesn't cover the question)")
        system = (
            "You are a research assistant helping a reviewer understand a paper. Answer from "
            + grounding + "; ground every claim in the source and don't invent facts. When "
            "asked for a summary, cover objective, method, data, key results (with numbers), "
            "and limitations." + CHAT_FORMAT
        )
        answer = llm.call(content=blocks, system=system, max_tokens=1500)
        source = "+".join(parts) or "abstract"
    except Exception as e:
        raise HTTPException(502, f"Chat failed: {e}")
    return {"answer": answer, "source": source}
 
 
@router.get("/runs/{run_id}")
def get_run_state(run_id: str, user_id: str = Depends(require_user)):
    run = get_run(run_id, user_id)
    pipeline = SiftPipeline()
    return {
        "run_id": run.run_id, "topic": run.topic, "reform": run.reform,
        "papers": run.papers, "approved_papers": run.approved_papers,
        "extractions": run.extractions, "synthesis": run.synthesis,
        "sections": run.sections, "eval_result": run.eval_result, "stage": run.stage,
        "side_modules": pipeline.side_modules(run) if run.synthesis else None,
        "experiment_plan": run.experiment_plan,
        "experiment_critique": run.experiment_critique,
        "experiment_iterations": run.experiment_iterations,
        "experiment_debate": run.experiment_debate,
    }
 
 
# ── Session history endpoints (no LLM) ───────────────────────────────────
 
@router.get("/sessions")
def sessions_list(user_id: str = Depends(require_user)):
    return list_sessions(user_id)


@router.get("/sessions/{session_id}/usage")
def session_usage(session_id: str, user_id: str = Depends(require_user)):
    """Token counts + dollar cost for one session, by stage and model. DB read."""
    return get_usage(session_id)


class ChatSaveBody(BaseModel):
    paper_key: str
    messages: list[dict] = []


class StudioHistorySaveBody(BaseModel):
    messages: list[dict] = []


class StudioChatBody(BaseModel):
    question: str
    paper_idxs: list[int] = []          # selected sources; empty = all included
    history: list[dict] = []
    api_key: str | None = None
    model: str | None = None
    chat_mode: str | None = None        # quick (Gemini) | deep (Sonnet)


@router.post("/runs/{run_id}/studio/chat")
def studio_chat(run_id: str, body: StudioChatBody, user_id: str = Depends(require_user)):
    """Chat grounded in MULTIPLE selected papers.

    Context is built from the cached extractions + abstracts we already have —
    no PDF fetching — so a question across 20 papers stays fast and cheap.
    Returns the answer plus suggested follow-up questions.
    """
    run = get_run(run_id, user_id)
    wanted = set(body.paper_idxs or [])
    papers = [p for p in (run.approved_papers or run.papers or [])
              if not wanted or p.get("idx") in wanted]
    if not papers:
        raise HTTPException(400, "Select at least one source to chat about.")

    ext_by_idx = {e.get("idx"): e for e in (run.extractions or [])}
    cite = {p["idx"]: i + 1 for i, p in enumerate(papers)}

    from core.paper_text import local_paper_full_text

    blocks = []
    for p in papers:
        e = ext_by_idx.get(p.get("idx"), {})
        lines = [f'[{cite[p["idx"]]}] {p.get("title","")} — {p.get("authors","")} ({p.get("year","?")})']
        for k in ("method", "finding", "metrics", "data", "limitation", "contribution"):
            v = e.get(k)
            if v and v != "n/a":
                lines.append(f"  {k}: {v}")
        # Uploaded sources (Sources > "Upload a file") have no URL, so the
        # abstract cached at upload time is already a short excerpt of
        # whatever was extracted — stacking Studio's usual 900-char abstract
        # cap on top of that left almost nothing for the model to work with.
        # Since these are documents the user deliberately added (not one of
        # many search results), pull real text straight from the uploaded
        # file instead of the compressed abstract. Capped well below the
        # single-paper chat's 60k-char budget since Studio can have several
        # sources selected at once.
        local_text = local_paper_full_text(p, max_chars=12000) if p.get("local_file") else None
        if local_text:
            lines.append(f"  full text (uploaded document):\n{local_text}")
        else:
            abs_ = (p.get("abstract") or "")[:900]
            if abs_:
                lines.append(f"  abstract: {abs_}")
        blocks.append("\n".join(lines))
    corpus = "\n\n".join(blocks)

    convo = ""
    for m in (body.history or [])[-8:]:
        role = "User" if m.get("role") == "user" else "Assistant"
        convo += f"{role}: {m.get('content','')}\n"
    convo += f"User: {body.question}\nAssistant:"

    chat_models = {"quick": settings.gemini_model or "gemini-2.5-flash",
                   "deep": "claude-sonnet-4-6"}
    model = chat_models.get(body.chat_mode) if body.chat_mode else (body.model or settings.mid_model)
    llm = LLMClient(api_key=body.api_key, model=model, run_id=run_id, stage="chat")

    system = (
        "You are a research assistant answering questions across a SET of papers the "
        "user selected. Ground every claim in the provided sources and cite them "
        f"inline as [n] using the numbers given. There are {len(papers)} sources. "
        "Compare and contrast across papers where useful; say plainly when the "
        "sources don't cover something rather than guessing." + CHAT_FORMAT +
        "\n\nSOURCES:\n" + corpus +
        "\n\n" + FOLLOWUPS_INSTRUCTION
    )
    try:
        raw = llm.call(user_text=convo, system=system, max_tokens=1400)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Studio chat failed: {e}")

    answer, followups = _split_followups(raw)
    if not followups:
        # Model didn't emit the block (or emitted something unparseable) —
        # fall back to the old keyword heuristic rather than showing nothing.
        followups = _followups_fallback(body.question, answer, len(papers))

    return {
        "answer": answer,
        "sources": [{"n": cite[p["idx"]], "idx": p["idx"], "title": p.get("title")} for p in papers],
        "followups": followups,
    }


# Asking the model to end its own answer with a short list of next questions
# costs nothing extra — it's the same call that produces the answer, just a
# few more output tokens — and gives suggestions that are actually about
# what was just discussed, instead of a fixed set of 4 that were almost
# always the same regardless of the conversation (see _followups_fallback).
FOLLOWUPS_INSTRUCTION = (
    "After your answer, on its own line write exactly ///FOLLOWUPS/// and then "
    "list exactly 3 short follow-up questions this user would plausibly ask next, "
    "one per line, no numbering or bullets. Base them specifically on what was just "
    "discussed and the sources above — not generic questions that would fit any chat."
)


def _split_followups(raw: str) -> tuple[str, list[str]]:
    marker = "///FOLLOWUPS///"
    if marker not in raw:
        return raw, []
    main, _, tail = raw.partition(marker)
    qs = [ln.strip(" \t-•*0123456789.)") for ln in tail.strip().splitlines()]
    qs = [q for q in qs if q]
    return main.rstrip(), qs[:4]


def _followups_fallback(question: str, answer: str, n_sources: int) -> list[str]:
    """Kept as a safety net for when the model doesn't emit the ///FOLLOWUPS///
    block (older/smaller models, or a malformed response)."""
    a = (answer or "").lower()
    q = (question or "").lower()
    out = []
    if n_sources > 1:
        out.append("Where do these sources disagree?")
    if "limitation" not in q and "limitation" not in a:
        out.append("What are the main limitations across these papers?")
    if "method" not in q:
        out.append("Compare the methods used in each paper.")
    if "gap" not in q:
        out.append("What research gaps do these papers leave open?")
    if any(w in a for w in ("%", "increase", "reduc", "improv", "accuracy", "score")):
        out.append("Summarise the reported numbers in a table.")
    out.append("Draw a diagram of how these findings connect.")
    return out[:4]


@router.get("/runs/{run_id}/studio/history")
def studio_history_get(run_id: str, user_id: str = Depends(require_user)):
    """Load saved Studio chat for this run, for the signed-in user — so
    reopening Studio (after a refresh, or coming back tomorrow) resumes the
    conversation instead of starting blank.

    Must be registered BEFORE the /studio/{artifact} route below — Starlette
    matches routes in registration order, and {artifact} is a wildcard that
    would otherwise swallow "history" as an artifact name (and 422/400,
    since it isn't report/deck/briefing and the body shape doesn't match)."""
    from core.studio_history import get_studio_chat
    return {"messages": get_studio_chat(user_id, run_id)}


@router.post("/runs/{run_id}/studio/history")
def studio_history_save(run_id: str, body: StudioHistorySaveBody, user_id: str = Depends(require_user)):
    """Persist the Studio chat message list for this run. Must also stay
    ahead of /studio/{artifact} — see note above."""
    from core.studio_history import save_studio_chat
    save_studio_chat(user_id, run_id, body.messages)
    return {"ok": True}


@router.post("/runs/{run_id}/studio/{artifact}")
def studio_artifact(run_id: str, artifact: str, body: StudioChatBody,
                    user_id: str = Depends(require_user)):
    """Generate a Studio artifact (report | deck outline) over the selected
    papers, returned as text the UI can show and then export."""
    prompts = {
        "report": ("Write a structured research report across these sources with headings: "
                   "Overview, Themes, Methods compared, Key findings with numbers, "
                   "Disagreements, Limitations, Gaps and Conclusion. Cite as [n]."),
        "deck": ("Draft a slide deck outline across these sources. Use '## Slide N: Title' "
                 "for each slide followed by 3-5 concise bullets. Cover: overview, themes, "
                 "methods, key findings with numbers, gaps, and conclusion. Cite as [n]."),
        "briefing": ("Write a one-page briefing for a colleague new to this topic: what "
                     "this body of work establishes, what's contested, and what to read first. Cite as [n]."),
    }
    if artifact not in prompts:
        raise HTTPException(400, "Unknown artifact. Use report, deck or briefing.")
    body = body.model_copy(update={"question": prompts[artifact]})
    result = studio_chat(run_id, body, user_id)
    return {"artifact": artifact, "content": result["answer"], "sources": result["sources"]}


class StudioExportBody(BaseModel):
    content: str
    title: str | None = None
    paper_idxs: list[int] = []


@router.post("/runs/{run_id}/studio/export/{fmt}")
def studio_export(run_id: str, fmt: str, body: StudioExportBody,
                  user_id: str = Depends(require_user)):
    """Download a generated Studio artifact as .pptx / .pdf / .docx.
    Built locally from the text already generated — no extra model cost."""
    from fastapi.responses import Response
    from core import exporters

    run = get_run(run_id, user_id)
    wanted = set(body.paper_idxs or [])
    papers = [p for p in (run.approved_papers or run.papers or [])
              if not wanted or p.get("idx") in wanted]
    title = body.title or "Research report"

    # Turn the generated markdown into the {section: text} shape the exporters use.
    sections = _sections_from_markdown(body.content, title)
    args = (title, sections, papers, run.synthesis or {})
    stem = _safe_filename(title)
    try:
        if fmt == "pptx":
            data = exporters.build_pptx(*args)
            media = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        elif fmt == "pdf":
            data = exporters.build_pdf(*args)
            media = "application/pdf"
        elif fmt == "docx":
            data = exporters.build_docx(*args, template="arxiv")
            media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        else:
            raise HTTPException(400, "Unsupported format. Use pptx, pdf or docx.")
    except ImportError as e:
        raise HTTPException(500, f"Export dependency missing: {e}. Run: pip install -r requirements.txt")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Export failed: {e}")

    return Response(content=data, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{stem}.{fmt}"'})


def _sections_from_markdown(md: str, title: str) -> dict:
    """Split '## Heading' / '**Heading**' markdown into exporter sections."""
    text = md or ""
    parts = re.split(r"\n(?=#{1,3}\s)", text)
    out, first = {"title": title}, []
    keys = ["abstract", "intro", "synthesis", "gaps", "future"]
    ki = 0
    for part in parts:
        m = re.match(r"#{1,3}\s*(.+)", part)
        if not m:
            first.append(part.strip())
            continue
        bodytext = part[m.end():].strip()
        if ki < len(keys):
            out[keys[ki]] = f"{m.group(1).strip()}\n\n{bodytext}" if bodytext else m.group(1).strip()
            ki += 1
        else:                      # overflow → append to the last section
            out[keys[-1]] = out.get(keys[-1], "") + f"\n\n{m.group(1).strip()}\n\n{bodytext}"
    lead = "\n\n".join(p for p in first if p)
    if lead:
        out["abstract"] = (lead + "\n\n" + out.get("abstract", "")).strip()
    if len(out) == 1:              # no headings at all
        out["synthesis"] = text
    return out


@router.get("/runs/{run_id}/export/{fmt}")
def export_review(run_id: str, fmt: str, template: str = "ieee", illustrate: bool = False,
                  user_id: str = Depends(require_user)):
    """Download the written review as .pptx / .pdf / .docx.

    Built locally from content the pipeline already produced — no LLM calls,
    so exporting is free. `template` applies to docx: ieee | arxiv.

    `illustrate` (pptx only) is an explicit opt-in that costs real money — it
    generates one AI illustration per section (core/image_gen.py) via Gemini's
    image model. Images are cached on the run (RunState.slide_images) so
    re-downloading the same run's deck doesn't regenerate/recharge; a section
    whose image generation fails just exports as plain text, same as today.
    """
    from fastapi.responses import Response
    from core import exporters
    from pipeline.data_analysis import comparison_table, year_distribution

    run = get_run(run_id, user_id)
    if not run.sections:
        raise HTTPException(400, "Generate the literature review first.")

    papers = _ordered_for_export(run)
    extractions_by_idx = {e["idx"]: e for e in (run.extractions or [])}
    ranked_by_idx = {r["idx"]: r for r in ((run.synthesis or {}).get("ranked") or [])}
    comparison = comparison_table(papers, extractions_by_idx, ranked_by_idx)
    year_dist = year_distribution(papers)

    args = (run.topic, run.sections, papers, run.synthesis or {})
    kwargs = {"comparison": comparison, "year_dist": year_dist}
    stem = _safe_filename(exporters.review_title(run.sections, run.topic))

    if fmt == "pptx":
        # Slide-native bullets (agents/slide_writer.py, Gemini — free tier,
        # same as extraction) instead of the old mechanical sentence-split.
        # Cached on the run so repeat downloads don't re-call the model.
        # Best-effort: any section that fails just falls back inside
        # build_pptx() to the sentence-split, so this can never break export.
        try:
            from agents.slide_writer import SlideWriterAgent
            from concurrent.futures import ThreadPoolExecutor
            missing = [(k, l) for k, l in exporters.SECTION_ORDER
                       if (run.sections or {}).get(k) and k not in run.slide_bullets]
            if missing:
                writer = SlideWriterAgent(LLMClient(
                    model=settings.gemini_model or "gemini-2.5-flash",
                    run_id=run_id, stage="slide_write"))
                def _write(item):
                    k, label = item
                    return k, writer.run(label, run.sections[k], run.topic)
                with ThreadPoolExecutor(max_workers=min(4, len(missing))) as ex:
                    for k, bullets in ex.map(_write, missing):
                        if bullets:
                            run.slide_bullets[k] = bullets
        except Exception:
            pass  # export still works via the mechanical fallback
        kwargs["slide_bullets"] = run.slide_bullets

    if fmt == "pptx" and illustrate:
        from core.image_gen import build_prompt, generate_image
        from core.usage import record_image_call
        generated = 0
        for key, label in exporters.SECTION_ORDER:
            text = (run.sections or {}).get(key)
            if not text or key in run.slide_images:
                continue
            img = generate_image(build_prompt(label, text, run.topic))
            if img:
                run.slide_images[key] = img[0]   # (bytes, mime_type) -> keep bytes only
                generated += 1
        if generated:
            record_image_call(run_id, "illustrate", generated)
        kwargs["images"] = run.slide_images

    try:
        if fmt == "pptx":
            data = exporters.build_pptx(*args, **kwargs)
            media = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        elif fmt == "pdf":
            data = exporters.build_pdf(*args, **kwargs)
            media = "application/pdf"
        elif fmt == "docx":
            data = exporters.build_docx(*args, template=template, **kwargs)
            media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            stem = f"{stem}_{(template or 'ieee').lower()}"
        else:
            raise HTTPException(400, "Unsupported format. Use pptx, pdf or docx.")
    except ImportError as e:
        raise HTTPException(
            500, f"Export dependency missing: {e}. Run: pip install -r requirements.txt")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Export failed: {e}")

    return Response(
        content=data, media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{stem}.{fmt}"'},
    )


class PaperListExportBody(BaseModel):
    fmt: str = "xlsx"                      # "csv" | "xlsx"
    included: dict[str, bool] | None = None  # idx (string keys, JSON) -> checked in the UI right now;
                                               # overrides server-known approval so this reflects the
                                               # Filter stage's live checkboxes even before they're submitted


@router.post("/runs/{run_id}/papers/export")
def export_paper_list(run_id: str, body: PaperListExportBody, user_id: str = Depends(require_user)):
    """Export the papers table — usable at the Filter stage (before
    extraction has run, so those columns are just blank) or the Sources
    stage (after). Doesn't touch the generated-review export path in
    core/exporters.py; this is the raw data, not the write-up."""
    from fastapi.responses import Response
    from core.paper_export import papers_to_csv, papers_to_xlsx

    run = get_run(run_id, user_id)
    extractions_by_idx = {e.get("idx"): e for e in (run.extractions or [])}

    if body.included is not None:
        included_map = {int(k): v for k, v in body.included.items()}
    else:
        approved_idx = {p.get("idx") for p in run.approved_papers}
        included_map = {p.get("idx"): (p.get("idx") in approved_idx) for p in run.papers}

    fmt = (body.fmt or "xlsx").lower()
    stem = _safe_filename(run.topic or "papers")
    if fmt == "csv":
        data = papers_to_csv(run.papers, extractions_by_idx, included_map)
        media = "text/csv"
    else:
        try:
            data = papers_to_xlsx(run.papers, extractions_by_idx, included_map)
        except ImportError as e:
            raise HTTPException(500, f"Export dependency missing: {e}. Run: pip install -r requirements.txt")
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        fmt = "xlsx"
    return Response(
        content=data, media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{stem}_papers.{fmt}"'},
    )


def _ordered_for_export(run) -> list[dict]:
    """Papers in citation order, so [n] in the text matches the reference list."""
    return SiftPipeline()._ordered_papers(run)


def _safe_filename(text: str) -> str:
    out = re.sub(r"[^\w\s-]", "", (text or "review")).strip()
    out = re.sub(r"\s+", "_", out)
    return (out[:60] or "literature_review")


@router.get("/runs/{run_id}/experiments/export/{fmt}")
def export_experiments(run_id: str, fmt: str, user_id: str = Depends(require_user)):
    """Download the hypothesis + experiment plan (Methods tab) as .docx or
    .pdf. Same no-LLM-cost approach as /export/{fmt}: built locally from
    content the pipeline already produced — the plan, the critic's scores if
    a Refine pass has run, and the source papers/extractions for the
    evidence-trail table."""
    from fastapi.responses import Response
    from core import exporters

    run = get_run(run_id, user_id)
    if not run.experiment_plan or not run.experiment_plan.get("hypotheses"):
        raise HTTPException(400, "Design experiments first.")

    papers = _ordered_for_export(run)
    stem = _safe_filename((run.topic or "experiment_plan")) + "_experiments"

    try:
        if fmt == "docx":
            data = exporters.build_experiments_docx(
                run.topic, run.experiment_plan, papers, run.extractions, run.experiment_critique)
            media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        elif fmt == "pdf":
            data = exporters.build_experiments_pdf(
                run.topic, run.experiment_plan, papers, run.extractions, run.experiment_critique)
            media = "application/pdf"
        else:
            raise HTTPException(400, "Unsupported format. Use docx or pdf.")
    except ImportError as e:
        raise HTTPException(
            500, f"Export dependency missing: {e}. Run: pip install -r requirements.txt")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Export failed: {e}")

    return Response(
        content=data, media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{stem}.{fmt}"'},
    )


@router.get("/news")
def news_feed():
    """Fresh AI-in-science headlines for the public landing page.

    PUBLIC (no auth) — the landing page is shown to signed-out visitors.
    Costs nothing: public RSS feeds + keyword tagging, no model calls, and
    results are cached server-side so visitors don't hit the feeds directly.
    """
    from core.news import get_news
    return get_news()


class ProfileBody(BaseModel):
    display_name: str | None = None
    orcid: str | None = None
    scholar_url: str | None = None
    affiliation: str | None = None


@router.get("/profile")
def profile_get(user_id: str = Depends(require_user)):
    """The signed-in user's researcher profile. DB read, no LLM."""
    from core.profile import get_profile
    return get_profile(user_id)


@router.post("/profile")
def profile_save(body: ProfileBody, user_id: str = Depends(require_user)):
    """Update display name / ORCID / Google Scholar / affiliation."""
    from core.profile import save_profile
    return save_profile(user_id, body.model_dump())


@router.get("/chat/history")
def chat_history_get(paper_key: str, user_id: str = Depends(require_user)):
    """Load saved chat for a paper (by URL), for the signed-in user."""
    from core.chat_history import get_chat
    return {"messages": get_chat(user_id, paper_key)}


@router.post("/chat/history")
def chat_history_save(body: ChatSaveBody, user_id: str = Depends(require_user)):
    """Persist the chat message list for a paper (by URL)."""
    from core.chat_history import save_chat
    save_chat(user_id, body.paper_key, body.messages)
    return {"ok": True}


class ProjectBody(BaseModel):
    name: str
    description: str | None = None


class ProjectUpdateBody(BaseModel):
    name: str | None = None
    description: str | None = None


class ProjectPaperBody(BaseModel):
    paper: dict
    source: str | None = "manual"


class ProjectNoteBody(BaseModel):
    title: str | None = ""
    body: str | None = ""


class AssignProjectBody(BaseModel):
    project_id: str | None = None  # None unfiles the run


class ZoteroImportBody(BaseModel):
    api_key: str
    library_id: str
    library_type: str = "user"  # "user" | "group"


@router.get("/projects")
def projects_list(user_id: str = Depends(require_user)):
    """All of the signed-in user's projects, with counts. No LLM."""
    from core.projects import list_projects
    return {"projects": list_projects(user_id)}


@router.post("/projects")
def projects_create(body: ProjectBody, user_id: str = Depends(require_user)):
    from core.projects import create_project
    return create_project(user_id, body.name, body.description or "")


@router.get("/projects/{project_id}")
def projects_get(project_id: str, user_id: str = Depends(require_user)):
    from core.projects import get_project
    proj = get_project(project_id, user_id)
    if not proj:
        raise HTTPException(404, "Project not found.")
    return proj


@router.patch("/projects/{project_id}")
def projects_update(project_id: str, body: ProjectUpdateBody, user_id: str = Depends(require_user)):
    from core.projects import update_project
    proj = update_project(project_id, user_id, body.name, body.description)
    if not proj:
        raise HTTPException(404, "Project not found.")
    return proj


@router.delete("/projects/{project_id}")
def projects_delete(project_id: str, keep_runs: bool = True, user_id: str = Depends(require_user)):
    """Delete a project. Runs filed under it are kept (unfiled) unless
    keep_runs=false is passed explicitly."""
    from core.projects import delete_project
    ok = delete_project(project_id, user_id, keep_runs=keep_runs)
    if not ok:
        raise HTTPException(404, "Project not found.")
    return {"ok": True}


@router.post("/projects/{project_id}/papers")
def projects_add_paper(project_id: str, body: ProjectPaperBody, user_id: str = Depends(require_user)):
    from core.projects import add_paper, get_project
    if not get_project(project_id, user_id):
        raise HTTPException(404, "Project not found.")
    return add_paper(project_id, user_id, body.paper, body.source or "manual")


@router.delete("/projects/{project_id}/papers/{paper_id}")
def projects_remove_paper(project_id: str, paper_id: str, user_id: str = Depends(require_user)):
    from core.projects import remove_paper
    ok = remove_paper(project_id, user_id, paper_id)
    if not ok:
        raise HTTPException(404, "Saved paper not found.")
    return {"ok": True}


@router.post("/projects/{project_id}/notes")
def projects_add_note(project_id: str, body: ProjectNoteBody, user_id: str = Depends(require_user)):
    from core.projects import add_note, get_project
    if not get_project(project_id, user_id):
        raise HTTPException(404, "Project not found.")
    return add_note(project_id, user_id, body.title or "", body.body or "")


@router.patch("/projects/{project_id}/notes/{note_id}")
def projects_update_note(project_id: str, note_id: str, body: ProjectNoteBody,
                          user_id: str = Depends(require_user)):
    from core.projects import update_note
    note = update_note(project_id, user_id, note_id, body.title, body.body)
    if not note:
        raise HTTPException(404, "Note not found.")
    return note


@router.delete("/projects/{project_id}/notes/{note_id}")
def projects_remove_note(project_id: str, note_id: str, user_id: str = Depends(require_user)):
    from core.projects import remove_note
    ok = remove_note(project_id, user_id, note_id)
    if not ok:
        raise HTTPException(404, "Note not found.")
    return {"ok": True}


@router.post("/runs/{run_id}/project")
def assign_run_project(run_id: str, body: AssignProjectBody, user_id: str = Depends(require_user)):
    """File (or unfile) an existing run under a project."""
    from core.projects import assign_session
    ok = assign_session(run_id, user_id, body.project_id)
    if not ok:
        raise HTTPException(404, "Run or project not found.")
    return {"ok": True}


@router.post("/projects/{project_id}/zotero/import")
def projects_zotero_import(project_id: str, body: ZoteroImportBody, user_id: str = Depends(require_user)):
    """Pull items from a Zotero library (read-only) and save them into this
    project's paper list. The API key is used once and never stored."""
    from core.projects import add_paper, get_project
    from core.zotero import fetch_library_items
    if not get_project(project_id, user_id):
        raise HTTPException(404, "Project not found.")
    try:
        items = fetch_library_items(body.api_key, body.library_id, body.library_type)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Could not reach Zotero: {e}")
    for paper in items:
        add_paper(project_id, user_id, paper, source="zotero")
    return {"imported": len(items)}


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
 
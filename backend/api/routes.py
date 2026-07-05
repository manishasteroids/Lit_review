"""
API routes — one endpoint per pipeline stage, mirroring the diagram so the
frontend's pipeline rail can light up node by node as each call returns.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from pipeline.orchestrator import RUNS, SamhitaPipeline
from core.llm_client import LLMClient

router = APIRouter(prefix="/api")


def get_run(run_id: str):
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found. Start a new run from the topic screen.")
    return run


class CreateRunBody(BaseModel):
    topic: str
    api_key: str | None = None
    model: str | None = None


class FilterBody(BaseModel):
    approved_indices: list[int]


@router.post("/runs")
def create_run(body: CreateRunBody):
    """Stages: User Topic/Query -> Query Reformulator -> Academic Search."""
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        run = pipeline.reformulate_and_search(body.topic)
    except Exception as e:  # noqa: BLE001 — surface model/parse errors to the UI
        raise HTTPException(502, f"Query Reformulator / Academic Search failed: {e}")
    return {
        "run_id": run.run_id,
        "reform": run.reform,
        "papers": run.papers,
        "stage": run.stage,
    }


@router.post("/runs/{run_id}/filter")
def filter_papers(run_id: str, body: FilterBody):
    """Stage: Paper Filter (human in the loop)."""
    run = get_run(run_id)
    if len(body.approved_indices) < 2:
        raise HTTPException(400, "Approve at least 2 papers to build a review.")
    pipeline = SamhitaPipeline()
    pipeline.apply_filter(run, body.approved_indices)
    return {"run_id": run.run_id, "approved_count": len(run.approved_papers), "stage": run.stage}


class SynthesizeBody(BaseModel):
    api_key: str | None = None
    model: str | None = None


@router.post("/runs/{run_id}/synthesize")
def synthesize(run_id: str, body: SynthesizeBody):
    """Stages: Reader & Extractor -> Critic & Synthesizer."""
    run = get_run(run_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        pipeline.extract_and_synthesize(run)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Reader & Extractor / Critic & Synthesizer failed: {e}")
    return {
        "run_id": run.run_id,
        "extractions": run.extractions,
        "synthesis": run.synthesis,
        "stage": run.stage,
    }


@router.post("/runs/{run_id}/write")
def write(run_id: str, body: SynthesizeBody):
    """Stage: Writer Agent -> Final Literature Review."""
    run = get_run(run_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        pipeline.write(run)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Writer Agent failed: {e}")
    return {
        "run_id": run.run_id,
        "sections": run.sections,
        "side_modules": pipeline.side_modules(run),
        "stage": run.stage,
    }


@router.post("/runs/{run_id}/evaluate")
def evaluate(run_id: str, body: SynthesizeBody):
    """Open-question module: rubric self-critique of review quality."""
    run = get_run(run_id)
    pipeline = SamhitaPipeline(api_key=body.api_key, model=body.model)
    try:
        result = pipeline.evaluate(run)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Evaluator failed: {e}")
    return {"run_id": run.run_id, "eval_result": result}


@router.get("/runs/{run_id}")
def get_run_state(run_id: str):
    run = get_run(run_id)
    pipeline = SamhitaPipeline()
    return {
        "run_id": run.run_id,
        "topic": run.topic,
        "reform": run.reform,
        "papers": run.papers,
        "approved_papers": run.approved_papers,
        "extractions": run.extractions,
        "synthesis": run.synthesis,
        "sections": run.sections,
        "eval_result": run.eval_result,
        "stage": run.stage,
        "side_modules": pipeline.side_modules(run) if run.synthesis else None,
    }

class PaperChatBody(BaseModel):
    paper_idx: int
    question: str
    history: list[dict] = []
    api_key: str | None = None
    model: str | None = None


@router.post("/runs/{run_id}/chat")
def chat_about_paper(run_id: str, body: PaperChatBody):
    """Answer a question grounded in ONE specific paper from the run."""
    run = get_run(run_id)
    paper = next((p for p in run.approved_papers if p["idx"] == body.paper_idx), None)
    if not paper:
        raise HTTPException(404, "Paper not found in this run.")
    e = next((x for x in run.extractions if x["idx"] == body.paper_idx), {})
    context = (
        f"Title: {paper.get('title','')}\nAuthors: {paper.get('authors','')}\n"
        f"Year: {paper.get('year','')}\nVenue: {paper.get('venue','')}\n"
        f"URL: {paper.get('url','')}\nAbstract: {paper.get('abstract','')}\n"
        f"Method: {e.get('method','')}\nFinding: {e.get('finding','')}\n"
        f"Metrics: {e.get('metrics','')}\nContribution: {e.get('contribution','')}\n"
        f"Limitation: {e.get('limitation','')}\nSummary: {e.get('excerpt','')}\n"
    )
    system = (
        "You are a research assistant answering questions about ONE specific paper. "
        "Use only the paper information provided as context. If the answer isn't in the "
        "provided information, say so plainly and suggest opening the paper link. "
        "Be concise and precise. Never invent findings or numbers."
    )
    convo = ""
    for turn in body.history[-6:]:
        convo += f"\n{turn.get('role','user').upper()}: {turn.get('content','')}"
    user_text = f"Paper context:\n{context}\n{convo}\n\nUSER: {body.question}"
    llm = LLMClient(api_key=body.api_key, model=body.model)
    try:
        answer = llm.call(user_text=user_text, system=system, max_tokens=800)
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(502, f"Paper chat failed: {ex}")
    return {"answer": answer}
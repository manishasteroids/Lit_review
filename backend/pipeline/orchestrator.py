"""
Orchestrator
-------------
Holds the state for one review run and calls agents in the order from the
diagram: reformulate -> search -> [human filter] -> extract -> synthesize
-> write -> evaluate. Each stage is its own method so the API can expose
them one at a time, pausing for the Paper Filter human-in-the-loop step.

State is in-memory only (a dict keyed by run_id) — fine for a single
process / demo. Swap `RUNS` for Redis or Postgres to survive restarts.
"""
import uuid
from dataclasses import dataclass, field
from typing import Optional

from agents.academic_search import AcademicSearchAgent
from agents.critic_synthesizer import CriticSynthesizerAgent
from agents.evaluator import EvaluatorAgent
from agents.paper_filter import PaperFilterAgent
from agents.query_reformulator import QueryReformulator
from agents.reader_extractor import ReaderExtractorAgent
from agents.writer import WriterAgent
from core.config import settings
from core.llm_client import LLMClient
from pipeline.data_analysis import comparison_table, year_distribution
from pipeline.knowledge_graph import build_knowledge_graph


@dataclass
class RunState:
    run_id: str
    topic: str
    reform: Optional[dict] = None
    papers: list[dict] = field(default_factory=list)
    approved_papers: list[dict] = field(default_factory=list)
    extractions: list[dict] = field(default_factory=list)
    synthesis: Optional[dict] = None
    sections: dict = field(default_factory=dict)
    eval_result: Optional[dict] = None
    stage: str = "query"


RUNS: dict[str, RunState] = {}


class SamhitaPipeline:
    """One instance per request; agents are cheap to construct."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        # The pipeline (esp. Academic Search) relies on Anthropic's web-search
        # tool and strict JSON, so it always runs on Claude. If a non-Claude
        # backbone (e.g. Gemini) is selected, fall back to the default Claude
        # model here — the selected model is still used for the paper chat/assess.
        pipeline_model = model
        if model and "gemini" in model.lower():
            pipeline_model = settings.model
        self.llm = LLMClient(api_key=api_key, model=pipeline_model)
        self.reformulator = QueryReformulator(self.llm)
        self.searcher = AcademicSearchAgent(self.llm)
        self.extractor = ReaderExtractorAgent(self.llm)
        self.synthesizer = CriticSynthesizerAgent(self.llm)
        self.writer = WriterAgent(self.llm)
        self.evaluator = EvaluatorAgent(self.llm)

    # ---- stage 1+2: reformulate then search -----------------------------
    def reformulate_and_search(self, topic: str, on_progress=None) -> RunState:
        def emit(step, message, detail=None):
            if on_progress:
                on_progress({"step": step, "message": message, "detail": detail})

        run = RunState(run_id=str(uuid.uuid4()), topic=topic)
        self.llm.run_id = run.run_id  # attribute every call below to this session

        emit("reformulate", "Query Reformulator is analysing your research question…")
        self.llm.stage = "reformulate"
        run.reform = self.reformulator.run(topic)
        queries = run.reform.get("queries", [])
        emit("reformulate", f"Expanded into {len(queries)} search strategies", queries)

        emit("search", "Searching Semantic Scholar…", "semantic_scholar")
        emit("search", "Searching arXiv…", "arxiv")
        emit("search", "Searching PubMed & bioRxiv…", "pubmed")
        self.llm.stage = "search"
        run.papers = self.searcher.run(topic, queries)
        emit("search", f"Found {len(run.papers)} papers — aggregating results…")

        run.stage = "filter"
        RUNS[run.run_id] = run
        return run

    # ---- stage 3: human filter (no LLM call) -----------------------------
    def apply_filter(self, run: RunState, approved_indices: list[int]) -> RunState:
        run.approved_papers = PaperFilterAgent.apply(run.papers, approved_indices)
        run.stage = "extract"
        return run

    # ---- stage 4+5: extract then critique/synthesize/rank ---------------
    def extract_and_synthesize(self, run: RunState) -> RunState:
        self.llm.run_id = run.run_id
        self.llm.stage = "extract"
        run.extractions = self.extractor.run(run.approved_papers)
        self.llm.stage = "synthesize"
        run.synthesis = self.synthesizer.run(run.extractions)
        run.stage = "write"
        return run

    # ---- stage 6: write -----------------------------------------------
    def write(self, run: RunState) -> RunState:
        self.llm.run_id = run.run_id
        self.llm.stage = "write"
        ordered = self._ordered_papers(run)
        extractions_by_idx = {e["idx"]: e for e in run.extractions}
        run.sections = self.writer.run(run.topic, ordered, extractions_by_idx, run.synthesis or {})
        run.stage = "done"
        return run

    # ---- evaluation (open question module) -------------------------------
    def evaluate(self, run: RunState) -> dict:
        self.llm.run_id = run.run_id
        self.llm.stage = "evaluate"
        run.eval_result = self.evaluator.run(
            run.topic, run.sections, len(run.approved_papers)
        )
        return run.eval_result

    # ---- side modules ---------------------------------------------------
    def side_modules(self, run: RunState) -> dict:
        ordered = self._ordered_papers(run)
        extractions_by_idx = {e["idx"]: e for e in run.extractions}
        ranked_by_idx = {
            r["idx"]: r for r in (run.synthesis or {}).get("ranked", [])
        }
        return {
            "knowledge_graph": build_knowledge_graph(run.extractions),
            "year_distribution": year_distribution(run.approved_papers),
            "comparison_table": comparison_table(ordered, extractions_by_idx, ranked_by_idx),
        }

    # ---- helpers ----------------------------------------------------------
    def _ordered_papers(self, run: RunState) -> list[dict]:
        ranked = (run.synthesis or {}).get("ranked", [])
        if ranked:
            by_idx = {p["idx"]: p for p in run.approved_papers}
            ordered = [by_idx[r["idx"]] for r in ranked if r["idx"] in by_idx]
            if ordered:
                return ordered
        return run.approved_papers


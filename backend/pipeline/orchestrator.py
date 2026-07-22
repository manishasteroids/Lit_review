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
    mode: Optional[str] = None      # search mode, so later stages reuse its models
    extract_stats: Optional[dict] = None   # full-text coverage for Deep runs


RUNS: dict[str, RunState] = {}
 
 
class SamhitaPipeline:
    """One instance per request; agents are cheap to construct."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None,
                 mode: Optional[str] = None):
        # A "mode" (lite / systematic / deep) bundles the paper count, model
        # routing, and full-text depth. When given it drives everything; without
        # it we fall back to the model_policy preset (settings.*).
        from core.modes import resolve as _resolve_mode
        self.mode_name = mode
        m = _resolve_mode(mode) if mode else None

        if m:
            fast_m, mid_m, write_m = m["fast"], m["mid"], m["write"]
            self.search_limit = m["search_limit"]
            self.full_text = m["full_text"]
        else:
            pipeline_model = model
            if model and "gemini" in model.lower():
                pipeline_model = settings.model
            if settings.per_purpose_routing:
                fast_m, mid_m = settings.fast_model, settings.mid_model
            else:
                fast_m = mid_m = pipeline_model
            write_m = settings.write_model or pipeline_model
            self.search_limit = settings.search_limit
            self.full_text = False

        self.fast = LLMClient(api_key=api_key, model=fast_m)   # reformulate, search, extract
        self.mid = LLMClient(api_key=api_key, model=mid_m)     # synthesize, evaluate
        self.main = LLMClient(api_key=api_key, model=write_m)  # write
        self._clients = [self.fast, self.mid, self.main]
        self.llm = self.main  # generic handle for anything that still references it

        self.reformulator = QueryReformulator(self.fast)
        self.searcher = AcademicSearchAgent(self.fast)
        self.extractor = ReaderExtractorAgent(self.fast)
        self.synthesizer = CriticSynthesizerAgent(self.mid)
        self.writer = WriterAgent(self.main)
        self.evaluator = EvaluatorAgent(self.mid)

    def _attribute(self, run_id: str) -> None:
        """Tag every per-purpose client with the session id for the usage ledger."""
        for c in self._clients:
            c.run_id = run_id

    # ---- stage 1+2: reformulate then search -----------------------------
    def reformulate_and_search(self, topic: str, on_progress=None) -> RunState:
        def emit(step, message, detail=None):
            if on_progress:
                on_progress({"step": step, "message": message, "detail": detail})

        run = RunState(run_id=str(uuid.uuid4()), topic=topic, mode=self.mode_name)
        self._attribute(run.run_id)  # attribute every call below to this session

        emit("reformulate", "Query Reformulator is analysing your research question…")
        self.fast.stage = "reformulate"
        run.reform = self.reformulator.run(topic)
        queries = run.reform.get("queries", [])
        if on_progress:
            on_progress({"step": "reformulate",
                         "message": "Understood your question — planning the search",
                         "reform": run.reform})
        emit("reformulate", f"Expanded into {len(queries)} search strategies", queries)
 
        emit("search", "Searching Semantic Scholar…", "semantic_scholar")
        emit("search", "Searching arXiv…", "arxiv")
        emit("search", "Searching PubMed & bioRxiv…", "pubmed")
        self.fast.stage = "search"
        run.papers = self.searcher.run(topic, queries, limit=self.search_limit)
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
    def extract_and_synthesize(self, run: RunState, on_progress=None) -> RunState:
        def emit(step, message, detail=None):
            if on_progress:
                on_progress({"step": step, "message": message, "detail": detail})

        self._attribute(run.run_id)
        self.fast.stage = "extract"
        emit("extract", f"Reading {len(run.approved_papers)} papers…")
        run.extractions = self.extractor.run(
            run.approved_papers, full_text=self.full_text, on_progress=on_progress)
        run.extract_stats = self.extractor.full_text_stats
        self.mid.stage = "synthesize"
        emit("synthesize", "Detecting themes, gaps & biases across the papers…")
        run.synthesis = self.synthesizer.run(run.extractions)
        run.stage = "write"
        return run
 
    # ---- stage 6: write -----------------------------------------------
    def write(self, run: RunState) -> RunState:
        self._attribute(run.run_id)
        self.main.stage = "write"
        ordered = self._ordered_papers(run)
        extractions_by_idx = {e["idx"]: e for e in run.extractions}
        run.sections = self.writer.run(run.topic, ordered, extractions_by_idx, run.synthesis or {})
        run.stage = "done"
        return run
 
    # ---- Sources page: add a single paper by hand -----------------------
    def resolve_candidates(self, identifier: str) -> list[dict]:
        """Look up a DOI / PMID / arXiv id / URL / title -> candidate papers."""
        return self.searcher.resolve(identifier)
 
    def add_paper(self, run: RunState, paper: dict) -> dict:
        """Append one resolved paper to the run and extract its fields, reusing
        the same Reader & Extractor used for the initial set. Returns the paper
        (with its new idx) and its extraction."""
        new_idx = max((p.get("idx", -1) for p in run.papers), default=-1) + 1
        paper = dict(paper)
        paper["idx"] = new_idx
        paper.setdefault("source", paper.get("source") or "manual")
        run.papers.append(paper)
        if not any(p.get("idx") == new_idx for p in run.approved_papers):
            run.approved_papers.append(paper)
 
        self.llm.run_id = run.run_id
        self.llm.stage = "extract"
        ext = None
        try:
            for e in (self.extractor.run([paper]) or []):
                e["idx"] = new_idx
                ext = e
        except Exception:
            ext = None
        if ext:
            # replace any stale extraction for this idx, then append
            run.extractions = [e for e in run.extractions if e.get("idx") != new_idx]
            run.extractions.append(ext)
        return {"paper": paper, "extraction": ext}
 
    def reanalyze(self, run: RunState, included_indices: list[int]) -> RunState:
        """Recompute synthesis/ranking (and, via side_modules, the KG + data
        analysis) for a changed source set — WITHOUT re-searching or
        re-extracting. Clears the draft review so it must be regenerated."""
        inc = set(included_indices)
        run.approved_papers = [p for p in run.papers if p.get("idx") in inc]
        included_exts = [e for e in run.extractions if e.get("idx") in inc]
        self.llm.run_id = run.run_id
        self.llm.stage = "synthesize"
        run.synthesis = self.synthesizer.run(included_exts)
        run.sections = {}          # draft literature review is now outdated
        run.stage = "done"
        return run
 
    # ---- evaluation (open question module) -------------------------------
    def evaluate(self, run: RunState) -> dict:
        self._attribute(run.run_id)
        self.mid.stage = "evaluate"
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
            "knowledge_graph": build_knowledge_graph(
                [e for e in run.extractions
                 if e.get("idx") in {p.get("idx") for p in run.approved_papers}]
            ),
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
 
"""
Reader & Extractor
--------------------
Diagram node: "Parses full text, extracts key info"
 
Pulls structured signal (method, finding, dataset, limitation, concept tags)
out of each approved paper. Currently reads from title + abstract; the
natural upgrade is to fetch and pass in full text (see note at the bottom).
 
Robustness: papers are extracted in small batches so no single model response
is large enough to truncate, and each batch is parsed defensively — if the JSON
comes back malformed, we salvage whatever complete records we can instead of
failing the whole stage.
"""
import json
import re
 
from agents.base import Agent
 
BATCH_SIZE = 5          # keep each response well under the token budget
MAX_TOKENS = 3000
 
 
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
            '"excerpt":"a 2-3 sentence summary of what this paper does and shows, in your own words",'
            '"relevance":"one sentence on why this paper matters to the review topic",'
            '"concepts":[2-3 short concept tags]}]. '
            "Keep every field grounded in the provided text; use \"n/a\" if truly unknown."
        )
 
    def run(self, approved_papers: list[dict]) -> list[dict]:
        results: list[dict] = []
        batches = [approved_papers[i:i + BATCH_SIZE]
                   for i in range(0, len(approved_papers), BATCH_SIZE)]
        for batch in batches:
            results.extend(self._extract_batch(batch))
        return results
 
    def _extract_batch(self, papers: list[dict]) -> list[dict]:
        corpus = "\n".join(
            f"[#{p['idx']}] {p['title']} ({p.get('year', '?')}). {p.get('abstract', '')}"
            for p in papers
        )
        try:
            out = self.llm.call(user_text=f"Papers:\n{corpus}", system=self.SYSTEM,
                                max_tokens=MAX_TOKENS)
        except Exception:
            return []
        return _parse_records(out)
 
 
def _parse_records(out: str) -> list[dict]:
    """Parse the model's JSON array, tolerating truncation/markdown by
    salvaging every complete {...} record it can find."""
    # 1. Try the clean path (shared helper strips code fences etc.).
    try:
        from core.llm_client import LLMClient
        data = LLMClient.parse_json(out)
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict)]
        if isinstance(data, dict):
            return [data]
    except Exception:
        pass
    # 2. Salvage: individual objects. Extraction records contain no nested
    #    braces (concepts is a [] array), so a non-greedy {...} scan is safe.
    records = []
    for m in re.finditer(r"\{[^{}]*\}", out):
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict) and "idx" in obj:
                records.append(obj)
        except Exception:
            continue
    return records
 
 
# To extract from full text instead of abstracts: fetch the PDF/HTML for
# each paper's url, run it through the pdf-reading toolchain to get plain
# text, and pass that text in place of `p.get("abstract", "")` above —
# the JSON contract for the agent's output doesn't need to change.
 
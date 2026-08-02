"""
Query Reformulator
-------------------
Diagram node: "Expands & refines search terms"

Takes the user's raw research question and turns it into search-engine-ready
queries plus a one-line statement of what the eventual review should cover.

Also classifies the topic's research domain (currently just "biomedical" vs
"other"). This rides along on the same free/cheap Gemini Flash call that
already runs for every search — no extra call, no extra latency — and is the
routing signal for the pre-indexed corpus: a "biomedical" topic can check the
local pre-indexed index first (fast); anything else goes straight to live
search exactly as today.
"""
from agents.base import Agent
from core.domain_classifier import normalize_domain


class QueryReformulator(Agent):
    name = "query_reformulator"

    SYSTEM = (
        "You are a query-reformulation agent for an academic literature search. "
        "Given a research topic, expand it into precise search queries and key terms, and "
        "classify its research domain. "
        'Respond ONLY with JSON, no markdown: {"queries":[3-4 search-engine-ready query '
        'strings],"terms":[6-8 key technical terms/synonyms],"scope":"one sentence on what '
        'a review of this should cover","domain":"biomedical or other — use \\"biomedical\\" '
        'for anything in medicine, biology, genetics, pharmacology, clinical research, '
        'biotech or life sciences; otherwise \\"other\\""}.'
    )

    def run(self, topic: str) -> dict:
        out = self.llm.call(user_text=f"Research topic: {topic}", system=self.SYSTEM)
        data = self.llm.parse_json(out)
        # Trust the model's classification if valid; fall back to a free
        # keyword check (core/domain_classifier.py) if it's missing/malformed
        # rather than letting a bad field silently break routing downstream.
        data["domain"] = normalize_domain(
            data.get("domain"), topic, data.get("scope", ""), " ".join(data.get("terms") or [])
        )
        return data

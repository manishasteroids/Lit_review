"""
Query Reformulator
-------------------
Diagram node: "Expands & refines search terms"

Takes the user's raw research question and turns it into search-engine-ready
queries plus a one-line statement of what the eventual review should cover.
"""
from agents.base import Agent


class QueryReformulator(Agent):
    name = "query_reformulator"

    SYSTEM = (
        "You are a query-reformulation agent for an academic literature search. "
        "Given a research topic, expand it into precise search queries and key terms. "
        'Respond ONLY with JSON, no markdown: {"queries":[3-4 search-engine-ready query '
        'strings],"terms":[6-8 key technical terms/synonyms],"scope":"one sentence on what '
        'a review of this should cover"}.'
    )

    def run(self, topic: str) -> dict:
        out = self.llm.call(user_text=f"Research topic: {topic}", system=self.SYSTEM)
        return self.llm.parse_json(out)

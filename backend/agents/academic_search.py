"""
Academic Search Agent
----------------------
Diagram node: "Semantic Scholar · arXiv · PubMed"

Uses Claude's web_search tool to find real papers. Swap this implementation
for direct Semantic Scholar / arXiv / PubMed API clients if you want results
independent of whichever search index the model's tool happens to hit —
see the docstring at the bottom for the seam to do that.
"""
from agents.base import Agent


class AcademicSearchAgent(Agent):
    name = "academic_search"

    def run(self, topic: str, queries: list[str]) -> list[dict]:
        user_text = (
            "Search the web for real, recent academic papers on this topic, preferring "
            "arXiv, PubMed, bioRxiv and Semantic Scholar. Topic: " + topic + ". "
            "Use these queries: " + " | ".join(queries) + ". "
            "Find 6 distinct, real papers. Then respond with ONLY a JSON array (no prose, "
            'no markdown) of objects: {"title","authors":"First Author et al.","year":number,'
            '"venue","url","abstract":"2-sentence summary of contribution"}. '
            "Only include papers you actually found in the search results."
        )
        out = self.llm.call(
            user_text=user_text,
            tools=[{"type": "web_search_20250305", "name": "web_search"}],
            max_tokens=1800,
        )
        data = self.llm.parse_json(out)
        papers = data if isinstance(data, list) else data.get("papers", [])
        for i, p in enumerate(papers):
            p["idx"] = i
        return papers


# --- Alternative implementation seam -----------------------------------
# To use the real arXiv API instead of the model's web_search tool (e.g. if
# your Anthropic key doesn't have web search enabled), replace `run` above
# with calls to https://export.arxiv.org/api/query, parse the Atom feed,
# and map entries onto the same {"idx","title","authors","year","venue",
# "url","abstract"} shape so nothing downstream has to change.

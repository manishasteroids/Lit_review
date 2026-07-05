"""
Paper Filter
-------------
Diagram node: "Users filter/approve papers from search results"

This is the human-in-the-loop checkpoint — deliberately not an LLM call.
The frontend shows the search results, the person checks/unchecks papers,
and this function just applies that decision before anything downstream
spends tokens on a source nobody wanted.
"""


class PaperFilterAgent:
    name = "paper_filter"

    @staticmethod
    def apply(papers: list[dict], approved_indices: list[int]) -> list[dict]:
        approved = set(approved_indices)
        return [p for p in papers if p["idx"] in approved]

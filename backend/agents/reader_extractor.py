"""
Reader & Extractor
--------------------
Diagram node: "Parses full text, extracts key info"

Pulls structured signal (method, finding, dataset, limitation, concept tags)
out of each approved paper. Currently reads from title + abstract; the
natural upgrade is to fetch and pass in full text (see note at the bottom).
"""
from agents.base import Agent


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
        corpus = "\n".join(
            f"[#{p['idx']}] {p['title']} ({p.get('year', '?')}). {p.get('abstract', '')}"
            for p in approved_papers
        )
        out = self.llm.call(user_text=f"Papers:\n{corpus}", system=self.SYSTEM, max_tokens=2500)
        return self.llm.parse_json(out)


# To extract from full text instead of abstracts: fetch the PDF/HTML for
# each paper's url, run it through the pdf-reading toolchain to get plain
# text, and pass that text in place of `p.get("abstract", "")` above —
# the JSON contract for the agent's output doesn't need to change.

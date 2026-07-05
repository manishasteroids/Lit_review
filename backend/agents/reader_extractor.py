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
        "its title and summary. Respond ONLY with a JSON array (no markdown): "
        '[{"idx":number,"method":"approach in <=10 words","finding":"key result in <=14 '
        'words","data":"dataset/system or n/a","limitation":"one limitation","concepts":'
        '[2-3 short concept tags]}].'
    )

    def run(self, approved_papers: list[dict]) -> list[dict]:
        corpus = "\n".join(
            f"[#{p['idx']}] {p['title']} ({p.get('year', '?')}). {p.get('abstract', '')}"
            for p in approved_papers
        )
        out = self.llm.call(user_text=f"Papers:\n{corpus}", system=self.SYSTEM)
        return self.llm.parse_json(out)


# To extract from full text instead of abstracts: fetch the PDF/HTML for
# each paper's url, run it through the pdf-reading toolchain to get plain
# text, and pass that text in place of `p.get("abstract", "")` above —
# the JSON contract for the agent's output doesn't need to change.

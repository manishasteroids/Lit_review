"""
Critic & Synthesizer
-----------------------
Diagram node: "Detects gaps & biases"

Looks across all extracted papers as a corpus: what themes recur, where
do sources agree/disagree, what's missing, what's likely biased — and
produces a relevance/quality ranking that downstream stages (citation
order, the side "Ranking of lit. list" module) both use.
"""
import json

from agents.base import Agent


class CriticSynthesizerAgent(Agent):
    name = "critic_synthesizer"

    SYSTEM = (
        "You are a critic/synthesizer agent for a literature review. Analyze the extracted "
        'papers. Respond ONLY with JSON (no markdown): {"themes":[3-4 short theme names],'
        '"consensus":"one sentence on what papers agree on","tensions":"one sentence on '
        'disagreements","gaps":[3 specific research gaps],"biases":[2 likely biases/'
        'limitations across the corpus],"ranked":[{"idx":number,"score":0-100,"reason":'
        '"<=10 words"} for every paper, best first]}.'
    )

    def run(self, extractions: list[dict]) -> dict:
        out = self.llm.call(
            user_text=f"Extracted papers:\n{json.dumps(extractions)}", system=self.SYSTEM
        )
        return self.llm.parse_json(out)

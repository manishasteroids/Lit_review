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
        # The `ranked` array holds one entry PER paper, so the output budget
        # must scale with the corpus size — otherwise a large shortlist (e.g.
        # 50 papers) truncates the JSON mid-array and parsing fails.
        n = len(extractions)
        max_tokens = min(8000, 1000 + 70 * n)
        # Send only the fields needed to find themes/gaps and rank — not the
        # full excerpt/contribution/relevance prose. Roughly halves the input.
        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        try:
            out = self.llm.call(
                user_text=f"Extracted papers:\n{json.dumps(compact)}",
                system=self.SYSTEM,
                max_tokens=max_tokens,
            )
            return self.llm.parse_json(out)
        except Exception:
            # Degrade gracefully instead of hard-failing the whole pipeline:
            # rank every paper equally so downstream citation order still works.
            return {
                "themes": [], "consensus": "", "tensions": "",
                "gaps": [], "biases": [],
                "ranked": [{"idx": e.get("idx"), "score": 50, "reason": ""} for e in extractions],
            }

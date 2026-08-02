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

    # Deep mode's extractions carry real detail (see reader_extractor.DEEP_SYSTEM)
    # — synthesizing from the same 4-field compact view as Medium would throw
    # that away right before the Writer needs it. Deep gets more input fields
    # and a bigger, more substantive output budget.
    DEEP_SYSTEM = (
        "You are a critic/synthesizer agent doing a DEEP analysis of extracted papers for a "
        "systematic literature review — you have detailed methods, findings, metrics and "
        "contributions for each paper, not just short summaries. Use that detail. "
        'Respond ONLY with JSON (no markdown): {"themes":[4-6 theme names, each with enough '
        'specificity to distinguish it from the others],"consensus":"2-3 sentences on what the '
        'papers agree on, citing specific methods/findings","tensions":"2-3 sentences on where '
        'papers disagree or use conflicting methods/metrics","gaps":[4-5 specific, substantive '
        'research gaps grounded in what the corpus does and doesn\'t cover],"biases":[3 likely '
        'biases/limitations across the corpus, e.g. dataset skew, methodological blind spots],'
        '"ranked":[{"idx":number,"score":0-100,"reason":"<=16 words, specific"} for every paper, '
        "best first]}."
    )

    def run(self, extractions: list[dict], deep: bool = False) -> dict:
        # The `ranked` array holds one entry PER paper, so the output budget
        # must scale with the corpus size — otherwise a large shortlist (e.g.
        # 50 papers) truncates the JSON mid-array and parsing fails.
        n = len(extractions)
        base_budget = 1600 if deep else 1000
        per_paper = 90 if deep else 70
        max_tokens = min(8000, base_budget + per_paper * n)

        if deep:
            # Full detail — this is the whole point of Deep mode's richer
            # extraction; Medium keeps the compact view to stay cheap.
            fields = ("idx", "method", "finding", "data", "metrics", "limitation",
                      "contribution", "concepts")
        else:
            fields = ("idx", "method", "finding", "limitation", "concepts")
        compact = [{k: e.get(k) for k in fields} for e in extractions]

        try:
            out = self.llm.call(
                user_text=f"Extracted papers:\n{json.dumps(compact)}",
                system=self.DEEP_SYSTEM if deep else self.SYSTEM,
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

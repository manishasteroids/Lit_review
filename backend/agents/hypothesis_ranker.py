"""
Hypothesis Ranker
------------------
Diagram node: "Head-to-head match in the ranking bracket"

New in the "best-outcome" Hypothesis Agent pipeline (hypothesis_agent_architecture.md
SS5, Fig. 4) -- Methods (the Sift-embedded panel) never calls this; it's used only
by the standalone Hypothesis Agent tool once the cap is raised above 2, where a
larger field of genuinely distinct hypotheses needs to be narrowed down to one
recommendation instead of just listing all of them with scores.

Deliberately a comparative judgment, not a repeat of the Critic's per-hypothesis
rubric: HypothesisCriticAgent scores each hypothesis in isolation (novelty,
grounding, testability, consistency). This agent's only job is a single
head-to-head call -- given two hypotheses (plus their own critique scores/issues
as context, not as the deciding factor) -- pick which one is the stronger bet for
this specific research topic, and say why. Called once per bracket match by
hypothesis_agent/pipeline.py's tournament orchestration, not once per run.
"""
import json

from agents.base import Agent


class HypothesisRankerAgent(Agent):
    name = "hypothesis_ranker"

    SYSTEM = (
        "You are judging a head-to-head match between two research hypotheses "
        "for the same topic, in a single-elimination ranking bracket. You are "
        "given each hypothesis's own experiment plan and the Critic's per-axis "
        "scores (novelty/grounding/testability/consistency) as context -- but "
        "your job is a comparative judgment, not just picking the higher raw "
        "score. Weigh which hypothesis is the better bet to actually pursue: "
        "genuine novelty beyond restating the literature, real grounding in the "
        "cited papers (not invented benchmarks), a concrete and runnable "
        "protocol, and a proposed method that actually tests its own claim. "
        "When the two are close, prefer the one more clearly grounded in a "
        "structural gap in this corpus over one that is merely plausible. "
        "Never call it a tie -- pick one, even when both are weak or both are "
        "strong. "
        'Respond ONLY with JSON (no markdown): {"winner":"a" or "b",'
        '"reason":"1-2 sentences on what specifically decided it, referencing '
        'the actual hypotheses (not just their scores)"}'
    )

    def run(self, topic: str, hyp_a: dict, critique_a: dict | None,
            hyp_b: dict, critique_b: dict | None,
            extractions: list[dict]) -> dict:
        """One match: returns {"winner": "a"|"b", "reason": str}. Defaults to
        "a" on any failure -- a bracket match must always produce a winner so
        the tournament can keep progressing; a coin-flip default on a rare
        parse failure is far less disruptive than aborting the whole run."""
        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Hypothesis A:\n{json.dumps(hyp_a)}\n"
                    f"Critic's scores for A:\n{json.dumps(critique_a or {})}\n\n"
                    f"Hypothesis B:\n{json.dumps(hyp_b)}\n"
                    f"Critic's scores for B:\n{json.dumps(critique_b or {})}\n\n"
                    f"Papers (cite by idx):\n{json.dumps(compact)}"
                ),
                system=self.SYSTEM,
                max_tokens=500,
                # Low temperature: a comparative judgment on fixed content,
                # not creative generation -- the same pair of hypotheses
                # should tend to produce the same winner on a re-run, since
                # this call decides who advances in the bracket.
                temperature=0.0,
            )
            result = self.llm.parse_json(out)
            if isinstance(result, dict) and result.get("winner") in ("a", "b"):
                return result
            return {"winner": "a", "reason": "Could not parse a clear judgment — defaulted to A."}
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"winner": "a", "reason": f"Ranker error, defaulted to A: {e}"}

"""
Hypothesis Results Check
--------------------------
Diagram node: "Check a hypothesis against results YOU actually ran"

The plausibility check (agents/hypothesis_plausibility.py) is a one-shot,
literature-only sanity check that runs automatically as part of the
pipeline. This agent is its human-in-the-loop counterpart: it only runs
when a researcher comes back with REAL results from actually running (some
version of) the proposed experiment, and asks a different, stronger
question -- not "is the target plausible given the literature" but "given
what you actually observed, was the hypothesis right?"

Three things happen in one call:
  1. A verdict on whether the supplied results support, refute, partially
     support, or are too incomplete to judge the hypothesis.
  2. A plain assessment explaining that verdict against the hypothesis's
     specific claim and metrics -- not a generic reaction to the numbers.
  3. Where the hypothesis wasn't fully supported, a REVISED hypothesis (same
     JSON shape agents/experiment_designer.py produces) that accounts for
     what was actually observed -- e.g. a corrected target, a changed setup
     to isolate what actually moved the result, a new risk noting the
     specific failure mode found. If the hypothesis was fully supported,
     `refined_hypothesis` is null -- there's nothing to change.

This agent never writes to a saved run itself -- api/hypothesis_routes.py's
/check-results endpoint calls it and appends the result to that run's
`data.user_validations` list; a separate /apply-refinement endpoint is what
actually swaps a hypothesis's text for `refined_hypothesis`, and only when
a person explicitly asks for that (never automatic). This is the
"human-in-the-loop refinement" path discussed but deliberately deferred
earlier in this tool's build -- this is that path, scoped to the one form
of human input the standalone Hypothesis Agent tool doesn't already have
robustly today: real experimental results, as opposed to a critique
objection (which agents/experiment_designer.py's respond_to_challenge
already handles, for Methods).
"""
import json

from agents.base import Agent


class HypothesisResultsCheckAgent(Agent):
    name = "hypothesis_results_check"

    SYSTEM = (
        "A researcher ran (a version of) a proposed experiment and is reporting "
        "back real results. You are given the hypothesis's specific claim, its "
        "experiment plan (setup, variables, metrics with any target), and the "
        "researcher's own description of what they actually observed. Judge "
        "honestly whether those results support, refute, or only partially "
        "support the hypothesis -- do not default to being agreeable, and do "
        "not assume the results are clean or complete if the researcher's "
        "description doesn't establish that. If the results don't say enough "
        "to judge (e.g. missing the specific metric the hypothesis was about), "
        "say so as \"inconclusive\" rather than guessing. "
        "Then, UNLESS the hypothesis was fully supported with no caveats, "
        "propose a revised hypothesis that accounts for what was actually "
        "observed -- change the actual substance (a corrected target, a "
        "changed setup that isolates what really drove the result, a new risk "
        "naming the specific failure mode found), not just the wording. Stay "
        "grounded: any approach/baseline must trace to a real paper idx from "
        "the extractions given, or be marked evidenced:false as a proposal. "
        "Never invent a benchmark, dataset, or citation. "
        'Respond ONLY with JSON (no markdown): {"verdict":"supported" or '
        '"refuted" or "partially_supported" or "inconclusive","assessment":'
        '"2-4 sentences, specific to the hypothesis\'s own claim and metrics, '
        'not a generic reaction to the numbers","refined_hypothesis":'
        '{"hypothesis":"...","rationale":"...","approaches":[{"name":"...",'
        '"from_idx":<idx or null>,"evidenced":bool}],"setup":"...","variables":'
        '{"independent":"...","dependent":"...","controlled":"..."},"metrics":'
        '[{"name":"...","unit":"...","target":"..."}],"baselines":[{"name":"...",'
        '"from_idx":<idx or null>}],"failure_modes":["..."],"validation":"...",'
        '"risks":"..."} or null if the hypothesis was fully supported,'
        '"refinement_note":"one sentence: why revised, or why no change was '
        'needed"}'
    )

    def run(self, topic: str, hypothesis: dict, results_text: str,
            extractions: list[dict]) -> dict:
        """Returns {"verdict": "supported"|"refuted"|"partially_supported"|
        "inconclusive", "assessment": str, "refined_hypothesis": dict|None,
        "refinement_note": str}. Never raises -- a failure still returns a
        usable dict so a bad call doesn't lose the researcher's own results
        text, which the caller persists regardless of this agent's outcome."""
        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Hypothesis under test:\n{json.dumps(hypothesis)}\n\n"
                    f"Researcher's reported results:\n{results_text}\n\n"
                    f"Papers this hypothesis was grounded in (cite by idx):\n"
                    f"{json.dumps(compact)}"
                ),
                system=self.SYSTEM,
                max_tokens=1800,
                # Low temperature, same rationale as the other judging
                # agents (Critic/Ranker/Meta-Review/Plausibility) -- this is
                # a verdict against given results, not creative generation.
                temperature=0.0,
            )
            result = self.llm.parse_json(out)
            if isinstance(result, dict) and result.get("verdict") in (
                "supported", "refuted", "partially_supported", "inconclusive"
            ):
                result.setdefault("refined_hypothesis", None)
                result.setdefault("refinement_note", "")
                return result
            return {
                "verdict": "inconclusive",
                "assessment": "Could not parse a verdict from the model's response.",
                "refined_hypothesis": None,
                "refinement_note": "",
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {
                "verdict": "inconclusive",
                "assessment": f"Results check error: {e}",
                "refined_hypothesis": None,
                "refinement_note": "",
            }

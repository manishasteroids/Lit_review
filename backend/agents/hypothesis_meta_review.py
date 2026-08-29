"""
Hypothesis Meta-Reviewer
-------------------------
Diagram node: "Final recommendation after the ranking bracket"

New in the "best-outcome" Hypothesis Agent pipeline (hypothesis_agent_architecture.md
SS5) -- the closing step after the ranking bracket (agents/hypothesis_ranker.py)
has produced a champion. Distinct from both the Designer (proposes) and the
Critic (scores each hypothesis alone): this agent looks at the champion AND the
runner-up together and writes the actual research recommendation a person would
read -- why the champion won, what would make the runner-up worth revisiting
instead, and what to watch out for before actually running the champion's
experiment. Methods (the Sift-embedded panel, cap=2, no bracket) never reaches
this stage; it only runs when the Hypothesis Agent tool's bracket has a real
champion + runner-up to compare.
"""
import json

from agents.base import Agent


class HypothesisMetaReviewAgent(Agent):
    name = "hypothesis_meta_review"

    SYSTEM = (
        "You are writing the closing recommendation after a bracket of "
        "candidate research hypotheses has been narrowed down to a champion "
        "and a runner-up (the hypothesis it beat in the final match). Someone "
        "deciding what to actually work on next will read only this. Be "
        "concrete and specific to these two hypotheses -- never generic "
        "advice that could apply to any pair. "
        'Respond ONLY with JSON (no markdown): {"recommendation":"1-2 '
        'sentences: which to pursue and the concrete next step",'
        '"why_champion_won":"1-2 sentences specific to these two hypotheses, '
        'not a restatement of scores","when_to_reconsider_runner_up":"one '
        'sentence: what finding or constraint would make the runner-up the '
        'better bet instead","caveats":["1-3 short, concrete things to watch '
        'out for before running the champion'
        '\'s experiment"],"confidence":0-100}'
    )

    # hypothesis_agent_architecture.md §6.2 -- the Meta-Review side of the
    # argument/dispute flow. Mirrors ExperimentDesignerAgent.respond_to_challenge's
    # shape (stance defended/revised, never "agree to be agreeable") but
    # applied to the CLOSING RECOMMENDATION rather than a hypothesis's own
    # design -- a researcher arguing "I don't think the champion is right,"
    # not "this hypothesis's setup is wrong." Deliberately does not touch the
    # bracket's match history (§6.3: applying a revision only swaps the
    # recommendation and, if the objection wins, which hypothesis is
    # preferred -- disputing an individual bracket match is a separate,
    # deferred mechanism, §6.1).
    DISPUTE_SYSTEM = (
        "A researcher is pushing back on your closing recommendation for "
        "which hypothesis to pursue, with a specific objection. Take the "
        "objection seriously and do exactly one of two things: (1) if it's "
        "valid, REVISE the recommendation -- this can mean recommending the "
        "runner-up instead of the champion, or keeping the same champion but "
        "with a materially different rationale/caveats that actually "
        "addresses what they raised, not just reworded; or (2) if the "
        "recommendation holds up despite it, DEFEND it with a specific "
        "counter-reason that engages with what they actually said. Never "
        "just agree to be agreeable, and never defend without a concrete "
        "counter-reason. "
        'Respond ONLY with JSON (no markdown): {"stance":"revised" or '
        '"defended","response":"2-4 sentences directly addressing their '
        'objection","prefer":"champion" or "runner_up",'
        '"recommendation":{"recommendation":"1-2 sentences: which to pursue '
        'and the concrete next step","why_champion_won":"1-2 sentences",'
        '"when_to_reconsider_runner_up":"one sentence","caveats":["1-3 short '
        'items"],"confidence":0-100}} (recommendation is UNCHANGED from the '
        'current one if stance is "defended"; "prefer" is "champion" unless '
        'you are revising to recommend the runner-up instead)'
    )

    def dispute(self, topic: str, champion: dict, champion_critique: dict | None,
                runner_up: dict, runner_up_critique: dict | None,
                bracket_history: list[dict], current_recommendation: dict,
                objection: str, extractions: list[dict]) -> dict:
        """Returns {"stance": "revised"|"defended", "response": str,
        "prefer": "champion"|"runner_up", "recommendation": dict (same shape
        as run()'s return)}. Never raises -- a failed dispute call defends
        the current recommendation unchanged rather than losing it."""
        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Champion hypothesis:\n{json.dumps(champion)}\n"
                    f"Champion's critic scores:\n{json.dumps(champion_critique or {})}\n\n"
                    f"Runner-up hypothesis (lost the final match):\n{json.dumps(runner_up)}\n"
                    f"Runner-up's critic scores:\n{json.dumps(runner_up_critique or {})}\n\n"
                    f"Bracket match history:\n{json.dumps(bracket_history)}\n\n"
                    f"Current recommendation:\n{json.dumps(current_recommendation)}\n\n"
                    f"Researcher's objection:\n{objection}\n\n"
                    f"Papers (cite by idx):\n{json.dumps(compact)}"
                ),
                system=self.DISPUTE_SYSTEM,
                max_tokens=900,
                # Same rationale as run()'s temperature=0.0 -- a dispute
                # verdict should be stable given the same objection, not a
                # second independent source of run-to-run variance.
                temperature=0.0,
            )
            result = self.llm.parse_json(out)
            if (isinstance(result, dict) and result.get("stance") in ("revised", "defended")
                    and isinstance(result.get("recommendation"), dict)):
                result.setdefault("prefer", "champion")
                if result["prefer"] not in ("champion", "runner_up"):
                    result["prefer"] = "champion"
                return result
            return {
                "stance": "defended", "prefer": "champion",
                "response": "Could not process the objection — no change made.",
                "recommendation": current_recommendation,
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {
                "stance": "defended", "prefer": "champion",
                "response": f"Error handling objection: {e}",
                "recommendation": current_recommendation,
            }

    def run(self, topic: str, champion: dict, champion_critique: dict | None,
            runner_up: dict, runner_up_critique: dict | None,
            bracket_history: list[dict], extractions: list[dict]) -> dict:
        """Returns the closing recommendation dict (schema above), or a safe
        fallback noting the failure -- a failed meta-review must never hide
        the champion the bracket already produced."""
        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Champion hypothesis:\n{json.dumps(champion)}\n"
                    f"Champion's critic scores:\n{json.dumps(champion_critique or {})}\n\n"
                    f"Runner-up hypothesis (lost the final match):\n{json.dumps(runner_up)}\n"
                    f"Runner-up's critic scores:\n{json.dumps(runner_up_critique or {})}\n\n"
                    f"Bracket match history (reasons for each result):\n{json.dumps(bracket_history)}\n\n"
                    f"Papers (cite by idx):\n{json.dumps(compact)}"
                ),
                system=self.SYSTEM,
                max_tokens=800,
                # Low temperature: writing up the already-decided champion,
                # not deciding it -- the closing recommendation shouldn't
                # itself become a second source of run-to-run variance.
                temperature=0.0,
            )
            result = self.llm.parse_json(out)
            if isinstance(result, dict) and result.get("recommendation"):
                return result
            return {
                "recommendation": "Meta-review could not be parsed — see the champion hypothesis above.",
                "why_champion_won": "", "when_to_reconsider_runner_up": "",
                "caveats": [], "confidence": None,
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {
                "recommendation": f"Meta-review failed ({e}) — see the champion hypothesis above.",
                "why_champion_won": "", "when_to_reconsider_runner_up": "",
                "caveats": [], "confidence": None,
            }

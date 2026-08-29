"""
Hypothesis Plausibility Check
------------------------------
Diagram node: "Literature-grounded empirical plausibility check"

New in the Hypothesis Agent's best-outcome pipeline -- a form of "empirical
validation" that's actually feasible here: this tool has no dataset or code
execution to run the champion hypothesis against, but it DOES have real
quantitative results already sitting in this run's own extractions
(agents/reader_extractor.py's "metrics" and "finding" fields -- AUROC,
accuracy, sample sizes, effect sizes, whatever the source papers reported).
So instead of running anything, this agent asks a narrower, checkable
question: given what SIMILAR methods in this corpus actually achieved, is
the champion hypothesis's own claimed metric target plausible, or does it
imply an improvement nothing in the literature comes close to supporting?

This is deliberately NOT a correctness check on the hypothesis itself (the
Critic already scores novelty/grounding/testability/consistency) and NOT a
search for prior art (hypothesis_novelty.py already does that against the
broader literature). It's narrower still: a sanity check on the NUMBERS —
"is this target realistic given what's actually been reported" — using only
data already in hand, so it costs one more LLM call, not another search.

Runs ONCE, on the champion hypothesis only (after the bracket + Meta-Review
have picked one) -- checking every hypothesis this way would be expensive
for no benefit, since only the champion is actually being recommended.

Verdicts:
  - plausible       the target is in line with, or a modest step past,
                     what comparable methods in the corpus reported
  - optimistic       the target is meaningfully beyond anything reported
                     here; achievable in principle, but would need real
                     justification beyond "the hypothesis says so"
  - unsupported      nothing in this corpus reports comparable numbers to
                     judge the target against at all
  - not_applicable   the hypothesis's own metrics don't specify a numeric
                     target to check in the first place (short-circuited
                     before any LLM call -- see below)
"""
import json

from agents.base import Agent


class HypothesisPlausibilityAgent(Agent):
    name = "hypothesis_plausibility"

    SYSTEM = (
        "You are a skeptical quantitative reviewer. You are given ONE research "
        "hypothesis's experiment plan (including its proposed metrics and, where "
        "stated, numeric targets) and a set of papers from the literature review "
        "it was generated from, each with what it actually reported (method, "
        "finding, quantitative metrics). Your job is narrow: judge whether the "
        "hypothesis's claimed target(s) are empirically plausible GIVEN WHAT "
        "SIMILAR METHODS IN THIS CORPUS ACTUALLY ACHIEVED — not whether the "
        "hypothesis is well-designed (that's judged elsewhere) and not whether "
        "it's novel (also judged elsewhere). If a comparable paper reports "
        "AUROC 0.81 and the hypothesis targets AUROC 0.83, that's a modest, "
        "plausible step. If nothing comparable reports above 0.81 and the "
        "hypothesis targets 0.95, that's optimistic and should be flagged as "
        "such, specifically and with the comparison that makes it clear. If no "
        "paper in the corpus reports numbers on a comparable metric at all, say "
        "so honestly rather than fabricating a comparison. "
        'Respond ONLY with JSON (no markdown): {"verdict":"plausible" or '
        '"optimistic" or "unsupported","reasoning":"2-3 sentences, cite specific '
        'idx numbers for any comparison you make","comparable_findings":['
        '{"idx":<paper idx>,"note":"what that paper actually reported, relevant '
        'to this comparison"}]}'
    )

    def run(self, topic: str, hypothesis: dict, extractions: list[dict]) -> dict:
        """Returns {"verdict": "plausible"|"optimistic"|"unsupported"|
        "not_applicable", "reasoning": str, "comparable_findings": list[dict]}.
        Short-circuits to "not_applicable" without an LLM call when the
        hypothesis's own metrics carry no numeric target to check in the
        first place — there's nothing to judge plausibility of."""
        metrics = hypothesis.get("metrics") or []
        has_target = any((m.get("target") or "").strip() for m in metrics if isinstance(m, dict))
        if not has_target:
            return {
                "verdict": "not_applicable",
                "reasoning": "This hypothesis's experiment plan doesn't specify a "
                             "numeric target to check against the literature.",
                "comparable_findings": [],
            }

        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "metrics", "limitation")}
            for e in extractions
        ]
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Champion hypothesis's experiment plan:\n"
                    f"{json.dumps({'hypothesis': hypothesis.get('hypothesis'), 'setup': hypothesis.get('setup'), 'metrics': metrics, 'baselines': hypothesis.get('baselines')})}\n\n"
                    f"Papers from this review, with what they actually reported "
                    f"(cite by idx):\n{json.dumps(compact)}"
                ),
                system=self.SYSTEM,
                max_tokens=600,
                # Low temperature: a verdict against fixed literature data,
                # not creative generation -- should be stable on a re-run.
                temperature=0.0,
            )
            result = self.llm.parse_json(out)
            if isinstance(result, dict) and result.get("verdict") in (
                "plausible", "optimistic", "unsupported"
            ):
                result.setdefault("comparable_findings", [])
                return result
            return {
                "verdict": "unsupported",
                "reasoning": "Could not parse a plausibility verdict.",
                "comparable_findings": [],
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {
                "verdict": "unsupported",
                "reasoning": f"Plausibility check error: {e}",
                "comparable_findings": [],
            }

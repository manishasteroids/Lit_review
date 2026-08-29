"""
Hypothesis Critic
------------------
Diagram node: "Recursively evaluates & scores generated hypotheses"

Sibling to evaluator.py (which scores literature-review QUALITY) — this one
scores the EXPERIMENT DESIGNER's output instead: each hypothesis gets scored
on four axes that map directly onto known LLM-hypothesis-generation failure
modes (see HypoBench / ProjectionBench / "Limits of LLM-as-Judge for
Scientific Novelty Assessment"):

  - novelty      does this go beyond restating a single cited paper's
                 `finding`, or is it just that finding reworded as a
                 hypothesis? (checked against the compact extractions the
                 designer was given, not vibes)
  - grounding    do the approaches/baselines actually trace to a real idx,
                 and is nothing invented (no phantom benchmarks/datasets)?
  - testability  are setup/variables/metrics concrete enough that someone
                 could actually run this — not just directionally sensible?
  - consistency  does the proposed method plausibly test the stated
                 hypothesis (no mismatch between claim and design)?

Deliberately a SEPARATE agent/prompt from the Experiment Designer itself —
a model grading its own output is a known weak spot; a differently-scoped
critic call at least catches more than self-grading would. Full novelty
verification against the broader literature (not just this run's corpus)
is a known gap here — see the retrieval-based novelty check in the
architecture notes; this rubric pass is the cheap, always-on first line.
"""
import json
import logging

from agents.base import Agent

log = logging.getLogger("samhita.hypothesis_critic")


class HypothesisCriticAgent(Agent):
    name = "hypothesis_critic"

    SYSTEM = (
        "You are a skeptical peer reviewer scoring a set of proposed research "
        "hypotheses and their experiment plans, given the papers they were "
        "supposed to be grounded in. Be harsh — most first-draft hypotheses "
        "deserve a mediocre score. For EACH hypothesis, score 0-100 on: "
        "novelty (does it go beyond restating one cited paper's finding — a "
        "hypothesis that just rephrases a single paper's `finding` field is "
        "NOT novel and should score low here), grounding (do approaches/"
        "baselines with from_idx actually match what that paper reports; "
        "flag any invented benchmark/dataset/metric not traceable to a paper "
        "or clearly marked proposed), testability (are setup/variables/"
        "metrics concrete enough to actually run, not just directionally "
        "plausible), consistency (does the proposed method actually test the "
        "stated hypothesis). "
        'Respond ONLY with JSON (no markdown): {"critiques":[{"index":<0-based '
        'position in the hypotheses array>,"scores":{"novelty":0-100,'
        '"grounding":0-100,"testability":0-100,"consistency":0-100},"overall":'
        '0-100,"issues":["specific, short issue"],"revise":"one concrete '
        'instruction for how to fix the weakest part, or null if it is already '
        'strong"} for every hypothesis],"note":"one sentence overall '
        'impression"}'
    )

    def run(self, topic: str, plan: dict, extractions: list[dict]) -> dict:
        hyps = (plan or {}).get("hypotheses", [])
        if not hyps:
            return {"critiques": [], "note": "No hypotheses to critique."}

        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        max_tokens = min(4000, 800 + 350 * len(hyps))
        out = ""
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Hypotheses to critique (0-indexed):\n{json.dumps(hyps)}\n\n"
                    f"Papers they should be grounded in (cite by idx):\n{json.dumps(compact)}"
                ),
                system=self.SYSTEM,
                max_tokens=max_tokens,
                # Low temperature: this is a rubric applied to given content,
                # not creative generation -- the same hypotheses should get
                # roughly the same scores on a re-run, not a different champion
                # every time purely from scoring noise cascading through the
                # bracket. See core/llm_client.py's `call()` docstring note.
                temperature=0.0,
            )
            result = self.llm.parse_json(out)
            if not isinstance(result, dict) or "critiques" not in result:
                return {"critiques": [], "note": "No critique produced."}
            return result
        except Exception as e:
            log.warning("Hypothesis critic failed to parse a result. "
                        "Raw output (first 500 chars): %r", out[:500], exc_info=True)
            return {"critiques": [], "note": f"Hypothesis critic error: {e}"}

"""
Method & Experiment Designer
----------------------------
Diagram node: "Turns findings into a testable experiment plan"

Takes the synthesized corpus (themes / gaps / tensions) plus the per-paper
extractions and proposes 2-3 falsifiable hypotheses, each with a concrete
experiment protocol framed for *physical* systems — bench setup, variables,
quantitative metrics with units, baselines drawn from the cited papers, failure
modes, and a validation path (sim-to-real or a named benchmark).

Grounding matters: every approach/baseline is tagged with the source paper idx
it came from and marked evidenced (traceable to a source) vs proposed (the
model's own inference), so the output is defensible rather than hallucinated.
"""
import json

from agents.base import Agent


class ExperimentDesignerAgent(Agent):
    name = "experiment_designer"

    SYSTEM = (
        "You are an experiment-design agent for a research assistant. "
        "First infer the DOMAIN of the papers (e.g. clinical/healthcare ML, "
        "robotics/control, NLP, biology, materials) and design experiments in "
        "THAT domain's language and conventions — do not force a physical/hardware "
        "framing onto a clinical or computational study. "
        "For clinical/healthcare ML: setup = cohort/dataset, inclusion criteria, "
        "retrospective vs prospective; metrics = AUROC, sensitivity@fixed-spec, "
        "calibration, Dice, etc.; baselines = existing clinical scores or prior "
        "models; validation = internal -> external -> temporal/multi-site; risks = "
        "distribution shift, label leakage, subgroup fairness, IRB/ethics. "
        "For robotics/physical systems: setup = hardware/sensors/actuators; "
        "metrics in physical units; validation = sim-to-real or a named benchmark; "
        "risks = physical failure/safety. "
        "Given the synthesis and the extracted papers, propose testable experiments "
        "that would advance the open gaps. Ground every claim in the provided papers "
        "by their idx; never invent a benchmark, dataset, or citation. "
        "Produce AT MOST 2 hypotheses, each concise. Keep every string short. "
        'Respond ONLY with JSON (no markdown): {"domain":"<inferred domain>",'
        '"hypotheses":[{'
        '"hypothesis":"one falsifiable sentence",'
        '"rationale":"<=20 words tying it to a specific gap",'
        '"approaches":[{"name":"short name","from_idx":<paper idx or null>,'
        '"evidenced":<true if drawn from a paper, false if your own proposal>}],'
        '"setup":"the study/experimental setup in this domain, one line",'
        '"variables":{"independent":"...","dependent":"...","controlled":"..."},'
        '"metrics":[{"name":"domain-appropriate metric","unit":"unit or scale",'
        '"target":"optional target"}],'
        '"baselines":[{"name":"method/score to compare against","from_idx":<paper idx or null>}],'
        '"failure_modes":["1-2 things most likely to invalidate the result"],'
        '"validation":"how results would be validated in this domain (only cite a '
        'benchmark/dataset if it appears in the papers; otherwise say none is standard)",'
        '"risks":"one key risk or ethical/safety consideration for this domain"}],'
        '"note":"one sentence: what is evidenced vs proposed, and any missing-benchmark caveat"}'
    )

    def run(self, topic: str, synthesis: dict, extractions: list[dict]) -> dict:
        # Give the model the gaps/tensions (what to target) plus a compact view
        # of each paper (what to build on / cite), keyed by idx — same compaction
        # the synthesizer uses, so the citation idxs line up across stages.
        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        focus = {
            "gaps": (synthesis or {}).get("gaps", []),
            "tensions": (synthesis or {}).get("tensions", ""),
            "themes": (synthesis or {}).get("themes", []),
        }
        # Scale the budget a little with corpus size; cap for cost.
        max_tokens = 4000
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Synthesis focus (target these gaps):\n{json.dumps(focus)}\n\n"
                    f"Papers (cite by idx):\n{json.dumps(compact)}"
                ),
                system=self.SYSTEM,
                max_tokens=max_tokens,
            )
            plan = self.llm.parse_json(out)
            # Defensive: always hand the UI a list under "hypotheses".
            if not isinstance(plan, dict) or "hypotheses" not in plan:
                return {"hypotheses": [], "note": "No plan produced."}
            return plan
        except Exception as e:
            import traceback; traceback.print_exc()
            return {
                "hypotheses": [],
                "note": f"Experiment designer error: {e}",
            }

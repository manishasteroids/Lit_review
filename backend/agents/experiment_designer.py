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
        "You may also be given KNOWLEDGE-GRAPH BRIDGE CANDIDATES: pairs of concepts "
        "that never co-occur in any single paper in this corpus, but each connects "
        "separately to some shared concept through different papers — a structural "
        "signal (not something any one paper states) that nobody here has combined "
        "those two things yet. When a bridge candidate is genuinely relevant to the "
        "topic, prefer building at least one hypothesis around it over a purely "
        "text-synthesized gap, and say so explicitly in that hypothesis's rationale "
        "(name the bridging concept). Do not force a bridge into the plan if none of "
        "them actually fit the topic — an irrelevant bridge is worse than none. "
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

    REFINE_SYSTEM = (
        "You are revising ONE research hypothesis + experiment plan in response "
        "to a critique from a peer reviewer. Keep the same JSON shape as the "
        "input hypothesis. Address every issue and the `revise` instruction "
        "specifically — do not just reword the hypothesis, actually change the "
        "weak part (e.g. if novelty was weak, propose something that goes "
        "beyond the single cited finding; if grounding was weak, fix or drop "
        "the unsupported approach/baseline; if testability was weak, make "
        "setup/variables/metrics concrete). Stay grounded: every approach/"
        "baseline must trace to a real paper idx from the list given, or be "
        "explicitly marked evidenced:false as your own proposal. Never invent "
        "a benchmark, dataset, or citation. "
        'Respond ONLY with the revised hypothesis JSON (no markdown, no '
        'surrounding object): {"hypothesis":"...","rationale":"...",'
        '"approaches":[{"name":"...","from_idx":<idx or null>,"evidenced":bool}],'
        '"setup":"...","variables":{"independent":"...","dependent":"...",'
        '"controlled":"..."},"metrics":[{"name":"...","unit":"...","target":"..."}],'
        '"baselines":[{"name":"...","from_idx":<idx or null>}],'
        '"failure_modes":["..."],"validation":"...","risks":"..."}'
    )

    def refine(self, topic: str, hypothesis: dict, critique: dict,
               extractions: list[dict]) -> dict:
        """Revise a single weak hypothesis given its critique. Returns the
        revised hypothesis dict (same shape as one entry in `hypotheses`),
        or the original hypothesis unchanged if the call fails — a failed
        refine should never drop a hypothesis from the plan."""
        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Current hypothesis:\n{json.dumps(hypothesis)}\n\n"
                    f"Critique to address:\n{json.dumps(critique)}\n\n"
                    f"Papers (cite by idx):\n{json.dumps(compact)}"
                ),
                system=self.REFINE_SYSTEM,
                max_tokens=1600,
            )
            revised = self.llm.parse_json(out)
            if isinstance(revised, dict) and revised.get("hypothesis"):
                return revised
            return hypothesis
        except Exception:
            import traceback; traceback.print_exc()
            return hypothesis

    CHALLENGE_SYSTEM = (
        "A human researcher is pushing back on ONE hypothesis with a specific "
        "objection. Take the objection seriously and do exactly one of two "
        "things: (1) if it's valid, REVISE the hypothesis to address it — "
        "change the actual substance, not just wording; or (2) if the "
        "hypothesis holds up despite it, DEFEND it with a specific reason the "
        "objection doesn't invalidate the design (not a dismissal — engage "
        "with what they actually said). Never just agree to be agreeable, and "
        "never defend without a concrete counter-reason. Stay grounded: any "
        "approach/baseline must trace to a real paper idx or be marked "
        "evidenced:false. Never invent a benchmark, dataset, or citation. "
        'Respond ONLY with JSON (no markdown): {"stance":"revised" or '
        '"defended","response":"2-3 sentences directly addressing their '
        'objection","hypothesis":{"hypothesis":"...","rationale":"...",'
        '"approaches":[{"name":"...","from_idx":<idx or null>,"evidenced":bool}],'
        '"setup":"...","variables":{"independent":"...","dependent":"...",'
        '"controlled":"..."},"metrics":[{"name":"...","unit":"...","target":"..."}],'
        '"baselines":[{"name":"...","from_idx":<idx or null>}],'
        '"failure_modes":["..."],"validation":"...","risks":"..."}} '
        '(hypothesis is UNCHANGED from the input if stance is "defended")'
    )

    def respond_to_challenge(self, topic: str, hypothesis: dict, argument: str,
                              extractions: list[dict]) -> dict:
        """A human argues with a hypothesis instead of the AI critic. Returns
        {"stance": "revised"|"defended", "response": str, "hypothesis": dict}
        — this is the dialectical counterpart to refine(): refine() responds
        to the Critic agent's rubric, this responds to a specific human
        objection, and the model is told explicitly that agreeing to be
        agreeable isn't a valid outcome."""
        compact = [
            {k: e.get(k) for k in ("idx", "method", "finding", "limitation", "concepts")}
            for e in extractions
        ]
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Current hypothesis:\n{json.dumps(hypothesis)}\n\n"
                    f"Researcher's objection:\n{argument}\n\n"
                    f"Papers (cite by idx):\n{json.dumps(compact)}"
                ),
                system=self.CHALLENGE_SYSTEM,
                max_tokens=1600,
            )
            result = self.llm.parse_json(out)
            if (isinstance(result, dict) and result.get("stance") in ("revised", "defended")
                    and isinstance(result.get("hypothesis"), dict)):
                return result
            return {"stance": "defended", "response": "Could not process the objection — no change made.",
                    "hypothesis": hypothesis}
        except Exception as e:
            import traceback; traceback.print_exc()
            return {"stance": "defended", "response": f"Error handling objection: {e}",
                    "hypothesis": hypothesis}

    def run(self, topic: str, synthesis: dict, extractions: list[dict],
            kg_bridges: list[dict] | None = None, max_hypotheses: int = 2) -> dict:
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
        user_text = (
            f"Research topic: {topic}\n\n"
            f"Synthesis focus (target these gaps):\n{json.dumps(focus)}\n\n"
            f"Papers (cite by idx):\n{json.dumps(compact)}"
        )
        if kg_bridges:
            user_text += (
                "\n\nKnowledge-graph bridge candidates (concept pairs with no "
                "direct co-occurrence in this corpus, connected only through a "
                "shared bridging concept — see system prompt):\n"
                f"{json.dumps(kg_bridges)}"
            )
        # Methods (the Sift-embedded panel) always calls this with the default
        # max_hypotheses=2 -- that behavior is unchanged. The standalone
        # Hypothesis Agent tool (hypothesis_agent/pipeline.py) is the only
        # caller that raises this, for its "best-outcome" pipeline (raise the
        # cap, then rank the field with a bracket + meta-review) -- see
        # hypothesis_agent_architecture.md SS5. A plain .replace() on the one
        # sentence in SYSTEM that pins the cap keeps every other instruction
        # (domain framing, grounding rules, JSON shape) identical either way.
        system = self.SYSTEM
        if max_hypotheses != 2:
            system = system.replace(
                "Produce AT MOST 2 hypotheses, each concise.",
                f"Produce AT MOST {max_hypotheses} hypotheses, each concise. "
                "Make them genuinely distinct approaches to the topic (different "
                "mechanisms, methods, or angles) rather than small variations on "
                "the same idea -- a later ranking stage needs real alternatives "
                "to compare, not near-duplicates.",
            )
            max_tokens = max(max_tokens, 900 + 900 * max_hypotheses)
        try:
            out = self.llm.call(
                user_text=user_text,
                system=system,
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

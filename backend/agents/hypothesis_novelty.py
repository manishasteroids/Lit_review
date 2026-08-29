"""
Hypothesis Novelty Verifier
----------------------------
Diagram node: "Prior-art check against the broader literature"

New in the Hypothesis Agent's best-outcome pipeline -- closes a documented
gap called out in agents/hypothesis_critic.py's own docstring: the Critic's
"novelty" score only ever checks a hypothesis against the small corpus it
was generated from (this run's papers). A hypothesis can score high on that
axis while something functionally identical already exists in the broader
published literature, simply because that paper wasn't one of the sources
fed into this run. This agent runs a REAL search (agents/academic_search.py
-- the same Semantic Scholar/arXiv/OpenAlex/etc. sources Sift's own search
stage uses, not the corpus) against each hypothesis's own claim, then asks a
skeptical LLM judgment: does any of what that search found already propose
or test essentially the same idea?

Deliberately conservative: being in the same research area is NOT prior
art -- testing the same specific mechanism/claim is. A false "prior art
found" would wrongly kill a genuinely novel hypothesis, so the prompt pushes
the model to require a real substantive match, not a topical one.

Methods (the Sift-embedded panel) never reaches this -- it's specific to the
standalone Hypothesis Agent tool's pipeline (hypothesis_agent/pipeline.py).
"""
import json

from agents.base import Agent


class HypothesisNoveltyAgent(Agent):
    name = "hypothesis_novelty"

    SYSTEM = (
        "You are checking whether a proposed research hypothesis is genuinely "
        "novel against REAL papers found by a live literature search — not just "
        "the small corpus it was generated from. You are given the hypothesis "
        "and a list of candidate papers (title/year/venue/abstract) that search "
        "returned. Decide: does any of these papers already propose or test "
        "essentially the same core mechanism or claim — not merely the same "
        "general topic or research area? Sharing a topic is NOT prior art; "
        "testing the same specific combination or mechanism is. Be skeptical of "
        "the search results themselves — a title/abstract that merely mentions "
        "similar keywords is not evidence of prior art. When in doubt, prefer "
        "prior_art_found:false — a false positive here wrongly kills a "
        "genuinely novel hypothesis. "
        'Respond ONLY with JSON (no markdown): {"prior_art_found":true or false,'
        '"closest_match":{"title":"...","year":<int or null>,"url":"...",'
        '"why_similar":"one sentence, specific to what overlaps"} or null if '
        'prior_art_found is false,'
        '"novelty_note":"1-2 sentences: what is still new here even given the '
        'closest match, or why the search turned up nothing that competes"}'
    )

    def run(self, topic: str, hypothesis: dict, candidates: list[dict]) -> dict:
        """Returns {"prior_art_found": bool, "closest_match": dict|None,
        "novelty_note": str, "searched": int}. `searched` is the number of
        candidate papers the search actually returned — 0 means the search
        itself came up empty (offline/throttled/no results), not that
        novelty was verified against nothing found; the note reflects that."""
        if not candidates:
            return {
                "prior_art_found": False, "closest_match": None,
                "novelty_note": "Live literature search returned no closely related "
                                 "papers to check against.",
                "searched": 0,
            }
        compact = [
            {"title": c.get("title"), "year": c.get("year"), "venue": c.get("venue"),
             "abstract": (c.get("abstract") or "")[:600], "url": c.get("url")}
            for c in candidates
        ]
        try:
            out = self.llm.call(
                user_text=(
                    f"Research topic: {topic}\n\n"
                    f"Proposed hypothesis:\n"
                    f"{json.dumps({'hypothesis': hypothesis.get('hypothesis'), 'rationale': hypothesis.get('rationale')})}\n\n"
                    f"Candidate papers from a live literature search "
                    f"(title/year/venue/abstract):\n{json.dumps(compact)}"
                ),
                system=self.SYSTEM,
                max_tokens=500,
            )
            result = self.llm.parse_json(out)
            if isinstance(result, dict) and "prior_art_found" in result:
                result["searched"] = len(candidates)
                return result
            return {
                "prior_art_found": False, "closest_match": None,
                "novelty_note": "Could not parse a novelty verdict.",
                "searched": len(candidates),
            }
        except Exception as e:
            import traceback; traceback.print_exc()
            return {
                "prior_art_found": False, "closest_match": None,
                "novelty_note": f"Novelty check error: {e}",
                "searched": len(candidates),
            }

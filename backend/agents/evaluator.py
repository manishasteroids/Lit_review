"""
Evaluator
----------
Diagram open question: "How to evaluate quality of the lit. review output?"

This is one concrete answer to that question: a rubric-based self-critique
across coverage, synthesis depth, balance, and clarity, plus a short
free-text critique. It's deliberately separate from the Writer Agent so the
review-then-critique loop is easy to extend into a revision pass later.
"""
from agents.base import Agent

SECTION_KEYS = ["intro", "synthesis", "gaps", "future"]


class EvaluatorAgent(Agent):
    name = "evaluator"

    SYSTEM = (
        "You evaluate the QUALITY of a generated literature review (the open question: how "
        "to evaluate the output). Respond ONLY with JSON (no markdown): {\"scores\":"
        '{"coverage":0-100,"synthesis":0-100,"balance":0-100,"clarity":0-100},"overall":'
        '0-100,"notes":"2-sentence critique"}.'
    )

    def run(self, topic: str, sections: dict, num_sources: int) -> dict:
        full = "\n\n".join(sections.get(k, "") for k in SECTION_KEYS)
        out = self.llm.call(
            user_text=f"Topic: {topic}\nSources: {num_sources}\nReview:\n{full}",
            system=self.SYSTEM,
        )
        return self.llm.parse_json(out)

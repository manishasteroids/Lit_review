"""
Writer Agent
-------------
Diagram node: "Creates structured summary -> Final Literature Review"

Writes the four sections of the review one at a time so each can stream to
the frontend as it completes, citing sources as [n] in IEEE style using the
ranking order the Critic & Synthesizer produced.
"""
from agents.base import Agent

SECTION_SPECS = [
    (
        "intro",
        "Write the INTRODUCTION (2 short paragraphs): frame the area, scope, and why this "
        "review matters. Cite papers as [n] where relevant.",
    ),
    (
        "synthesis",
        "Write the THEMATIC SYNTHESIS (2-3 short paragraphs): group the work by the themes, "
        "state consensus and disagreement. Cite heavily as [n].",
    ),
    (
        "gaps",
        "Write GAPS & LIMITATIONS (1-2 short paragraphs): the key open problems and biases "
        "across the corpus.",
    ),
    (
        "future",
        "Write FUTURE DIRECTIONS & CONCLUSION (1-2 short paragraphs): concrete next steps "
        "and a brief close.",
    ),
]

SYSTEM = (
    "You are the writer agent producing a scholarly literature-review section in IEEE-style "
    "prose. Write plain paragraphs separated by blank lines. No section headers, no markdown, "
    "no bullet lists. Use inline citations like [1], [2] referring to the numbered papers. "
    "Keep it tight and academic."
)


class WriterAgent(Agent):
    name = "writer"

    def run(
        self,
        topic: str,
        ordered_papers: list[dict],
        extractions_by_idx: dict[int, dict],
        synthesis: dict,
    ) -> dict:
        cite_num = {p["idx"]: i + 1 for i, p in enumerate(ordered_papers)}
        corpus_lines = []
        for p in ordered_papers:
            e = extractions_by_idx.get(p["idx"], {})
            corpus_lines.append(
                f"[{cite_num[p['idx']]}] {p['title']} ({p.get('year', '?')}): "
                f"method={e.get('method', '?')}; finding={e.get('finding', '?')}; "
                f"limitation={e.get('limitation', '?')}"
            )
        base = (
            f"Topic: {topic}\nPapers (cite as [n]):\n" + "\n".join(corpus_lines) +
            f"\nThemes: {', '.join(synthesis.get('themes', []))}\n"
            f"Gaps: {'; '.join(synthesis.get('gaps', []))}\n"
        )

        sections: dict[str, str] = {}
        for key, prompt in SECTION_SPECS:
            sections[key] = self.llm.call(
                user_text=base + "\n" + prompt, system=SYSTEM, max_tokens=1500
            )
        return sections

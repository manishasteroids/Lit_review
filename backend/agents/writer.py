"""
Writer Agent
-------------
Diagram node: "Creates structured summary -> Final Literature Review"

Writes the four sections of the review one at a time so each can stream to
the frontend as it completes, citing sources as [n] in IEEE style using the
ranking order the Critic & Synthesizer produced.
"""
from concurrent.futures import ThreadPoolExecutor

from agents.base import Agent

SECTION_SPECS = [
    (
        "title",
        "Write ONLY the title of this literature review — a clear, specific, academic "
        "title of 8-14 words that names the subject and scope. Do not restate the user's "
        "question verbatim, do not use quotes, a trailing period, or any prefix like "
        "'Title:'. Output the title text and nothing else.",
    ),
    (
        "abstract",
        "Write the ABSTRACT (150-200 words, one paragraph, no citations): the scope of "
        "this review, the body of work covered, the main themes and findings that "
        "emerged, and the key gaps identified.",
    ),
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

# Deep mode has genuinely more to work with — full-text extractions (see
# reader_extractor.DEEP_SYSTEM) and a richer synthesis (see
# critic_synthesizer.DEEP_SYSTEM) — so its sections are allowed to actually be
# longer and more specific instead of producing the same length as Medium in
# a fancier model's prose. This was the direct cause of Deep/Opus reviews
# reading almost identically to Medium/Sonnet ones.
DEEP_SECTION_SPECS = [
    ("title", SECTION_SPECS[0][1]),
    (
        "abstract",
        "Write the ABSTRACT (200-260 words, one paragraph, no citations): the scope of "
        "this review, the body of work covered, the main themes and findings that "
        "emerged — including specific methods/results, not just topic names — and the "
        "key gaps identified.",
    ),
    (
        "intro",
        "Write the INTRODUCTION (3-4 paragraphs): frame the area in depth, the scope of "
        "this review, why it matters now, and a roadmap of what the review covers. Cite "
        "papers as [n] liberally and specifically (not just at paragraph ends).",
    ),
    (
        "synthesis",
        "Write the THEMATIC SYNTHESIS (4-6 paragraphs, one per major theme): for each "
        "theme, name the papers that contribute to it as [n], describe their specific "
        "methods and findings (numbers, metrics, datasets where available), and state "
        "where they agree or conflict and why. This is the core of the review — go deep, "
        "not just wide.",
    ),
    (
        "gaps",
        "Write GAPS & LIMITATIONS (2-3 paragraphs): specific open problems, methodological "
        "blind spots, and biases across the corpus, grounded in what particular papers did "
        "or didn't address. Cite [n] where a gap is specific to certain papers' scope.",
    ),
    (
        "future",
        "Write FUTURE DIRECTIONS & CONCLUSION (2-3 paragraphs): concrete, specific next "
        "research steps suggested by the gaps just identified, and a substantive close "
        "that synthesizes what this body of work establishes.",
    ),
]

SYSTEM = (
    "You are the writer agent producing a scholarly literature-review section in IEEE-style "
    "prose. Write plain paragraphs separated by blank lines. No section headers, no markdown, "
    "no bullet lists. Use inline citations like [1], [2] referring to the numbered papers. "
    "Keep it tight and academic."
)

DEEP_SYSTEM = (
    "You are the writer agent producing a scholarly, IN-DEPTH literature-review section in "
    "IEEE-style prose, drawing on detailed per-paper methods/findings/metrics you were given — "
    "use that specificity; don't write generically about 'themes' when you have actual numbers "
    "and methods to cite. Write plain paragraphs separated by blank lines. No section headers, "
    "no markdown, no bullet lists. Use inline citations like [1], [2] referring to the numbered "
    "papers, and cite specifically next to the claim they support, not just at paragraph ends. "
    "Be substantive and detailed, but never pad with filler — every sentence should carry real "
    "information from the corpus."
)


def _clean_title(raw: str) -> str:
    """Models sometimes wrap the title in quotes or prefix it — strip that."""
    import re
    t = (raw or "").strip().splitlines()[0] if (raw or "").strip() else ""
    t = re.sub(r"^\s*(title|heading)\s*[:\-—]\s*", "", t, flags=re.I)
    t = t.strip().strip('"').strip("'").strip()
    return t.rstrip(".").strip()


class WriterAgent(Agent):
    name = "writer"

    def run(
        self,
        topic: str,
        ordered_papers: list[dict],
        extractions_by_idx: dict[int, dict],
        synthesis: dict,
        deep: bool = False,
    ) -> dict:
        cite_num = {p["idx"]: i + 1 for i, p in enumerate(ordered_papers)}
        corpus_lines = []
        for p in ordered_papers:
            e = extractions_by_idx.get(p["idx"], {})
            if deep:
                # Deep extractions actually HAVE this detail (see
                # reader_extractor.DEEP_SYSTEM) — feeding the writer only
                # method/finding/limitation, same as Medium, was exactly why
                # Deep reviews read almost identically to Medium ones.
                corpus_lines.append(
                    f"[{cite_num[p['idx']]}] {p['title']} ({p.get('year', '?')}): "
                    f"method={e.get('method', '?')}; finding={e.get('finding', '?')}; "
                    f"data={e.get('data', '?')}; metrics={e.get('metrics', '?')}; "
                    f"limitation={e.get('limitation', '?')}; contribution={e.get('contribution', '?')}"
                )
            else:
                corpus_lines.append(
                    f"[{cite_num[p['idx']]}] {p['title']} ({p.get('year', '?')}): "
                    f"method={e.get('method', '?')}; finding={e.get('finding', '?')}; "
                    f"limitation={e.get('limitation', '?')}"
                )
        base = f"Topic: {topic}\nPapers (cite as [n]):\n" + "\n".join(corpus_lines)
        base += f"\nThemes: {', '.join(synthesis.get('themes', []))}\n"
        base += f"Gaps: {'; '.join(synthesis.get('gaps', []))}\n"
        if deep:
            # Medium's synthesis doesn't request consensus/tensions/biases with
            # any real substance, but Deep's does (critic_synthesizer.DEEP_SYSTEM)
            # — pass them through so the writer can actually use them.
            if synthesis.get("consensus"):
                base += f"Consensus: {synthesis['consensus']}\n"
            if synthesis.get("tensions"):
                base += f"Tensions/disagreements: {synthesis['tensions']}\n"
            if synthesis.get("biases"):
                base += f"Likely biases/limitations across corpus: {'; '.join(synthesis.get('biases', []))}\n"

        # The `base` corpus is identical across all section calls, so cache it:
        # it's written to cache once (1.25x) and read back at 0.1x for the other
        # calls instead of paying full input price every time. Only cache when
        # it's big enough to clear the provider's minimum cacheable size.
        cache = base if len(base) > 4000 else None

        specs = DEEP_SECTION_SPECS if deep else SECTION_SPECS
        system = DEEP_SYSTEM if deep else SYSTEM

        def call_section(key: str, prompt: str) -> str:
            # The title is one short line — don't spend a big budget on it.
            # Deep's other sections are written to run meaningfully longer
            # (see DEEP_SECTION_SPECS), so they get a bigger token budget too
            # — otherwise the richer prompt just gets truncated mid-thought.
            budget = 60 if key == "title" else (3000 if deep else 1500)
            if cache:
                out = self.llm.call(
                    user_text=prompt, system=system, max_tokens=budget, cache_prefix=cache
                )
            else:
                out = self.llm.call(
                    user_text=base + "\n" + prompt, system=system, max_tokens=budget
                )
            return _clean_title(out) if key == "title" else out

        sections: dict[str, str] = {}
        if not specs:
            return sections

        # The 6 sections used to run one at a time — in Deep mode that's 5
        # sequential Opus calls at up to 3000 tokens each, which is most of
        # why Deep reviews feel slow to generate. They're independent given
        # the shared corpus, so: write the title first (cheap, and with
        # caching on, this is also what WRITES the prompt cache), then fire
        # the remaining sections at once so they all read from an already-
        # warm cache instead of each re-paying for it — same total tokens,
        # wall-clock time now bounded by the slowest single section instead
        # of the sum of all of them.
        title_key, title_prompt = specs[0]
        sections[title_key] = call_section(title_key, title_prompt)

        rest = specs[1:]
        if rest:
            with ThreadPoolExecutor(max_workers=len(rest)) as pool:
                futures = {key: pool.submit(call_section, key, prompt) for key, prompt in rest}
                for key, fut in futures.items():
                    sections[key] = fut.result()

        return sections

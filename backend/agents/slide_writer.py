"""
Slide Writer
-------------
The Writer Agent writes the review as continuous academic prose meant to be
read as a report/manuscript — that's exactly right for the PDF/DOCX exports,
but wrong for slides. Until now, build_pptx() just chopped that prose into
bullets with a regex sentence-splitter, which reads generic and choppy: full
academic sentences crammed onto a slide instead of actual presentation-style
points.

This agent rewrites a section into short, punchy, slide-native bullets
instead. It runs on Gemini (cheap/fast, already the free-tier model used for
extraction elsewhere) since deck bullets don't need the review's own model
tier — never raises; on any failure the caller falls back to the mechanical
sentence-split so a slow/rate-limited call never breaks the export.
"""
from agents.base import Agent

SYSTEM = (
    "You are a slide-writing assistant. Rewrite the given literature-review section "
    "into 4-6 SHORT presentation bullet points — NOT sentences chopped out of the "
    "prose, actual standalone statements a presenter could read aloud. Each bullet "
    "<=18 words, punchy and specific (keep real numbers/methods/findings from the "
    "text), no filler lead-ins like \"This section discusses\" or \"The review finds\", "
    "no restating the section title. Keep inline citation markers like [1] or [2] "
    "ONLY where they're attached to a specific claim you kept. "
    'Respond ONLY with a JSON array of strings, e.g. ["Bullet one.", "Bullet two."].'
)


class SlideWriterAgent(Agent):
    name = "slide_writer"

    def run(self, section_label: str, section_text: str, topic: str) -> list[str]:
        if not (section_text or "").strip():
            return []
        try:
            out = self.llm.call(
                user_text=f'Topic: {topic}\nSection: "{section_label}"\nContent:\n{section_text}',
                system=SYSTEM,
                max_tokens=500,
            )
            bullets = self.llm.parse_json(out)
            if isinstance(bullets, list):
                return [b.strip() for b in bullets if isinstance(b, str) and b.strip()]
        except Exception:
            pass
        return []  # caller falls back to the mechanical sentence-split

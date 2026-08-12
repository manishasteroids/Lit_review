"""
Slide illustration generation (opt-in, costs real money).

Produces one small conceptual/schematic illustration per review section
(Introduction, Thematic Synthesis, etc.) using Gemini's image model, for
embedding into the exported slide deck. This is NOT wired into the normal
export path — export stays free by default; a caller must explicitly opt in
(see api/routes.py's `illustrate` query param) because every image call has
a real per-image cost (core.pricing.IMAGE_PRICE_USD).

Never raises: a failed image generation just means that slide falls back to
text-only, exactly like today — illustration is a bonus, not a dependency.
"""
import logging

from core.config import settings
from core.pricing import IMAGE_MODEL

log = logging.getLogger("samhita.image_gen")

_STYLE = (
    "Clean, minimal scientific/conceptual illustration suitable for a presentation "
    "slide background accent — schematic or diagrammatic, NOT photorealistic, no "
    "embedded text or labels, no fake data or numbers, simple flat colors on a plain "
    "or transparent-feeling background. "
)


def build_prompt(section_label: str, section_text: str, topic: str) -> str:
    """Turn a written section into an image prompt grounded in its actual
    content (not just the topic), so different sections get visibly
    different illustrations instead of one generic stock image repeated."""
    gist = (section_text or "").strip().replace("\n", " ")[:400]
    return (
        f"{_STYLE}"
        f"Illustrate the core concept of this literature-review section, titled "
        f'"{section_label}", from a review on "{topic}". Section content to base the '
        f"illustration on: {gist}"
    )


def generate_image(prompt: str) -> tuple[bytes, str] | None:
    """Return (image_bytes, mime_type) or None on any failure. Costs money —
    callers are responsible for the opt-in gate and usage recording."""
    try:
        from google import genai
        from google.genai import types
    except Exception as e:
        log.warning("google-genai not available for image generation: %s", e)
        return None
    if not settings.gemini_api_key:
        log.warning("no GEMINI_API_KEY set — cannot generate slide illustrations")
        return None

    try:
        client = genai.Client(api_key=settings.gemini_api_key)
        resp = client.models.generate_content(
            model=IMAGE_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
        )
        for part in (resp.candidates[0].content.parts if resp.candidates else []):
            inline = getattr(part, "inline_data", None)
            if inline and inline.data:
                return inline.data, (inline.mime_type or "image/png")
    except Exception as e:
        log.warning("slide image generation failed: %s", e)
    return None

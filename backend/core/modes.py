"""
Search modes — the user-facing "how thorough?" choice that replaces the raw
model dropdown. Each mode bundles a paper count, the model routing, and whether
to read papers in full (fetch PDFs) or just their abstracts.

    Lite        — quick scan: few papers, abstracts, cheapest models.
    Systematic  — widest net: many papers, abstract-level, cheap extraction.
    Deep        — deep read: fewer papers but FULL TEXT, best writer model.

Version-controlled (like model_policy) so it survives .env resets.
"""

MODES = {
    # Lite — the current cheap setup: Gemini extraction, Haiku everywhere else.
    "lite": {
        "label": "Lite",
        "blurb": "Fast & cheap — Gemini + Haiku, abstracts",
        "search_limit": 20,
        "full_text": False,
        "fast": "gemini-2.5-flash",              # reformulate + extract
        "mid": "claude-haiku-4-5-20251001",      # synthesize + evaluate
        "write": "claude-haiku-4-5-20251001",    # writer
    },
    # Medium Research — Haiku + Gemini + Sonnet as needed; Sonnet writes.
    "medium": {
        "label": "Medium Research",
        "blurb": "Balanced — Gemini + Haiku + Sonnet, abstracts",
        "search_limit": 50,
        "full_text": False,
        "fast": "gemini-2.5-flash",
        "mid": "claude-haiku-4-5-20251001",
        "write": "claude-sonnet-4-6",
    },
    # Deep search — best results: full-text reading, Sonnet synthesis, Opus writer.
    "deep": {
        "label": "Deep search",
        "blurb": "Best quality — full text, Sonnet + Opus",
        "search_limit": 40,
        "full_text": True,                       # fetch PDFs, extract from full text
        "fast": "gemini-2.5-flash",              # extraction stays on Gemini (cheap on full text)
        "mid": "claude-sonnet-4-6",
        "write": "claude-opus-4-8",
    },
}

DEFAULT_MODE = "medium"


def resolve(mode: str | None) -> dict:
    """Return a mode config dict, falling back to the default for unknown modes."""
    return MODES.get((mode or "").lower(), MODES[DEFAULT_MODE])


def public_list() -> list[dict]:
    """Lightweight list for the UI selector."""
    return [
        {"id": k, "label": v["label"], "blurb": v["blurb"],
         "search_limit": v["search_limit"], "full_text": v["full_text"]}
        for k, v in MODES.items()
    ]

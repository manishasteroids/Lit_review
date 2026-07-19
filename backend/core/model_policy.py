"""
Pipeline model policy — VERSION-CONTROLLED defaults.

Unlike API keys (which are secrets and live in .env), the model routing and
paper limit are *policy*: they define how the pipeline behaves. Keeping them
here means they survive .env resets, stay consistent across machines, and are
reviewed in git like any other code.

Routing model (see pipeline/orchestrator.py):
    reformulate · search-fallback · extract  →  FAST_MODEL
    synthesize · evaluate                     →  MID_MODEL
    write                                     →  WRITE_MODEL, or the model the
                                                 USER selects if WRITE_MODEL == ""

HOW TO SWITCH CONFIG: change ACTIVE_PRESET below to one of the PRESETS keys.
Any single value can still be overridden per-environment via .env
(FAST_MODEL, MID_MODEL, WRITE_MODEL, SEARCH_LIMIT, PER_PURPOSE_ROUTING).
"""

# ── Cost/quality presets ────────────────────────────────────────────────────
PRESETS = {
    # Works TODAY on just your Anthropic key. ~5¢ for 20 papers, no Gemini.
    "balanced": {
        "FAST_MODEL": "claude-haiku-4-5-20251001",   # reformulate + extract
        "MID_MODEL": "claude-haiku-4-5-20251001",    # synthesize + evaluate
        "WRITE_MODEL": "",                           # "" = use the selected model
        "SEARCH_LIMIT": 20,
    },

    # Best writing quality, higher cost. Synthesis on Sonnet; Writer = whatever
    # you select in the dropdown (Sonnet/Opus). ~15-40¢ depending on papers/model.
    "quality": {
        "FAST_MODEL": "claude-haiku-4-5-20251001",
        "MID_MODEL": "claude-sonnet-4-6",
        "WRITE_MODEL": "",
        "SEARCH_LIMIT": 25,
    },

    # 100 papers for ~2¢. Extraction + synthesis run FREE on Gemini; only the
    # Writer costs anything (Haiku, with its corpus cached).
    #
    # ⚠ REQUIRES a valid Google AI Studio key in .env:
    #     GEMINI_API_KEY=AIzaSy...        (NOT an "AQ." OAuth token)
    #   and `pip install google-genai`. Without a working key the Gemini stages
    #   fail and extraction returns empty — so keep this preset OFF until the
    #   key validates (see tests/inspect_reader_extractor.py or a quick
    #   `genai.Client(api_key=...).models.generate_content(...)` check).
    #
    # Notes: Gemini free tier throttles (~10 req/min); 100 papers = ~10 extract
    #   batches, so it may take a couple of minutes (client retries on 429).
    #   If heavily throttled, use "gemini-2.0-flash" (higher free RPM).
    "cheap_100": {
        "FAST_MODEL": "gemini-2.5-flash",            # reformulate + extract → free
        "MID_MODEL": "gemini-2.5-flash",             # synthesize (ranks all 100) → free
        "WRITE_MODEL": "claude-haiku-4-5-20251001",  # Writer pinned to Haiku (cached)
        "SEARCH_LIMIT": 100,
    },

    # 50 papers on gemini-2.5-flash (extraction + synthesis free/cheap), Writer
    # on Haiku. gemini-2.0-flash is RETIRED — use 2.5-flash. With billing enabled
    # the free-tier request caps don't apply; on free tier this can hit the
    # ~20-requests/day limit, so enable billing for repeated runs.
    "cheap_50": {
        "FAST_MODEL": "gemini-2.5-flash",
        "MID_MODEL": "gemini-2.5-flash",
        "WRITE_MODEL": "claude-haiku-4-5-20251001",
        "SEARCH_LIMIT": 50,
    },

    # 100 papers TODAY on just the Anthropic key (no Gemini). Extraction +
    # synthesis on Haiku, Writer = selected model. ~20¢/run because paid-model
    # extraction of 100 papers isn't free — switch to "cheap_100" once you have
    # a valid Gemini key (starts "AIzaSy") to drop this to ~2¢.
    "haiku_100": {
        "FAST_MODEL": "claude-haiku-4-5-20251001",
        "MID_MODEL": "claude-haiku-4-5-20251001",
        "WRITE_MODEL": "",                           # use the selected model (Sonnet) for quality
        "SEARCH_LIMIT": 100,
    },
}

# ── Active config ───────────────────────────────────────────────────────────
# Change this one line to switch. Set to "cheap_100" once your GEMINI_API_KEY
# (starts "AIzaSy") is in .env and validated.
ACTIVE_PRESET = "cheap_100"

# Per-purpose routing on/off. If False, every stage uses the selected model.
PER_PURPOSE_ROUTING = True

# ── Derived exports (read by core/config.py) — don't edit below ─────────────
_p = PRESETS[ACTIVE_PRESET]
FAST_MODEL = _p["FAST_MODEL"]
MID_MODEL = _p["MID_MODEL"]
WRITE_MODEL = _p["WRITE_MODEL"]
SEARCH_LIMIT = _p["SEARCH_LIMIT"]

"""
Model pricing + "thinking depth" tiers — the single source of truth for cost.

Prices are USD per 1,000,000 tokens, verified 2026-07.  They change: keep this
table dated and update it when Anthropic changes rates.  (e.g. Haiku 4.5 moved
from $0.8/$4 to $1/$5 on 2026-07-02.)

TIER drives the dashboard indicator:
    "deep"     -> heavy / expensive "deep thinking" model  (red)
    "standard" -> mid model                                (amber)
    "light"    -> cheap or free model                      (green)
"""
from typing import Tuple

PRICES_EFFECTIVE = "2026-07"

# model_id -> (input $/Mtok, output $/Mtok, tier)
_PRICING: dict[str, Tuple[float, float, str]] = {
    "claude-opus-4-8":            (15.0, 75.0, "deep"),
    "claude-sonnet-4-6":          (3.0, 15.0, "standard"),
    "claude-haiku-4-5":           (1.0, 5.0, "light"),
    "claude-haiku-4-5-20251001":  (1.0, 5.0, "light"),
    # free-tier / not-yet-wired backbones (priced $0 = free tier; if you move
    # to a paid Gemini tier, put the real per-Mtok rates here)
    "gemini-2.0-flash":           (0.0, 0.0, "light"),
    "gemini-2.5-flash":           (0.0, 0.0, "light"),
    "gemini":                     (0.0, 0.0, "light"),
    "gpt5":                       (0.0, 0.0, "standard"),
}

# what we assume when a model id isn't in the table (don't silently price at 0)
_FALLBACK = (3.0, 15.0, "standard")

# Cache token multipliers (relative to the base input rate), per Anthropic:
#   writing to cache costs 1.25x input;  reading from cache costs 0.10x input.
CACHE_WRITE_MULT = 1.25
CACHE_READ_MULT = 0.10

# Server-side tools billed per request, on TOP of tokens.
WEB_SEARCH_PER_1K = 10.0  # USD per 1,000 web_search requests


def _lookup(model: str) -> Tuple[float, float, str]:
    if model in _PRICING:
        return _PRICING[model]
    # tolerate dated/alias suffixes, e.g. "claude-opus-4-8-20260101"
    for key, val in _PRICING.items():
        if model.startswith(key):
            return val
    return _FALLBACK


def tier_of(model: str) -> str:
    """'deep' | 'standard' | 'light' — for the UI indicator."""
    return _lookup(model)[2]


def rates_of(model: str) -> Tuple[float, float]:
    """(input_per_mtok, output_per_mtok) in USD."""
    inp, out, _ = _lookup(model)
    return inp, out


def cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_write: int = 0,
    cache_read: int = 0,
    web_searches: int = 0,
) -> float:
    """Full dollar cost of one call, rounded to 6 dp (sub-cent calls are common).

    Includes uncached input, output, cache write/read tokens (billed at
    different rates), and any server-side web_search requests. Cache tokens
    are reported by Anthropic SEPARATELY from input_tokens, so adding them
    here is not double counting.
    """
    inp, out = rates_of(model)
    c = (input_tokens / 1_000_000) * inp + (output_tokens / 1_000_000) * out
    c += (cache_write / 1_000_000) * inp * CACHE_WRITE_MULT
    c += (cache_read / 1_000_000) * inp * CACHE_READ_MULT
    c += (web_searches / 1_000.0) * WEB_SEARCH_PER_1K
    return round(c, 6)


def is_known(model: str) -> bool:
    """False if we fell back to a guess price — surface this in the UI."""
    if model in _PRICING:
        return True
    return any(model.startswith(k) for k in _PRICING)

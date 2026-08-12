"""
Thin wrapper around the model providers shared by every agent.
Supports two backbones, chosen by the selected model id:
  - Anthropic (Claude)  — default
  - Google Gemini       — when the model id contains "gemini"
Both accept the same multimodal `content` blocks (text + document/PDF + image);
the Gemini path converts them to google-genai Parts.
"""
import base64
import json
import logging
import re
import time
from typing import Any, Optional

import anthropic

from .config import settings
from .usage import record_call

log = logging.getLogger("samhita.llm")


def _build_gemini_client():
    """Construct a google-genai Client with a bounded timeout so a bad key /
    network issue errors cleanly instead of hanging. Shared by the primary
    Gemini provider path and the Anthropic->Gemini fallback path."""
    from google import genai
    try:
        from google.genai import types as _gt
        return genai.Client(
            api_key=settings.gemini_api_key,
            http_options=_gt.HttpOptions(timeout=30_000),
        )
    except Exception:
        return genai.Client(api_key=settings.gemini_api_key)


class LLMClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        run_id: Optional[str] = None,
        stage: str = "misc",
    ):
        self.model = model or settings.model
        self.provider = "gemini" if "gemini" in self.model.lower() else "anthropic"

        if self.provider == "gemini":
            self._gclient = _build_gemini_client()  # lazy import so Claude-only setups don't need it
            self._gemini_model = settings.gemini_model if self.model == "gemini" else self.model
        else:
            # max_retries=1 (down from the SDK's default of 2): the SDK's own
            # retry/backoff on 429/5xx is exactly what can silently turn one
            # "call" into several minutes of hidden waiting (see the slow-call
            # warning below) — better to fail this attempt fast and let our
            # own Gemini fallback take over than sit through it.
            self.client = anthropic.Anthropic(
                api_key=api_key or settings.anthropic_api_key, max_retries=1,
            )
            self._gclient = None  # lazily built only if a fallback is actually needed

        # set by the orchestrator/routes so every call is attributed to a
        # session and a pipeline stage in the token/cost ledger.
        self.run_id = run_id
        self.stage = stage

    def call(
        self,
        user_text: Optional[str] = None,
        system: Optional[str] = None,
        tools: Optional[list] = None,
        max_tokens: int = 1200,
        content: Optional[list] = None,
        cache_prefix: Optional[str] = None,
    ) -> str:
        if self.provider == "gemini":
            # Gemini uses a different caching API; just fold the prefix into the
            # prompt so the call still works (no Anthropic-style caching here).
            gem_text = f"{cache_prefix}\n{user_text or ''}" if cache_prefix else user_text
            return self._call_gemini(gem_text, system, max_tokens, content, model=self._gemini_model)

        # `content` lets callers pass multimodal blocks (text + document/PDF +
        # image). `cache_prefix` marks a stable prefix for prompt caching —
        # billed 1.25x to write once, then 0.1x per read (Anthropic). Ideal for
        # text re-sent across calls (e.g. the Writer's corpus across 4 sections).
        if content is not None:
            message_content = content
        elif cache_prefix:
            message_content = [
                {"type": "text", "text": cache_prefix, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": user_text or ""},
            ]
        else:
            message_content = user_text
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": message_content}],
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools

        # Cap how long we'll wait on Anthropic before giving up on THIS call
        # and falling back — scaled to the output budget so a legitimately
        # long Deep-mode section isn't cut off, but a stuck/rate-limited call
        # doesn't get to eat the whole request timeout by itself.
        per_call_timeout = min(180.0, max(60.0, max_tokens / 20.0))

        t0 = time.perf_counter()
        try:
            resp = self.client.messages.create(**kwargs, timeout=per_call_timeout)
        except (anthropic.APITimeoutError, anthropic.RateLimitError,
                anthropic.OverloadedError, anthropic.InternalServerError,
                anthropic.APIConnectionError) as e:
            latency_ms = int((time.perf_counter() - t0) * 1000)
            if not settings.gemini_api_key:
                log.warning(
                    "Anthropic call failed after %.1fs (stage=%s model=%s): %s — "
                    "no GEMINI_API_KEY set, cannot fall back, re-raising",
                    latency_ms / 1000, self.stage, self.model, type(e).__name__,
                )
                raise
            log.warning(
                "Anthropic call failed after %.1fs (stage=%s model=%s): %s — "
                "falling back to Gemini for this call",
                latency_ms / 1000, self.stage, self.model, type(e).__name__,
            )
            fallback_model = settings.gemini_model or "gemini-2.5-flash"
            gem_text = f"{cache_prefix}\n{user_text or ''}" if cache_prefix else user_text
            out = self._call_gemini(gem_text, system, max_tokens, content, model=fallback_model)
            log.warning("Gemini fallback (%s) completed for stage=%s", fallback_model, self.stage)
            return out
        latency_ms = int((time.perf_counter() - t0) * 1000)
        # A single call taking this long usually means the Anthropic SDK's own
        # built-in retry/backoff kicked in underneath us (429 rate limit or a
        # transient 5xx) — surfacing it here makes that visible in the backend
        # terminal instead of just a mysterious frontend timeout, since a
        # multi-call stage like the Writer (6 sequential calls) can blow past
        # its request timeout even though no single call ever "failed".
        if latency_ms > 20_000:
            log.warning(
                "slow LLM call: stage=%s model=%s latency=%.1fs (>20s often means "
                "the SDK is silently retrying a rate-limited/5xx response)",
                self.stage, self.model, latency_ms / 1000,
            )

        # record token usage + dollar cost for this call (best-effort; never
        # raises into the pipeline). resp.usage carries the real counts,
        # including cache tokens and server-side web_search request counts.
        usage = getattr(resp, "usage", None)
        in_tok = getattr(usage, "input_tokens", 0) or 0
        out_tok = getattr(usage, "output_tokens", 0) or 0
        cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
        cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
        stu = getattr(usage, "server_tool_use", None)
        web_searches = (getattr(stu, "web_search_requests", 0) or 0) if stu else 0
        record_call(
            self.run_id, self.stage, self.model, in_tok, out_tok, latency_ms,
            cache_write=cache_write, cache_read=cache_read, web_searches=web_searches,
        )

        return "\n".join(b.text for b in resp.content if b.type == "text").strip()

    def _call_gemini(self, user_text, system, max_tokens, content, model: str) -> str:
        """Route the same request to Google Gemini, converting Anthropic-style
        content blocks (text / document / image) into google-genai Parts.
        `model` is explicit (rather than always self._gemini_model) so this
        also works as a mid-call fallback FROM an Anthropic-backed instance,
        which has no _gemini_model/_gclient of its own until one is needed."""
        from google.genai import types

        if self._gclient is None:
            try:
                self._gclient = _build_gemini_client()
            except Exception as e:
                log.warning("could not build Gemini fallback client: %s", e)
                raise

        parts = []
        if content is not None:
            for block in content:
                btype = block.get("type")
                if btype == "text":
                    parts.append(types.Part.from_text(text=block.get("text", "")))
                elif btype in ("document", "image"):
                    src = block.get("source", {})
                    raw = base64.b64decode(src.get("data", ""))
                    mime = src.get("media_type", "application/pdf" if btype == "document" else "image/png")
                    parts.append(types.Part.from_bytes(data=raw, mime_type=mime))
        else:
            parts.append(types.Part.from_text(text=user_text or ""))

        cfg_kwargs = dict(
            max_output_tokens=max_tokens,
            system_instruction=system or None,
        )
        # Gemini 2.5 models "think" by default, which eats the output-token
        # budget and can return truncated/empty JSON (blank extractions).
        # Disable it so the whole budget goes to the actual answer.
        try:
            cfg_kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        except Exception:
            pass
        config = types.GenerateContentConfig(**cfg_kwargs)
        t0 = time.perf_counter()
        # Retry on free-tier rate limits (many concurrent extraction batches
        # can trip the RPM cap); back off and try again a few times.
        resp = None
        for attempt in range(3):
            try:
                resp = self._gclient.models.generate_content(
                    model=model,
                    contents=parts,
                    config=config,
                )
                break
            except Exception as e:
                msg = str(e).lower()
                if attempt < 2 and ("429" in msg or "quota" in msg or "rate" in msg or "resource_exhausted" in msg):
                    time.sleep(1.5 * (attempt + 1))   # 1.5s, then 3s — fail fast instead of stacking 30s timeouts
                    continue
                raise
        latency_ms = int((time.perf_counter() - t0) * 1000)

        # record token usage for the Gemini path too. Gemini reports counts in
        # `usage_metadata`; thinking tokens (2.5 models) are billed as output.
        um = getattr(resp, "usage_metadata", None)
        in_tok = getattr(um, "prompt_token_count", 0) or 0
        out_tok = getattr(um, "candidates_token_count", 0) or 0
        out_tok += getattr(um, "thoughts_token_count", 0) or 0
        cache_read = getattr(um, "cached_content_token_count", 0) or 0
        # Attribute to the model actually used, not self.model — when this
        # runs as a fallback from an Anthropic-backed instance, self.model is
        # still the Claude model id, and mislabeling would both corrupt the
        # cost ledger (charging Claude rates for Gemini tokens) and hide that
        # a fallback happened.
        record_call(
            self.run_id, self.stage, model, in_tok, out_tok, latency_ms,
            cache_read=cache_read,
        )

        return (resp.text or "").strip()

    @staticmethod
    def parse_json(text: str) -> Any:
        """Models occasionally wrap JSON in prose or code fences, or append
        trailing commentary after the actual JSON value. Strip fences/leading
        prose, then parse with raw_decode() — which reads exactly ONE JSON
        value from the start of the string and stops, ignoring whatever
        comes after it. The previous approach (slice to the LAST '}'/']' in
        the whole text, then json.loads the slice) broke with a
        'JSONDecodeError: Extra data' whenever the model appended any
        trailing text that itself contained a brace/bracket — raw_decode()
        can't hit that failure mode since it never looks past the first
        complete value."""
        t = re.sub(r"```json", "", text, flags=re.I).replace("```", "").strip()
        start = next((i for i, c in enumerate(t) if c in "[{"), 0)
        return json.JSONDecoder().raw_decode(t[start:])[0]

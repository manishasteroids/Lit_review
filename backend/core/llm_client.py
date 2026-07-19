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
import re
import time
from typing import Any, Optional

import anthropic

from .config import settings
from .usage import record_call


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
            from google import genai  # lazy import so Claude-only setups don't need it
            # 30s timeout so an invalid key / network issue errors cleanly
            # instead of hanging the pipeline. Falls back if the option is
            # unsupported by the installed google-genai version.
            try:
                from google.genai import types as _gt
                self._gclient = genai.Client(
                    api_key=settings.gemini_api_key,
                    http_options=_gt.HttpOptions(timeout=30_000),
                )
            except Exception:
                self._gclient = genai.Client(api_key=settings.gemini_api_key)
            self._gemini_model = settings.gemini_model if self.model == "gemini" else self.model
        else:
            self.client = anthropic.Anthropic(api_key=api_key or settings.anthropic_api_key)

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
            return self._call_gemini(gem_text, system, max_tokens, content)

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

        t0 = time.perf_counter()
        resp = self.client.messages.create(**kwargs)
        latency_ms = int((time.perf_counter() - t0) * 1000)

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

    def _call_gemini(self, user_text, system, max_tokens, content) -> str:
        """Route the same request to Google Gemini, converting Anthropic-style
        content blocks (text / document / image) into google-genai Parts."""
        from google.genai import types

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
        for attempt in range(4):
            try:
                resp = self._gclient.models.generate_content(
                    model=self._gemini_model,
                    contents=parts,
                    config=config,
                )
                break
            except Exception as e:
                msg = str(e).lower()
                if attempt < 3 and ("429" in msg or "quota" in msg or "rate" in msg or "resource_exhausted" in msg):
                    time.sleep(2 * (attempt + 1))
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
        record_call(
            self.run_id, self.stage, self.model, in_tok, out_tok, latency_ms,
            cache_read=cache_read,
        )

        return (resp.text or "").strip()

    @staticmethod
    def parse_json(text: str) -> Any:
        """Models occasionally wrap JSON in prose or code fences. Strip that."""
        t = re.sub(r"```json", "", text, flags=re.I).replace("```", "").strip()
        start = next((i for i, c in enumerate(t) if c in "[{"), 0)
        t = t[start:]
        end = max(t.rfind("}"), t.rfind("]"))
        if end > -1:
            t = t[: end + 1]
        return json.loads(t)

"""
Thin wrapper around the model providers shared by every agent.
Supports three backbones, chosen by the selected model id:
  - Anthropic (Claude)  — default
  - Google Gemini       — when the model id contains "gemini"
  - OpenRouter          — when the model id contains "/" (OpenRouter's own
                          naming convention for every model it hosts, e.g.
                          "deepseek/deepseek-v3.2", "qwen/qwen3-coder",
                          "meta-llama/llama-4-maverick" — never true of an
                          Anthropic or Gemini model id, so this is unambiguous)
Claude and Gemini accept the same multimodal `content` blocks (text +
document/PDF + image); the Gemini path converts them to google-genai Parts.
OpenRouter is text-only for now (no agent in this codebase sends it images/
PDFs yet) — see _call_openrouter's docstring if that's ever needed.

OpenRouter is deliberately the integration point for open-weight models
(DeepSeek/Qwen/Llama and friends) rather than each vendor's own API: it
speaks the same OpenAI-compatible /v1/chat/completions shape as every
self-hosted serving stack (vLLM, SGLang, Ollama) and as several other
hosted providers (Together, Fireworks). That means switching from "hosted
via OpenRouter" to "self-hosted on our own GPU" later is a `base_url`
change (core/config.py's `openrouter_base_url`) plus a model-id change —
never a rewrite of this file, and removing the whole open-weight
experiment (if it doesn't pan out) is deleting one branch below plus one
config value, since no agent file anywhere references a vendor name.
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


def _build_openrouter_client():
    """OpenRouter speaks the OpenAI wire protocol, so the `openai` SDK works
    unmodified — just pointed at a different base_url and a different key.
    Swapping to a self-hosted vLLM/SGLang endpoint later needs nothing more
    than changing settings.openrouter_base_url; this function doesn't change."""
    from openai import OpenAI
    return OpenAI(api_key=settings.openrouter_api_key, base_url=settings.openrouter_base_url)


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
        if "gemini" in self.model.lower():
            self.provider = "gemini"
        elif "/" in self.model:
            self.provider = "openrouter"
        else:
            self.provider = "anthropic"

        if self.provider == "gemini":
            self._gclient = _build_gemini_client()  # lazy import so Claude-only setups don't need it
            self._gemini_model = settings.gemini_model if self.model == "gemini" else self.model
        elif self.provider == "openrouter":
            self._orclient = _build_openrouter_client()  # lazy import so non-OpenRouter setups don't need `openai`
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

        # Set after every call() to "max_tokens" (Anthropic) or "MAX_TOKENS"
        # (Gemini) when the response was cut off by the token budget rather
        # than the model finishing naturally — e.g. a long structured Deep
        # answer that runs out of room mid-sentence. Callers that care (chat
        # endpoints, where a silently truncated answer just looks broken to
        # the user) can check this right after call() and let the user know,
        # rather than the response ending mid-thought with no explanation.
        self.last_truncated = False

    def call(
        self,
        user_text: Optional[str] = None,
        system: Optional[str] = None,
        tools: Optional[list] = None,
        max_tokens: int = 1200,
        content: Optional[list] = None,
        cache_prefix: Optional[str] = None,
        temperature: Optional[float] = None,
    ) -> str:
        # `temperature` is opt-in and None by default -- omitting it keeps
        # every existing caller (generation/writing stages, where run-to-run
        # variety across the same corpus is fine or even desirable) exactly
        # as it behaved before this parameter existed, using the provider's
        # own default sampling. Callers that need a REPEATABLE judgment
        # (scoring/ranking/verdict agents, not creative generation) pass a
        # low value explicitly -- see agents/hypothesis_critic.py,
        # hypothesis_ranker.py, hypothesis_meta_review.py,
        # hypothesis_plausibility.py, and hypothesis_results_check.py, all of
        # which apply a fixed rubric to given content rather than proposing
        # new ideas, and were the specific source of run-to-run inconsistency
        # in the Hypothesis Agent's final recommendation.
        if self.provider == "gemini":
            # Gemini uses a different caching API; just fold the prefix into the
            # prompt so the call still works (no Anthropic-style caching here).
            gem_text = f"{cache_prefix}\n{user_text or ''}" if cache_prefix else user_text
            return self._call_gemini(gem_text, system, max_tokens, content,
                                      model=self._gemini_model, temperature=temperature)

        if self.provider == "openrouter":
            # No cross-provider fallback here (unlike the Anthropic path
            # below) — this is a new, still-being-evaluated backbone, and
            # silently falling back to Claude/Gemini on a failure would hide
            # exactly the reliability signal that matters while evaluating
            # whether an open-weight model is good enough to keep using.
            or_text = f"{cache_prefix}\n{user_text or ''}" if cache_prefix else user_text
            return self._call_openrouter(or_text, system, max_tokens, temperature=temperature)

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
        if temperature is not None:
            kwargs["temperature"] = temperature

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
            out = self._call_gemini(gem_text, system, max_tokens, content,
                                     model=fallback_model, temperature=temperature)
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

        out = "\n".join(b.text for b in resp.content if b.type == "text").strip()
        if not out:
            # Anthropic returned zero text content (e.g. a refusal, or a
            # response made up entirely of non-text blocks) — this used to
            # propagate as an empty string all the way to json.loads(""),
            # which fails with the cryptic "Expecting value: line 1 column 1
            # (char 0)" deep inside parse_json with no indication the real
            # problem was upstream. Surface it clearly here instead, and
            # fall back to Gemini the same way a hard API error would.
            stop_reason = getattr(resp, "stop_reason", None)
            log.warning(
                "Anthropic call returned empty text (stage=%s model=%s stop_reason=%s)",
                self.stage, self.model, stop_reason,
            )
            if settings.gemini_api_key:
                fallback_model = settings.gemini_model or "gemini-2.5-flash"
                gem_text = f"{cache_prefix}\n{user_text or ''}" if cache_prefix else user_text
                log.warning("Falling back to Gemini (%s) after empty Anthropic response", fallback_model)
                return self._call_gemini(gem_text, system, max_tokens, content,
                                          model=fallback_model, temperature=temperature)
            raise ValueError(
                f"Anthropic returned an empty response (stop_reason={stop_reason}) "
                "and no GEMINI_API_KEY is set to fall back to."
            )
        self.last_truncated = getattr(resp, "stop_reason", None) == "max_tokens"
        return out

    def call_json(
        self,
        user_text: Optional[str] = None,
        system: Optional[str] = None,
        tools: Optional[list] = None,
        max_tokens: int = 1200,
        content: Optional[list] = None,
        cache_prefix: Optional[str] = None,
        temperature: Optional[float] = None,
        retries: int = 1,
    ) -> Any:
        """call() + parse_json(), retrying the WHOLE call (not just re-parsing
        the same broken text) up to `retries` times if the response doesn't
        parse. Every one of parse_json()'s fallback repairs (truncation,
        stray unescaped quotes) is best-effort against known patterns, not a
        guarantee -- a response can still fail to parse for a reason neither
        repair covers, and that used to surface straight to the user as a raw
        Python exception (e.g. "Expecting ',' delimiter: line 7 column 3
        (char 361)") crashing an early pipeline stage like the Query
        Reformulator. These are near-always one-off formatting slips, not a
        deterministic failure, so a fresh call with the same prompt very
        often just succeeds -- turning what was a user-facing pipeline crash
        into an invisible retry. On a retry, the system prompt gets an extra
        line reinforcing strict JSON, in case the first failure was the model
        drifting into markdown/prose rather than a one-off stray character."""
        last_err: Exception | None = None
        for attempt in range(retries + 1):
            call_system = system
            if attempt > 0 and system:
                call_system = system + (
                    "\n\nYour previous response was not valid JSON. Respond with ONLY "
                    "valid, complete JSON this time — no markdown fences, no text "
                    "before or after it, every quote inside a string properly escaped."
                )
            out = self.call(
                user_text=user_text, system=call_system, tools=tools, max_tokens=max_tokens,
                content=content, cache_prefix=cache_prefix, temperature=temperature,
            )
            try:
                return self.parse_json(out)
            except Exception as e:
                last_err = e
                log.warning(
                    "call_json: response didn't parse (stage=%s attempt=%d/%d): %s",
                    self.stage, attempt + 1, retries + 1, e,
                )
        raise last_err

    def _call_gemini(self, user_text, system, max_tokens, content, model: str,
                      temperature: Optional[float] = None) -> str:
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
        if temperature is not None:
            cfg_kwargs["temperature"] = temperature
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

        out = (resp.text or "").strip()
        if not out:
            # Same empty-response problem as the Anthropic path above, but
            # here it's usually a safety block or an empty/missing candidate
            # rather than a refusal — surface the reason instead of quietly
            # returning "" and letting parse_json() fail with an opaque
            # "Expecting value: line 1 column 1 (char 0)" downstream.
            candidates = getattr(resp, "candidates", None) or []
            finish_reason = getattr(candidates[0], "finish_reason", None) if candidates else None
            log.warning(
                "Gemini call returned empty text (stage=%s model=%s finish_reason=%s)",
                self.stage, model, finish_reason,
            )
            raise ValueError(f"Gemini returned an empty response (finish_reason={finish_reason}).")
        candidates = getattr(resp, "candidates", None) or []
        finish_reason = getattr(candidates[0], "finish_reason", None) if candidates else None
        self.last_truncated = str(finish_reason) in ("MAX_TOKENS", "FinishReason.MAX_TOKENS")
        return out

    def _call_openrouter(self, user_text, system, max_tokens, temperature: Optional[float] = None) -> str:
        """OpenRouter's own API is the OpenAI chat-completions shape exactly
        — this is the one path in this file that doesn't need a bespoke
        request/response translation the way Gemini's does. Text-only for
        now (see this module's docstring); a `content`/multimodal parameter
        can be added here the same way Gemini's is, if some future agent
        needs it.

        Reasoning models on OpenRouter (DeepSeek R1, Qwen's "-thinking"
        variants) often emit a visible chain-of-thought before the actual
        answer, either as a separate `reasoning` field on the response or as
        an inline `<think>...</think>` block in the content itself,
        depending on the model. The inline case is handled by
        `parse_json()` stripping a leading `<think>` block before parsing —
        this method deliberately does NOT strip it here, so the full
        reasoning trace (a genuinely useful audit artifact — see this
        session's own discussion of it) still reaches whatever records
        `call()`'s raw return value (e.g. hypothesis_agent/pipeline.py's
        audit log)."""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user_text or ""})

        t0 = time.perf_counter()
        kwargs: dict[str, Any] = {"model": self.model, "messages": messages, "max_tokens": max_tokens}
        if temperature is not None:
            kwargs["temperature"] = temperature
        resp = self._orclient.chat.completions.create(**kwargs)
        latency_ms = int((time.perf_counter() - t0) * 1000)
        if latency_ms > 20_000:
            log.warning(
                "slow OpenRouter call: stage=%s model=%s latency=%.1fs",
                self.stage, self.model, latency_ms / 1000,
            )

        usage = getattr(resp, "usage", None)
        in_tok = getattr(usage, "prompt_tokens", 0) or 0
        out_tok = getattr(usage, "completion_tokens", 0) or 0
        record_call(self.run_id, self.stage, self.model, in_tok, out_tok, latency_ms)

        choice = resp.choices[0] if getattr(resp, "choices", None) else None
        out = ((choice.message.content if choice else None) or "").strip()
        # A "-thinking"/R1-style model can put its entire chain-of-thought in
        # a separate `reasoning` field and leave `content` empty until the
        # final answer — some OpenRouter routes surface this as
        # message.reasoning. Fold it back in front of the content (rather
        # than discard it) so the audit log still captures it, and so an
        # empty `content` with a non-empty `reasoning` doesn't look like a
        # silent failure below.
        reasoning = getattr(choice.message, "reasoning", None) if choice else None
        if reasoning and not out:
            out = f"<think>{reasoning}</think>"
        elif reasoning:
            out = f"<think>{reasoning}</think>\n{out}"
        if not out:
            finish_reason = getattr(choice, "finish_reason", None) if choice else None
            log.warning(
                "OpenRouter call returned empty text (stage=%s model=%s finish_reason=%s)",
                self.stage, self.model, finish_reason,
            )
            raise ValueError(f"OpenRouter returned an empty response (finish_reason={finish_reason}).")
        finish_reason = getattr(choice, "finish_reason", None) if choice else None
        self.last_truncated = finish_reason == "length"
        return out

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
        complete value.

        A reasoning-style open-weight model (DeepSeek R1, Qwen's
        "-thinking" variants, via the OpenRouter backbone) puts a visible
        chain-of-thought in front of its actual answer, as a literal
        `<think>...</think>` block in the text — see _call_openrouter's
        docstring. Strip it first: everything after the LAST `</think>` is
        the real answer. Without this, the fallback below (find the first
        `[`/`{` in the whole text) would seize on any brace the model's own
        reasoning happens to mention before reaching the real JSON — a
        realistic failure mode, since reasoning about "what JSON to produce"
        often mentions JSON syntax inline."""
        if "</think>" in text.lower():
            text = re.split(r"</think>", text, flags=re.I)[-1]
        t = re.sub(r"```json", "", text, flags=re.I).replace("```", "").strip()
        start = next((i for i, c in enumerate(t) if c in "[{"), 0)
        body = t[start:]
        try:
            return json.JSONDecoder().raw_decode(body)[0]
        except json.JSONDecodeError as e1:
            # Common cause #1: the response hit max_tokens mid-value (an
            # "Unterminated string" or missing closing bracket right at the
            # end of the text) — the JSON is otherwise complete/valid, it
            # just got cut off. Try to salvage it instead of discarding an
            # otherwise-good response.
            try:
                return json.JSONDecoder().raw_decode(LLMClient._repair_truncated_json(body))[0]
            except json.JSONDecodeError:
                pass
            # Common cause #2: the model put a literal, un-escaped `"` inside
            # a string value (e.g. a search term like the CISPR "25" standard,
            # or a quoted phrase) — valid English, invalid JSON. That reads as
            # "Expecting ',' delimiter" partway through the document, not at
            # the end, so the truncation repair above doesn't touch it. Walk
            # the text and escape any quote that isn't actually closing a
            # string (i.e. isn't followed by the punctuation JSON expects
            # after a string ends).
            try:
                return json.JSONDecoder().raw_decode(LLMClient._escape_stray_quotes(body))[0]
            except json.JSONDecodeError:
                raise e1

    @staticmethod
    def _repair_truncated_json(t: str) -> str:
        """Best-effort repair for JSON cut off mid-value: close an
        unterminated string, then close any still-open [] / {} in the right
        order. Not a general JSON repair tool — just enough to handle the
        'ran out of output tokens partway through' case."""
        stack: list[str] = []
        in_string = False
        escape = False
        for ch in t:
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
            else:
                if ch == '"':
                    in_string = True
                elif ch in "{[":
                    stack.append(ch)
                elif ch in "}]" and stack:
                    stack.pop()
        repaired = t
        if in_string:
            repaired += '"'
        for opener in reversed(stack):
            repaired += "}" if opener == "{" else "]"
        return repaired

    @staticmethod
    def _escape_stray_quotes(t: str) -> str:
        """Best-effort repair for a literal, un-escaped `"` inside a JSON
        string value (models do this constantly with quoted terms/standard
        names). At each `"` encountered while inside a string, look ahead
        past whitespace: if the next non-space character is one JSON would
        actually expect right after a string ends (`,`, `}`, `]`, `:`, or
        end-of-text), treat it as the real closing quote; otherwise it's a
        stray quote mid-value — escape it and keep going. Not a general JSON
        repair tool, just enough to handle this one common failure mode."""
        out: list[str] = []
        in_string = False
        escape = False
        n = len(t)
        i = 0
        while i < n:
            ch = t[i]
            if in_string:
                if escape:
                    out.append(ch)
                    escape = False
                elif ch == "\\":
                    out.append(ch)
                    escape = True
                elif ch == '"':
                    j = i + 1
                    while j < n and t[j] in " \t\r\n":
                        j += 1
                    nxt = t[j] if j < n else ""
                    if nxt in ",}]:" or j >= n:
                        in_string = False
                        out.append(ch)
                    else:
                        out.append('\\"')
                else:
                    out.append(ch)
            else:
                if ch == '"':
                    in_string = True
                out.append(ch)
            i += 1
        return "".join(out)

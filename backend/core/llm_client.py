"""
Thin wrapper around the Anthropic SDK shared by every agent.
Keeping this in one place means each agent file only has to think about
*what to ask*, not *how to call the model or parse its reply*.
"""
import json
import re
from typing import Any, Optional

import anthropic

from .config import settings


class LLMClient:
    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        self.client = anthropic.Anthropic(api_key=api_key or settings.anthropic_api_key)
        self.model = model or settings.model

    def call(
        self,
        user_text: str,
        system: Optional[str] = None,
        tools: Optional[list] = None,
        max_tokens: int = 1200,
    ) -> str:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": user_text}],
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools
        resp = self.client.messages.create(**kwargs)
        return "\n".join(b.text for b in resp.content if b.type == "text").strip()

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

"""
Tests for the OpenRouter backbone in core/llm_client.py.

WHY THIS BACKBONE EXISTS
------------------------
A third provider alongside Anthropic and Gemini, for open-weight models
(DeepSeek/Qwen/Llama and friends) reached through OpenRouter's single
OpenAI-compatible endpoint. Deliberately built as an isolated branch of
LLMClient with zero references from any agent file — removing it later (or
swapping OpenRouter for a self-hosted vLLM/SGLang endpoint) only ever
touches this one file plus one config value.

These tests mock the `openai` client, so they're fast, free, and
deterministic — no real OpenRouter account/key needed to run them.

Run:
    cd backend
    pytest tests/test_llm_client_openrouter.py -v
"""
from unittest import mock

import pytest

from core.llm_client import LLMClient


def _fake_client(content, reasoning=None, finish_reason="stop", usage=(10, 20)):
    choice = mock.MagicMock()
    choice.message.content = content
    choice.message.reasoning = reasoning
    choice.finish_reason = finish_reason
    resp = mock.MagicMock()
    resp.choices = [choice]
    resp.usage.prompt_tokens = usage[0]
    resp.usage.completion_tokens = usage[1]
    client = mock.MagicMock()
    client.chat.completions.create.return_value = resp
    return client


def test_provider_detection_openrouter():
    """A model id containing '/' (OpenRouter's own convention for every
    model it hosts) selects the openrouter provider, without needing a real
    key/network call — construction alone should not touch the network."""
    with mock.patch("core.llm_client._build_openrouter_client", return_value=mock.MagicMock()):
        c = LLMClient(model="deepseek/deepseek-v3.2", run_id="r1", stage="test")
        assert c.provider == "openrouter"


def test_provider_detection_unaffected_for_gemini_and_anthropic():
    """Adding the openrouter branch must not change routing for the two
    existing backbones."""
    with mock.patch("core.llm_client._build_gemini_client", return_value=mock.MagicMock()):
        assert LLMClient(model="gemini-2.5-flash").provider == "gemini"
    with mock.patch("anthropic.Anthropic", return_value=mock.MagicMock()):
        assert LLMClient(model="claude-sonnet-4-6").provider == "anthropic"


def test_call_sends_openai_compatible_request_and_returns_clean_json():
    with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
        client = _fake_client('{"winner":"a","reason":"clean json"}')
        mbuild.return_value = client
        llm = LLMClient(model="deepseek/deepseek-chat-v3.1", run_id="r1", stage="test")

        out = llm.call(user_text="judge these", system="sys", max_tokens=500, temperature=0.0)

        assert out == '{"winner":"a","reason":"clean json"}'
        assert LLMClient.parse_json(out) == {"winner": "a", "reason": "clean json"}
        kwargs = client.chat.completions.create.call_args.kwargs
        assert kwargs["model"] == "deepseek/deepseek-chat-v3.1"
        assert kwargs["temperature"] == 0.0
        assert kwargs["messages"] == [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "judge these"},
        ]


def test_parse_json_strips_inline_think_block_even_with_a_spurious_brace_inside():
    """A reasoning model's chain-of-thought can itself mention JSON syntax
    (e.g. "the format should be {...}") before the real answer — parse_json
    must skip past the WHOLE <think> block, not just find the first brace
    in the entire text, or it would seize on the brace inside the reasoning."""
    text = (
        "<think>Hypothesis A has {fake brace} in my reasoning about "
        "format... deciding now.</think>\n"
        '{"winner":"b","reason":"real answer"}'
    )
    assert LLMClient.parse_json(text) == {"winner": "b", "reason": "real answer"}


def test_reasoning_only_response_folds_into_think_block_instead_of_looking_empty():
    """Some OpenRouter routes surface a 'thinking' model's chain-of-thought
    as a separate `reasoning` field with `content` still empty until a
    final answer arrives. Treat that as real output (wrapped as a <think>
    block) rather than the empty-response error path."""
    with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
        mbuild.return_value = _fake_client(None, reasoning="thinking hard about this...")
        llm = LLMClient(model="qwen/qwen3-max-thinking", run_id="r1", stage="test")

        out = llm.call(user_text="x", system="sys", max_tokens=500)

        assert out == "<think>thinking hard about this...</think>"


def test_fully_empty_response_raises_clearly():
    with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
        mbuild.return_value = _fake_client("", reasoning=None, finish_reason="content_filter")
        llm = LLMClient(model="meta-llama/llama-4-maverick", run_id="r1", stage="test")

        with pytest.raises(ValueError, match="empty response"):
            llm.call(user_text="x", system="sys", max_tokens=500)


def test_last_truncated_flag_set_on_length_finish_reason():
    with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
        mbuild.return_value = _fake_client('{"a":1', finish_reason="length")
        llm = LLMClient(model="deepseek/deepseek-v3.2")

        llm.call(user_text="x", max_tokens=10)

        assert llm.last_truncated is True

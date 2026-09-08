import sys, os, types, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)
from unittest import mock

# Stub settings before importing llm_client, so config.py's dotenv load etc. doesn't need real env
import core.config as config
config.settings.openrouter_api_key = "test-key"
config.settings.openrouter_base_url = "https://openrouter.ai/api/v1"

from core.llm_client import LLMClient

# ---- Test 1: provider detection ----
with mock.patch("core.llm_client._build_openrouter_client", return_value=mock.MagicMock()) as mbuild:
    c = LLMClient(model="deepseek/deepseek-v3.2", run_id="r1", stage="test")
    assert c.provider == "openrouter", c.provider
    print("TEST 1 (provider detection) PASSED: provider =", c.provider)

with mock.patch("core.llm_client._build_gemini_client", return_value=mock.MagicMock()):
    c2 = LLMClient(model="gemini-2.5-flash")
    assert c2.provider == "gemini"
with mock.patch("anthropic.Anthropic", return_value=mock.MagicMock()):
    c3 = LLMClient(model="claude-sonnet-4-6")
    assert c3.provider == "anthropic"
print("TEST 1b (gemini/anthropic unaffected) PASSED")

# ---- Test 2: normal call, clean JSON content ----
def make_fake_client(content, reasoning=None, finish_reason="stop", usage=(10,20)):
    fake_choice = mock.MagicMock()
    fake_choice.message.content = content
    fake_choice.message.reasoning = reasoning
    fake_choice.finish_reason = finish_reason
    fake_resp = mock.MagicMock()
    fake_resp.choices = [fake_choice]
    fake_resp.usage.prompt_tokens = usage[0]
    fake_resp.usage.completion_tokens = usage[1]
    fake_client = mock.MagicMock()
    fake_client.chat.completions.create.return_value = fake_resp
    return fake_client, fake_resp

with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
    fake_client, _ = make_fake_client('{"winner":"a","reason":"clean json"}')
    mbuild.return_value = fake_client
    c = LLMClient(model="deepseek/deepseek-chat-v3.1", run_id="r1", stage="test")
    out = c.call(user_text="judge these", system="sys", max_tokens=500, temperature=0.0)
    assert out == '{"winner":"a","reason":"clean json"}', out
    parsed = LLMClient.parse_json(out)
    assert parsed == {"winner": "a", "reason": "clean json"}
    # verify request shape
    call_kwargs = fake_client.chat.completions.create.call_args.kwargs
    assert call_kwargs["model"] == "deepseek/deepseek-chat-v3.1"
    assert call_kwargs["temperature"] == 0.0
    assert call_kwargs["messages"][0] == {"role": "system", "content": "sys"}
    assert call_kwargs["messages"][1] == {"role": "user", "content": "judge these"}
    print("TEST 2 (clean JSON call + parse) PASSED")

# ---- Test 3: reasoning model with inline <think> block in content ----
with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
    think_text = "<think>Let's see, hypothesis A has {fake brace} in my reasoning about format... ok deciding now.</think>\n{\"winner\":\"b\",\"reason\":\"real answer\"}"
    fake_client, _ = make_fake_client(think_text)
    mbuild.return_value = fake_client
    c = LLMClient(model="deepseek/deepseek-r1", run_id="r1", stage="test")
    out = c.call(user_text="judge", system="sys", max_tokens=500, temperature=0.0)
    parsed = LLMClient.parse_json(out)
    assert parsed == {"winner": "b", "reason": "real answer"}, parsed
    print("TEST 3 (think-block with spurious brace, correctly stripped) PASSED")

# ---- Test 4: reasoning surfaced via separate `reasoning` field, empty content ----
with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
    fake_client, _ = make_fake_client(None, reasoning="thinking hard about this...")
    # simulate model eventually also filling content after reasoning - here test the empty-content+reasoning-only case
    mbuild.return_value = fake_client
    c = LLMClient(model="qwen/qwen3-max-thinking", run_id="r1", stage="test")
    try:
        out = c.call(user_text="x", system="sys", max_tokens=500)
        print("TEST 4 (reasoning-only, empty content) result out=", repr(out))
        assert out == "<think>thinking hard about this...</think>"
    except ValueError as e:
        print("TEST 4 unexpectedly raised:", e)
        raise
    print("TEST 4 PASSED")

# ---- Test 5: fully empty response raises ValueError ----
with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
    fake_client, _ = make_fake_client("", reasoning=None, finish_reason="content_filter")
    mbuild.return_value = fake_client
    c = LLMClient(model="meta-llama/llama-4-maverick", run_id="r1", stage="test")
    try:
        c.call(user_text="x", system="sys", max_tokens=500)
        print("TEST 5 FAILED (should have raised)")
    except ValueError as e:
        assert "empty response" in str(e)
        print("TEST 5 (empty response raises clearly) PASSED:", e)

# ---- Test 6: truncation flag ----
with mock.patch("core.llm_client._build_openrouter_client") as mbuild:
    fake_client, _ = make_fake_client('{"a":1', finish_reason="length")
    mbuild.return_value = fake_client
    c = LLMClient(model="deepseek/deepseek-v3.2")
    out = c.call(user_text="x", max_tokens=10)
    assert c.last_truncated is True
    print("TEST 6 (last_truncated flag) PASSED")

print("ALL OPENROUTER TESTS PASSED")

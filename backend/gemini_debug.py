"""
One-shot diagnostic: calls Gemini with the REAL extraction prompt on a sample
paper and prints exactly what comes back — so we can see whether the empty
extractions are (a) empty output, (b) valid JSON in a shape the parser rejects,
or (c) a rate-limit/other error.

Run:  cd backend && .venv/bin/python gemini_debug.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from google import genai
from google.genai import types
from agents.reader_extractor import ReaderExtractorAgent, _as_list
from core.llm_client import LLMClient

key = (os.environ.get("GEMINI_API_KEY") or "").strip()
model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
print(f"model = {model} | key starts {key[:6]}… ({len(key)} chars)\n")

sample = (
    "[#0] The STRING database (2023). STRING systematically collects and "
    "integrates protein-protein interactions from text mining, experiments, "
    "co-expression and curated databases, scoring each interaction.\n"
    "[#1] AlphaFold protein structure (2021). A deep-learning system predicts "
    "3D protein structure from sequence with high accuracy on CASP14 (GDT ~92)."
)

client = genai.Client(api_key=key)

cfg = dict(max_output_tokens=3000, system_instruction=ReaderExtractorAgent.SYSTEM)
try:
    cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
    print("thinking_config: APPLIED (thinking disabled)\n")
except Exception as e:
    print(f"thinking_config: NOT SUPPORTED by this SDK -> {e}\n")

try:
    resp = client.models.generate_content(
        model=model,
        contents=[types.Part.from_text(text=f"Papers:\n{sample}")],
        config=types.GenerateContentConfig(**cfg),
    )
except Exception as e:
    print("!!! generate_content raised:", type(e).__name__, str(e)[:300])
    raise SystemExit(1)

print("=== usage_metadata ===")
print(resp.usage_metadata)
print("\n=== RAW resp.text (repr) ===")
print(repr(resp.text))

print("\n=== parse_json result ===")
try:
    parsed = LLMClient.parse_json(resp.text or "")
    print("type:", type(parsed).__name__)
    print("value:", parsed)
    print("\n=== after _as_list (what the extractor keeps) ===")
    rows = _as_list(parsed)
    print(f"{len(rows)} extraction(s):")
    for r in rows:
        print(" ", {k: r.get(k) for k in ("idx", "method", "finding", "concepts")})
except Exception as e:
    print("PARSE FAILED:", type(e).__name__, e)

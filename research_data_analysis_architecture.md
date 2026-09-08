# Research Data Analysis Agent — System Architecture (v1)

*Working document, v1 — design only, nothing built yet. Scope locked in from two decisions: (a) users describe an analysis in plain language and the agent generates + runs code on demand, rather than only picking from a fixed tool menu; (b) the data is the user's own uploaded datasets (CSV/Excel/etc.), not data extracted from Sift's literature corpus. This is deliberately the third, independent product alongside Sift and the Hypothesis Agent — same two-service-topology reasoning as the Hypothesis Agent doc §1: its own process, its own deploy, zero dependency on the other two being up.*

---

## 0. Direct answer first

The one piece of this that is a genuinely new engineering problem — not a variant of anything Sift or the Hypothesis Agent already do — is **running LLM-generated code safely**. Everything else (model routing, provider abstraction, cost tracking, audit log) is the same pattern you already have from the OpenRouter work, reused. Get the sandbox right first; the rest is comparatively routine.

Model layer: **Qwen3 Coder is the right default**, not DeepSeek. It's the one open-weight model in your five that's specifically tuned for code generation, it's cheap ($0.22/$1.80 per M tokens), and "write correct pandas/numpy code from a natural-language request" is exactly its training target. DeepSeek V3.2 is the fallback and the model for anything that isn't code generation (interpreting results in prose, deciding which analysis fits a request). Reasoning models (DeepSeek R1, Qwen3 Max Thinking) are the wrong tool here — chain-of-thought depth doesn't help write correct pandas calls, it just costs more.

## 1. The core loop

```
User uploads dataset (CSV/XLSX)
        │
        ▼
Schema sniff (columns, dtypes, row count, head preview) — plain code, no LLM
        │
        ▼
User describes the analysis in plain language
        │
        ▼
Code-gen agent (Qwen3 Coder) writes a Python snippet
  against the sniffed schema — pandas/numpy/scipy only
        │
        ▼
Snippet runs in an isolated sandbox: no network, capped
  CPU/memory/wall-clock, capped output size
        │
        ├─ success → result (table / number / chart) + the code shown to the user
        │
        └─ failure (exception, timeout) → error fed back to the code-gen agent
             for one retry, then surfaced to the user as-is (no infinite retry loop)
        │
        ▼
Optional: a second, cheap model call turns the raw result into a
  one-paragraph plain-language interpretation (DeepSeek V3.2, not Qwen3 Coder —
  narration isn't a coding task)
```

Two things worth calling out because they're easy to get wrong:

- **Show the generated code, always.** This isn't optional polish — it's the trust mechanism. A user running statistical analysis on their own data needs to be able to see and sanity-check what actually ran, the same way the Hypothesis Agent's audit log lets you see what a judge actually scored. Never execute silently and show only a result.
- **One retry, not a loop.** If the generated code throws, feed the exact traceback back to the model once and let it fix its own bug (this is the single highest-value use of the retry — off-by-one column names, wrong dtype assumptions). If it fails twice, stop and show the user the error and the code, rather than burning tokens on a third/fourth attempt that's unlikely to fix a conceptual mistake.

## 2. The sandbox — the actual hard part

This is new infrastructure Sift and the Hypothesis Agent don't need, because neither of them executes model-written code. Do not skip straight to "just use `exec()`" — a code-gen agent will, sooner or later, write something that reads environment variables, opens a socket, or spins forever, not out of malice but because nothing in its prompt told it not to, and because open-weight models via OpenRouter are less consistently safety-tuned around this than Claude.

Minimum bar, in order of how much it matters:

1. **No network access from the sandbox process.** Non-negotiable — this is what stops a generated script from exfiltrating the dataset or calling out anywhere, intentionally or not.
2. **Process isolation, not just a `try/except` around `exec()`.** Run the snippet as a genuinely separate OS process (subprocess with a restricted environment) at minimum; a container (Docker, gVisor) or a hosted sandbox (e.g. an ephemeral container-per-run service) is stronger and worth it once this is past prototype stage. `exec()` in-process shares your server's memory and can be escaped.
3. **Resource caps**: wall-clock timeout (a few seconds to low tens of seconds, not minutes), memory ceiling, CPU ceiling. A generated `while True` or an accidental O(n³) join over a large CSV should fail fast and cheaply, not hang a worker.
4. **Filesystem scope**: the snippet can read the uploaded dataset and write nothing outside a throwaway temp directory that's wiped after the run. No access to the rest of the server's filesystem, no access to `.env`/API keys.
5. **Import allowlist**: restrict to pandas/numpy/scipy/matplotlib (or whatever chart library) plus the standard library subset actually needed — not arbitrary `import os`, `import subprocess`, `import socket`.
6. **Output size cap**: a generated script that returns a 500MB dataframe as "the result" needs to be truncated/rejected before it comes anywhere near the LLM interpretation step or the response payload.

This list is exactly why the earlier architecture work (LLMClient, provider abstraction) doesn't help here — it solves "call a model cheaply and swappably," this solves "don't let the model's output hurt you." They're independent problems and the sandbox is the one to get right first, before spending effort on tool-library breadth.

## 3. Model layer: fitting into what's already built

No new provider abstraction needed — this reuses `LLMClient`/`config.py`/`model_policy.py` exactly as built for the Hypothesis Agent, with one addition: a new *purpose* in the per-purpose routing (`model_policy.py` already routes mechanical stages → `FAST_MODEL`, synthesis/eval → `MID_MODEL`, user-selected → Writer). Add a fourth:

| Purpose | Default model | Why |
|---|---|---|
| `code_gen` | `qwen/qwen3-coder` | Coder-tuned, cheap, this is its whole job |
| Result narration | `deepseek/deepseek-v3.2` | Cheap general model, prose not code |
| User-selected override | whatever the picker has live | Same swappable-backbone pattern as everywhere else — a user who doesn't trust Qwen3 Coder's output on a given dataset can force Claude Sonnet instead, same dropdown pattern as Hypothesis Agent |

Because this reuses `LLMClient` unchanged, the "easy to remove or swap later" property you required for the OpenRouter integration carries over automatically — nothing here is a new place a vendor name leaks into agent code. The only new file is a `code_gen` prompt template and the sandbox runner; both call `self.llm.call(...)` exactly like every existing agent.

One real difference from the Hypothesis Agent's use of these models: there, output is JSON judged for content. Here, output is *code* that then executes — so `parse_json`'s `<think>`-stripping logic doesn't directly apply, but the same principle does: if you route `code_gen` through a reasoning model by mistake (Qwen3 Max Thinking, R1), you'd need to strip a `<think>` block out of a code fence before executing it, or you execute garbage. Recommend the `code_gen` purpose is hard-pinned to non-reasoning models only, at least until there's a concrete reason to reconsider — reasoning depth isn't the lever for code correctness here, and it adds exactly this class of parsing risk into something that gets `exec`'d.

## 4. Data ingestion

Plain code, no LLM, mirrors Sift's existing upload handling:

- Accept CSV/XLSX/TSV (start narrow — these cover the large majority of "research data" a user would upload; add Parquet/JSON later if asked).
- Sniff schema on upload: column names, inferred dtypes, row count, a head-of-file preview. This is what gets fed into the code-gen prompt as ground truth about the dataset's actual shape — the single biggest lever against hallucinated column names is giving the model the real schema, not asking it to guess.
- Size cap on upload (protects both the sandbox's memory ceiling and your own storage) — a few tens of MB is a reasonable starting cap; revisit if real usage needs more.
- Store the same way Sift stores uploaded source files today (`UPLOADS_DIR`, keyed by run id) — no new storage mechanism needed.

## 5. Built-in tools vs. fully on-demand generation

You picked on-demand generation over a fixed tool library, which is the right call to *start* with — it's the smaller build (no separate tool-definition/registry system) and it's strictly more flexible for a v1 where you don't yet know which analyses users actually want. Two things worth deciding explicitly rather than by default:

- **A small set of few-shot examples in the code-gen prompt, not a tool registry.** Give Qwen3 Coder 3-5 worked examples of "request → correct pandas/scipy snippet" covering the analyses you already know matter (a time-series trend/seasonality decomposition, a t-test or correlation, a basic regression) — this is prompt engineering, not infrastructure, and it meaningfully raises first-try correctness without building the "reusable tool" system you explicitly deferred.
- **Caching identical requests is cheap insurance later, not a v1 requirement.** If the same user re-runs "compute the correlation matrix" on the same dataset shape twice, regenerating code both times is wasted tokens — but this is a nice-to-have to revisit once you see real usage patterns, not something to build speculatively now.

## 6. Suggested build order

1. **Sandbox runner first, in isolation, with a hardcoded test script** — prove the isolation model (subprocess/container, resource caps, no network) actually holds before any LLM is involved. This is the part that's expensive to get wrong after the fact.
2. **Upload → schema sniff → code-gen (Qwen3 Coder) → sandbox execute → raw result**, no narration yet, no chart rendering yet — the smallest end-to-end loop that proves the concept.
3. **The one-retry-on-failure path** — feed tracebacks back for a single correction attempt.
4. **Result narration** (DeepSeek V3.2) and basic chart rendering.
5. **`code_gen` purpose wired into `model_policy.py`'s per-purpose routing**, with the user-override dropdown matching the existing Hypothesis Agent picker pattern.
6. Only after real usage: reusable tool registry, caching, broader file-format support.

## 7. Open questions for you

- **Isolation strength for v1**: plain subprocess with `resource` limits (fast to build, weaker isolation) vs. a container-per-run (stronger, more infra to stand up)? Given this handles arbitrary user data and arbitrary generated code, I'd lean toward not shipping past a small internal pilot on subprocess-only isolation — worth deciding your risk tolerance explicitly rather than defaulting.
- **Where does this live relative to Sift/Hypothesis Agent in the frontend** — a third top-level app, or a tab inside the existing shell? (Note: Sift already has a "Data analysis" tab name in use for the year-chart/comparison-table side module — this new agent needs a different label to avoid confusion, e.g. "Data Workbench" or similar.)
- **Chart library** for rendering results — matplotlib (server-renders a static image, simplest to sandbox) vs. something that ships interactive charts to the frontend (more capability, more surface area to secure since it's more than a static image coming out of the sandbox).

# Data Analysis Agent — Architecture (v1, strategy only, no code yet)

*Working document. Companion to `hypothesis_agent_architecture.md`, same
purpose: settle the shape of a new agent pipeline before writing any of it.
Nothing in this document is built.*

---

## 0. Direct answer first

You already have a module called `pipeline/data_analysis.py` — it is not
this. That module is a Sift **side view**: it counts publication years and
builds a comparison table across the papers a Sift run found. It never
touches a researcher's own dataset and involves zero LLM calls. What you're
asking for is a new, separate capability: a researcher uploads *their own*
data (a spreadsheet of measurements, assay results, survey responses,
whatever), and the pipeline explores it and produces figures good enough to
put in a paper. Different input, different output, different agent. I'd
rename the existing module's *concept* in conversation to "corpus
analytics" to stop the two from colliding in your head — no code change
needed for that, just don't call the new thing "the data analysis agent"
without qualifying it.

Three decisions drive everything below, and I'd flag disagreement with any
of them before you read further:

1. **The LLM never writes or runs plotting code.** It writes a structured
   *plot spec* (chart type + which columns + how to aggregate); a
   deterministic renderer turns that into the actual figure. The
   alternative — let the model emit matplotlib code and `exec()` it — is a
   real security hole (arbitrary code execution on whatever the model
   decides to write, sandboxed or not) for a benefit (more flexible charts)
   you don't need yet. Same trim logic as the hypothesis doc's §2: don't
   pay for infrastructure risk the current scale doesn't justify.
2. **The LLM never computes statistics.** t-tests, correlations, means,
   confidence intervals — all `scipy`/`numpy`, all deterministic, all
   already correct. The LLM's job is to *choose* which test/plot makes
   sense for the data shape, and to *write the caption* once the numbers
   exist. This mirrors the hypothesis doc's own principle in reverse: just
   as UCB/novelty-scoring aren't "agents" because they're not LLM calls,
   arithmetic shouldn't become an LLM call either, because LLMs get
   arithmetic wrong in ways a library doesn't.
3. **New dependencies here are the free/local kind, not the paid/hosted
   kind.** `pandas`, `numpy`, `scipy`, `matplotlib` are pip installs, no
   API key, no monthly bill, no new account — the same category as
   `python-docx`/`python-pptx`/`reportlab` already in `requirements.txt`,
   not the category of Neo4j/FAISS the hypothesis doc correctly refused.
   Adding them doesn't violate the "don't add infra you don't need"
   principle; it's the same kind of addition as adding `openpyxl` was.

## 1. What's actually an agent (LLM call) vs. what's just code

Re-deriving the component list the way the hypothesis doc's §2 did —
counting only real LLM calls:

| # | Component | LLM call? | What it does |
|---|---|---|---|
| — | **Ingest & profile** | No | Load CSV/XLSX with `pandas`; infer dtypes, row/column counts, missing-value rate, min/max/mean per numeric column, unique-value counts per categorical column. Plain code, near-free, runs in-process. |
| 1 | **Analysis Planner** | **Yes** | Given the profile (column names, dtypes, a small sample of rows, summary stats — never the full dataset, to keep the prompt small and avoid leaking large data into the LLM call unnecessarily) plus the researcher's stated question (optional free-text), proposes 3–6 candidate analyses as structured **plot specs**: chart type, x/y/group columns, aggregation, and a one-line rationale for why this view matters for the stated question. This is the one genuinely valuable LLM step — same role `QueryReformulator` plays for Sift. |
| — | **Stats engine** | No | For each plot spec that implies a statistical claim (group comparison, correlation, trend), run the matching `scipy` test (Welch's t-test / ANOVA / Pearson or Spearman correlation / linear regression) and attach the real numbers (statistic, p-value, effect size, CI) to that spec. Deterministic, exact, cheap. |
| — | **Renderer** | No | Turns a validated plot spec + its attached stats into an actual `matplotlib` figure using one shared publication style sheet (§4). Exports PNG (screen/export embedding) and SVG or PDF (true vector, for a researcher who wants to drop it straight into a manuscript). Deterministic — same spec always renders the same figure. |
| 2 | **Caption Writer** | **Yes** | Given one rendered figure's spec + its real computed statistics, writes a publication-style caption ("Figure 1. X vs Y, grouped by Z (n=…, p=…, Welch's t-test)") and a short plain-language interpretation paragraph. Never touches the numbers — only describes numbers it's handed. |
| — | **Refine (direct edit)** | No | A researcher can hand-edit any plot spec (swap chart type, flip axes, change color/log-scale) and re-render instantly — no LLM call, same "the user is always allowed to overrule the agents" principle as `update_hypothesis`. |
| 3 | **Refine (ask agent)** *(optional, phase 3)* | Yes | "Make this presentation-ready instead of exploratory" / "I don't think a bar chart is right here" — one more Planner-shaped call that revises a single spec given the researcher's free-text objection, same shape as the hypothesis agent's `respond_to_challenge`. |

**Net: 2 LLM agents for the MVP (Planner + Caption Writer), a 3rd
(conversational refine) only once the constrained direct-edit path proves
insufficient.** Everything else is `pandas`/`scipy`/`matplotlib` — no
framework, no new model provider, no vector store, no code execution
sandbox.

## 2. Why constrained specs, not free-form code generation

This is the one place I'd push back hardest if you're inclined toward
"let the model just write the plotting code" — worth spelling out why.

| | Constrained plot spec (recommended) | LLM-generated code |
|---|---|---|
| Security surface | Zero — the spec is a validated Pydantic object, never executed as code | Real — you'd be running model output with `exec()`/subprocess, on a server, against a researcher's uploaded data |
| Reliability | Renderer is one tested function; a spec either validates or it doesn't | Model-written code can raise, hang, import something unexpected, or silently produce a wrong-but-plausible-looking chart |
| Consistency | Every figure uses the same style sheet automatically (§4) — this is what "publication-ready" actually cashes out to: consistent fonts, consistent DPI, consistent color palette across every figure in one export | Each generated snippet reinvents styling; consistency across a researcher's whole figure set isn't guaranteed |
| Auditability | The spec IS the audit log entry — small, diffable, human-readable | Generated code is harder to review at a glance and harder to diff across a "refine" round |
| Cost to extend | Add a new chart type = one new case in the renderer, once | No cumulative benefit — you're generating fresh code every time regardless |

The ceiling of a constrained spec is lower (you can't ask for a chart type
that isn't implemented yet), but the floor is much higher, and the ceiling
is easy to raise incrementally by adding chart types to the renderer as
real requests come in — you don't have to guess the full set up front.
Recommend starting with: bar (grouped/stacked), line, scatter (with
optional trendline), box/violin, histogram, and a correlation heatmap.
That covers the large majority of what shows up in a typical results
section.

## 3. Where this plugs into the existing pipeline

### 3.1 Standalone by default, same "one-directional dependency" rule

Same rule the hypothesis doc set for Sift↔Hypothesis Agent: a researcher
must be able to upload a dataset and get figures **without ever having run
Sift or the Hypothesis Agent.** This is not a literature tool — it's a
sibling capability that happens to live in the same app. So:

- The Analysis Planner's required input is the dataset profile. A stated
  research question (free text) is optional. Sift/Hypothesis Agent context
  is *also* optional and additive, never required.
- **Optional enrichment**: if a Sift run or a Hypothesis Agent champion
  hypothesis exists for this session, its topic/claim can be passed to the
  Planner as extra context ("bias suggested analyses toward what would
  support or refute this hypothesis"). This is the same shape as the
  Hypothesis Agent reading Sift's Literature Package — read-only, one
  direction, and the Data Analysis Agent works identically with that
  context absent.

### 3.2 Same process for now, per your own precedent

The hypothesis doc's §1 designed a two-service split, then §1's own
retrospective note says it shipped same-process anyway ("start same
process, extract later"), because at this scale two processes cost fault
isolation you don't yet need and gain you nothing you're using. Same
reasoning applies here, probably more strongly — this feature has *less*
reason to run standalone than the Hypothesis Agent did (no separate
long-running bracket, no separate database of its own beyond storing plot
specs+figures against the existing run/session). Recommend: same FastAPI
app, same deploy, new router file (`api/data_analysis_routes.py`, mirroring
`api/hypothesis_routes.py`'s separation from `api/routes.py` — separate
file for a separate concern, not a separate process).

### 3.3 New files, following the repo's existing split

```
backend/
├── agents/
│   ├── data_analysis_planner.py     # Planner (LLM)
│   └── data_analysis_captioner.py   # Caption Writer (LLM)
├── core/
│   ├── data_profile.py              # ingest + profile (no LLM)
│   ├── data_stats.py                # scipy test runner (no LLM)
│   └── plot_style.py                # the one shared style sheet (§4)
├── pipeline/
│   ├── data_analysis_pipeline.py    # orchestration: profile -> plan -> stats -> render -> caption
│   └── plot_renderer.py             # spec -> matplotlib figure (no LLM)
└── api/
    └── data_analysis_routes.py      # upload / plan / render / refine / export endpoints
```

`pipeline/data_analysis.py` (the existing corpus-analytics module) is
untouched — different job, different file, no rename forced on it unless
you want one for clarity.

### 3.4 Reused as-is, no changes needed

- `core/llm_client.py`'s `LLMClient` + per-purpose model routing
  (`FAST_MODEL`/`MID_MODEL`) — Planner and Captioner are exactly the
  "mechanical stage" and "synthesis stage" split `model_policy.py` already
  encodes. Planner → fast model (structured classification-shaped task,
  same tier as Query Reformulator); Captioner → mid model (short but
  genuinely generative prose, same tier as the Synthesizer).
- The `Agent(ABC)` pattern — two new small agent classes, not a new
  framework.
- `settings.uploads_dir` — the exact mechanism already storing uploaded
  PDFs/DOCX keyed by run id extends directly to uploaded CSV/XLSX. Same
  size-cap pattern as `MAX_BODY_BYTES`/the 50MB PDF check in
  `api/routes.py` (recommend a lower cap for tabular data — see §6).
- `core/exporters.py` — once a researcher picks which figures to keep,
  embedding PNGs + captions into the existing DOCX/PPTX/PDF export path is
  additive to that module, not a new exporter. A "Figures" section slots in
  next to the existing literature-review sections.
- The `on_progress` SSE + audit-log pattern from
  `hypothesis_agent/pipeline.py` — reused verbatim: `emit("profile", ...)`,
  `emit("planning", ...)`, `emit("rendering", ...)`, same shape the rail
  components already know how to render.
- The direct-edit / "argue with the agent" human-in-the-loop shape from
  `update_hypothesis` / `dispute_hypothesis` — a plot spec is edited the
  same way a hypothesis is: free, instant, no LLM call, and the researcher
  can always simply override what the Planner proposed.

### 3.5 Genuinely new

- `pandas`, `numpy`, `scipy`, `matplotlib` in `requirements.txt` (§0.3 —
  free/local, same category as existing deps, not a category violation).
- A CSV/XLSX ingest step — nothing in the current stack parses tabular
  data files; PDF/DOCX text extraction (`core/paper_text.py`) doesn't
  transfer.
- The plot-spec schema itself (new Pydantic models in `core/models.py` or
  a new `core/plot_models.py` — `PlotSpec`, `StatResult`, `FigureResult`).
- `plot_style.py` — a single source of truth for what "publication-ready"
  means here: font family/size, DPI (300 for raster export), a
  colorblind-safe categorical palette, consistent axis-label and
  figure-title conventions, no default matplotlib "Arial at 72dpi with the
  default blue" look. This is the module that actually earns the phrase
  "publication-ready" — without it you get functional charts that still
  look like a script output, not a figure.

## 4. What "publication-ready" concretely means here

Worth being explicit, since it's doing a lot of work in the ask:

- **Vector export** (SVG and/or PDF) alongside PNG — a raster-only chart
  is not publication-ready by most journals' own submission standards;
  reviewers/typesetters expect vector or ≥300dpi raster.
- **One consistent style sheet** across every figure in a given
  export — same font, same DPI, same palette — so a results section
  doesn't look like six different tools made six different charts.
- **A real caption**, not just a title — journals expect
  "Figure N. What this shows. (n=…, statistic, p-value where relevant)",
  which is exactly the Caption Writer's job in §1.
- **Colorblind-safe, print-safe by default** — a categorical palette that
  survives grayscale printing and common color-vision deficiencies,
  matching how you'd want any scientific figure to actually get used.
- Explicitly **not** in scope for "publication-ready": journal-specific
  submission templates (exact column widths for a specific journal's
  house style). That's a real rabbit hole — defer until a specific journal
  requirement is named, same "concrete case first" bar the hypothesis
  doc's §6.1 used for its own deferred items.

## 5. Suggested build order

Mirrors the hypothesis doc's §8.5 shape — cheapest, highest-value slice
first, defer the rest until real use justifies it:

1. **Ingest + profile + Planner + deterministic render (no stats, no
   captions yet).** Upload a CSV, get back 3–6 sensible charts as PNG.
   This alone is already useful and is the smallest slice that proves the
   spec→renderer approach end to end.
2. **Stats engine + Caption Writer.** Real numbers attached to each figure,
   real captions. This is what turns "some charts" into "results-section
   material."
3. **Direct-edit refine** (free) — swap chart type/columns/scale on any
   spec, instant re-render.
4. **Export integration** — selected figures + captions flow into the
   existing DOCX/PPTX/PDF export alongside the rest of a project's output.
5. *(Deferred, build only if #1–4 in real use show it's needed)*
   **Conversational refine** (§1's LLM agent 3) and **optional
   Sift/Hypothesis Agent context enrichment** (§3.1). Both are additive,
   neither blocks anything above, and both are cheap to bolt on later
   because the Planner already has a stable interface to extend.

## 6. Open questions

1. **Input formats**: CSV + XLSX cover the large majority of what a
   researcher will actually have. Worth also supporting bare JSON records
   or a Google Sheets link, or is CSV/XLSX enough for v1?
2. **Size caps**: PDFs are capped at 50MB. A spreadsheet with hundreds of
   thousands of rows will blow up both the profiling step's cost and the
   Planner prompt's size if summary stats aren't aggressively summarized.
   Proposing a row cap (e.g. 100k rows, or a "your data has 400k rows,
   we're profiling from a random 50k-row sample" fallback) — want a
   specific number, or is "reasonable default, revisit if it bites" fine?
3. **Where does a dataset attach?** — to an existing Sift/Hypothesis
   project (so figures live alongside a literature review), or can a
   researcher start a data-analysis-only session with no project at all?
   Affects whether this needs its own top-level nav entry or lives inside
   the existing project shell.
4. **Model tier for the Planner** — proposing FAST_MODEL (same tier as
   Query Reformulator, since it's a structured-output classification-shaped
   task) rather than MID_MODEL. Agree, or does picking the *right* chart
   type for messy real-world data warrant the stronger model?
5. Any concrete dataset you already have in mind as the first real test
   case? Same value here as the hypothesis doc's open item 4 (“a concrete
   example that disappointed you”) — a real dataset with real quirks
   (missing values, mixed types, a wide format that needs melting) will
   surface spec-schema gaps faster than a clean synthetic example would.

---

## 7. Response to the Gemini research you pasted

Same treatment the hypothesis doc's §0 gave its own pasted proposal: a
reasonable menu of ideas, several genuinely worth adopting, several that
are the "looks like the papers/blog posts, not sized for where you
actually are" trap. Going point by point rather than accepting or
rejecting the whole thing.

### 7.1 Genuinely worth adopting — folds into §1/§4 above, no new decision needed

The **statistical-test menu and plot-type list** (its 3rd exchange) is the
best material in the transcript and belongs directly in this doc's §4/§1,
expanding the "publication-ready" bar:

- **Test selection, not just test execution**: the Stats engine (§1) should
  pick Welch's *t* vs. Mann-Whitney, ANOVA vs. Kruskal-Wallis, Pearson vs.
  Spearman based on a normality check (Shapiro-Wilk) and variance check
  (Levene's), rather than always defaulting to the parametric version.
  Cheap to add — it's a branch in the deterministic Stats engine, not a
  new agent.
- **Effect sizes alongside p-values** (Cohen's *d*, *R²*) — one more field
  in `StatResult`, not new infrastructure. A p-value without an effect
  size is exactly the kind of thing a reviewer flags.
- **A richer chart-type set for the Renderer**: raincloud plots (violin +
  box + jittered points — genuinely the modern default over a bare bar
  chart), box/violin with significance brackets, Q-Q plots, a correlation
  heatmap with hierarchical clustering, PCA scree/2D projection, forest
  plots, Kaplan-Meier curves, Bland-Altman. All of these are still "spec →
  deterministic matplotlib function" under §2's architecture — they don't
  change the design, they just mean the Renderer needs more chart-type
  cases than the six named in §2. Recommend: ship the original six first
  (§5 phase 1), add raincloud/heatmap+dendrogram/PCA/significance-bracket
  box plots in phase 2 alongside the Stats engine (they're what makes the
  Stats engine's output visible), and treat forest plots/Kaplan-Meier/
  Bland-Altman as **on-demand, domain-triggered** additions — build the
  first one only when a researcher's data actually needs it (survival
  data → Kaplan-Meier), not speculatively.
- **Style templates per publisher** (Nature/Science/IEEE-flavored presets
  on top of the one shared style sheet from §4) — a reasonable phase-2
  extension of `plot_style.py`: instead of one hardcoded style, 2-3 named
  presets. Still zero new infrastructure, just more constants in one file.
- **Auto-generated results-paragraph text** ("A Welch's t-test revealed a
  statistically significant difference… t(42.3)=3.14, p=0.0031, d=0.82")
  is exactly the Caption Writer's job, just spelled out more concretely
  than §1 did — worth using this transcript's phrasing as the actual
  target output format for that agent's prompt.

None of this changes §1's two-agent count or §2's spec-not-code
architecture. It's entirely inside the Stats engine and Renderer, both
deterministic, both already scoped to grow incrementally.

### 7.2 The one real disagreement: code execution vs. constrained specs

The transcript's own answer flips position mid-conversation. Its first
answer (architecture diagram, "Sandboxed REPL / Code Execution") assumes
the LLM writes and runs arbitrary Python. Its *own* answer to "why do I
need MCP" backs off the ecosystem/BYOT framing but still lands on "Agent
generates Python execution code… Backend executes code in a secure
container" — i.e., still code generation + execution, just without MCP
around it. §2 of this doc recommends against that, for the security and
consistency reasons already laid out there. Restating the actual trade-off
plainly since it's a real fork, not a settled question:

- **Code-gen + sandboxed execution** genuinely does cover more cases with
  less up-front engineering per chart type — a Docker/Firecracker/WASM
  sandbox, once built, handles any chart or transform a researcher can
  describe, including ones nobody anticipated. The cost is that sandbox
  itself: real infrastructure (container orchestration, resource limits,
  network isolation so a "sandboxed" script can't exfiltrate the dataset
  or phone home), ongoing security surface, and non-determinism (the same
  request can produce subtly different code, and therefore a subtly
  different-looking figure, run to run) — the opposite of the
  reproducibility the transcript itself says researchers need ("full
  reproducibility logs… researchers will not trust a black-box analysis").
  A spec is trivially reproducible (same spec, same figure, forever); a
  freshly generated script is not, unless you also snapshot and pin the
  exact code every time — which just re-derives a spec by another name,
  minus the validation.
- **Constrained specs** cover less out of the box (only chart types you've
  implemented) but cost nothing in sandbox infrastructure, are exactly
  reproducible by construction, and match the "no new paid/hosted infra"
  bar §0.3 set for this whole doc — a Docker/Firecracker sandbox is a real
  new operational dependency (something to run, patch, and monitor
  in production), not a pip install.

Recommendation unchanged from §2: **ship spec-based, and treat "let a
researcher request a genuinely novel chart type we haven't built" as the
concrete-case trigger for revisiting code execution later** — same
"defer until real usage shows you need it" bar this doc and the hypothesis
doc both use everywhere else. If that day comes, it's an *additional*
escape-hatch path alongside the spec renderer, not a replacement for it —
most requests should still hit the fast, reproducible, free path.

### 7.3 Cut for now — real ideas, wrong scale

Same "not a rejection of the idea, a right-sizing to where Samhita
actually is" framing as the hypothesis doc's §2:

| Idea (from the transcript) | Why it's cut for now |
|---|---|
| **MCP / "bring your own tools"** — researchers write and register their own analysis functions via an MCP server | The transcript's *own* answer to being asked directly says "start without it" and only reach for it once researchers ask for on-prem/private-data execution or internal DB hooks — that concrete case hasn't happened yet. Revisit the day it does; nothing in §1-§5's design blocks adding it later, since a spec-based Planner and an MCP tool call are orthogonal (a future MCP tool could just be one more thing the Planner is allowed to call). |
| **Domain file parsers** (DICOM, HDF5/NetCDF) | No evidence yet that a Samhita researcher has this data shape. CSV/XLSX (already §6 open question 1) covers the near-term case; add a parser when a specific researcher brings a specific file that needs one. |
| **Experiment-tracker integration** (Weights & Biases, MLflow) | A different product (ML training-run tracking) from what this pipeline does (a researcher's own dataset → figures). Out of scope, not merely deferred. |
| **Causal inference / power analysis / sensitivity analysis** (propensity matching, instrumental variables, DAGs, Cohen's-d-driven sample-size calculators) | Real, valuable, and squarely "Stats engine, phase-3-or-later" — each is its own well-defined `scipy`/`statsmodels` function, no architectural change, just more menu items once the core test-selection logic (§7.1) is live and the basic pipeline has real usage. Not cut, just sequenced behind the essentials. |
| **Multi-language runtime** (Python *and* R *and* Julia) | Samhita's entire backend is Python; every dependency named in §3.5 is a Python package. Supporting R/Julia means a second runtime and a second sandbox story for a benefit (an R-only stats routine) `scipy`/`statsmodels` almost always already covers. No concrete case for it yet. |
| **Open-weight orchestrator/execution models** (Qwen2.5-Coder, DeepSeek, Llama 3.3 via OpenRouter) | Worth noting separately, §7.4 — not a flat "cut," a genuine "not yet, and here's the actual condition under which it'd make sense." |

### 7.4 Model choice: the OpenRouter point is real, just not triggered yet

Interesting alignment: Samhita's `core/config.py` and `llm_client.py`
*already* wire up OpenRouter as "the third backbone" specifically so
"swapping this key for a self-hosted endpoint later is a base_url change,
not a rewrite" (per that file's own docstring) — so if you ever do want
Qwen2.5-Coder or DeepSeek for this pipeline, there's genuinely no new
infrastructure to add, just a model-id string.

But the transcript's reasoning for reaching for a coder-specialized model
("generates clean, executable Python… syntax-perfect Matplotlib/Seaborn
rendering") is specifically an argument for the code-generation
architecture §7.2 recommends against. Under the spec-based design, the
Planner's job is structured JSON classification (pick a chart type, pick
columns, pick an aggregation) — the exact task Claude's existing
FAST_MODEL tier already handles well elsewhere in this codebase (Query
Reformulator, domain classification), and it's the model you're already
paying for and have already tuned prompts against. Recommend: **keep
Claude for the Planner/Captioner per §6 open question 4, and treat
OpenRouter/open-weight models as the thing you'd reach for specifically
if §7.2's deferred code-execution path ever gets built** (a coder model
genuinely is the better fit for *that* job, if that day comes) — not as a
cost-saving swap for the spec-based Planner, where a chart-type
classification call is cheap enough on Claude that the swap wouldn't
meaningfully move your bill.

### 7.5 Net effect on this doc

§1's two-agent count, §2's spec-not-code recommendation, and §5's build
order all stand unchanged. What changes: §4's chart-type and stat-test
menus get meaningfully richer (§7.1), sequenced into the existing phases
rather than added as new ones, and §6 gains one more open question below.

## 8. New open question from §7

6. **Code-execution escape hatch**: agree with §7.2's "spec-based now,
   revisit sandboxed code execution only once a researcher asks for a
   genuinely novel chart type" — or is there a use case you already have
   in mind where you know up front the fixed chart-type set won't be
   enough (e.g. a domain-specific plot no generic library menu will ever
   cover)?

---

## 9. §6's questions, resolved — plus what a real dataset just taught us

### 9.1 Decisions

1. **Input formats**: CSV + XLSX only for v1. Confirmed.
2. **Size caps**: default row-cap-with-sampling fallback (§6.2's proposal),
   no specific number requested — ship the reasonable default, revisit if
   a real dataset hits it.
3. **Where a dataset attaches**: **standalone tool, not project-scoped.**
   This is a real change from §3's implicit framing (which leaned on
   "attaches to a run") and worth calling out precisely: a researcher can
   open the Data Analysis Agent on its own, with no Sift run and no
   Hypothesis Agent session in progress, at any point — before starting a
   literature review, mid-review, after a hypothesis is picked, or
   completely unrelated to either. Concretely:
   - It needs its **own top-level nav entry**, not a tab nested inside an
     existing project's shell.
   - §3.1's "optional enrichment" from Sift/Hypothesis Agent context still
     holds, but inverts which way it's optional: when a researcher *does*
     arrive at the Data Analysis Agent from an existing project (a link
     from the Methods panel, say), that project's topic/hypothesis rides
     along as optional context; when they open it cold, it works exactly
     the same with none of that context. Neither path is the "main" one.
   - Where do results live, then, if not attached to a Sift run? Needs its
     own lightweight run/session record (dataset + profile + specs +
     figures + captions, keyed by its own id) — same shape as
     `hypothesis_runs`, not nested under `sessions`. A researcher can
     later *link* a data-analysis session to a project (so its figures are
     available to that project's export, per §3.4's exporter integration)
     without ever having been required to start from one.
4. **Planner model tier**: FAST_MODEL confirmed.

### 9.2 What the real capture file changes about §3's ingest step

You attached a real oscilloscope/CAN-bus fault capture
(`dcdcnvm_pcan_usbbus4_escope_capture_…fault1…csv`, 3,333 rows) — exactly
the kind of concrete test case §6's open item 5 asked for, and it
immediately breaks the "profile a tidy table" assumption §3's Ingest &
profile step quietly made. Worth detailing what it actually contains,
because it's a real shape you'll hit again, not a one-off:

- **Columns 0–5** (`CH 0 Data` … `CH 5 Data`) are dense: 3,333 continuous
  numeric samples each — a genuine 6-channel waveform capture, with no
  explicit time/index column. Row position *is* the time axis (sample N),
  but nothing in the file states the sample rate, so "time" can only be
  labeled as sample index unless the researcher supplies a rate separately.
- **Column 6** is entirely empty, every row — a blank separator, not data.
- **Columns 7–8** are sparse: populated for only the first 76 rows, empty
  for the remaining 3,257. Where populated, column 7 holds a *key name*
  (`FH_FaultsTask0`, `board_revision`, `state_cmd_pre_fault`,
  `obc_temp_1_pre_fault`, `voltage_cmd_post_fault`, …) and column 8 holds
  that key's *value* — but the value's type varies row to row: hex strings
  (`0x8000`), plain integers (`181`), floats (`69.548…`), even zero used as
  both a real value and a "false" flag. This is a **vertical key-value
  metadata dump riding along in the same file as a wide waveform table**,
  purely because whoever exported this appended one metadata pair per row
  onto the first 76 rows of an otherwise unrelated 6-channel capture.

Naively `pandas.read_csv()`-ing this and handing the whole thing to a
profiler produces garbage: a "column 8" with mixed hex/int/float/string
values that isn't numeric, isn't categorical, and isn't remotely
plottable as one series, sitting next to 6 columns of a real waveform it
has nothing to do with. §3's Ingest step, as originally scoped ("load
CSV/XLSX with pandas; infer dtypes, row/column counts, missing-value rate,
summary stats"), doesn't catch this — it would happily compute nonsense
stats on column 8 and hand them to the Planner. This is a genuine gap the
original design missed, not a minor edge case: **lab/instrument CSV
exports routinely aren't one clean table**, and any researcher-facing tool
that assumes they are will choke on exactly this file.

**Fix: a structure-detection pass before profiling, still zero LLM
calls.** Add one deterministic step ahead of §3's profiler:

1. **Drop all-null columns** outright (column 6 here) — never shown to the
   Planner as a candidate.
2. **Detect a sparse trailing key/value block**: a pair of columns where
   one holds short repeated-format strings (looks like an identifier —
   snake_case, no spaces, low cardinality-per-length) and the other holds
   mixed scalar types, and both are populated for only a small leading or
   trailing run of rows while the rest of the table is dense — split that
   pair OUT of the "waveform table" entirely and parse it as a flat
   `dict[str, str|int|float]` (76 keys here). This is pattern-matching on
   shape (density, column-position, value heterogeneity), not semantic
   understanding — no LLM needed.
3. **Profile the two pieces separately**: the waveform table gets the
   normal numeric-column profile (min/max/mean/std per channel, sample
   count, no time column found → flag "index-based, no explicit time
   axis"); the metadata dict is small enough (76 pairs) to pass to the
   Planner **whole**, not summarized — it's cheap in tokens and, unlike
   the waveform's raw samples, is exactly the kind of thing worth the
   model actually reading.

**Why the metadata block is worth keeping, not just discarding as junk**:
this specific file's metadata is a fault-diagnostic register dump with a
recurring `_pre_fault`/`_post_fault` naming pattern (`obc_temp_1_pre_fault`
/ `obc_temp_1_post_fault`, `voltage_cmd_pre_fault` /
`voltage_cmd_post_fault`, `cont_nacs_cmd_pre_fault` / `…_post_fault`, and
so on for a dozen+ sensors/commands). That's a direct, ready-made
before/after comparison — exactly the "paired data" test category from
§7.1's stat menu — sitting in the metadata, independent of the waveform
entirely. A Planner that sees this metadata block can propose "pre vs.
post fault, every *_pre_fault/*_post_fault pair, as one grouped bar chart"
as a candidate analysis without ever needing to guess it from the
waveform. Discarding the metadata block as unplottable junk (the naive
read) throws away the most directly useful part of the file for a
fault-investigation researcher.

**And the waveform itself**: the last row's CH1/CH2 values
(13.5→0.027, 177→1.69) are a visible step-change relative to the rest of
the file's tight range — almost certainly the fault event itself, sitting
right at the end of the capture. Whether "detect a transient/step-change
in the tail of a signal and flag it" belongs in v1 is a real question
(§9.3.3), but it confirms the earlier "mean line plot" chart type
(§4/§7.1) is the right default for this file's shape, not a bar/box/
scatter meant for grouped experimental data — the Planner needs the
profiler to tell it "this looks like a continuous time-series capture,
not a set of experimental observations" so it reaches for the right chart
family, which is a second, separate signal the structure-detection pass
should surface (§9.3.1).

### 9.3 What this changes in the doc, concretely

1. **New deterministic stage**: `core/data_structure.py` (or fold into
   `core/data_profile.py` as its first step) — the null-column-drop +
   sparse-key-value-block-split logic above, run before profiling, zero
   LLM calls, same cost tier as the rest of Ingest & profile.
2. **Profile output gains a `kind` signal per table**: `"tabular"` (rows
   are independent observations — the §4/§7.1 stat-test menu applies) vs.
   `"timeseries"` (rows are sequential samples — mean-line/waveform charts
   apply, paired hypothesis tests mostly don't). Cheap heuristic (an
   explicit time/date column, or high row count with no natural grouping
   column, tilts toward timeseries) — doesn't need to be perfect, just
   needs to steer the Planner away from proposing a t-test on 3,333
   sequential oscilloscope samples as if they were 3,333 independent
   subjects.
3. **Metadata dict, when found, is a free addition to the Planner's
   prompt** — no new agent, just a richer input to the existing one.
4. This is exactly the kind of finding §6's open item 5 was fishing for —
   a clean synthetic CSV would never have surfaced the "two tables sharing
   one file" shape, and it's very likely not unique to this one capture
   (any instrument/DAQ export tool that appends run metadata the same way
   will produce the same shape). Worth treating "handle a metadata block
   riding along with a waveform" as a v1 requirement now that there's a
   real example, not a deferred nice-to-have.

### 9.3.1–9.3.3 Open follow-ups from this file specifically

1. Confirmed above — `kind: timeseries` detection is now in scope for v1's
   Ingest step, not deferred.
2. Sample-rate/units: this file has no time axis at all, only row order.
   Should the uploader be able to attach "samples per second" (or a start
   timestamp + rate) as optional metadata at upload time, so the x-axis
   can read as real time instead of "sample #"? Cheap to add as an
   optional form field; without it, every timeseries chart from this kind
   of file is stuck labeling its x-axis "sample index."
3. Transient/step-change detection (flagging the fault event itself,
   §9.2's last paragraph) — is this worth a v1 heuristic (a rolling-window
   change-point flag, still deterministic, still no LLM), or should the
   Planner just always propose "plot the full waveform" and let the
   researcher's own eyes find the fault, deferring automatic detection
   until there's evidence researchers actually want it? Leaning toward
   the latter (simpler, and matches this doc's "concrete case first" bar
   everywhere else) but flagging it since this file makes the value
   obvious.

*Note: you mentioned "template document attached" — only the CSV came
through on this message. Send it separately when you get a chance; happy
to fold it in.*

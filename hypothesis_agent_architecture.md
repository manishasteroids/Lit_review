# Hypothesis Agent — System Architecture

*Working document, v7 — architecture only, no code, per §6 below. v6 was the pre-build plan; §§1–5 are now built (best-outcome pipeline: raised cap, novelty check, ranking bracket, meta-review, plausibility check, audit log, and a first human-in-the-loop mechanism — the user-supplied-results check, §6.0). §6 is new: the design for a second, distinct human-in-the-loop mechanism — arguing with a judgment the pipeline already made, not reporting a new result.*

---

## 0. Direct answer first

The proposal you pasted is a reasonable *menu* of ideas from the papers, but as a build plan it's not optimized for low cost — it's optimized for looking like the papers. Three things in it actively work against "best and efficient, low cost":

1. **It counts non-LLM steps as "agents."** UCB reward tracking, the knowledge graph, novelty/proximity scoring, and the supervisor are all plain code in the source papers — zero LLM calls, near-zero cost. Labeling them "agents" alongside Generation and Critique makes the system look 9x more expensive than it needs to be. The actual LLM-call count for a lean version is **2**, not 9.
2. **It introduces new infrastructure Sift doesn't need and doesn't have**: Neo4j, FAISS/ChromaDB, a new agent framework (AutoGen/CrewAI/LangGraph), and GPT-4 as a second model provider. Every one of these is a real recurring cost (hosting, API keys, learning curve) for a problem your existing stack already solves at your current scale.
3. **One piece is a correctness bug, not just a cost issue**: the alternating-refinement pseudocode borrows HypoGeniC/HypoRefine's "refine from the wrong-example bank" mechanism, which requires labeled ground-truth data to know which examples a hypothesis got *wrong*. Sift has no labeled dataset — there is no "wrong bank" to build. Only the literature-conditioned half of that pattern applies here (flagged as exactly this limitation in the v3/v4 doc already).

None of this means the underlying research is bad — it means translating "what Co-Scientist/Robin/HypoGeniC do at their scale, with their budgets" into "what a 2-hypothesis literature-review tool should do" requires trimming, not adopting wholesale. Below is that trim, point by point, plus the reconciled integration decision.

## 1. Integration and deployment topology

### 1.1 Why v5's "same process" idea was wrong

Your actual reasons for wanting two separate tools: reduce complexity, and — the important one I under-weighted last turn — **Sift must keep working even if the Hypothesis Agent breaks**, plus a user should be able to run Sift alone and never touch the Hypothesis Agent at all.

A shared process directly fails that second goal. If both live in one FastAPI app / one deployment: a bad Hypothesis Agent deploy (an import error, an unhandled exception during startup, a dependency version conflict, a memory leak, a runaway loop hogging the event loop) can take down or destabilize the *entire* process — including Sift's own routes, which never asked to be coupled to the Hypothesis Agent's health. That's the opposite of what you asked for. I optimized for hosting cost and missed the actual requirement.

### 1.2 The corrected recommendation: two separate processes, one direction of dependency, still cheap

**Two independently deployable services** — separate processes, separate deploys, separate crash domains — talking over a real HTTP call (v4's Option B). This is what "start with API/adapter" already pointed to; it just also happens to be the correct choice for fault isolation, once that's named as the actual goal.

The important clarification: **process separation is not what made v5 "cheap" or this option "expensive."** The heavy costs I flagged in §2/§3 (Neo4j, FAISS/ChromaDB, a new agent framework, GPT-4 as a second provider) are unnecessary regardless of deployment topology — cutting those is where the real savings are. Two small services (two lightweight containers, or even two plain Python processes under a process supervisor on the same box) cost barely more than one to run. Don't conflate "separate services" with "expensive cloud infrastructure" — it can be as cheap as two `systemd` units or two containers on the same VM.

Concretely:

- **Sift** exposes one new, narrow, read-only endpoint: `GET /runs/{id}/export` → the Literature Package (v4 §1.3, unchanged). That's the *entire* surface area Sift exposes to the Hypothesis Agent. Sift's code never imports from, calls into, or knows the Hypothesis Agent exists — the dependency arrow points one way only, exactly matching "Hypothesis Agent needs Sift's output; Sift doesn't need the Hypothesis Agent at all."
- **The Hypothesis Agent** is its own service, its own process, its own database, its own deploy. It calls that one Sift endpoint when a user starts a hypothesis run, gets back a self-contained snapshot, and from that point on has zero further dependency on Sift being up, healthy, or even running — the snapshot is enough to do everything else (design, critique, refine, export).
- **Frontend**: if the Methods panel is its own module/app, Sift's core UI (Sources/Review/Studio) must not fail to render just because the Hypothesis Agent's service happens to be down — that tab alone shows "Hypothesis Agent unavailable," nothing else in Sift notices.
- **Repo**: can still be one monorepo with two service directories and two deploy targets — repo layout doesn't affect fault isolation, only what actually *runs* as separate processes does. Pick monorepo-vs-two-repos on convenience, not on this requirement.

This satisfies all three of your stated goals at once: Sift runs standalone with zero awareness of the Hypothesis Agent (someone can use Sift alone, forever, and never notice the other tool exists); the Hypothesis Agent depends on Sift's output only at the moment a run starts, via one narrow endpoint; and a crash, bad deploy, or runaway cost in either service cannot take the other down, because they're different processes with different failure domains.

## 2. The corrected agent/component count

Re-deriving from the same ten papers, but counting only what's actually an LLM call, and only what Sift doesn't already provide:

| # | Component | LLM call? | Why / correction vs. your list |
|---|---|---|---|
| — | ~~Paper Summarizer~~ | — | **Cut entirely.** This is Sift's Reader & Extractor, already run, already crossing the integration boundary as `extractions` in the Literature Package. Rebuilding it duplicates work Sift already paid for. |
| — | ~~Graph Builder~~ | No | Not an agent — it's the deterministic co-occurrence/bridge-candidate code already written (`knowledge_graph.py`'s `find_bridge_candidates`). Runs on the extractions' `concepts` tags, zero LLM calls, effectively free. Neo4j is not warranted at this scale (dozens of concepts, one run) — a plain in-memory structure is what's already built and tested. |
| 1 | **Generation Agent** | Yes | Exists today (`ExperimentDesignerAgent`). Keep. |
| 2 | **Critique Agent** | Yes | Exists today (`HypothesisCriticAgent`). The one enhancement worth paying for: give it real search-tool access before it scores novelty (§2.2 of v4 — the 6.14→2.38/10 and 44.5%→0% numbers). This is a tool added to an existing agent, not a new agent. |
| — | ~~Literature Refinement Agent~~ | — | **Folds into Critique/refine as it works today** — `refine()` already regenerates against a critique. A separate agent for this is the same job twice. |
| — | ~~Proximity/Novelty Agent~~ | No | Not an agent — Kulkarni et al.'s formula, `N(H) = 1 − mean cosine similarity`, is an embedding computation over data already in the Literature Package. No FAISS/ChromaDB needed: at tens of papers and 2 hypotheses per run, this is a handful of vectors compared in memory, not a vector-database problem. A vector DB only earns its cost if you go persistent/cross-run — already ruled out. |
| — | ~~UCB Reward Tracker~~ | No | Not an agent — a Python dict + formula, and it's HypoGeniC's mechanism specifically, which needs labeled-data accuracy to compute the "accuracy" term. Sift has no labels. **Skip UCB entirely for this tool** — it doesn't apply, not just "it's extra cost." |
| 3 | **Ranking Agent** *(only if you raise the hypothesis cap)* | Yes | If you want more than 2 candidates ranked, use Robin's pairwise-tournament + Bradley–Terry–Luce judge, not UCB and not Elo — it's the one ranking mechanism in the whole reading list with real-world validation (beat human-expert consistency). Deferred until you actually decide to raise the cap (open question in v4, still open). |
| — | ~~Meta-Review Agent~~ | Optional | Only earns its cost once there are enough hypotheses/rounds that "patterns across rounds" is a real thing to summarize. At a 2-hypothesis, few-round scale, skip — revisit if the cap is raised. |
| — | ~~Supervisor Agent~~ | No | Not an agent — this is what `orchestrator.py` already does as plain control-flow code (call Design, then Critique, then Refine, in order). An LLM "supervisor" deciding what to run next is solving a problem you don't have yet at this scale. |

**Net: 2 LLM agents for the MVP (Generation + Critique-with-search), a 3rd (Ranking) only if you raise the cap, zero new infrastructure, zero new model providers, zero new agent framework.** This is the actual "best and efficient, low cost" version of everything the papers describe — not a rejection of the research, a right-sizing of it to a 2-hypothesis literature-review tool instead of a 30-candidate biomedical discovery platform with a wet-lab budget.

## 3. Stack: reuse what's already paid for

- **LLM**: keep the existing `LLMClient` (Claude + Gemini fallback) — do not add GPT-4/OpenAI as a third provider. There's no capability gap the papers' use of GPT-4 implies you're missing; it's just what those particular labs happened to use.
- **Agent framework**: do not adopt AutoGen/CrewAI/LangGraph. The existing `Agent(ABC)` + `LLMClient` pattern already does everything ResearchAgent/Co-Scientist's frameworks do at this scale (a handful of sequential/looped LLM calls) — a framework earns its cost at dozens of agents coordinating asynchronously, which is a different scale of problem than 2–3 agents.
- **Embeddings**: for the cosine-novelty check, a single embedding-API call per hypothesis/finding (whatever provider you already use, or a cheap dedicated embedding model) — no FAISS/ChromaDB, no new vector infra.
- **Graph**: the existing in-memory Python structures in `knowledge_graph.py` — no Neo4j.

## 4. What survives from your pasted plan, genuinely

Not everything gets cut — a few things are worth keeping, credited to where they actually came from:

- **The refine loop's alternating conditioning** — but literature-only, since the data-driven half doesn't apply. Each refine round can alternate between "revise against the critique" and "revise against the bridge-candidate/literature signal" rather than always the same conditioning.
- **The falsification/contrastive framing** for testability (already in v4 §2.3.8).
- **"Don't skip human review"** — genuinely the single most load-bearing caution across all ten papers, not just this proposal; stays as a first-class design commitment (v4 §2.2, §2.3.11).
- **Summarize before generation, always** — already true here by construction, since the Literature Package carries Sift's extractions (already summarized), never raw PDF text.

---

## 5. Revised open questions

1. Does §1.2 (two separate services, one narrow read-only export endpoint, one-directional dependency) match what you had in mind — or is there a stronger isolation requirement I'm still not weighing correctly (e.g. must run on entirely separate infrastructure/hosting accounts, not just separate processes)?
2. Any objection to cutting UCB, Neo4j, FAISS/ChromaDB, a new agent framework, and GPT-4 from the plan, per §2/§3 (unchanged by this revision)?
3. Still open: hypothesis cap — 2, or raise it (which is what makes the Ranking agent and Meta-review worth building)?
4. Still open from before: a concrete example of a hypothesis the current tool produced that disappointed you.

---

*§§1–3 above are now settled by what actually got built: one process for now (the "start same-process, extract later" phase noted in the pipeline's own docstring), not the two-service split — still the documented target, still deferred, tracked as its own separate item, not blocking anything in §6. Hypothesis cap was raised to 6 (§5.3), which is what made the Ranking Agent and Meta-Review worth building — both exist today.*

## 6. Human-in-the-loop argument/dispute flow

§4 named "don't skip human review" as the single most load-bearing caution across all ten source papers. Two human-in-the-loop mechanisms exist today; this section is about a third, deliberately distinct one.

### 6.0 What already exists (so this section doesn't re-solve it)

| Mechanism | Where | Input | What it changes |
|---|---|---|---|
| **Challenge a hypothesis** (`ExperimentDesignerAgent.respond_to_challenge`) | Methods panel only (cap=2, no bracket) | A researcher's objection to a hypothesis's own design | The hypothesis's own text — stance `revised` or `defended` |
| **Check against your results** (`HypothesisResultsCheckAgent`) | Hypothesis Agent tool, any hypothesis | Real results the researcher actually observed running the experiment | Proposes a revised hypothesis; applied only on explicit click (`/apply-refinement`) |

Neither lets a researcher argue with a *judgment the pipeline itself made* — a Critic score, a Ranker match's winner, the Meta-Review's final pick, a Novelty or Plausibility verdict. That's the gap this section designs for: not "here's a new fact," but "I disagree with your call, and here's why."

### 6.1 What's disputable — six candidates, trimmed to two for v1

Every stage that renders a verdict is a candidate target:

| Target | What disputing it means | v1? |
|---|---|---|
| **Meta-Review's recommendation** | "I don't think the champion is the right call" | **Yes** — highest value: it's the one thing every researcher actually reads, and it's a single cheap call to re-argue (no bracket replay needed unless applied — see §6.3) |
| **A ranking-bracket match** | "H3 should have beaten H5 in that match" | **Yes** — the mechanism a power user needs to actually change *why* a different hypothesis should have won, not just assert the ending should differ |
| Critic's per-hypothesis score | "This novelty score is too harsh" | Deferred | 
| Novelty check's verdict | "That IS/ISN'T prior art, I know the field" | Deferred |
| Plausibility check's verdict | "You're comparing against the wrong baseline" | Deferred |

Same trimming logic as §2: build the two that carry the most researcher value per call spent, defer the rest until there's a concrete case for them (mirrors §5's open item 4 — "a concrete example of a hypothesis that disappointed you" is exactly the kind of evidence that would justify adding one of the deferred three).

Explicitly NOT in scope for v1: a multi-turn back-and-forth debate loop. Every dispute mechanism built so far in this tool (Methods' challenge, the results-check) is one argument in, one stance-and-response out — §6 keeps that shape rather than opening conversational-UI scope.

### 6.2 Two new methods, not two new agent files

Following §4's "reuse what's already built" precedent (`respond_to_challenge` lives ON `ExperimentDesignerAgent`, not a separate file) and the class-based `Agent` pattern from §3:

- **`HypothesisMetaReviewAgent.dispute(topic, champion, runner_up, current_recommendation, objection, extractions) -> {"stance": "revised"|"defended", "response": str, "recommendation": {...} | same shape as today's meta_review}`** — given the researcher's objection to the current recommendation, either defend it with a specific counter-reason (never "agreeing to be agreeable" — same explicit instruction `respond_to_challenge`'s prompt already uses) or revise it, possibly naming the runner-up as the new pick instead.
- **`HypothesisRankerAgent.dispute(topic, hyp_a, hyp_b, current_winner, current_reason, objection, extractions) -> {"stance": "revised"|"defended", "response": str, "winner": "a"|"b", "reason": str}`** — same shape as a normal match judgment, but conditioned on the objection instead of judging cold.

Both are new methods on agents that already exist, not new files — the smallest-footprint way to add this.

### 6.3 The hard part: what "Apply" actually does

This is the one genuinely new piece of logic, and it's where the cost/complexity trade-off actually lives.

**Propose, then explicit apply — same pattern as `user_validations`/`apply-refinement` (§6.0), not automatic cascade.** Submitting a dispute always returns a response; nothing about the saved run changes until a person clicks Apply. This keeps the default case free (arguing costs one LLM call, same as any other single judgment) and keeps the displayed recommendation from silently rewriting itself under a researcher who was just curious what the agent would say.

What Apply does differs by target, because the two targets sit at different depths of the pipeline:

- **Applying a Meta-Review revision** is cheap: swap the stored `meta_review` dict for the revised one. If the revision also names a different champion, swap `champion_index`/`runner_up_index` too, and mark `plausibility_check` stale (same "stale until re-run" language the UI already shows after `apply-refinement`) rather than silently leaving a plausibility verdict computed against the old champion. No bracket replay — the bracket's match history doesn't change, only which hypothesis the write-up ultimately recommends.
- **Applying a ranker-match revision is the expensive one.** Flipping one match's winner potentially changes every match after it in the bracket (the semifinal/final the flipped hypothesis would now play). `_run_bracket` needs a new capability — replay from a given match forward with one result forced — reusing the earlier, unaffected rounds' results rather than re-judging the whole bracket from scratch. Once replay produces a (possibly new) champion/runner-up, `meta_review` and `plausibility_check` are stale by construction and need re-running — real LLM calls, not free. The UI should say this cost up front before a researcher clicks Apply on a match dispute ("this may change the champion and will re-run the closing recommendation"), not surprise them with a spinner.

### 6.4 Interface for researchers

Two entry points, both reusing visual language already shipped in this tool rather than inventing new patterns:

- **On the Meta-Review card**: an "Argue with this recommendation" affordance next to the existing confidence gauge — opens a text box, submits, and shows the response inline: `defended` renders as a rebuttal paragraph appended under the existing caveats; `revised` renders with the same "proposed change + Apply" treatment the results-check's `ValidationEntry` already uses (§6.0), including the same explicit staleness note pattern.
- **On a bracket match**: the existing "Show match reasoning" collapsible (`MatchReasoning` in `HypothesisAgentPanel.jsx`) gets a small "Argue with this call" link per match, same submit → response → (conditional) Apply flow, scoped to that one match.
- **A running dispute history**, same collapsed-list-of-entries pattern as `user_validations` — every argument stays visible and timestamped, not just the most recent, so a researcher (or a collaborator reading the run later) can see what was contested and how it was resolved.

### 6.5 Decisions (resolved)

1. **v1 scope: Meta-Review dispute only.** Ranker-match disputes (and the bracket-replay logic §6.3 describes for them) are deferred until real usage shows researchers actually want to contest a specific match rather than just the final call — same "concrete case first" bar §6.1 set for the other three deferred targets. §6.1's table and §6.3's match-dispute paragraph stay in this document as the designed-but-not-built path, not deleted, so the replay design doesn't have to be re-derived if it's picked up later.
2. **Propose-then-apply confirmed**, matching every other human-in-the-loop mechanism already in this tool: a dispute's response is free and immediate; Apply is a separate explicit click. With ranker-match disputes deferred, v1's Apply is the cheap case only (§6.3's "Applying a Meta-Review revision" paragraph) — no re-computation cost to price or label in the UI yet.
3. Superseded by (1).
4. Not answered yet — not a blocker for v1's build, since Meta-Review dispute reuses `respond_to_challenge`'s already-battle-tested "defend with a specific counter-reason, never agree to be agreeable" prompt pattern (§6.2) rather than a novel one. Worth revisiting once real disputes exist, to sanity-check the prompt against an actual disagreement.

---

*§6 is now built: `data.disputes`, `/runs/{id}/dispute-meta-review`, `/runs/{id}/apply-dispute`. §7 is new — closing the loop those mechanisms (and the results-check, §6.0) currently leave open.*

## 7. Closing the loop: re-entering ranking after a refinement or dispute

### 7.0 The gap

Two mechanisms already change a hypothesis or the recommendation after the pipeline has run: the results-check's `apply-refinement` (swaps `plan.hypotheses[idx]` for a refined version) and the Meta-Review dispute's `apply-dispute` (swaps `meta_review`, and swaps `champion_index`/`runner_up_index` if the dispute preferred the runner-up). Both are terminal — the changed hypothesis never goes back through Ranking. A refined hypothesis that's now materially stronger than the current champion just sits at its old bracket position; it never gets a chance to actually beat the champion in a real match. The published research this project has been benchmarked against (Robin's dAMD discovery, Co-Scientist's liver fibrosis result) makes exactly this loop — generate, test against something real, feed the result back in, re-rank — the mechanism that produced their validated results, not a better one-shot ranking. Right now this tool has the first two steps (generate, test-via-results-check) and the last step is missing.

### 7.1 Two ways to close it, and why one is the right size

**Option A — full bracket replay.** Re-insert the changed hypothesis at its original bracket seed and re-run every match from that point forward (§6.3 already scoped this for ranker-match disputes and named it "the hard part": `_run_bracket` needs a new "replay from match N forward" capability). Correct, but expensive — for a 6-hypothesis bracket a mid-bracket change can force 2-3 re-judged matches, and it requires building infrastructure this project deliberately deferred once already (§6.5 decision 1).

**Option B — champion-challenge.** Don't replay the bracket. Instead, run the changed hypothesis through two new pairwise matches: challenger vs. current champion, and (only if the first match is lost) challenger vs. current runner-up. Reuses `HypothesisRankerAgent`'s existing single-match judge call as-is — the same method §6.2 already uses for match disputes — with no new bracket logic. Whichever of {challenger, champion, runner-up} comes out on top after those 1-2 matches becomes the new champion/runner-up pair.

Option B is the one worth building. It costs at most 2 extra ranking calls (vs. up to a full sub-tree of replayed matches), needs zero new methods on `HypothesisRankerAgent` (the existing `run()` pairwise judge is reused unchanged), and answers the question a researcher actually has after refining a hypothesis or winning a dispute — "is this now better than what you're currently recommending?" — directly, without reconstructing bracket history that was never in question. The trade-off: it's not a strictly correct re-ranking of the whole field (a hypothesis that would also now beat H3 or H5, but isn't tested against them, stays untested against them) — but per §0's own standing principle, that's the right-sized version of the mechanism for a tool at this scale, not a rejection of full replay. Option A's design stays written above in §6.3 if usage ever shows the lighter version isn't enough.

### 7.2 What re-verification actually does

New method, following §6.2's "reuse what exists" precedent — no new agent files:

- **Critic re-score**: the changed hypothesis needs a fresh Critic pass before it's compared to anything (its rationale/approach may have materially changed). Reuses the existing Critic call shape, scoped to one hypothesis instead of the full set.
- **Two challenge matches** (at most): challenger vs. champion using `HypothesisRankerAgent.run()` unchanged; challenger vs. runner-up only if the challenger lost the first match (no need to test against the runner-up if it already beat the champion — it's the new champion regardless of how it'd fare against the old #2).
- **Outcome**:
  - Beats champion → challenger becomes champion; old champion becomes runner-up.
  - Loses to champion, beats runner-up → challenger becomes runner-up; old runner-up drops out of the top two (still visible in the full hypothesis list, just no longer champion/runner-up).
  - Loses both → no change; the challenge result is still recorded so the researcher can see it was tried and didn't move the needle.
- **Downstream staleness**: if the champion changed, `meta_review` and `plausibility_check` are stale by the same rule §6.3/§7.1 already established — re-running them is a separate explicit action with cost shown upfront, not automatic. If only the runner-up changed, `meta_review`'s "when to reconsider the runner-up" section is stale but the recommendation itself isn't — worth flagging, not necessarily worth forcing a re-run.

### 7.3 Interface

Same propose-then-apply shape as everything else in §6 — nothing re-verifies without an explicit click:

- On an applied refinement (`ValidationEntry`, already shipped) and on an applied "revised" dispute (`DisputeEntry`, already shipped): a new "Check against current champion" button, shown only once the entry is applied (re-verifying a hypothesis that was never actually adopted doesn't mean anything).
- Clicking it shows the cost up front — "Runs a fresh score and up to 2 head-to-head matches (~3 model calls)" — matching §6.3's "show the cost before the spinner" rule.
- Result renders as a small challenge-history card: the two (or one) matches with their reasoning, and the outcome (`new_champion` / `new_runner_up` / `no_change`), same visual language as bracket match cards already use.
- If the champion changed, the existing "stale" pill (already shown for plausibility after a dispute) appears on the Plausibility section, and the Meta-Review card gets a "recommendation may be outdated — re-run to confirm" note rather than silently keeping the old text on screen next to a different champion.

### 7.4 Decision needed

The one real open question: should re-verification apply to *any* changed hypothesis (refinement or dispute), or only to results-check refinements — since a dispute-driven champion swap already updates `champion_index` directly via `apply-dispute` (§6.5), re-verifying it again may be redundant with the swap that already happened. Recommendation: scope v1 to results-check refinements only, since that's the case with the real gap (a refined hypothesis today never competes for the champion slot at all); a Meta-Review dispute that already swapped the champion doesn't need a second re-verification pass on top of the swap it just did.

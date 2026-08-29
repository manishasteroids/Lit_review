import React from "react";
import { FileText, FlaskConical, Brain, Search, ListOrdered, Sparkles, BarChart3, Check, RotateCw } from "./icons.jsx";

// Mirrors backend/hypothesis_agent/pipeline.py's seven stages, in order:
// bridge lookup (fast, folded into "Literature Package" — it reads the same
// extractions), Experiment Designer, Hypothesis Critic, Novelty verification
// (a real literature search per hypothesis, see agents/hypothesis_novelty.py
// — distinct from the Critic's corpus-only novelty score), ranking bracket
// (single-elimination, see agents/hypothesis_ranker.py), Meta-Review (the
// closing recommendation, see agents/hypothesis_meta_review.py), Plausibility
// check (a literature-grounded sanity check on the CHAMPION's own numeric
// target against what this run's own extractions actually reported — see
// agents/hypothesis_plausibility.py). Kept as its own small list rather than
// reusing PipelineRail.STAGES since this is a different pipeline with
// different stages. "novelty"/"ranking"/"meta_review"/"plausibility" only
// fire when the Designer produced hypotheses to check — with zero, the
// pipeline skips straight to done.
const STAGES = [
  { key: "fetch", label: "Literature Package", sub: "Reads Sift's extractions + synthesis", icon: FileText, kind: "entry" },
  { key: "designer", label: "Experiment Designer", sub: "Generates hypotheses", icon: FlaskConical, kind: "step" },
  { key: "critic", label: "Hypothesis Critic", sub: "Scores & critiques", icon: Brain, kind: "step" },
  { key: "novelty", label: "Novelty check", sub: "Live search for prior art, per hypothesis", icon: Search, kind: "step" },
  { key: "ranking", label: "Ranking bracket", sub: "Head-to-head matches, single elimination", icon: ListOrdered, kind: "step" },
  { key: "meta_review", label: "Meta-Review", sub: "Final recommendation", icon: Sparkles, kind: "step" },
  { key: "plausibility", label: "Plausibility check", sub: "Champion's target vs. reported literature", icon: BarChart3, kind: "output" },
];

/**
 * Right-rail progress view for the Hypothesis Agent's OWN pipeline —
 * reuses PipelineRail's CSS classes (.rail/.rail-node/.dot/.meta/...) so it
 * looks native to the app, but tracks a completely separate run. Shown in
 * place of the Sift PipelineRail while the "Hypothesis" tool tab is open,
 * so a running Hypothesis Agent pass has its own live progress instead of
 * the Sift rail just sitting there unrelated to what's actually in flight.
 *
 * Props: stage (current in-flight stage key, or null when idle),
 *        busy, done ({stageKey: true} for stages that have finished),
 *        live ({critic: {hypotheses}, ranking: {total, current: {a,b}|null,
 *        matches: [{a,b,winner,reason}]}}) — sub-stage detail for the two
 *        slowest stages, from backend/hypothesis_agent/pipeline.py's
 *        "critic"/"ranking" progress events (see its on_progress docstring).
 *        Both are single-threaded (critic: one big scoring call; ranking:
 *        matches run one at a time since each decides who plays next), so
 *        this exists to make that wait legible instead of an opaque spinner.
 */
export default function HypothesisPipelineRail({ stage, busy, done = {}, live = {} }) {
  return (
    <div className="rail">
      <div className="eyebrow" style={{ marginBottom: 14 }}>Hypothesis pipeline</div>
      {STAGES.map((s, i) => {
        const Icon = s.icon;
        const isActive = busy && stage === s.key;
        const isDone = !!done[s.key];
        const reached = isActive || isDone;
        const dotCls =
          "dot " + (s.kind === "entry" ? "entry " : s.kind === "output" ? "output " : "") +
          (isActive ? "active " : isDone ? "done " : "");
        return (
          <div key={s.key} className={"rail-node" + (reached ? " is-active" : "") + (isDone ? " is-done" : "")}>
            {i < STAGES.length - 1 && (
              <div className="rail-line" style={isDone ? { background: "var(--green-soft)" } : null} />
            )}
            <div className={dotCls}>
              {isActive ? <RotateCw size={15} className="spin" /> : isDone ? <Check size={15} /> : <Icon size={15} />}
            </div>
            <div className="meta">
              <div className="lab">{s.label}</div>
              <div className="sub">{s.sub}</div>
              {isActive && s.key === "critic" && <CriticLiveDetail detail={live.critic} />}
              {isActive && s.key === "ranking" && <RankingLiveDetail detail={live.ranking} />}
            </div>
          </div>
        );
      })}
      {!busy && Object.keys(done).length === 0 && (
        <div className="muted tiny" style={{ marginTop: 10 }}>Not run yet for this review.</div>
      )}
    </div>
  );
}

// One LLM call scores every hypothesis at once (see hypothesis_critic.py's
// docstring) — there's no per-item sub-progress to show, so this just makes
// the wait legible: what it's doing and on how many hypotheses, since a
// 6-hypothesis field genuinely takes longer than a 2-hypothesis one.
function CriticLiveDetail({ detail }) {
  const n = detail?.hypotheses;
  return (
    <div className="tiny" style={{ marginTop: 4, color: "var(--muted,#667)", lineHeight: 1.4 }}>
      Scoring {n ? `all ${n} hypotheses` : "each hypothesis"} on novelty, grounding,
      testability &amp; consistency — one combined call, not one per hypothesis.
    </div>
  );
}

// Matches run one at a time (each match's winner decides who plays next),
// so this is the stage most worth narrating live: which two hypotheses are
// being judged right now, a running tally, and the trail of decisions so
// far — a plain sub-log rather than trying to redraw the bracket diagram
// mid-run (that lives in HypothesisAgentPanel once the run is saved).
function RankingLiveDetail({ detail }) {
  const total = detail?.total;
  const matches = detail?.matches || [];
  const current = detail?.current;
  const label = (idx) => (idx == null ? "—" : `H${idx + 1}`);
  return (
    <div className="tiny" style={{ marginTop: 4, color: "var(--muted,#667)", lineHeight: 1.5 }}>
      {typeof total === "number" && (
        <div>{matches.length} of {total} match{total === 1 ? "" : "es"} judged</div>
      )}
      {current && (
        <div style={{ fontWeight: 600 }}>
          Judging {label(current.a)} vs {label(current.b)}…
        </div>
      )}
      {matches.length > 0 && (
        <div style={{ marginTop: 3, display: "flex", flexDirection: "column", gap: 2 }}>
          {matches.slice(-3).map((m, j) => (
            <div key={j}>
              {label(m.a)} vs {label(m.b)} → <b>{label(m.winner)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

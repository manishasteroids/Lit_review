import React, { useState, useEffect } from "react";
import { CiteLink, CitedText, KgBridgePanel, ScoreLegend, ScoreBars } from "./MethodsPanel.jsx";

// One accent color per hypothesis slot (by index, wraps past 6) — a plain
// left-edge stripe so a wide grid of cards reads as distinct entrants at a
// glance, the way the bracket diagram below already color-codes nothing but
// position. Kept as a small fixed hex palette (not CSS vars) — same
// approach MethodsPanel.jsx's STATUS palette already uses for score dots.
const ACCENTS = ["#6c5ce7", "#0e9488", "#d97f3d", "#c0447e", "#3a7bd5", "#5f9b3f"];

const READING_WIDTH = 720; // prose (notes, rationale) stays legible; grids/diagrams use the full column

/**
 * Hypothesis Agent — its own dedicated tool tab, separate from Methods.
 *
 * The "best-outcome" pipeline (hypothesis_agent_architecture.md SS5):
 * Generation (up to 6 genuinely distinct hypotheses) -> Critique (every
 * hypothesis scored) -> a single-elimination ranking bracket (agents/
 * hypothesis_ranker.py judges each match) -> Meta-Review (agents/
 * hypothesis_meta_review.py writes the closing recommendation from the
 * champion + runner-up). Runs server-side (backend/hypothesis_agent/
 * pipeline.py) against this run's own `hypothesis_runs` table (backend/
 * core/hypothesis_db.py) — separate from Sift's `sessions`, read-only
 * w.r.t. the source run. Read-only display here too: no Edit/Challenge
 * (that interactivity stays specific to Methods' HypothesisCard).
 *
 * Layout note: unlike Methods (a single reading column), this panel fills
 * the whole content area — a grid of hypothesis cards plus a bracket
 * diagram both want the width. Only actual prose (notes, rationale) is
 * capped at READING_WIDTH for legibility; structural elements span full width.
 *
 * Props: runId (the Sift session this reads from), apiKey, model, busy,
 *        result (the saved hypothesis run record, or null), error,
 *        onRun(), papers=[{idx,title,url}], extractions=[{idx,finding,...}]
 */
export default function HypothesisAgentPanel({
  runId, busy, result, error, onRun, papers = [], extractions = [],
  onCheckResults, onApplyRefinement, resultsCheckBusy, resultsCheckError,
  onReverifyRefinement, reverifyBusy, reverifyError,
  onDisputeMetaReview, onApplyDispute, disputeBusy, disputeError,
}) {
  const muted = { color: "var(--muted, #667)" };
  const data = result?.data || null;
  const plan = data?.plan || null;
  const critique = data?.critique || null;
  const kgBridges = data?.kg_bridges || [];
  const bracket = data?.bracket || null;
  const metaReview = data?.meta_review || null;
  const championIndex = data?.champion_index;
  const runnerUpIndex = data?.runner_up_index;
  const auditLog = data?.audit_log || [];
  const noveltyChecks = data?.novelty_checks || {};
  const plausibilityCheck = data?.plausibility_check || null;
  const plausibilityStale = !!data?.plausibility_stale;
  const userValidations = data?.user_validations || [];
  const disputes = data?.disputes || [];
  const reverifications = data?.reverifications || [];
  const metaReviewStale = !!data?.meta_review_stale;
  const [showAbout, setShowAbout] = useState(false);
  const critiqueByIndex = Object.fromEntries(
    (critique?.critiques || []).map((c) => [c.index, c])
  );
  // Every citation in this panel is keyed by a paper's raw internal `idx`
  // (0-based — the first paper in a run is idx 0), which reads as
  // "paper 0" to a reader if shown as-is. citeNum maps it to the familiar
  // 1-based number instead (same convention App.jsx already uses for the
  // Review tab's own citations) — passed to every CitedText/CiteLink below
  // purely as a display override; the underlying idx still does the actual
  // paper lookup, so links/hovers are unaffected.
  const citeNum = {};
  papers.forEach((p, i) => { citeNum[p.idx] = i + 1; });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Hypothesis Agent</h3>
        <button onClick={onRun} disabled={busy || !runId} type="button">
          {busy ? "Working…" : data ? "Run again" : "Run hypothesis pipeline"}
        </button>
        <button
          type="button" onClick={() => setShowAbout((v) => !v)}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            fontSize: 12.5, color: "var(--muted,#667)", display: "flex", alignItems: "center", gap: 4,
          }}
        >
          <span aria-hidden="true">ⓘ</span> {showAbout ? "Hide" : "About"} this tool
        </button>
        {plan?.domain && (
          <span style={{
            fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 999,
            background: "var(--indigo-soft,#eeecfd)", color: "var(--accent,#6c5ce7)",
          }}>
            {plan.domain}
          </span>
        )}
        {data?.model && <span style={{ ...muted, fontSize: 12, marginLeft: "auto" }}>model: {data.model}</span>}
      </div>

      {showAbout && (
        <div style={{ ...muted, fontSize: 13, margin: "0 0 16px", lineHeight: 1.5, maxWidth: READING_WIDTH }}>
          Reads this literature review's extractions and synthesis, generates up to 6
          genuinely distinct hypotheses, critiques each one, then runs them through a
          head-to-head ranking bracket and writes a final recommendation. Its own
          separate pipeline and saved run, so you can compare against Methods.
          Read-only for now: no editing or challenging a hypothesis here yet.
        </div>
      )}

      {error && (
        <div style={{ color: "#d03b3b", fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!data && !busy && !error && (
        <div style={{ ...muted, fontSize: 13 }}>
          No hypothesis run yet for this review. Click "Run hypothesis pipeline" to generate one.
        </div>
      )}

      {metaReview && (
        <div style={{
          margin: "0 0 22px", padding: "18px 20px", borderRadius: 14,
          border: "1px solid var(--accent,#6c5ce7)", background: "var(--indigo-soft, #eeecfd)",
          display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap",
        }}>
          {metaReview.confidence != null && <ConfidenceGauge value={metaReview.confidence} />}
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span aria-hidden="true" style={{ fontSize: 18 }}>🏆</span>
              <span style={{ fontWeight: 700, fontSize: 15 }}>
                Recommendation{typeof championIndex === "number" ? `: H${championIndex + 1}` : ""}
              </span>
              {metaReviewStale && (
                <span style={{
                  fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 999,
                  border: "1px solid var(--amber-border,#e9c27a)", color: "var(--amber-text,#8a6116)",
                  background: "var(--amber-soft,#fdf6e6)",
                }}>
                  stale — a refined hypothesis was re-verified after this was written
                </span>
              )}
            </div>
            <div style={{ fontSize: 14, marginBottom: 8, maxWidth: READING_WIDTH, lineHeight: 1.5 }}>
              <CitedText text={metaReview.recommendation} papers={papers} citeNum={citeNum} />
            </div>
            {metaReview.why_champion_won && (
              <div style={{ fontSize: 13, marginBottom: 4, maxWidth: READING_WIDTH, lineHeight: 1.5 }}>
                <span style={muted}>Why it won:</span>{" "}
                <CitedText text={metaReview.why_champion_won} papers={papers} citeNum={citeNum} />
              </div>
            )}
            {metaReview.when_to_reconsider_runner_up && (
              <div style={{ fontSize: 13, marginBottom: 4, maxWidth: READING_WIDTH, lineHeight: 1.5 }}>
                <span style={muted}>
                  Reconsider H{typeof runnerUpIndex === "number" ? runnerUpIndex + 1 : "?"} if:
                </span>{" "}
                <CitedText text={metaReview.when_to_reconsider_runner_up} papers={papers} citeNum={citeNum} />
              </div>
            )}
            {(metaReview.caveats || []).length > 0 && (
              <div style={{ fontSize: 13, marginTop: 8, maxWidth: READING_WIDTH, lineHeight: 1.5 }}>
                <span style={muted}>Watch out for:</span>{" "}
                {metaReview.caveats.map((c, j) => (
                  <React.Fragment key={j}>
                    {j > 0 && " · "}
                    <CitedText text={c} papers={papers} citeNum={citeNum} />
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {metaReview && onDisputeMetaReview && (
        <MetaReviewDisputeSection
          disputes={disputes}
          onDispute={onDisputeMetaReview}
          onApply={onApplyDispute}
          busy={disputeBusy}
          error={disputeError}
          championIndex={championIndex}
          runnerUpIndex={runnerUpIndex}
          papers={papers}
          citeNum={citeNum}
        />
      )}

      {plausibilityCheck && (
        <PlausibilitySection
          plausibilityCheck={plausibilityCheck} championIndex={championIndex}
          papers={papers} stale={plausibilityStale} citeNum={citeNum}
        />
      )}

      {plan?.note && (
        <CitedText text={plan.note} papers={papers} citeNum={citeNum} style={{ ...muted, fontSize: 13, margin: "4px 0 8px", display: "block", maxWidth: READING_WIDTH }} />
      )}
      {critique?.note && (
        <div style={{ ...muted, fontSize: 13, margin: "4px 0 12px", fontStyle: "italic", maxWidth: READING_WIDTH }}>
          Critic: <CitedText text={critique.note} papers={papers} citeNum={citeNum} />
        </div>
      )}
      {plan && kgBridges.length > 0 && (
        <div style={{ maxWidth: READING_WIDTH, marginBottom: 8 }}>
          <KgBridgePanel bridges={kgBridges} papers={papers} citeNum={citeNum} />
        </div>
      )}

      {(plan?.hypotheses || []).some((_, i) => critiqueByIndex[i]) && <ScoreLegend />}

      {(plan?.hypotheses || []).length > 0 && (
        <div style={{
          display: "grid", gap: 16, marginTop: 4,
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
        }}>
          {plan.hypotheses.map((h, i) => (
            <ReadOnlyHypothesisCard
              key={i}
              h={h}
              i={i}
              papers={papers}
              extractions={extractions}
              critique={critiqueByIndex[i]}
              noveltyCheck={noveltyChecks[i]}
              isChampion={i === championIndex}
              isRunnerUp={i === runnerUpIndex}
              accent={ACCENTS[i % ACCENTS.length]}
              citeNum={citeNum}
            />
          ))}
        </div>
      )}

      {plan && (plan.hypotheses || []).length === 0 && (
        <div style={muted}>No hypotheses generated for this run.</div>
      )}

      {bracket && (
        <BracketSection bracket={bracket} hypotheses={plan?.hypotheses || []} accents={ACCENTS} />
      )}

      {(plan?.hypotheses || []).length > 0 && onCheckResults && (
        <UserResultsSection
          hypotheses={plan.hypotheses}
          validations={userValidations}
          reverifications={reverifications}
          championIndex={championIndex}
          runnerUpIndex={runnerUpIndex}
          onCheckResults={onCheckResults}
          onApplyRefinement={onApplyRefinement}
          onReverifyRefinement={onReverifyRefinement}
          busy={resultsCheckBusy}
          error={resultsCheckError}
          reverifyBusy={reverifyBusy}
          reverifyError={reverifyError}
          papers={papers}
          citeNum={citeNum}
        />
      )}

      {auditLog.length > 0 && <AuditLogSection auditLog={auditLog} />}
    </div>
  );
}

// ---- user-supplied results: the human-in-the-loop counterpart to the -----
// automatic plausibility check above. That one only ever checks the
// literature; this is for when a researcher has actually run (a version
// of) the experiment and wants the hypothesis re-checked against what
// really happened — see agents/hypothesis_results_check.py's docstring for
// why this is scoped separately from the Critic's objection-handling
// (respond_to_challenge, Methods-only) and from the plausibility check.
// Every submission is appended to data.user_validations, newest first here;
// nothing changes the hypothesis text itself unless "Apply this revision"
// is clicked explicitly.
const VERDICT_STYLE = {
  supported: { emoji: "✅", label: "Supported", border: "var(--green-soft,#bfe6bf)", bg: "var(--green-bg,#eefbee)" },
  partially_supported: { emoji: "⚠️", label: "Partially supported", border: "var(--amber-border,#e9c27a)", bg: "var(--amber-soft,#fdf6e6)" },
  refuted: { emoji: "❌", label: "Refuted", border: "#e6a3a3", bg: "#fdeeee" },
  inconclusive: { emoji: "❔", label: "Inconclusive", border: "var(--border,#e5e7eb)", bg: "var(--chip,#f1f0fb)" },
};

function UserResultsSection({
  hypotheses, validations, reverifications, championIndex, runnerUpIndex,
  onCheckResults, onApplyRefinement, onReverifyRefinement,
  busy, error, reverifyBusy, reverifyError, papers, citeNum,
}) {
  const muted = { color: "var(--muted, #667)" };
  const [selectedIndex, setSelectedIndex] = useState(
    typeof championIndex === "number" ? championIndex : 0
  );
  const [resultsText, setResultsText] = useState("");

  // Default the picker to the champion once it's known (e.g. the run just
  // finished after this component already mounted with championIndex null).
  useEffect(() => {
    if (typeof championIndex === "number") setSelectedIndex(championIndex);
  }, [championIndex]);

  function submit() {
    const text = resultsText.trim();
    if (!text || busy) return;
    onCheckResults(selectedIndex, text);
    setResultsText("");
  }

  return (
    <div style={{
      marginTop: 16, padding: "16px 18px", borderRadius: 12,
      border: "1px solid var(--border,#e5e7eb)",
    }}>
      <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4 }}>
        Check against your results
      </div>
      <div style={{ ...muted, fontSize: 12.5, marginBottom: 10, maxWidth: READING_WIDTH, lineHeight: 1.4 }}>
        Ran (a version of) one of these experiments? Paste what you actually observed —
        a verdict comes back against that hypothesis's own claim and metrics, with a
        revised hypothesis proposed if it wasn't fully supported.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 8 }}>
        <select
          value={selectedIndex} onChange={(e) => setSelectedIndex(Number(e.target.value))}
          style={{ fontSize: 12.5, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border,#e5e7eb)" }}
        >
          {hypotheses.map((h, i) => (
            <option key={i} value={i}>H{i + 1}{i === championIndex ? " (champion)" : ""}</option>
          ))}
        </select>
      </div>
      <textarea
        value={resultsText} onChange={(e) => setResultsText(e.target.value)} rows={4}
        placeholder="What did you observe? e.g. metrics achieved, notable deviations, failure modes, unexpected effects…"
        style={{
          width: "100%", maxWidth: READING_WIDTH, fontSize: 13, fontFamily: "inherit",
          padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border,#e5e7eb)",
          resize: "vertical", boxSizing: "border-box",
        }}
      />
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" onClick={submit} disabled={busy || !resultsText.trim()}>
          {busy ? "Checking…" : "Check against results"}
        </button>
        {error && <span style={{ color: "#d03b3b", fontSize: 12.5 }}>{error}</span>}
      </div>

      {validations.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {validations.slice().reverse().map((v) => (
            <ValidationEntry
              key={v.id} v={v} onApplyRefinement={onApplyRefinement} busy={busy} papers={papers}
              citeNum={citeNum}
              championIndex={championIndex} runnerUpIndex={runnerUpIndex}
              onReverifyRefinement={onReverifyRefinement}
              reverifyBusy={reverifyBusy} reverifyError={reverifyError}
              reverifications={(reverifications || []).filter((r) => r.validation_id === v.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ValidationEntry({
  v, onApplyRefinement, busy, papers, citeNum, championIndex, runnerUpIndex,
  onReverifyRefinement, reverifyBusy, reverifyError, reverifications = [],
}) {
  const [open, setOpen] = useState(false);
  const muted = { color: "var(--muted, #667)" };
  const style = VERDICT_STYLE[v.verdict] || VERDICT_STYLE.inconclusive;

  return (
    <div style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${style.border}`, background: style.bg }}>
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 0, width: "100%",
          display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, textAlign: "left",
        }}
      >
        <span aria-hidden="true">{style.emoji}</span>
        <b>H{v.hypothesis_index + 1}</b>
        <span>{style.label}</span>
        {v.applied && (
          <span style={{
            fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 999,
            background: "var(--accent,#6c5ce7)", color: "#fff",
          }}>
            revision applied
          </span>
        )}
        <span style={{ ...muted, marginLeft: "auto" }}>
          {new Date(v.created_at).toLocaleDateString()}
        </span>
        <span aria-hidden="true" style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {v.assessment && (
            <div style={{ marginBottom: 6, lineHeight: 1.5 }}>
              <CitedText text={v.assessment} papers={papers} citeNum={citeNum} />
            </div>
          )}
          <div style={{ ...muted, fontSize: 12, fontStyle: "italic", marginBottom: 8 }}>
            "{v.results_text}"
          </div>
          {v.refined_hypothesis && (
            <div style={{
              padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.5)",
              border: "1px dashed var(--border,#e5e7eb)",
            }}>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Proposed revision</div>
              <div style={{ marginBottom: 6 }}>{v.refined_hypothesis.hypothesis}</div>
              {v.refinement_note && <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>{v.refinement_note}</div>}
              {v.applied ? (
                <span style={{ ...muted, fontSize: 12 }}>Applied — this hypothesis's text now reflects the revision.</span>
              ) : (
                <button type="button" disabled={busy} onClick={() => onApplyRefinement(v.id)} style={{ fontSize: 12.5 }}>
                  Apply this revision
                </button>
              )}
              {!v.applied && (
                <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>
                  Applying replaces H{v.hypothesis_index + 1}'s text. The critique, ranking,
                  and plausibility scores above won't reflect it until you run the pipeline again.
                </div>
              )}
            </div>
          )}
          {v.applied && onReverifyRefinement && (
            <ReverifySection
              validationId={v.id} hypothesisIndex={v.hypothesis_index}
              championIndex={championIndex} runnerUpIndex={runnerUpIndex}
              onReverifyRefinement={onReverifyRefinement}
              busy={reverifyBusy} error={reverifyError}
              reverifications={reverifications}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---- closing the loop (hypothesis_agent_architecture.md SS7) -------------
// An applied refinement swaps in new text but never got a chance to
// actually beat the current champion — this is that chance: a fresh Critic
// score plus up to two head-to-head matches (vs champion, then vs
// runner-up only if it lost that one), reusing the same ranker call the
// bracket itself uses. Deliberately NOT a full bracket replay (SS7.1) —
// cost is shown up front, same "no surprise spinner" rule SS6.3 set for
// the ranker-match dispute case.
const REVERIFY_OUTCOME_STYLE = {
  new_champion: { label: "Became the new champion", border: "var(--green-soft,#bfe6bf)", bg: "var(--green-bg,#eefbee)" },
  new_runner_up: { label: "Became the new runner-up", border: "var(--amber-border,#e9c27a)", bg: "var(--amber-soft,#fdf6e6)" },
  no_change: { label: "Didn't beat the current top two", border: "var(--border,#e5e7eb)", bg: "var(--chip,#f1f0fb)" },
};

function ReverifySection({
  validationId, hypothesisIndex, championIndex, runnerUpIndex,
  onReverifyRefinement, busy, error, reverifications,
}) {
  const muted = { color: "var(--muted, #667)" };
  const alreadyTop = hypothesisIndex === championIndex || hypothesisIndex === runnerUpIndex;

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border,#e5e7eb)" }}>
      {alreadyTop ? (
        <div style={{ ...muted, fontSize: 12 }}>
          {hypothesisIndex === championIndex
            ? "This hypothesis is already the champion."
            : "This hypothesis is already the runner-up."}
        </div>
      ) : (
        <>
          <button
            type="button" disabled={busy}
            onClick={() => onReverifyRefinement(validationId)}
            style={{ fontSize: 12.5 }}
          >
            {busy ? "Checking against champion…" : "Check against current champion"}
          </button>
          <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>
            Runs a fresh score and up to 2 head-to-head matches (~3 model calls) —
            doesn't replay the whole bracket, just checks this hypothesis against
            the current top two.
          </div>
          {error && <div style={{ color: "#d03b3b", fontSize: 12, marginTop: 4 }}>{error}</div>}
        </>
      )}

      {reverifications.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {reverifications.slice().reverse().map((r) => {
            const style = REVERIFY_OUTCOME_STYLE[r.outcome] || REVERIFY_OUTCOME_STYLE.no_change;
            return (
              <div
                key={r.id}
                style={{
                  padding: "8px 10px", borderRadius: 8,
                  border: `1px solid ${style.border}`, background: style.bg, fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{style.label}</div>
                {r.matches.map((m, j) => (
                  <div key={j} style={{ marginBottom: 4, lineHeight: 1.4 }}>
                    vs {m.opponent === "champion" ? "champion" : "runner-up"}: {" "}
                    <b>{m.winner === "challenger" ? "this hypothesis won" : "opponent won"}</b>
                    {m.reason && <span style={muted}> — {m.reason}</span>}
                  </div>
                ))}
                <div style={{ ...muted, fontSize: 10.5, marginTop: 2 }}>
                  {new Date(r.created_at).toLocaleDateString()}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- audit log: the raw prompt/response behind every call this run made --
// hypothesis_agent_architecture.md SS6.4 — the structured plan/critique/
// bracket/meta_review above are each agent's PARSED output; this is what it
// was actually shown and actually said, in call order, so a run can be
// inspected or reproduced later without re-running it. Collapsed by
// default and each entry collapsed too — this is depth for someone
// debugging or auditing a specific call, not something to read top to
// bottom on every visit.
function AuditLogSection({ auditLog }) {
  const [open, setOpen] = useState(false);
  const muted = { color: "var(--muted, #667)" };

  return (
    <div style={{
      marginTop: 16, padding: "14px 16px", borderRadius: 12,
      border: "1px solid var(--border,#e5e7eb)",
    }}>
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 0,
          fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
        }}
      >
        <span aria-hidden="true">🧾</span>
        Audit log — {auditLog.length} LLM call{auditLog.length === 1 ? "" : "s"}
        <span aria-hidden="true" style={{ fontSize: 11 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {auditLog.map((e, i) => (
            <AuditLogEntry key={i} index={i} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function AuditLogEntry({ index, entry }) {
  const [open, setOpen] = useState(false);
  const muted = { color: "var(--muted, #667)" };
  const pre = {
    whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 11.5,
    background: "var(--chip,#f1f0fb)", borderRadius: 8, padding: "8px 10px",
    maxHeight: 260, overflow: "auto", margin: "4px 0 0",
  };

  return (
    <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 8, padding: "8px 10px" }}>
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 0, width: "100%",
          display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, textAlign: "left",
        }}
      >
        <span style={{ ...muted, fontFamily: "monospace" }}>#{index + 1}</span>
        <b>{STAGE_LABEL[entry.stage] || entry.stage}</b>
        <span style={muted}>{entry.model}</span>
        <span style={{ ...muted, marginLeft: "auto" }}>{entry.latency_ms} ms</span>
        <span aria-hidden="true" style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {entry.system && (
            <>
              <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 6 }}>System</div>
              <pre style={pre}>{entry.system}</pre>
            </>
          )}
          {entry.user_text && (
            <>
              <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 6 }}>Input</div>
              <pre style={pre}>{entry.user_text}</pre>
            </>
          )}
          {entry.output && (
            <>
              <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 6 }}>Raw output</div>
              <pre style={pre}>{entry.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const STAGE_LABEL = {
  hypothesis_designer: "Experiment Designer",
  hypothesis_critic: "Hypothesis Critic",
  hypothesis_novelty: "Novelty check",
  hypothesis_ranker: "Ranking bracket",
  hypothesis_meta_review: "Meta-Review",
  hypothesis_plausibility: "Plausibility check",
};

// ---- confidence gauge: a small radial dial instead of a bare number -------
// Meta-Review's confidence is the one number in this panel worth a glance
// treatment — everything else here is text or a score bar already.
function ConfidenceGauge({ value }) {
  const size = 76;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const color = pct >= 75 ? "#0ca30c" : pct >= 50 ? "#fab219" : "#d03b3b";
  return (
    <div style={{ flexShrink: 0, textAlign: "center" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Confidence ${pct} out of 100`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border,#e5e7eb)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="53%" textAnchor="middle" fontSize="18" fontWeight="700" fill="currentColor">{pct}</text>
      </svg>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--muted,#667)", marginTop: 2 }}>
        confidence
      </div>
    </div>
  );
}

// ---- plausibility check: the closest thing to "empirical validation" -----
// this tool can do without a dataset or code execution to actually run the
// champion hypothesis against — a literature-grounded sanity check on its
// own numeric target(s), compared to what similar methods in THIS run's
// own extractions actually reported. See agents/hypothesis_plausibility.py.
// Deliberately its own section (not folded into the meta-review card above)
// since it can exist even when there's no meta-review at all — a
// single-hypothesis run has a champion (and so a plausibility check) but
// never reaches the bracket/meta-reviewer.
const PLAUSIBILITY_STYLE = {
  plausible: { emoji: "✅", label: "Plausible", border: "var(--green-soft,#bfe6bf)", bg: "var(--green-bg,#eefbee)" },
  optimistic: { emoji: "⚠️", label: "Optimistic", border: "var(--amber-border,#e9c27a)", bg: "var(--amber-soft,#fdf6e6)" },
  unsupported: { emoji: "❔", label: "Unsupported", border: "var(--border,#e5e7eb)", bg: "var(--chip,#f1f0fb)" },
  not_applicable: { emoji: "—", label: "Not applicable", border: "var(--border,#e5e7eb)", bg: "var(--chip,#f1f0fb)" },
};

function PlausibilitySection({ plausibilityCheck, championIndex, papers, stale, citeNum }) {
  const muted = { color: "var(--muted, #667)" };
  const style = PLAUSIBILITY_STYLE[plausibilityCheck.verdict] || PLAUSIBILITY_STYLE.unsupported;
  const findings = plausibilityCheck.comparable_findings || [];
  return (
    <div style={{
      margin: "0 0 22px", padding: "14px 18px", borderRadius: 12,
      border: `1px solid ${style.border}`, background: style.bg, maxWidth: READING_WIDTH,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13.5, fontWeight: 700 }}>
        <span aria-hidden="true">{style.emoji}</span>
        Plausibility check{typeof championIndex === "number" ? ` — H${championIndex + 1}'s target` : ""}: {style.label}
        {stale && (
          <span style={{
            fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 999,
            border: "1px solid var(--border,#e5e7eb)", color: "var(--muted,#667)",
          }}>
            stale — champion changed since this ran
          </span>
        )}
      </div>
      {plausibilityCheck.reasoning && (
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <CitedText text={plausibilityCheck.reasoning} papers={papers} citeNum={citeNum} />
        </div>
      )}
      {findings.length > 0 && (
        <div style={{ ...muted, fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
          {findings.map((f, j) => (
            <div key={j}>
              [<CiteLink idx={f.idx} papers={papers} label={f.idx} citeNum={citeNum} />] {f.note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- argument/dispute flow: hypothesis_agent_architecture.md §6 ----------
// v1 scope (§6.5): Meta-Review dispute only -- "I don't think the champion
// is the right call," as opposed to the results-check above ("here's a new
// fact") or Methods' own per-hypothesis challenge (arguing with a
// hypothesis's own design, not a judgment the pipeline made). Same
// propose-then-explicit-apply shape as UserResultsSection: submitting
// always gets a response; nothing changes until Apply is clicked.
const DISPUTE_STYLE = {
  defended: { emoji: "🛡️", label: "Defended", border: "var(--border,#e5e7eb)", bg: "var(--chip,#f1f0fb)" },
  revised: { emoji: "🔁", label: "Revised", border: "var(--accent,#6c5ce7)", bg: "var(--indigo-soft,#eeecfd)" },
};

function MetaReviewDisputeSection({ disputes, onDispute, onApply, busy, error, championIndex, runnerUpIndex, papers, citeNum }) {
  const muted = { color: "var(--muted, #667)" };
  const [objection, setObjection] = useState("");

  function submit() {
    const text = objection.trim();
    if (!text || busy) return;
    onDispute(text);
    setObjection("");
  }

  return (
    <div style={{
      margin: "0 0 22px", padding: "14px 18px", borderRadius: 12,
      border: "1px solid var(--border,#e5e7eb)", maxWidth: READING_WIDTH,
    }}>
      <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4 }}>
        Argue with this recommendation
      </div>
      <div style={{ ...muted, fontSize: 12.5, marginBottom: 10, lineHeight: 1.4 }}>
        Don't think H{typeof championIndex === "number" ? championIndex + 1 : "?"} is the right call? Say why —
        the agent will either defend its pick with a specific counter-reason or revise the recommendation,
        possibly in favor of H{typeof runnerUpIndex === "number" ? runnerUpIndex + 1 : "?"} instead.
      </div>
      <textarea
        value={objection} onChange={(e) => setObjection(e.target.value)} rows={3}
        placeholder="e.g. the runner-up's approach is more feasible with the equipment we actually have…"
        style={{
          width: "100%", fontSize: 13, fontFamily: "inherit", padding: "8px 10px",
          borderRadius: 8, border: "1px solid var(--border,#e5e7eb)", resize: "vertical", boxSizing: "border-box",
        }}
      />
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" onClick={submit} disabled={busy || !objection.trim()}>
          {busy ? "Arguing…" : "Argue"}
        </button>
        {error && <span style={{ color: "#d03b3b", fontSize: 12.5 }}>{error}</span>}
      </div>

      {disputes.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {disputes.slice().reverse().map((d) => (
            <DisputeEntry key={d.id} d={d} onApply={onApply} busy={busy} papers={papers} citeNum={citeNum} />
          ))}
        </div>
      )}
    </div>
  );
}

function DisputeEntry({ d, onApply, busy, papers, citeNum }) {
  const [open, setOpen] = useState(false);
  const muted = { color: "var(--muted, #667)" };
  const style = DISPUTE_STYLE[d.stance] || DISPUTE_STYLE.defended;
  const changesChampion = d.stance === "revised" && d.prefer === "runner_up";

  return (
    <div style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${style.border}`, background: style.bg }}>
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 0, width: "100%",
          display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, textAlign: "left",
        }}
      >
        <span aria-hidden="true">{style.emoji}</span>
        <span>{style.label}</span>
        {d.applied && (
          <span style={{
            fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 999,
            background: "var(--accent,#6c5ce7)", color: "#fff",
          }}>
            applied
          </span>
        )}
        <span style={{ ...muted, marginLeft: "auto" }}>
          {new Date(d.created_at).toLocaleDateString()}
        </span>
        <span aria-hidden="true" style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <div style={{ ...muted, fontSize: 12, fontStyle: "italic", marginBottom: 6 }}>
            "{d.objection}"
          </div>
          {d.response && (
            <div style={{ marginBottom: 8, lineHeight: 1.5 }}>
              <CitedText text={d.response} papers={papers} citeNum={citeNum} />
            </div>
          )}
          {d.stance === "revised" && d.recommendation && (
            <div style={{
              padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.5)",
              border: "1px dashed var(--border,#e5e7eb)",
            }}>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                Revised recommendation{changesChampion ? " — prefers the runner-up" : ""}
              </div>
              <div style={{ marginBottom: 6 }}>{d.recommendation.recommendation}</div>
              {d.applied ? (
                <span style={{ ...muted, fontSize: 12 }}>Applied — the recommendation above now reflects this.</span>
              ) : (
                <>
                  <button type="button" disabled={busy} onClick={() => onApply(d.id)} style={{ fontSize: 12.5 }}>
                    Apply this revision
                  </button>
                  <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>
                    {changesChampion
                      ? "Applying swaps the champion and runner-up; the plausibility check below will be marked stale (it ran against the old champion)."
                      : "Applying replaces the recommendation write-up only — the bracket and champion stay the same."}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- ranking bracket: a real tournament diagram, plus the reasoning -------
// The diagram is the headline (the "how did it decide" shape at a glance);
// each match's actual judgment text is still available below it, expanded
// by default now that it has a picture to anchor it rather than being a
// wall of "H3 vs H6 -> winner H3" lines on its own.
function BracketSection({ bracket, hypotheses, accents }) {
  return (
    <div style={{
      marginTop: 4, padding: "16px 18px", borderRadius: 12,
      border: "1px solid var(--border,#e5e7eb)", background: "var(--chip,#f1f0fb)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
        <span aria-hidden="true">🥊</span>
        Ranking bracket — {(bracket.matches || []).filter((m) => !m.bye).length} head-to-head match
        {(bracket.matches || []).filter((m) => !m.bye).length === 1 ? "" : "es"}, single elimination
      </div>
      <BracketDiagram bracket={bracket} hypotheses={hypotheses} accents={accents} />
      <MatchReasoning bracket={bracket} />
    </div>
  );
}

function BracketDiagram({ bracket, hypotheses, accents }) {
  const rounds = {};
  (bracket.matches || []).forEach((m) => { (rounds[m.round] ||= []).push(m); });
  const roundNums = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  if (roundNums.length === 0) return null;

  const boxW = 168;
  const boxH = 46;
  const colGap = 56;
  const unitH = 60;
  const firstCount = rounds[roundNums[0]].length;
  const height = firstCount * unitH;
  const width = roundNums.length * boxW + (roundNums.length - 1) * colGap + 8;

  const yPos = {};
  yPos[roundNums[0]] = rounds[roundNums[0]].map((_, i) => i * unitH + unitH / 2);
  for (let idx = 1; idx < roundNums.length; idx++) {
    const r = roundNums[idx];
    const prevY = yPos[roundNums[idx - 1]];
    yPos[r] = rounds[r].map((_, i) => (prevY[2 * i] + prevY[2 * i + 1]) / 2);
  }

  const label = (i) => (i == null ? "" : `H${i + 1}`);
  const accentFor = (i) => (i == null ? "var(--muted,#667)" : accents[i % accents.length]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label="Single-elimination ranking bracket, from first-round matches to the champion"
      style={{ width: "100%", maxWidth: width, height: "auto", display: "block", marginBottom: 4 }}
    >
      {roundNums.map((r, ridx) => {
        const x = ridx * (boxW + colGap);
        const nextR = roundNums[ridx + 1];
        return (
          <g key={r}>
            {rounds[r].map((m, i) => {
              const y = yPos[r][i];
              if (m.bye) {
                return (
                  <g key={i}>
                    <rect x={x} y={y - boxH / 2} width={boxW} height={boxH} rx={8}
                          fill="var(--surface-2,#fff)" stroke="var(--border,#e5e7eb)" strokeDasharray="3 3" />
                    <rect x={x} y={y - boxH / 2} width={4} height={boxH} fill={accentFor(m.winner)} />
                    <text x={x + 12} y={y + 4} fontSize={12} fill="currentColor">{label(m.winner)} — bye</text>
                  </g>
                );
              }
              return (
                <g key={i}>
                  <rect x={x} y={y - boxH / 2} width={boxW} height={boxH} rx={8}
                        fill="var(--surface-2,#fff)" stroke="var(--border,#e5e7eb)" />
                  <rect x={x} y={y - boxH / 2} width={4} height={boxH} fill={accentFor(m.winner)} />
                  <text x={x + 12} y={y - 5} fontSize={11.5} fontWeight={m.winner === m.a ? 700 : 400}
                        fill="currentColor" opacity={m.winner === m.a ? 1 : 0.55}>
                    {label(m.a)}
                  </text>
                  <text x={x + 12} y={y + 15} fontSize={11.5} fontWeight={m.winner === m.b ? 700 : 400}
                        fill="currentColor" opacity={m.winner === m.b ? 1 : 0.55}>
                    {label(m.b)}
                  </text>
                </g>
              );
            })}
            {nextR && rounds[r].map((_, i) => {
              if (i % 2 === 1) return null;
              const yA = yPos[r][i];
              const yB = yPos[r][i + 1];
              const midX = x + boxW + colGap / 2;
              const nextX = (ridx + 1) * (boxW + colGap);
              return (
                <g key={"c" + i} stroke="currentColor" strokeOpacity={0.3} fill="none">
                  <line x1={x + boxW} y1={yA} x2={midX} y2={yA} />
                  <line x1={x + boxW} y1={yB} x2={midX} y2={yB} />
                  <line x1={midX} y1={yA} x2={midX} y2={yB} />
                  <line x1={midX} y1={(yA + yB) / 2} x2={nextX} y2={(yA + yB) / 2} />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function MatchReasoning({ bracket }) {
  const [open, setOpen] = useState(false);
  const muted = { color: "var(--muted, #667)" };
  const label = (idx) => (idx == null ? "—" : `H${idx + 1}`);
  const real = (bracket.matches || []).filter((m) => !m.bye);
  if (real.length === 0) return null;

  return (
    <div>
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 0,
          fontSize: 12.5, fontWeight: 600, color: "var(--accent,#6c5ce7)",
          display: "flex", alignItems: "center", gap: 4, marginTop: 4,
        }}
      >
        {open ? "Hide" : "Show"} match reasoning
        <span aria-hidden="true" style={{ fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {real.map((m, j) => (
            <div key={j} style={{ fontSize: 13 }}>
              <b>{label(m.a)}</b> vs <b>{label(m.b)}</b> → winner <b>{label(m.winner)}</b>
              {m.reason && <div style={muted}>{m.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- read-only card: hypothesis + rationale + evidence + critic scores ----
// Deliberately not HypothesisCard from MethodsPanel.jsx — that component is
// tightly coupled to Methods' interactive props (onUpdate/onDispute/
// onAcceptRevision/debate). This is a plain view.
function ReadOnlyHypothesisCard({ h, i, papers, extractions, critique, noveltyCheck, isChampion, isRunnerUp, accent, citeNum }) {
  const muted = { color: "var(--muted, #667)" };
  const titleFor = (idx) => papers.find((p) => p.idx === idx)?.title;
  const findingFor = (idx) => extractions.find((e) => e.idx === idx)?.finding;

  const items = [
    ...(h.approaches || []).map((a) => ({ ...a, role: "approach" })),
    ...(h.baselines || []).map((b) => ({ ...b, role: "baseline" })),
  ].filter((it) => it.from_idx != null);
  const proposed = (h.approaches || []).filter((a) => a.from_idx == null || a.evidenced === false);

  return (
    <div style={{
      position: "relative", overflow: "hidden",
      border: isChampion ? "1.5px solid var(--accent,#6c5ce7)" : "1px solid var(--border,#e5e7eb)",
      borderRadius: 12, padding: "16px 16px 16px 20px",
      boxShadow: isChampion ? "0 2px 10px rgba(108,92,231,0.12)" : "none",
    }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 5, background: accent }} />
      <div style={{ fontWeight: 700, marginBottom: 2, display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span>H{i + 1}. <CitedText text={h.hypothesis} papers={papers} citeNum={citeNum} /></span>
        {isChampion && (
          <span style={{
            flexShrink: 0, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
            background: "var(--accent,#6c5ce7)", color: "#fff",
          }}>🏆 champion</span>
        )}
        {isRunnerUp && (
          <span style={{
            flexShrink: 0, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
            border: "1px solid var(--border,#e5e7eb)", color: "var(--muted,#667)",
          }}>runner-up</span>
        )}
      </div>

      {h.rationale && (
        <div style={{ fontSize: 13, margin: "6px 0" }}>
          <CitedText text={h.rationale} papers={papers} citeNum={citeNum} />
        </div>
      )}

      {(h.variables?.independent || h.variables?.dependent || h.setup) && (
        <div style={{ display: "flex", alignItems: "stretch", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
          <div style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border,#e5e7eb)", background: "var(--chip,#f1f0fb)", fontSize: 13 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, ...muted, marginBottom: 3 }}>Independent</div>
            {h.variables?.independent || "—"}
          </div>
          <span aria-hidden="true" style={{ alignSelf: "center", ...muted }}>→</span>
          <div style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border,#e5e7eb)", fontSize: 13 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, ...muted, marginBottom: 3 }}>Setup</div>
            {h.setup || "—"}
          </div>
          <span aria-hidden="true" style={{ alignSelf: "center", ...muted }}>→</span>
          <div style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border,#e5e7eb)", background: "var(--chip,#f1f0fb)", fontSize: 13 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, ...muted, marginBottom: 3 }}>Dependent</div>
            {h.variables?.dependent || "—"}
          </div>
        </div>
      )}
      {h.variables?.controlled && (
        <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>held constant: {h.variables.controlled}</div>
      )}

      {(h.metrics || []).length > 0 && (
        <div style={{ fontSize: 13, margin: "6px 0" }}>
          {h.metrics.map((m, j) => (
            <span key={j} style={{ display: "inline-block", marginRight: 10, marginBottom: 4 }}>
              <b>{m.name}</b>{m.target ? `: ${m.target}` : ""}
            </span>
          ))}
        </div>
      )}

      {h.risks && (
        <div style={{ ...muted, fontSize: 13, margin: "6px 0" }}>
          <b>Risks:</b> <CitedText text={h.risks} papers={papers} citeNum={citeNum} />
        </div>
      )}

      {noveltyCheck && <NoveltyBadge noveltyCheck={noveltyCheck} />}

      {(items.length > 0 || proposed.length > 0) && (
        <div style={{ margin: "10px 0" }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            Evidence trail — what this is grounded in
          </div>
          {items.length > 0 && (
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, marginBottom: proposed.length ? 8 : 0 }}>
              <thead>
                <tr style={{ ...muted, textAlign: "left" }}>
                  <th style={{ padding: "4px 8px 4px 0" }}>{h.approaches?.length ? "Approach / baseline" : "Baseline"}</th>
                  <th style={{ padding: "4px 8px 4px 0" }}>Source paper</th>
                  <th style={{ padding: "4px 8px 4px 0" }}>What it found</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, j) => (
                  <tr key={j}>
                    <td style={{ padding: "4px 8px 4px 0" }}>
                      {it.name} [<CiteLink idx={it.from_idx} papers={papers} label={it.from_idx} citeNum={citeNum} />]
                    </td>
                    <td style={{ padding: "4px 8px 4px 0", maxWidth: 240 }}>{titleFor(it.from_idx) || "—"}</td>
                    <td style={{ padding: "4px 8px 4px 0", ...muted }}>{findingFor(it.from_idx) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {proposed.length > 0 && (
            <div style={{ ...muted, fontSize: 13, fontStyle: "italic" }}>
              Not traced to a source (the agent's own proposal): {proposed.map((a) => a.name).join(", ")}
            </div>
          )}
        </div>
      )}

      {critique && <ScoreBars critique={critique} papers={papers} citeNum={citeNum} />}
    </div>
  );
}

// ---- novelty badge: live prior-art check, distinct from the Critic's -----
// corpus-only novelty score. agents/hypothesis_novelty.py searches the real
// literature (not just this run's papers) per hypothesis and returns a
// conservative verdict — shown here as a small callout, not baked into
// ScoreBars, since it's a different kind of check (external search result,
// not an LLM self-critique) and "searched: 0" is meaningfully different
// from "searched some, found nothing close."
function NoveltyBadge({ noveltyCheck }) {
  const muted = { color: "var(--muted, #667)" };
  const found = !!noveltyCheck.prior_art_found;
  const match = noveltyCheck.closest_match;
  return (
    <div style={{
      margin: "8px 0", padding: "8px 10px", borderRadius: 8, fontSize: 12.5,
      border: `1px solid ${found ? "var(--amber-border,#e9c27a)" : "var(--border,#e5e7eb)"}`,
      background: found ? "var(--amber-soft,#fdf6e6)" : "var(--chip,#f1f0fb)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        <span aria-hidden="true">{found ? "⚠️" : "🔎"}</span>
        {found ? "Possible prior art found" : "No close prior art found"}
        {typeof noveltyCheck.searched === "number" && (
          <span style={{ ...muted, fontWeight: 400, marginLeft: "auto" }}>
            {noveltyCheck.searched} paper{noveltyCheck.searched === 1 ? "" : "s"} searched
          </span>
        )}
      </div>
      {found && match && (
        <div style={{ marginTop: 4 }}>
          {match.url ? (
            <a href={match.url} target="_blank" rel="noreferrer">{match.title || "closest match"}</a>
          ) : (
            <b>{match.title || "closest match"}</b>
          )}
          {match.year ? ` (${match.year})` : ""}
          {match.why_similar && <div style={muted}>{match.why_similar}</div>}
        </div>
      )}
      {noveltyCheck.novelty_note && (
        <div style={{ ...muted, marginTop: 4 }}>{noveltyCheck.novelty_note}</div>
      )}
    </div>
  );
}

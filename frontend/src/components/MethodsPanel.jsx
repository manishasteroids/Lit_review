import React, { useState } from "react";

/**
 * Methods / Experiment Designer panel (controlled).
 * Plan + design handler live in App.jsx so results survive tab switches.
 *
 * Each hypothesis renders as a scannable card:
 *   - the hypothesis + rationale
 *   - critic scores as small status-colored bars (novelty/grounding/
 *     testability/consistency) instead of a plain number — see ScoreBars
 *   - an "Evidence trail" table: which cited paper actually backs which
 *     claim, so "what is this grounded in" is answered in the UI itself,
 *     not just in a citation number you have to go look up
 *   - an Edit toggle: every field is user-editable, and edits save with no
 *     LLM call — the agent's output is a draft to argue with, not a verdict
 *   - a "Challenge" box: type an objection, the designer either revises the
 *     hypothesis or defends it with a specific counter-reason (never a bare
 *     concession) — see agents/experiment_designer.py: respond_to_challenge
 *
 * Props: plan, critique, iterations, debate, busy, onDesign, onRefine,
 *        onUpdate(index, edits), onDispute(index, argument),
 *        onAcceptRevision(index, proposedHypothesis), onExport(fmt),
 *        papers=[{idx,title}], extractions=[{idx,finding,...}]
 */
export default function MethodsPanel({
  plan, critique, iterations = 0, debate = {}, busy,
  onDesign, onRefine, onUpdate, onDispute, onAcceptRevision, onExport,
  papers = [], extractions = [],
}) {
  const muted = { color: "var(--muted, #667)" };
  const critiqueByIndex = Object.fromEntries(
    (critique?.critiques || []).map((c) => [c.index, c])
  );

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Methods &amp; Experiments</h3>
        <button onClick={onDesign} disabled={busy} type="button">
          {busy ? "Working…" : plan ? "Regenerate" : "Design experiments"}
        </button>
        <button
          onClick={onRefine}
          disabled={busy}
          type="button"
          title="Critique each hypothesis and revise the weak ones — repeats a couple of rounds automatically"
        >
          {busy ? "Working…" : "Refine (recursive self-improve)"}
        </button>
        {iterations > 0 && <span style={{ ...muted, fontSize: 12 }}>Refined ×{iterations}</span>}
        {plan && onExport && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button type="button" onClick={() => onExport("docx")} disabled={busy}>Export .docx</button>
            <button type="button" onClick={() => onExport("pdf")} disabled={busy}>Export .pdf</button>
          </span>
        )}
      </div>
      <p style={{ ...muted, marginTop: 0 }}>
        Turns the synthesis and detected gaps into testable experiment plans, in
        the language of the paper's domain — grounded in your cited sources.
        Nothing here is final: edit any field, or challenge a hypothesis
        directly and the agent will revise it or defend it. Saved automatically —
        it'll still be here if you leave and come back.
      </p>
      <ProcessDiagram />

      {plan?.domain && (
        <div style={{ fontSize: 13, margin: "8px 0 4px" }}>
          <span style={muted}>Domain detected:</span> <b>{plan.domain}</b>
        </div>
      )}
      {plan?.note && (
        <div style={{ ...muted, fontSize: 13, margin: "4px 0 8px" }}>{plan.note}</div>
      )}
      {critique?.note && (
        <div style={{ ...muted, fontSize: 13, margin: "4px 0 8px", fontStyle: "italic" }}>
          Critic: {critique.note}
        </div>
      )}
      {(plan?.hypotheses || []).some((_, i) => critiqueByIndex[i]) && <ScoreLegend />}

      {(plan?.hypotheses || []).map((h, i) => (
        <HypothesisCard
          key={i}
          h={h}
          i={i}
          papers={papers}
          extractions={extractions}
          critique={critiqueByIndex[i]}
          debate={debate[i] || []}
          busy={busy}
          onUpdate={onUpdate ? (edits) => onUpdate(i, edits) : null}
          onDispute={onDispute ? (argument) => onDispute(i, argument) : null}
          onAcceptRevision={onAcceptRevision ? (proposed) => onAcceptRevision(i, proposed) : null}
        />
      ))}

      {plan && (plan.hypotheses || []).length === 0 && !busy && (
        <div style={muted}>No experiment plan for this run yet.</div>
      )}
    </div>
  );
}

// ---- process diagram: what "Design" vs "Refine" actually do ---------------
// A one-time explainer, not repeated per hypothesis — see the panel's
// architecture notes: Design generates from scratch, Refine loops
// critique -> revise until scores clear the bar or the round budget runs out.
function ProcessDiagram() {
  const muted = { color: "var(--muted, #667)" };
  const step = (label, sub) => (
    <div style={{ textAlign: "center", flex: 1, minWidth: 0 }}>
      <div style={{
        border: "1px solid var(--border,#e5e7eb)", borderRadius: 10, padding: "8px 6px",
        background: "var(--chip,#f1f0fb)", fontSize: 12, fontWeight: 600,
      }}>
        {label}
      </div>
      {sub && <div style={{ ...muted, fontSize: 11, marginTop: 3 }}>{sub}</div>}
    </div>
  );
  return (
    <div style={{ margin: "2px 0 16px", maxWidth: 480 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {step("Design", "propose hypotheses")}
        <span aria-hidden="true" style={{ ...muted, fontSize: 16, flexShrink: 0 }}>→</span>
        {step("Critique", "score 4 axes")}
        <span aria-hidden="true" style={{ ...muted, fontSize: 16, flexShrink: 0 }}>→</span>
        {step("Revise", "fix the weak ones")}
      </div>
      <div style={{ textAlign: "center", ...muted, fontSize: 11, marginTop: 4 }}>
        ↻ Refine repeats this loop until scores clear the bar, or the round budget runs out
      </div>
    </div>
  );
}

// ---- score visualization -------------------------------------------------
// Status is a quality GATE (pass/needs-work/fail), not an arbitrary category,
// so it uses the reserved status palette rather than a categorical hue — and
// per that palette's contrast rules, color never carries the meaning alone:
// every bar pairs an icon + text label with the fill.
const STATUS = {
  good: { color: "#0ca30c", icon: "●", label: "good" },
  warning: { color: "#fab219", icon: "▲", label: "needs work" },
  critical: { color: "#d03b3b", icon: "✕", label: "weak" },
};
function statusFor(score) {
  if (score == null) return null;
  if (score >= 75) return STATUS.good;
  if (score >= 50) return STATUS.warning;
  return STATUS.critical;
}

function ScoreLegend() {
  const muted = { color: "var(--muted, #667)" };
  return (
    <div style={{ ...muted, fontSize: 12, margin: "0 0 12px" }}>
      Critic scores:
      {Object.values(STATUS).map((s) => (
        <span key={s.label} style={{ marginLeft: 10 }}>
          <span aria-hidden="true" style={{ color: s.color, marginRight: 3 }}>{s.icon}</span>
          {s.label}
        </span>
      ))}
    </div>
  );
}

function ScoreBars({ critique }) {
  const muted = { color: "var(--muted, #667)" };
  if (!critique) return null;
  const rows = [
    ["novelty", critique.scores?.novelty],
    ["grounding", critique.scores?.grounding],
    ["testability", critique.scores?.testability],
    ["consistency", critique.scores?.consistency],
  ].filter(([, v]) => v != null);
  if (rows.length === 0) return null;

  return (
    <div style={{ margin: "8px 0 12px", maxWidth: 420 }}>
      {rows.map(([label, value]) => {
        const s = statusFor(value);
        return (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ ...muted, fontSize: 12, width: 82, flexShrink: 0 }}>
              <span aria-hidden="true" style={{ color: s.color, marginRight: 4 }}>{s.icon}</span>
              {label}
            </span>
            {/* bar: ≤24px thick (here 8px), 4px rounded ends, single baseline */}
            <div style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--border,#e5e7eb)", overflow: "hidden" }}>
              <div style={{ width: `${value}%`, height: "100%", borderRadius: 4, background: s.color }} />
            </div>
            <span style={{ fontSize: 12, width: 22, textAlign: "right", fontWeight: 600 }}>{value}</span>
          </div>
        );
      })}
      {critique.overall != null && (
        <div style={{ fontSize: 12, marginTop: 2 }}>
          <b>Overall {critique.overall}</b>
          {statusFor(critique.overall) && <> — {statusFor(critique.overall).label}</>}
        </div>
      )}
      {(critique.issues || []).length > 0 && (
        <div style={{ ...muted, fontSize: 13, marginTop: 6 }}>{critique.issues.join(" · ")}</div>
      )}
      {critique.revise && (
        <div style={{ fontSize: 13, marginTop: 2, fontStyle: "italic" }}>Next revision: {critique.revise}</div>
      )}
    </div>
  );
}

// ---- evidence trail: which cited paper backs which claim ------------------
function EvidenceTrail({ h, papers, extractions }) {
  const muted = { color: "var(--muted, #667)" };
  const titleFor = (idx) => papers.find((p) => p.idx === idx)?.title;
  const findingFor = (idx) => extractions.find((e) => e.idx === idx)?.finding;

  const items = [
    ...(h.approaches || []).map((a) => ({ ...a, role: "approach" })),
    ...(h.baselines || []).map((b) => ({ ...b, role: "baseline" })),
  ].filter((it) => it.from_idx != null);
  const proposed = (h.approaches || []).filter((a) => a.from_idx == null || a.evidenced === false);

  if (items.length === 0 && proposed.length === 0) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
        Evidence trail — what this is grounded in
      </div>
      {items.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, marginBottom: proposed.length ? 8 : 0 }}>
          <thead>
            <tr style={{ ...muted, textAlign: "left" }}>
              <th style={th}>{h.approaches?.length ? "Approach / baseline" : "Baseline"}</th>
              <th style={th}>Source paper</th>
              <th style={th}>What it found</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, j) => (
              <tr key={j}>
                <td style={td}>{it.name} <span style={muted}>[{it.from_idx}]</span></td>
                <td style={{ ...td, maxWidth: 240 }}>{titleFor(it.from_idx) || "—"}</td>
                <td style={{ ...td, ...muted }}>{findingFor(it.from_idx) || "—"}</td>
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
  );
}

// ---- variables diagram: independent -> setup -> dependent, controlled aside --
// Replaces a plain "independent: X · dependent: Y · controlled: Z" text line
// with the actual causal shape of the experiment — worth a diagram because
// this is the one thing in the card that IS a flow (an intervention between
// two variables), not just a list of facts a table already handles fine.
function VariablesDiagram({ variables, setup }) {
  const muted = { color: "var(--muted, #667)" };
  const boxLabel = { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--muted,#667)", marginBottom: 3 };
  const box = (bg) => ({
    flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 10,
    border: "1px solid var(--border,#e5e7eb)", background: bg, fontSize: 13, lineHeight: 1.4,
  });
  const arrow = { flexShrink: 0, fontSize: 18, color: "var(--muted,#667)", alignSelf: "center" };

  return (
    <div style={{ margin: "4px 0 14px" }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 8, flexWrap: "wrap" }}>
        <div style={box("var(--chip,#f1f0fb)")}>
          <div style={boxLabel}>Independent</div>
          {variables.independent || "—"}
        </div>
        <span aria-hidden="true" style={arrow}>→</span>
        <div style={box("var(--surface-2,#fff)")}>
          <div style={boxLabel}>Intervention / setup</div>
          {setup || "—"}
        </div>
        <span aria-hidden="true" style={arrow}>→</span>
        <div style={box("var(--chip,#f1f0fb)")}>
          <div style={boxLabel}>Dependent</div>
          {variables.dependent || "—"}
        </div>
      </div>
      {variables.controlled && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <span style={muted}>held constant:</span> {variables.controlled}
        </div>
      )}
    </div>
  );
}

// ---- the card itself: view, edit, and dispute ------------------------------
function HypothesisCard({ h, i, papers, extractions, critique, debate, busy, onUpdate, onDispute, onAcceptRevision }) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [argument, setArgument] = useState("");
  const muted = { color: "var(--muted, #667)" };

  const titleFor = (idx) => (idx == null ? null : (papers.find((p) => p.idx === idx)?.title || `[${idx}]`));
  const cite = (idx, evidenced) =>
    idx == null ? (
      <span style={{ ...muted, fontStyle: "italic" }}>proposed</span>
    ) : (
      <span title={titleFor(idx)} style={{ color: evidenced === false ? "var(--muted,#667)" : "var(--accent,#6c5ce7)" }}>
        [{idx}]
      </span>
    );

  const pill = {
    display: "inline-block", fontSize: 13, padding: "3px 10px", marginRight: 6,
    marginBottom: 6, borderRadius: 999, background: "var(--chip,#f1f0fb)",
    border: "1px solid var(--border,#e5e7eb)",
  };
  const inputStyle = {
    width: "100%", fontSize: 13, padding: "4px 6px", marginBottom: 6,
    border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, boxSizing: "border-box",
  };

  function startEdit() {
    setDraft({
      hypothesis: h.hypothesis || "", rationale: h.rationale || "", setup: h.setup || "",
      variables: { ...(h.variables || {}) }, risks: h.risks || "",
      metrics: (h.metrics || []).map((m) => ({ ...m })),
    });
    setEditing(true);
  }
  function saveEdit() {
    onUpdate?.(draft);
    setEditing(false);
  }

  async function submitDispute() {
    if (!argument.trim()) return;
    const text = argument;
    setArgument("");
    await onDispute?.(text);
  }

  return (
    <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        {editing ? (
          <textarea
            style={{ ...inputStyle, fontWeight: 700 }}
            rows={2}
            value={draft.hypothesis}
            onChange={(e) => setDraft({ ...draft, hypothesis: e.target.value })}
          />
        ) : (
          <div style={{ fontWeight: 700, marginBottom: 2 }}>H{i + 1}. {h.hypothesis}</div>
        )}
        {onUpdate && !editing && (
          <button type="button" onClick={startEdit} style={{ fontSize: 12, flexShrink: 0 }}>Edit</button>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            style={inputStyle} rows={2} placeholder="Rationale"
            value={draft.rationale} onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
          />
          <textarea
            style={inputStyle} rows={2} placeholder="Setup"
            value={draft.setup} onChange={(e) => setDraft({ ...draft, setup: e.target.value })}
          />
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {["independent", "dependent", "controlled"].map((k) => (
              <input
                key={k} style={inputStyle} placeholder={k} value={draft.variables[k] || ""}
                onChange={(e) => setDraft({ ...draft, variables: { ...draft.variables, [k]: e.target.value } })}
              />
            ))}
          </div>
          {draft.metrics.map((m, j) => (
            <div key={j} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <span style={{ ...muted, fontSize: 13, minWidth: 100 }}>{m.name}</span>
              <input
                style={{ ...inputStyle, marginBottom: 0 }} placeholder="target" value={m.target || ""}
                onChange={(e) => {
                  const metrics = [...draft.metrics];
                  metrics[j] = { ...m, target: e.target.value };
                  setDraft({ ...draft, metrics });
                }}
              />
            </div>
          ))}
          <textarea
            style={inputStyle} rows={2} placeholder="Risks"
            value={draft.risks} onChange={(e) => setDraft({ ...draft, risks: e.target.value })}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={saveEdit}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          {h.rationale && <div style={{ ...muted, fontSize: 13, marginBottom: 4 }}>{h.rationale}</div>}
          <ScoreBars critique={critique} />

          {(h.approaches || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Candidate approaches</div>
              {h.approaches.map((a, j) => (
                <span key={j} style={pill}>{a.name} {cite(a.from_idx, a.evidenced)}</span>
              ))}
            </div>
          )}

          {(h.metrics || []).length > 0 && (
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14, marginBottom: 6 }}>
              <thead>
                <tr style={{ ...muted, textAlign: "left" }}>
                  <th style={th}>Metric</th><th style={th}>Unit / scale</th><th style={th}>Target</th>
                </tr>
              </thead>
              <tbody>
                {h.metrics.map((m, j) => (
                  <tr key={j}>
                    <td style={td}>{m.name}</td>
                    <td style={{ ...td, ...muted }}>{m.unit || "—"}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{m.target || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <button
            type="button" onClick={() => setOpen((o) => !o)}
            style={{ background: "none", border: "none", color: "var(--accent,#6c5ce7)", cursor: "pointer", padding: 0, fontSize: 13, marginTop: 4 }}
          >
            {open ? "Hide evidence, variables & validation ▲" : "Show evidence, variables & validation ▼"}
          </button>

          {open && (
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border,#e5e7eb)", paddingTop: 12 }}>
              <EvidenceTrail h={h} papers={papers} extractions={extractions} />
              {h.variables ? (
                <VariablesDiagram variables={h.variables} setup={h.setup} />
              ) : (
                h.setup && <Field label="Setup">{h.setup}</Field>
              )}
              {(h.baselines || []).length > 0 && (
                <Field label="Baselines">
                  {h.baselines.map((b, j) => (
                    <span key={j} style={{ marginRight: 10 }}>{b.name} {cite(b.from_idx, true)}</span>
                  ))}
                </Field>
              )}
              {(h.failure_modes || []).length > 0 && (
                <Field label="What could invalidate it">{h.failure_modes.join("; ")}</Field>
              )}
              {h.validation && <Field label="Validation">{h.validation}</Field>}
              {h.risks && <Field label="Risks / ethics">{h.risks}</Field>}
            </div>
          )}

          {onDispute && (
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border,#e5e7eb)", paddingTop: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Argue with this hypothesis</div>
              {debate.map((d, j) => {
                const applied = d.proposed && d.proposed.hypothesis === h.hypothesis;
                return (
                  <div key={j} style={{ fontSize: 13, marginBottom: 8 }}>
                    <div style={muted}>You: {d.argument}</div>
                    <div>
                      <span style={{
                        display: "inline-block", fontSize: 11, padding: "1px 6px", borderRadius: 999,
                        marginRight: 6, border: "1px solid var(--border,#e5e7eb)",
                        color: d.stance === "revised" ? "var(--accent,#6c5ce7)" : "var(--muted,#667)",
                      }}>
                        {d.stance === "revised" ? "revised" : "defended"}
                      </span>
                      {d.response}
                    </div>
                    {d.proposed && !applied && (
                      <div style={{ marginTop: 4, padding: 8, background: "var(--chip,#f1f0fb)", borderRadius: 8 }}>
                        <div style={muted}>Proposed: {d.proposed.hypothesis}</div>
                        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                          <button type="button" onClick={() => onAcceptRevision?.(d.proposed)} disabled={busy}>
                            Agree — apply this
                          </button>
                          <span style={muted}>or keep the current wording above</span>
                        </div>
                      </div>
                    )}
                    {applied && <div style={{ ...muted, fontStyle: "italic", marginTop: 2 }}>Applied ✓</div>}
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
                  placeholder={'e.g. "the metric target seems arbitrary — where does 15% come from?"'}
                  value={argument}
                  onChange={(e) => setArgument(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitDispute()}
                  disabled={busy}
                />
                <button type="button" onClick={submitDispute} disabled={busy || !argument.trim()}>
                  {busy ? "Working…" : "Challenge"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const th = { padding: "6px 10px", borderBottom: "1px solid var(--border,#e5e7eb)", fontWeight: 600 };
const td = { padding: "6px 10px", borderBottom: "1px solid var(--border,#f0f0f4)", verticalAlign: "top" };

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 8, fontSize: 14, lineHeight: 1.5 }}>
      <span style={{ fontWeight: 600, marginRight: 6 }}>{label}:</span>
      {children}
    </div>
  );
}

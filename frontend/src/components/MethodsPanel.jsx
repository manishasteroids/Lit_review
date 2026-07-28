import React, { useState } from "react";

/**
 * Methods / Experiment Designer panel (controlled).
 * Plan + design handler live in App.jsx so results survive tab switches.
 * Each hypothesis renders as a scannable card: hypothesis + approach pills +
 * a metrics TABLE up top, with the fuller protocol (setup, variables,
 * baselines, validation, risks) collapsed behind a toggle.
 *
 * Props: plan, busy, onDesign, papers=[{idx,title}]
 */
export default function MethodsPanel({ plan, busy, onDesign, papers = [] }) {
  const muted = { color: "var(--muted, #667)" };

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Methods &amp; Experiments</h3>
        <button onClick={onDesign} disabled={busy} type="button">
          {busy ? "Designing…" : plan ? "Regenerate" : "Design experiments"}
        </button>
      </div>
      <p style={{ ...muted, marginTop: 0 }}>
        Turns the synthesis and detected gaps into testable experiment plans, in
        the language of the paper's domain — grounded in your cited sources.
      </p>

      {plan?.domain && (
        <div style={{ fontSize: 13, margin: "8px 0 4px" }}>
          <span style={muted}>Domain detected:</span> <b>{plan.domain}</b>
        </div>
      )}
      {plan?.note && (
        <div style={{ ...muted, fontSize: 13, margin: "4px 0 16px" }}>{plan.note}</div>
      )}

      {(plan?.hypotheses || []).map((h, i) => (
        <HypothesisCard key={i} h={h} i={i} papers={papers} />
      ))}

      {plan && (plan.hypotheses || []).length === 0 && !busy && (
        <div style={muted}>No experiment plan for this run yet.</div>
      )}
    </div>
  );
}

function HypothesisCard({ h, i, papers }) {
  const [open, setOpen] = useState(false);
  const muted = { color: "var(--muted, #667)" };

  const titleFor = (idx) =>
    idx == null ? null : (papers.find((p) => p.idx === idx)?.title || `[${idx}]`);

  const cite = (idx, evidenced) =>
    idx == null ? (
      <span style={{ ...muted, fontStyle: "italic" }}>proposed</span>
    ) : (
      <span
        title={titleFor(idx)}
        style={{ color: evidenced === false ? "var(--muted,#667)" : "var(--accent,#6c5ce7)" }}
      >
        [{idx}]
      </span>
    );

  const pill = {
    display: "inline-block",
    fontSize: 13,
    padding: "3px 10px",
    marginRight: 6,
    marginBottom: 6,
    borderRadius: 999,
    background: "var(--chip,#f1f0fb)",
    border: "1px solid var(--border,#e5e7eb)",
  };

  return (
    <div
      style={{
        border: "1px solid var(--border,#e5e7eb)",
        borderRadius: 12,
        padding: 16,
        marginBottom: 14,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 2 }}>H{i + 1}. {h.hypothesis}</div>
      {h.rationale && <div style={{ ...muted, fontSize: 13, marginBottom: 12 }}>{h.rationale}</div>}

      {(h.approaches || []).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Candidate approaches</div>
          {h.approaches.map((a, j) => (
            <span key={j} style={pill}>
              {a.name} {cite(a.from_idx, a.evidenced)}
            </span>
          ))}
        </div>
      )}

      {(h.metrics || []).length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14, marginBottom: 6 }}>
          <thead>
            <tr style={{ ...muted, textAlign: "left" }}>
              <th style={th}>Metric</th>
              <th style={th}>Unit / scale</th>
              <th style={th}>Target</th>
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
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "none",
          border: "none",
          color: "var(--accent,#6c5ce7)",
          cursor: "pointer",
          padding: 0,
          fontSize: 13,
          marginTop: 4,
        }}
      >
        {open ? "Hide full protocol ▲" : "Show full protocol ▼"}
      </button>

      {open && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--border,#e5e7eb)", paddingTop: 12 }}>
          {h.setup && <Field label="Setup">{h.setup}</Field>}

          {h.variables && (
            <Field label="Variables">
              <span style={muted}>independent:</span> {h.variables.independent}{" · "}
              <span style={muted}>dependent:</span> {h.variables.dependent}{" · "}
              <span style={muted}>controlled:</span> {h.variables.controlled}
            </Field>
          )}

          {(h.baselines || []).length > 0 && (
            <Field label="Baselines">
              {h.baselines.map((b, j) => (
                <span key={j} style={{ marginRight: 10 }}>
                  {b.name} {cite(b.from_idx, true)}
                </span>
              ))}
            </Field>
          )}

          {(h.failure_modes || []).length > 0 && (
            <Field label="What could invalidate it">{(h.failure_modes || []).join("; ")}</Field>
          )}
          {h.validation && <Field label="Validation">{h.validation}</Field>}
          {h.risks && <Field label="Risks / ethics">{h.risks}</Field>}
        </div>
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

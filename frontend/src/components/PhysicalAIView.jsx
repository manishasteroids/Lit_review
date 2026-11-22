import React from "react";
import { Cpu, PenTool, FlaskConical, ArrowLeft } from "./icons.jsx";

/**
 * Physical AI — a placeholder page (architecture doc: Phase 4, deliberately
 * unscoped), styled the same as the other placeholder pages (see
 * DataAnalysisPlaceholder.jsx) rather than as a separate full-screen
 * takeover, so it reads as part of the same app instead of a different
 * product. Eventual pipeline: reads a selected hypothesis from a Project's
 * `hypothesis` handoff artifact and compiles it into robot control code --
 * see pipeline-wiring-architecture.md's note on this being a future
 * `physical_ai` workflow slot.
 */
export default function PhysicalAIView({ onBack }) {
  return (
    <div style={{ maxWidth: 640, margin: "60px auto", textAlign: "center", padding: "0 32px" }}>
      {onBack && (
        <button
          type="button" onClick={onBack}
          style={{
            display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
            color: "var(--muted, #5b6472)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
            padding: 0, margin: "0 auto 20px", fontFamily: "inherit",
          }}
        >
          <ArrowLeft size={13} /> Home
        </button>
      )}
      <div style={{ marginBottom: 14, display: "flex", justifyContent: "center", color: "var(--indigo, #6d5df6)" }}>
        <Cpu size={32} />
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>Physical AI</div>

      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8, flexWrap: "wrap",
        fontSize: 12, color: "var(--muted, #5b6472)", marginBottom: 16,
      }}>
        <Step icon={<PenTool size={12} />} label="Hypothesis Agent output" />
        <span style={{ color: "var(--indigo, #6d5df6)" }}>→</span>
        <Step icon={<Cpu size={12} />} label="Physical AI" />
        <span style={{ color: "var(--indigo, #6d5df6)" }}>→</span>
        <Step icon={<FlaskConical size={12} />} label="Robot control code" />
      </div>

      <div style={{ color: "var(--muted, #5b6472)", fontSize: 13.5, lineHeight: 1.6, marginBottom: 16 }}>
        Physical AI will take a ranked hypothesis from the Hypothesis Agent and translate it into
        executable code to operate a robot for physical experimentation.
      </div>

      <div style={{
        display: "inline-block", background: "#eef0fe", color: "var(--indigo, #6d5df6)", fontSize: 12,
        fontWeight: 600, padding: "6px 14px", borderRadius: 20,
      }}>
        Coming later — placeholder page only
      </div>
    </div>
  );
}

function Step({ icon, label }) {
  return (
    <span style={{
      display: "flex", alignItems: "center", gap: 6, background: "var(--panel2, #f1f3f9)",
      border: "1px solid var(--line, #e4e7ef)", borderRadius: 20, padding: "5px 11px",
    }}>
      {icon} {label}
    </span>
  );
}

import React from "react";
import { BarChart3, ArrowLeft } from "./icons.jsx";

/**
 * Placeholder for the standalone Data Analysis Agent (architecture doc:
 * Phase 2, not yet built — the `tab === "data"` view elsewhere in this app
 * is a different, existing thing: per-search paper-year/comparison charts
 * inside an active Sift run, not this future dataset-upload agent).
 */
export default function DataAnalysisPlaceholder({ which, onBack }) {
  const label = which === "timeseries" ? "Time Series Analysis" : "Data Visualization";
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
        <BarChart3 size={32} />
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{label}</div>
      <div style={{ color: "var(--muted, #5b6472)", fontSize: 13.5, lineHeight: 1.6 }}>
        The Data Analysis Agent (upload a dataset, run exploratory analysis, generate
        publication-ready figures) is Phase 2 of the dashboard upgrade — not built yet.
      </div>
    </div>
  );
}

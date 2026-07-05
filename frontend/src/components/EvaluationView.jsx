import React from "react";
import { FlaskConical } from "./icons.jsx";

export default function EvaluationView({ evalRes, busy, onEvaluate }) {
  return (
    <div>
      <div className="oq" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--amber)" }}>Open question:</b> how do you evaluate the quality
        of the review output? This module runs a rubric-based self-critique as one possible answer.
      </div>

      {!evalRes ? (
        <button className="btn" disabled={busy} onClick={onEvaluate}>
          <FlaskConical size={15} /> Evaluate this review
        </button>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 18 }}>
            <div className="serif" style={{ fontSize: 40, fontWeight: 600, color: "var(--indigo)" }}>
              {evalRes.overall}
            </div>
            <div className="muted tiny">/ 100 overall</div>
          </div>
          {Object.entries(evalRes.scores || {}).map(([k, v]) => (
            <div key={k} style={{ marginBottom: 12 }}>
              <div className="score-row">
                <span style={{ textTransform: "capitalize" }}>{k}</span>
                <span className="mono muted">{v}</span>
              </div>
              <div className="evalbar"><i style={{ width: v + "%" }} /></div>
            </div>
          ))}
          <div className="muted tiny" style={{ marginTop: 14, lineHeight: 1.6 }}>{evalRes.notes}</div>
        </div>
      )}
    </div>
  );
}

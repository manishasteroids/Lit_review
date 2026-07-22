import React from "react";
import { RotateCw } from "./icons.jsx";

/**
 * Shown while the academic search runs, using the reformulator's
 * output that's already available — so the wait is productive instead of a
 * spinner. Renders: the scope statement, a concept map of the key terms, the
 * expanded search strategies and a compact live status line.
 *
 * Pure client-side, no extra model call.
 */
export default function UnderstandingCard({ topic, reform, progressMsgs = [], stage }) {
  const terms = (reform?.terms?.length ? reform.terms : reform?.queries || []).slice(0, 8);
  const queries = reform?.queries || [];
  const scope = reform?.scope;
  const latest = progressMsgs[progressMsgs.length - 1];

  const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

  // Concept-map geometry: topic in the centre, terms on a ring around it.
  const W = 600, H = 320, cx = W / 2, cy = H / 2, R = 140;
  const nodes = terms.map((t, i) => {
    const a = (i / Math.max(terms.length, 1)) * 2 * Math.PI - Math.PI / 2;
    return { t, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });

  return (
    <div className="card">
      <div className="card-h">
        <div className="ic"><RotateCw size={16} className="spin" /></div>
        <h3>Understanding your question</h3>
        <span className="tag">{stage === "search" ? "searching…" : "planning…"}</span>
      </div>

      {scope && (
        <div style={{ fontSize: 13, lineHeight: 1.55, margin: "2px 0 4px", color: "var(--txt)" }}>
          {scope}
        </div>
      )}

      {nodes.length > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Key concepts"
          style={{ width: "100%", height: "auto", maxHeight: 320, display: "block" }}>
          {nodes.map((n, i) => (
            <line key={"l" + i} x1={cx} y1={cy} x2={n.x} y2={n.y}
              stroke="var(--line)" strokeWidth="1.5" />
          ))}
          {nodes.map((n, i) => (
            <g key={"n" + i} className="pulse" style={{ animationDelay: `${i * 0.12}s` }}>
              <rect x={n.x - 52} y={n.y - 14} width={104} height={28} rx={8}
                fill="var(--indigo-soft)" stroke="var(--line)" />
              <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize="10.5"
                fill="var(--txt)">{short(n.t, 16)}</text>
            </g>
          ))}
          <g>
            <rect x={cx - 92} y={cy - 21} width={184} height={42} rx={11} fill="var(--indigo)" />
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize="12" fontWeight="600"
              fill="#fff">{short(topic, 28)}</text>
          </g>
        </svg>
      )}

      {queries.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Search strategies</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {queries.map((q, i) => (
              <span key={i} className="pill theme">{q}</span>
            ))}
          </div>
        </div>
      )}

      <div className="muted tiny" style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 14 }}>{stage === "search" ? "🔍" : "🤖"}</span>
        <span className="pulse">{latest?.message || "Working…"}</span>
      </div>
    </div>
  );
}

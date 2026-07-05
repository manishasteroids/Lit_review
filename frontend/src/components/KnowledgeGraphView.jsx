import React from "react";

export default function KnowledgeGraphView({ concepts, citeNum }) {
  if (!concepts || !concepts.length) return <div className="muted tiny">No concepts extracted yet.</div>;

  const W = 560, H = 360, cx = W / 2, cy = H / 2;
  const paperIdxs = Array.from(new Set(concepts.flatMap((c) => c.papers)));
  const pPos = {};
  paperIdxs.forEach((idx, i) => {
    const a = (i / paperIdxs.length) * Math.PI * 2 - Math.PI / 2;
    pPos[idx] = { x: cx + Math.cos(a) * 150, y: cy + Math.sin(a) * 130 };
  });
  const cPos = concepts.map((c, i) => {
    const a = (i / concepts.length) * Math.PI * 2 - Math.PI / 2;
    return { ...c, x: cx + Math.cos(a) * 78, y: cy + Math.sin(a) * 66 };
  });

  return (
    <div>
      <div className="muted tiny" style={{ marginBottom: 12 }}>
        Concepts (indigo) extracted from approved papers (green), linked where a paper exhibits a concept.
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }}>
          {cPos.map((c, ci) =>
            c.papers.map((pi) => pPos[pi] && (
              <line key={ci + "-" + pi} x1={c.x} y1={c.y} x2={pPos[pi].x} y2={pPos[pi].y} stroke="#2c313d" strokeWidth="1" />
            ))
          )}
          {paperIdxs.map((idx) => (
            <g key={idx}>
              <circle cx={pPos[idx].x} cy={pPos[idx].y} r="13" fill="#1d4a39" stroke="#43a47b" strokeWidth="1.2" />
              <text x={pPos[idx].x} y={pPos[idx].y + 4} textAnchor="middle" fontSize="11" fontFamily="JetBrains Mono" fill="#43a47b">
                {citeNum[idx]}
              </text>
            </g>
          ))}
          {cPos.map((c, i) => (
            <g key={i}>
              <circle cx={c.x} cy={c.y} r={9 + c.papers.length * 2} fill="#33356a" stroke="#6f6cf3" strokeWidth="1.2" />
              <text x={c.x} y={c.y - 14 - c.papers.length} textAnchor="middle" fontSize="11" fontFamily="Space Grotesk" fill="#a3a1f7">
                {c.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

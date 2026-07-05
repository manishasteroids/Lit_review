import React from "react";

function YearChart({ data }) {
  if (!data || !data.length) return <div className="muted tiny">No data.</div>;
  const W = 520, H = 170, pad = 30;
  const max = Math.max(...data.map((d) => d.count), 1);
  const slot = (W - pad * 2) / data.length;
  const bw = Math.min(54, slot - 16);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }}>
      <line x1={pad} y1={H - 28} x2={W - 8} y2={H - 28} stroke="#2c313d" strokeWidth="1" />
      {data.map((d, i) => {
        const x = pad + i * slot + (slot - bw) / 2;
        const h = (H - 50) * (d.count / max);
        const y = H - 28 - h;
        return (
          <g key={i}>
            <rect x={x} y={y} width={bw} height={h} rx="4" fill="#6f6cf3" />
            <text x={x + bw / 2} y={H - 11} textAnchor="middle" fontSize="11" fontFamily="JetBrains Mono" fill="#8b91a2">{d.year}</text>
            <text x={x + bw / 2} y={y - 5} textAnchor="middle" fontSize="11" fontFamily="JetBrains Mono" fill="#a3a1f7">{d.count}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function DataAnalysisView({ yearDistribution, comparisonTable }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 10 }}>Papers by year</div>
      <YearChart data={yearDistribution} />

      <div className="eyebrow" style={{ margin: "22px 0 10px" }}>Comparison table</div>
      <div style={{ overflowX: "auto" }}>
        <table className="cmp">
          <thead>
            <tr><th>#</th><th>Paper</th><th>Year</th><th>Method</th><th>Key finding</th><th>Rank</th></tr>
          </thead>
          <tbody>
            {(comparisonTable || []).map((row, i) => (
              <tr key={row.idx}>
                <td><span className="cite">[{i + 1}]</span></td>
                <td><b>{row.title.length > 54 ? row.title.slice(0, 54) + "…" : row.title}</b></td>
                <td>{row.year}</td>
                <td>{row.method || "—"}</td>
                <td>{row.finding || "—"}</td>
                <td>{row.score ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

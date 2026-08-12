import React, { useMemo, useState } from "react";

// Matches the app's actual (light) theme CSS variables — the previous version
// hardcoded dark-theme hex colors (e.g. near-black edges, navy node fills)
// that were nearly invisible against the white card background this renders
// on, which was most of why the graph read as small and unclear.
const C = {
  concept: "var(--indigo, #6d5df6)",
  conceptSoft: "var(--indigo-soft, #eceafe)",
  paper: "var(--green, #1f8a5b)",
  paperSoft: "var(--green-soft, #e2f4ea)",
  line: "var(--line, #e4e7ef)",
  muted: "var(--muted, #5b6472)",
  muted2: "var(--muted2, #98a0af)",
  txt: "var(--txt, #1c2128)",
  card: "var(--panel, #fff)",
};

export default function KnowledgeGraphView({ concepts, citeNum = {}, papers = [] }) {
  const [hover, setHover] = useState(null); // { type: "concept"|"paper", key }

  const paperByIdx = useMemo(() => {
    const m = {};
    (papers || []).forEach((p) => { m[p.idx] = p; });
    return m;
  }, [papers]);

  const paperIdxs = useMemo(
    () => Array.from(new Set((concepts || []).flatMap((c) => c.papers))),
    [concepts]
  );

  // Concept<->concept "related ideas" edges: any two concepts that co-occur
  // in at least one shared paper are related — this relationship wasn't
  // shown at all before, only concept->paper links were.
  const conceptEdges = useMemo(() => {
    const edges = [];
    const list = concepts || [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const shared = list[i].papers.filter((p) => list[j].papers.includes(p));
        if (shared.length) edges.push({ a: i, b: j, weight: shared.length });
      }
    }
    return edges;
  }, [concepts]);

  if (!concepts || !concepts.length) {
    return <div className="muted tiny">No concepts extracted yet.</div>;
  }

  // A much bigger canvas than before (was 560x360, capped at 560px display
  // width regardless of screen size) — now fills the available width, and
  // both rings' radii scale up with node count instead of cramming
  // everything into a fixed small circle.
  const W = 1080, H = 720, cx = W / 2, cy = H / 2;
  const paperR = Math.max(260, paperIdxs.length * 11);
  const conceptR = Math.max(150, concepts.length * 10);

  const pPos = {};
  paperIdxs.forEach((idx, i) => {
    const a = (i / paperIdxs.length) * Math.PI * 2 - Math.PI / 2;
    pPos[idx] = { x: cx + Math.cos(a) * paperR, y: cy + Math.sin(a) * paperR * 0.82 };
  });
  const cPos = concepts.map((c, i) => {
    const a = (i / concepts.length) * Math.PI * 2 - Math.PI / 2;
    return { ...c, x: cx + Math.cos(a) * conceptR, y: cy + Math.sin(a) * conceptR * 0.82 };
  });

  const activeConceptIdx = hover?.type === "concept" ? hover.key : null;
  const activePaperIdx = hover?.type === "paper" ? hover.key : null;

  const connectedPapers = activeConceptIdx != null ? new Set(cPos[activeConceptIdx].papers) : null;
  const connectedConcepts =
    activePaperIdx != null
      ? new Set(cPos.map((c, i) => (c.papers.includes(activePaperIdx) ? i : null)).filter((x) => x != null))
      : activeConceptIdx != null
      ? new Set(
          conceptEdges
            .filter((e) => e.a === activeConceptIdx || e.b === activeConceptIdx)
            .map((e) => (e.a === activeConceptIdx ? e.b : e.a))
        )
      : null;

  const dim = (isActive) => (hover ? (isActive ? 1 : 0.15) : 1);

  let detail = null;
  if (activeConceptIdx != null) {
    const c = cPos[activeConceptIdx];
    detail = {
      title: c.label,
      sub: `${c.papers.length} source${c.papers.length === 1 ? "" : "s"} · ${
        connectedConcepts?.size || 0
      } related concept${connectedConcepts?.size === 1 ? "" : "s"}`,
      lines: c.papers.map((idx) => {
        const p = paperByIdx[idx];
        return `[${citeNum[idx] ?? "?"}] ${p ? p.title : "Paper " + idx}`;
      }),
    };
  } else if (activePaperIdx != null) {
    const p = paperByIdx[activePaperIdx];
    const related = cPos.filter((c) => c.papers.includes(activePaperIdx)).map((c) => c.label);
    detail = {
      title: p ? `[${citeNum[activePaperIdx] ?? "?"}] ${p.title}` : `Paper ${activePaperIdx}`,
      sub: p?.authors ? `${p.authors}${p.year ? " · " + p.year : ""}` : "",
      lines: related,
    };
  }

  return (
    <div>
      <div className="muted tiny" style={{ marginBottom: 10, lineHeight: 1.7 }}>
        <span style={{ color: C.concept, fontWeight: 700 }}>●</span> Concepts extracted across your sources &nbsp;
        <span style={{ color: C.paper, fontWeight: 700 }}>●</span> Papers (cited as [n]) &nbsp;
        <span style={{ color: C.concept }}>┄</span> related concepts (share a source) &nbsp;
        — hover any node for detail
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 620px", minWidth: 320 }}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", minHeight: 520 }}>
            {conceptEdges.map((e, i) => {
              const a = cPos[e.a], b = cPos[e.b];
              const isActive = activeConceptIdx === e.a || activeConceptIdx === e.b;
              return (
                <line
                  key={"ce" + i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={C.concept} strokeWidth={1 + Math.min(e.weight, 3)}
                  strokeDasharray="5 5" opacity={dim(isActive) * 0.4}
                />
              );
            })}
            {cPos.map((c, ci) =>
              c.papers.map(
                (pi) =>
                  pPos[pi] && (
                    <line
                      key={ci + "-" + pi}
                      x1={c.x} y1={c.y} x2={pPos[pi].x} y2={pPos[pi].y}
                      stroke={C.muted2}
                      strokeWidth={activeConceptIdx === ci || activePaperIdx === pi ? 2 : 1}
                      opacity={dim(activeConceptIdx === ci || activePaperIdx === pi) * 0.55}
                    />
                  )
              )
            )}
            {paperIdxs.map((idx) => {
              const isActive = activePaperIdx === idx || (connectedPapers && connectedPapers.has(idx));
              const r = activePaperIdx === idx ? 19 : 15;
              return (
                <g
                  key={idx}
                  onMouseEnter={() => setHover({ type: "paper", key: idx })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: "pointer" }}
                  opacity={dim(isActive)}
                >
                  <circle cx={pPos[idx].x} cy={pPos[idx].y} r={r} fill={C.paperSoft} stroke={C.paper} strokeWidth="2.2" />
                  <text
                    x={pPos[idx].x} y={pPos[idx].y + 5} textAnchor="middle"
                    fontSize="13" fontFamily="'JetBrains Mono',monospace" fontWeight="700" fill={C.paper}
                  >
                    {citeNum[idx] ?? idx}
                  </text>
                </g>
              );
            })}
            {cPos.map((c, i) => {
              const r = 18 + Math.min(c.papers.length, 10) * 2.4;
              const isActive = activeConceptIdx === i || (connectedConcepts && connectedConcepts.has(i));
              return (
                <g
                  key={i}
                  onMouseEnter={() => setHover({ type: "concept", key: i })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: "pointer" }}
                  opacity={dim(isActive)}
                >
                  <circle cx={c.x} cy={c.y} r={r} fill={C.conceptSoft} stroke={C.concept} strokeWidth="2.4" />
                  <text
                    x={c.x} y={c.y - r - 10} textAnchor="middle"
                    fontSize="14.5" fontFamily="'Space Grotesk',sans-serif" fontWeight="700"
                    fill={C.txt} stroke={C.card} strokeWidth="5" paintOrder="stroke"
                  >
                    {c.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <div
          style={{
            flex: "0 0 270px", minWidth: 230, border: `1px solid ${C.line}`, borderRadius: 10,
            padding: "14px 16px", background: C.card, alignSelf: "flex-start", position: "sticky", top: 12,
          }}
        >
          {detail ? (
            <>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 3, color: C.txt, lineHeight: 1.4 }}>
                {detail.title}
              </div>
              {detail.sub && <div className="muted tiny" style={{ marginBottom: 10 }}>{detail.sub}</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.lines.length ? (
                  detail.lines.map((l, i) => (
                    <div key={i} style={{ fontSize: 12, color: C.muted, lineHeight: 1.45 }}>{l}</div>
                  ))
                ) : (
                  <div className="muted tiny">No connections.</div>
                )}
              </div>
            </>
          ) : (
            <div className="muted tiny" style={{ lineHeight: 1.6 }}>
              Hover a concept (indigo) or paper (green) node to see full details — which sources
              support a concept, or which concepts a paper contributes to.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import React from "react";
import {
  Sparkles, Filter, Search, Check, FileText, Brain, PenTool,
  RotateCw, Network, ListOrdered, BarChart3, HelpCircle,
} from "./icons.jsx";

export const STAGES = [
  { key: "query", label: "User Topic / Query", sub: "Research question input", icon: Sparkles, kind: "entry" },
  { key: "reformulate", label: "Query Reformulator", sub: "Expands & refines terms", icon: Filter, kind: "step" },
  { key: "search", label: "Academic Search", sub: "Semantic Scholar · arXiv · PubMed", icon: Search, kind: "step" },
  { key: "filter", label: "Paper Filter", sub: "Approve / reject sources", icon: Check, kind: "step" },
  { key: "extract", label: "Reader & Extractor", sub: "Parses text, extracts info", icon: FileText, kind: "step" },
  { key: "synthesize", label: "Critic & Synthesizer", sub: "Detects gaps & biases", icon: Brain, kind: "step" },
  { key: "write", label: "Writer Agent", sub: "Structured literature review", icon: PenTool, kind: "output" },
];

export default function PipelineRail({ stage, busy, done, kg, ranked, dataReady, memory, onRecall }) {
  const curIdx = STAGES.findIndex((s) => s.key === stage);

  return (
    <div className="rail">
      <div className="eyebrow" style={{ marginBottom: 14 }}>Agent pipeline</div>
      {STAGES.map((s, i) => {
        const Icon = s.icon;
        const isActive = stage === s.key && busy;
        const isDone = done[s.key];
        const reached = i <= curIdx;
        const dotCls =
          "dot " + (s.kind === "entry" ? "entry " : s.kind === "output" ? "output " : "") +
          (isActive ? "active " : isDone ? "done " : "");
        return (
          <div key={s.key} className={"rail-node" + (reached ? " is-active" : "") + (isDone ? " is-done" : "")}>
            {i < STAGES.length - 1 && (
              <div className="rail-line" style={isDone ? { background: "var(--green-soft)" } : null} />
            )}
            <div className={dotCls}>
              {isActive ? <RotateCw size={15} className="spin" /> : isDone ? <Check size={15} /> : <Icon size={15} />}
            </div>
            <div className="meta">
              <div className="lab">{s.label}</div>
              <div className="sub">{s.sub}</div>
            </div>
          </div>
        );
      })}

      <div className="side">
        <div className="eyebrow" style={{ marginBottom: 2 }}>Side modules</div>
        <div className="side-chip">
          <Network size={14} color="var(--indigo)" /> Knowledge graph {kg ? `· ${kg.length} concepts` : "· idle"}
        </div>
        <div className="side-chip">
          <ListOrdered size={14} color="var(--indigo)" /> Ranking {ranked ? `· ${ranked} ranked` : "· idle"}
        </div>
        <div className="side-chip">
          <BarChart3 size={14} color="var(--indigo)" /> Data analysis {dataReady ? "· ready" : "· idle"}
        </div>
        <div className="oq" style={{ marginTop: 4 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <HelpCircle size={12} /> MEMORY SYSTEM
          </div>
          {memory && memory.length ? (
            <div className="memory">
              {memory.map((m) => (
                <span key={m} className="mem" onClick={() => onRecall(m)}>
                  {m.length > 28 ? m.slice(0, 28) + "…" : m}
                </span>
              ))}
            </div>
          ) : (
            "In-session recall of past topics. Persistent memory = open design question."
          )}
        </div>
      </div>
    </div>
  );
}

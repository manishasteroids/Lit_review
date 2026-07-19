import React from "react";
import {
  Sparkles, Filter, Search, Check, FileText, Brain, PenTool,
  RotateCw, Network, ListOrdered, BarChart3,
} from "./icons.jsx";
import { shortModel, tierOf, TIER_META } from "../modelTiers.js";

// small colored chip showing which model a stage runs on
function ModelChip({ model, apis }) {
  if (apis) {
    return (
      <span style={{
        fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 600,
        color: "var(--green)", background: "var(--green-soft)", borderRadius: 4,
        padding: "1px 5px", marginTop: 3, display: "inline-block",
      }}>APIs · free</span>
    );
  }
  if (!model) return null;
  const meta = TIER_META[tierOf(model)];
  return (
    <span style={{
      fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 600,
      color: meta.color, background: meta.bg, borderRadius: 4,
      padding: "1px 5px", marginTop: 3, display: "inline-block",
    }}>{shortModel(model)}</span>
  );
}

export const STAGES = [
  { key: "query", label: "User Topic / Query", sub: "Research question input", icon: Sparkles, kind: "entry" },
  { key: "reformulate", label: "Query Reformulator", sub: "Expands & refines terms", icon: Filter, kind: "step" },
  { key: "search", label: "Academic Search", sub: "Semantic Scholar · arXiv · PubMed", icon: Search, kind: "step" },
  { key: "filter", label: "Paper Filter", sub: "Approve / reject sources", icon: Check, kind: "step" },
  { key: "extract", label: "Reader & Extractor", sub: "Parses text, extracts info", icon: FileText, kind: "step" },
  { key: "synthesize", label: "Critic & Synthesizer", sub: "Detects gaps & biases", icon: Brain, kind: "step" },
  { key: "write", label: "Writer Agent", sub: "Structured literature review", icon: PenTool, kind: "output" },
];

export default function PipelineRail({ stage, busy, done, kg, ranked, dataReady, models }) {
  const curIdx = STAGES.findIndex((s) => s.key === stage);
  const stageModels = models?.stages || {};

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
              {s.key === "search"
                ? <ModelChip apis />
                : <ModelChip model={stageModels[s.key]} />}
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
        {/* {showMemory && (
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
        )} */}
      </div>
    </div>
  );
}

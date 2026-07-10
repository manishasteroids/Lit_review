import React from "react";
import {
  BookOpen, Layers, Brain, Network, BarChart3, FlaskConical, Clock,
} from "./icons.jsx";

const TOOLS = [
  ["review", BookOpen, "Review"],
  ["sources", Layers, "Sources"],
  ["critique", Brain, "Critique"],
  ["graph", Network, "Knowledge graph"],
  ["data", BarChart3, "Data analysis"],
  ["eval", FlaskConical, "Evaluation"],
];

function relTime(at) {
  const diff = (Date.now() - at) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

export default function WorkspacePanel({ tab, setTab, toolsEnabled, memory, onRecall, busy }) {
  return (
    <div className="workspace">
      <div className="panel-block">
        <div className="eyebrow" style={{ marginBottom: 12 }}>Tools</div>
        <div className="tool-list">
          {TOOLS.map(([k, Ic, lab]) => {
            const on = toolsEnabled && tab === k;
            return (
              <button
                key={k}
                className={"tool-item" + (on ? " on" : "") + (toolsEnabled ? "" : " idle")}
                disabled={!toolsEnabled}
                title={toolsEnabled ? lab : "Available once a review is generated"}
                onClick={() => toolsEnabled && setTab(k)}
              >
                <Ic size={15} />
                <span>{lab}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel-block hist-block">
        <div className="eyebrow" style={{ marginBottom: 12 }}>History</div>
        {memory && memory.length ? (
          <div className="hist-list">
            {memory.map((m) => (
              <button
                key={m.topic}
                className="hist-item"
                disabled={busy}
                title="Recall this topic"
                onClick={() => onRecall(m.topic)}
              >
                <div className="hist-title">{m.topic}</div>
                <div className="hist-meta"><Clock size={10} /> {relTime(m.at)}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="hist-empty">
            No past runs yet. Completed topics are saved here for quick recall.
          </div>
        )}
      </div>
    </div>
  );
}

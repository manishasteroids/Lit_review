import React from "react";
import { Sparkles, Cpu, Play, ChevronRight } from "./icons.jsx";

const BACKBONES = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", live: true },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", live: true },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", live: true },
  { id: "gpt5", label: "OpenAI GPT-5", live: false },
  { id: "gemini", label: "Gemini 2.5 Pro", live: false },
];

const EXAMPLES = [
  "Ribosome load prediction from 5' UTR sequence using deep learning",
  "CRISPR off-target prediction with machine learning",
  "Single-cell multi-omics integration methods",
];

export function ModelBar({ model, setModel, apiKey, setApiKey }) {
  return (
    <div className="backbone">
      <div className="eyebrow" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Cpu size={11} /> Model layer · swappable backbone
      </div>
      <div className="model-select-wrap">
        <select
          className="model-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {BACKBONES.map((b) => (
            <option key={b.id} value={b.id} disabled={!b.live}>
              {b.label}{b.live ? "" : " · not wired"}
            </option>
          ))}
        </select>
        <ChevronRight size={14} className="model-caret" />
      </div>
      <div className="keyrow">
        <input
          type="password"
          placeholder="sk-ant-… (optional — falls back to server key)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
    </div>
  );
}

export default function QueryInput({ topic, setTopic, busy, onRun }) {
  return (
    <div className="card">
      <div className="card-h">
        <div className="ic"><Sparkles size={16} /></div>
        <h3>Research question</h3>
        <span className="tag">entry node</span>
      </div>
      <textarea
        className="topic"
        rows={3}
        placeholder="e.g. How do deep-learning models predict translation efficiency from mRNA sequence?"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
      />
      <div className="ex-row">
        {EXAMPLES.map((ex) => (
          <button key={ex} className="ex" onClick={() => setTopic(ex)}>{ex}</button>
        ))}
      </div>
      <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" disabled={!topic.trim() || busy} onClick={onRun}>
          <Play size={15} /> Run pipeline
        </button>
        <span className="muted tiny">→ reformulate · search web · filter · extract · synthesize · write</span>
      </div>
    </div>
  );
}

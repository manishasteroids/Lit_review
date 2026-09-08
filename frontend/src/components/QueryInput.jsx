import React from "react";
import { Sparkles, Cpu, Play, ChevronRight, Brain, FileText } from "./icons.jsx";
import { tierOf, TIER_META } from "../modelTiers.js";

// Open-weight models, reached through OpenRouter (core/llm_client.py's third
// backbone) rather than each vendor's own API — one key, one OpenAI-
// compatible endpoint. Model ids use OpenRouter's own "vendor/model" naming,
// which is also how LLMClient tells this backbone apart from Claude/Gemini
// (see its provider-detection docstring). `live: false` until
// OPENROUTER_API_KEY is actually set server-side; flip to `true` once a run
// against one of these has actually been tried.
const OPEN_WEIGHT_BACKBONES = [
  { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2 (open-weight)", live: true },
  { id: "deepseek/deepseek-r1", label: "DeepSeek R1 — reasoning (open-weight)", live: true },
  { id: "qwen/qwen3-max-thinking", label: "Qwen3 Max Thinking (open-weight)", live: true },
  { id: "qwen/qwen3-coder", label: "Qwen3 Coder (open-weight)", live: true },
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick (open-weight)", live: true },
];

const BACKBONES = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", live: true },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", live: true },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", live: true },
  { id: "gpt5", label: "OpenAI GPT-5", live: false },
  { id: "gemini", label: "Gemini 2.5 flash", live: true },
  ...OPEN_WEIGHT_BACKBONES,
];

const EXAMPLES = [
  "Ribosome load prediction from 5' UTR sequence using deep learning",
  "CRISPR off-target prediction with machine learning",
  "Single-cell multi-omics integration methods",
];

// Colored "thinking depth" indicator — turns red when a heavy deep-thinking
// model (e.g. Opus) is selected, so the token-cost risk is visible at a glance.
export function ModelTierBadge({ model, size = 13 }) {
  const tier = tierOf(model);
  const meta = TIER_META[tier];
  return (
    <span
      title={`${meta.label} model — ${meta.note}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 600,
        color: meta.color, background: meta.bg, borderRadius: 5, padding: "2px 7px",
      }}
    >
      <Brain size={size} color={meta.color} />
      {meta.label}
    </span>
  );
}

// apiKey/setApiKey are accepted but unused now — the run always uses the
// server-side key. Kept in the signature so callers don't need to change.
export function ModelBar({ model, setModel }) {
  return (
    <div className="backbone">
      <div className="eyebrow" style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Cpu size={11} /> Model layer · swappable backbone
        </span>
        <ModelTierBadge model={model} />
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
    </div>
  );
}

// Fallback if /api/modes hasn't loaded yet.
const FALLBACK_MODES = [
  { id: "lite", label: "Lite", blurb: "Fast & cheap · ~20 papers" },
  { id: "medium", label: "Medium Research", blurb: "Balanced · ~50 papers" },
  { id: "deep", label: "Deep search", blurb: "Best quality · full text" },
];

// Dropdown that replaces the raw model picker: the user picks HOW THOROUGH the
// review should be, and the backend maps that to papers + models + read depth.
export function ModeBar({ modes, mode, setMode }) {
  const list = modes && modes.length ? modes : FALLBACK_MODES;
  const current = list.find((m) => m.id === mode) || list[0];
  return (
    <div className="backbone">
      <div className="eyebrow" style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <Cpu size={11} /> Search mode
      </div>
      <div className="model-select-wrap">
        <select
          className="model-select"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          {list.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <ChevronRight size={14} className="model-caret" />
      </div>
      {/* {current?.blurb && (
        <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 6, lineHeight: 1.4 }}>
          {current.blurb}
        </div>
      )} */}
    </div>
  );
}

export default function QueryInput({ topic, setTopic, busy, onRun, onAnalyzeDocs }) {
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

      {onAnalyzeDocs && (
        <button
          type="button"
          disabled={busy}
          onClick={onAnalyzeDocs}
          style={{
            marginTop: 18, width: "100%", display: "flex", alignItems: "center", gap: 13,
            textAlign: "left", padding: "13px 15px", borderRadius: 12, cursor: busy ? "default" : "pointer",
            border: "1px dashed var(--indigo)", background: "var(--indigo-soft)",
            fontFamily: "inherit", opacity: busy ? 0.6 : 1,
          }}
        >
          <span style={{
            flex: "0 0 34px", width: 34, height: 34, borderRadius: 9, background: "var(--card,#fff)",
            border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--indigo)",
          }}>
            <FileText size={17} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "var(--txt)" }}>
              Already have the papers? Analyze your own documents instead
            </span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)", marginTop: 2, lineHeight: 1.5 }}>
              Skip the search — upload PDFs, Word docs, or slide decks and go straight to Studio to chat, summarize, or build a report/deck from them.
            </span>
          </span>
          <span style={{
            flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6,
            background: "var(--indigo)", color: "#fff", fontSize: 12.5, fontWeight: 600,
            borderRadius: 9, padding: "9px 14px", whiteSpace: "nowrap",
          }}>
            Analyze documents <ChevronRight size={14} />
          </span>
        </button>
      )}
    </div>
  );
}

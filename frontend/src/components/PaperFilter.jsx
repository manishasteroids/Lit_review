import React, { useState } from "react";
import { Filter, Check, X, ChevronRight, RotateCw } from "./icons.jsx";
import PaperChatPanel from "./PaperChatPanel.jsx";
import { api } from "../api/client.js";

const VERDICT = {
  keep:  { label: "Likely relevant", bg: "var(--green-soft)", fg: "var(--green)" },
  maybe: { label: "Maybe",           bg: "rgba(224,163,62,.14)", fg: "var(--amber)" },
  skip:  { label: "Probably skip",   bg: "rgba(240,138,138,.14)", fg: "#f08a8a" },
};

function Kv({ k, v }) {
  if (!v || v === "n/a") return null;
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.45 }}>
      <span style={{
        fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted2)",
        textTransform: "uppercase", letterSpacing: ".06em", flex: "0 0 84px", paddingTop: 1,
      }}>{k}</span>
      <span style={{ color: "var(--txt)" }}>{v}</span>
    </div>
  );
}

export default function PaperFilter({ papers, approved, scope, busy, onToggle, onApprove, onRestart, runId, apiKey, model, notes={}, onNote }) {
  const approvedCount = Object.values(approved).filter(Boolean).length;
  const [chatPaper, setChatPaper] = useState(null);
  const [assess, setAssess] = useState({}); // idx -> { loading | data | error }

  async function runAssess(p) {
    setAssess((a) => ({ ...a, [p.idx]: { loading: true } }));
    try {
      const res = await api.assessPaper(runId, p, scope, apiKey || undefined, model);
      setAssess((a) => ({ ...a, [p.idx]: { data: res.assessment } }));
    } catch (e) {
      setAssess((a) => ({ ...a, [p.idx]: { error: e.message } }));
    }
  }

  return (
    <div className="card">
      <div className="card-h">
        <div className="ic"><Filter size={16} /></div>
        <h3>Filter sources</h3>
        <span className="tag">human in the loop · {approvedCount}/{papers.length}</span>
      </div>
      {scope && <div className="muted tiny" style={{ marginBottom: 12 }}>Scope: {scope}</div>}

      {papers.map((p) => {
        const a = assess[p.idx];
        const v = a?.data?.verdict && VERDICT[a.data.verdict];
        return (
          <div key={p.idx} className={"paper" + (approved[p.idx] ? "" : " off")}>
            <div className="paper-top">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="paper-title">{p.title}</div>
                <div className="paper-meta">
                  {p.authors || "—"} · {p.year || "—"} · {p.venue || "preprint"}
                  {p.url ? " · " : ""}
                  {p.url && <a href={p.url} target="_blank" rel="noreferrer">link</a>}
                  {" · "}
                  <button className="pt-chat-btn" onClick={() => setChatPaper(p)}>chat</button>
                  {" · "}
                  <button className="pt-chat-btn" disabled={a?.loading} onClick={() => runAssess(p)}>
                    {a?.loading ? "assessing…" : a?.data ? "re-assess" : "assess"}
                  </button>
                </div>
                {p.abstract && <div className="paper-abs">{p.abstract}</div>}

                {a?.error && (
                  <div className="muted tiny" style={{ marginTop: 8, color: "#f08a8a" }}>⚠ {a.error}</div>
                )}
                {a?.data && (
                  <div style={{
                    marginTop: 10, padding: "10px 12px", borderRadius: 9,
                    background: "var(--panel2)", border: "1px solid var(--line)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      {v && (
                        <span style={{
                          fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, fontWeight: 500,
                          borderRadius: 5, padding: "2px 8px", background: v.bg, color: v.fg,
                        }}>{v.label}</span>
                      )}
                      <span className="muted tiny">{a.data.reason}</span>
                    </div>
                    <div style={{ display: "grid", gap: 4 }}>
                      <Kv k="Method" v={a.data.method} />
                      <Kv k="Finding" v={a.data.finding} />
                      <Kv k="Metrics" v={a.data.metrics} />
                      <Kv k="Contribution" v={a.data.contribution} />
                    </div>
                  </div>
                )}
                <textarea
                  className="note-box"
                  rows={2}
                  placeholder="Your notes on this paper…"
                  value={notes[p.idx] || ""}
                  onChange={(e) => onNote && onNote(p.idx, e.target.value)}
                  style={{
                    width: "100%", marginTop: 10, background: "var(--ink)",
                    border: "1px solid var(--line)", borderRadius: 9, color: "var(--txt)",
                    fontFamily: "'Space Grotesk',sans-serif", fontSize: 12.5, padding: "8px 10px",
                    resize: "vertical", outline: "none", lineHeight: 1.5,
                  }}
                />
              </div>
              <div className={"toggle" + (approved[p.idx] ? " on" : "")} onClick={() => onToggle(p.idx)}>
                {approved[p.idx] ? <Check size={15} /> : <X size={15} />}
              </div>
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" disabled={busy || approvedCount < 2} onClick={onApprove}>
          <ChevronRight size={15} /> Review {approvedCount} papers
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={onRestart}>
          <RotateCw size={13} /> Restart
        </button>
      </div>

      {chatPaper && (
        <PaperChatPanel
          runId={runId}
          paper={chatPaper}
          cite={chatPaper.idx + 1}
          apiKey={apiKey}
          model={model}
          onClose={() => setChatPaper(null)}
        />
      )}
    </div>
  );
}

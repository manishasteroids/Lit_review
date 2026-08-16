import React, { useState, useEffect } from "react";
import { Filter, Check, X, ChevronRight, RotateCw, ChevronUp, ChevronDown } from "./icons.jsx";
import PaperChatPanel from "./PaperChatPanel.jsx";
import PdfViewer from "./PdfViewer.jsx";
import { api } from "../api/client.js";

// Jump-to-top/bottom buttons for the paper list — the Filter view can run to
// 40+ papers with no inner scroll container (the whole document scrolls), so
// once the page has scrolled a bit these appear fixed in the corner to skip
// re-scrolling by hand.
function ScrollNav() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    function onScroll() {
      setShow(window.scrollY > 400);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  const btn = {
    width: 36, height: 36, borderRadius: 10, border: "1px solid var(--line)",
    background: "var(--panel)", color: "var(--txt)", display: "flex",
    alignItems: "center", justifyContent: "center", cursor: "pointer",
    boxShadow: "0 4px 14px rgba(0,0,0,.35)",
  };
  return (
    <div style={{
      position: "fixed", right: 22, bottom: 22, zIndex: 40,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <button
        type="button" aria-label="Scroll to top" title="Scroll to top" style={btn}
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      >
        <ChevronUp size={17} />
      </button>
      <button
        type="button" aria-label="Scroll to bottom" title="Scroll to bottom" style={btn}
        onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
      >
        <ChevronDown size={17} />
      </button>
    </div>
  );
}

function ExportPapersButtons({ runId, included }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  async function go(fmt) {
    setBusy(fmt);
    setErr(null);
    try {
      await api.downloadPaperList(runId, fmt, included);
    } catch (e) {
      setErr(e.message || "Export failed.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <button className="btn ghost sm" disabled={!!busy} onClick={() => go("xlsx")}>
        {busy === "xlsx" ? "…" : "Export Excel"}
      </button>
      <button className="btn ghost sm" disabled={!!busy} onClick={() => go("csv")}>
        {busy === "csv" ? "…" : "Export CSV"}
      </button>
      {err && <span className="tiny" style={{ color: "#f08a8a" }}>{err}</span>}
    </span>
  );
}

const VERDICT = {
  keep:  { label: "Likely relevant", bg: "var(--green-soft)", fg: "var(--green)" },
  maybe: { label: "Maybe",           bg: "rgba(224,163,62,.14)", fg: "var(--amber)" },
  skip:  { label: "Probably skip",   bg: "rgba(240,138,138,.14)", fg: "#f08a8a" },
};

// Where the paper record came from - real database vs. model fallback.
const SOURCE = {
  semantic_scholar: { label: "Semantic Scholar", fg: "var(--muted)", bg: "var(--panel2)", title: "Verified record from Semantic Scholar" },
  arxiv:            { label: "arXiv",            fg: "var(--muted)", bg: "var(--panel2)", title: "Verified record from arXiv" },
  model:            { label: "⚠ unverified",     fg: "#b3261e",      bg: "rgba(240,138,138,.16)", title: "Model-generated (databases unreachable) — verify before citing" },
  pubmed:           { label: "PubMed",           fg: "var(--muted)", bg: "var(--panel2)", title: "Verified record from PubMed" },
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
  const [readPaper, setReadPaper] = useState(null);
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
        const src = SOURCE[p.source];
        return (
          <div key={p.idx} className={"paper" + (approved[p.idx] ? "" : " off")}>
            <div className="paper-top">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="paper-title">
                  {p.title}
                  {src && (
                    <span title={src.title} style={{
                      fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, fontWeight: 500,
                      padding: "1px 6px", borderRadius: 5, marginLeft: 8, whiteSpace: "nowrap",
                      background: src.bg, color: src.fg, verticalAlign: "middle",
                    }}>{src.label}</span>
                  )}
                </div>
                <div className="paper-meta">
                  {p.authors || "—"} · {p.year || "—"} · {p.venue || "preprint"}
                  {p.url ? " · " : ""}
                  {p.url && <a href={p.url} target="_blank" rel="noreferrer">link</a>}
                  {" · "}
                  <button className="pt-chat-btn" onClick={() => setReadPaper(p)}>read</button>
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
        <span style={{ flex: 1 }} />
        <ExportPapersButtons runId={runId} included={approved} />
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

      {readPaper && (
        <PdfViewer runId={runId} paper={readPaper} onClose={() => setReadPaper(null)} />
      )}

      {papers.length > 4 && <ScrollNav />}
    </div>
  );
}

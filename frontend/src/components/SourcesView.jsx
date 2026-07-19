import React, { useState, useMemo } from "react";
import PaperChatPanel from "./PaperChatPanel.jsx";
 
const COLUMNS = [
  { key: "paper", label: "Paper", always: true, width: 300 },
  // Abstract comes straight from the source paper (free — no extraction needed).
  { key: "abstract", label: "Abstract", fromPaper: true, width: 380 },
  { key: "excerpt", label: "Excerpt", width: 340 },
  { key: "contribution", label: "Contribution", width: 240 },
  { key: "method", label: "Method", width: 200 },
  { key: "metrics", label: "Metrics", width: 200 },
  { key: "finding", label: "Key finding", width: 220 },
  { key: "limitation", label: "Limitation", width: 220 },
  { key: "relevance", label: "Relevance", width: 240 },
];
const DEFAULT_ON = ["paper", "abstract", "contribution", "metrics", "method"];
 
const ACCENT = "#6d5ef6";
const badge = (bg, fg) => ({
  fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 500,
  borderRadius: 5, padding: "2px 7px", background: bg, color: fg, whiteSpace: "nowrap",
});
 
export default function SourcesView({
  citeOrder, extractions, extractStats, runId, apiKey, model,
  papers = [], included = {}, scope,
  analysisStale = false, busy = false,
  onRemove, onAdd, onReanalyze, onGenerate, hasReview = false,
}) {
  const extByIdx = {};
  (extractions || []).forEach((e) => (extByIdx[e.idx] = e));
 
  const [visible, setVisible] = useState(new Set(DEFAULT_ON));
  const [chatPaper, setChatPaper] = useState(null);
  const [detailPaper, setDetailPaper] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
 
  const editable = typeof onRemove === "function";  // Sources editing wired from App
  const citeNumOf = (idx) => citeOrder.findIndex((p) => p.idx === idx) + 1;
 
  const includedCount = citeOrder.length;
  const removedCount = Object.values(included).filter((v) => !v).length;
  const addedCount = (papers || []).filter((p) => p.added).length;
 
  const toggleCol = (key) =>
    setVisible((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const shownCols = COLUMNS.filter((c) => c.always || visible.has(c.key));
 
  const allIdx = citeOrder.map((p) => p.idx);
  const allSelected = allIdx.length > 0 && allIdx.every((i) => selected.has(i));
  const toggleSel = (idx) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(idx) ? n.delete(idx) : n.add(idx);
      return n;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(allIdx));
 
  const canGenerate = includedCount >= 1 && !busy && !adding && !analysisStale;
 
  function removeSelected() {
    const ids = allIdx.filter((i) => selected.has(i));
    if (!ids.length) return;
    if (!window.confirm(
      `Remove ${ids.length} paper${ids.length > 1 ? "s" : ""} from your sources? ` +
      "They'll be excluded from the synthesis, ranking, knowledge graph, citations and review."
    )) return;
    onRemove(ids);
    setSelected(new Set());
  }
 
  function removeOne(idx) {
    if (!window.confirm("Remove this paper from your sources?")) return;
    onRemove([idx]);
    setSelected((prev) => { const n = new Set(prev); n.delete(idx); return n; });
    setDetailPaper(null);
  }
 
  async function generate() {
    if (!canGenerate) return;
    const ok = window.confirm(
      `Generate the literature review?\n\n` +
      `• ${includedCount} papers included\n` +
      (removedCount ? `• ${removedCount} paper${removedCount > 1 ? "s" : ""} removed\n` : "") +
      (addedCount ? `• ${addedCount} paper${addedCount > 1 ? "s" : ""} manually added\n` : "")
    );
    if (ok) onGenerate();
  }
 
  // Deep-mode full-text coverage: how many papers were read in full vs abstract.
  const st = extractStats;
  const fullCount = st ? (st.fetched || 0) + (st.cached || 0) : 0;

  return (
    <div>
      {/* ── Toolbar ─────────────────────────────────────────── */}
      {editable && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          paddingBottom: 12, marginBottom: 12, borderBottom: "1px solid var(--line)",
        }}>
          <span style={{ ...badge("var(--indigo-soft)", ACCENT) }}>{includedCount} sources included</span>
          <button className="btn ghost sm" disabled={busy || adding} onClick={() => setShowAdd(true)}>+ Add paper</button>
          <button className="btn ghost sm" disabled={busy || selected.size === 0} onClick={removeSelected}>
            Remove selected{selected.size ? ` (${selected.size})` : ""}
          </button>
          <button className="btn ghost sm" disabled={busy || !analysisStale} onClick={onReanalyze}>
            {busy ? "Updating…" : "Update analysis"}
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn sm" disabled={!canGenerate} onClick={generate}
            title={analysisStale ? "Update the analysis first" : ""}>
            {hasReview ? "Regenerate literature review" : "Generate literature review"}
          </button>
        </div>
      )}
 
      {/* ── Staleness banner ────────────────────────────────── */}
      {editable && analysisStale && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
          borderRadius: 9, marginBottom: 14, fontSize: 13,
          background: "rgba(224,163,62,.12)", border: "1px solid rgba(224,163,62,.35)",
          color: "var(--amber, #b8862f)",
        }}>
          <span style={{ flex: 1 }}>
            The source list has changed. Update the analysis before generating the review.
          </span>
          <button className="btn sm" disabled={busy} onClick={onReanalyze}>
            {busy ? "Updating…" : "Update analysis"}
          </button>
        </div>
      )}
 
      {/* ── Column picker ───────────────────────────────────── */}
      {st && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
          fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "var(--muted)",
        }}>
          <span style={{
            color: "var(--green)", background: "var(--green-soft)",
            borderRadius: 5, padding: "2px 8px", fontWeight: 600,
          }}>
            Full text: {fullCount}/{st.total || 0}
          </span>
          <span>
            {st.fetched || 0} fetched
            {st.cached ? ` · ${st.cached} from cache` : ""}
            {st.fell_back ? ` · ${st.fell_back} abstract-only (paywalled)` : ""}
          </span>
        </div>
      )}
      <div className="col-picker">
        <span className="eyebrow" style={{ marginRight: 4 }}>Columns</span>
        {COLUMNS.map((c) => (
          <button key={c.key} disabled={c.always}
            className={"col-chip" + (c.always || visible.has(c.key) ? " on" : "")}
            onClick={() => !c.always && toggleCol(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
 
      {/* ── Table ───────────────────────────────────────────── */}
      <div className="ptable-wrap">
        <table className="ptable">
          <thead>
            <tr>
              {editable && (
                <th style={{ width: 30 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll}
                    title="Select all" />
                </th>
              )}
              <th style={{ width: 38 }}>#</th>
              {editable && <th style={{ width: 90 }}>Status</th>}
              {shownCols.map((c) => <th key={c.key} style={{ minWidth: c.width }}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {citeOrder.map((p, i) => {
              const e = extByIdx[p.idx] || {};
              const hasExt = Object.keys(e).length > 0;
              return (
                <tr key={p.idx} style={selected.has(p.idx) ? { background: "var(--indigo-soft)" } : null}>
                  {editable && (
                    <td style={{ textAlign: "center" }}>
                      <input type="checkbox" checked={selected.has(p.idx)}
                        onChange={() => toggleSel(p.idx)} />
                    </td>
                  )}
                  <td className="pt-num"><span className="cite">[{i + 1}]</span></td>
                  {editable && (
                    <td>
                      {p.added
                        ? <span style={badge("var(--indigo-soft)", ACCENT)}>Added</span>
                        : <span style={badge("var(--green-soft, #e7f6ee)", "var(--green, #2e9e5b)")}>Included</span>}
                      {!hasExt && <span style={{ ...badge("rgba(224,163,62,.14)", "#b8862f"), marginLeft: 4 }}>no data</span>}
                    </td>
                  )}
                  {shownCols.map((c) => {
                    if (c.key === "paper") {
                      return (
                        <td key={c.key}>
                          <div className="pt-title">{p.title}</div>
                          <div className="pt-meta">{p.authors || "—"} · {p.year || "—"} · {p.venue || "preprint"}</div>
                          <div className="pt-actions">
                            {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="pt-link">link</a>}
                            <button className="pt-chat-btn" onClick={() => setChatPaper(p)}>chat</button>
                            {editable && <button className="pt-chat-btn" onClick={() => setDetailPaper(p)}>details</button>}
                            {editable && <button className="pt-chat-btn" onClick={() => removeOne(p.idx)}>remove</button>}
                          </div>
                          {e.concepts?.length > 0 && (
                            <div className="pt-tags">
                              {e.concepts.map((t) => <span key={t} className="pill theme">{t}</span>)}
                            </div>
                          )}
                        </td>
                      );
                    }
                    // abstract (and excerpt) render as wide text; abstract is
                    // read from the paper, other columns from the extraction.
                    const value = c.fromPaper ? p[c.key] : e[c.key];
                    return (
                      <td key={c.key} className={c.key === "abstract" || c.key === "excerpt" ? "pt-excerpt" : ""}>
                        {value || <span className="pt-na">n/a</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
 
      <div className="muted tiny" style={{ marginTop: 10 }}>
        {includedCount} sources
        {removedCount ? ` · ${removedCount} removed` : ""}
        {addedCount ? ` · ${addedCount} added` : ""}
        {" "}· scroll horizontally for more columns · toggle columns above
      </div>
 
      {showAdd && (
        <AddPaperModal
          runId={runId}
          busy={adding}
          onClose={() => !adding && setShowAdd(false)}
          onAdd={async (paper) => {
            setAdding(true);
            try {
              await onAdd(paper);
              setShowAdd(false);
            } catch (e) {
              throw e;   // surfaced inside the modal
            } finally {
              setAdding(false);
            }
          }}
        />
      )}
 
      {detailPaper && (
        <PaperDetail
          paper={detailPaper}
          ext={extByIdx[detailPaper.idx] || {}}
          onClose={() => setDetailPaper(null)}
          onRemove={editable ? () => removeOne(detailPaper.idx) : null}
          onChat={() => { setChatPaper(detailPaper); setDetailPaper(null); }}
        />
      )}
 
      {chatPaper && (
        <PaperChatPanel runId={runId} paper={chatPaper} cite={citeNumOf(chatPaper.idx)}
          apiKey={apiKey} model={model} onClose={() => setChatPaper(null)} />
      )}
    </div>
  );
}
 
/* ── Add paper modal ─────────────────────────────────────────── */
function AddPaperModal({ runId, busy, onClose, onAdd }) {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [cands, setCands] = useState(null);
  const [err, setErr] = useState(null);
 
  async function lookup(e) {
    e?.preventDefault();
    if (!q.trim()) return;
    setLoading(true); setErr(null); setCands(null);
    try {
      const { api } = await import("../api/client.js");
      const res = await api.resolvePaper(runId, q.trim());
      setCands(res.candidates || []);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setLoading(false);
    }
  }
 
  async function pick(p) {
    setErr(null);
    try {
      await onAdd(p);
    } catch (e2) {
      setErr(e2.message);
    }
  }
 
  return (
    <Overlay onClose={onClose}>
      <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>Add a paper</h3>
      <div className="muted tiny" style={{ marginBottom: 14 }}>
        Paste a DOI, PubMed ID, arXiv ID, or paper URL — or search by title.
      </div>
 
      <form onSubmit={lookup} style={{ display: "flex", gap: 8 }}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="10.1000/xyz · 2401.01234 · 39876543 · or a title…"
          style={inp} disabled={busy} />
        <button className="btn sm" type="submit" disabled={loading || busy || !q.trim()}>
          {loading ? "…" : "Look up"}
        </button>
      </form>
 
      {err && <div style={{ color: "#c0392b", fontSize: 13, marginTop: 10 }}>{err}</div>}
 
      {cands && cands.length === 0 && (
        <div className="muted tiny" style={{ marginTop: 14 }}>No matches found. Try a different identifier or title.</div>
      )}
 
      {cands && cands.length > 0 && (
        <div style={{ marginTop: 14, maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {cands.map((p, i) => (
            <div key={i} style={{
              border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px",
              opacity: p.duplicate ? 0.6 : 1,
            }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.35 }}>{p.title}</div>
              <div className="muted tiny" style={{ marginTop: 3 }}>
                {p.authors || "—"} · {p.year || "—"} · {p.venue || p.source || "preprint"}
              </div>
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                {p.duplicate
                  ? <span className="muted tiny">Already in your sources</span>
                  : <button className="btn sm" disabled={busy} onClick={() => pick(p)}>
                      {busy ? "Adding…" : "Add & extract"}
                    </button>}
                {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="pt-link">link</a>}
              </div>
            </div>
          ))}
        </div>
      )}
 
      {busy && (
        <div className="muted tiny" style={{ marginTop: 12 }}>
          Retrieving & extracting the paper — this runs the same reader/extractor as your other sources…
        </div>
      )}
    </Overlay>
  );
}
 
/* ── Paper detail view ───────────────────────────────────────── */
function PaperDetail({ paper, ext, onClose, onRemove, onChat }) {
  const fields = [
    ["Method", ext.method], ["Key finding", ext.finding], ["Dataset", ext.data],
    ["Metrics", ext.metrics], ["Limitation", ext.limitation],
    ["Contribution", ext.contribution], ["Relevance", ext.relevance],
  ].filter(([, v]) => v && v !== "n/a");
 
  return (
    <Overlay onClose={onClose} wide>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 17, lineHeight: 1.3 }}>{paper.title}</h3>
      </div>
      <div className="muted tiny" style={{ marginBottom: 6 }}>
        {paper.authors || "—"} · {paper.year || "—"} · {paper.venue || "preprint"}
        {paper.source ? ` · ${paper.source}` : ""}
      </div>
      <div className="tiny" style={{ marginBottom: 12 }}>
        {paper.url
          ? <>Full text: <a href={paper.url} target="_blank" rel="noreferrer" className="pt-link">available ↗</a></>
          : <span className="muted">Full text: not linked</span>}
      </div>
 
      {paper.abstract && (
        <div style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Abstract</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{paper.abstract}</div>
        </div>
      )}
 
      {fields.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Extracted fields</div>
          {fields.map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10, fontSize: 13, marginBottom: 5 }}>
              <span style={{ minWidth: 96, color: "var(--muted)" }}>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
      {ext.concepts?.length > 0 && (
        <div className="pt-tags" style={{ marginBottom: 14 }}>
          {ext.concepts.map((t) => <span key={t} className="pill theme">{t}</span>)}
        </div>
      )}
 
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn sm" onClick={onChat}>Chat with paper</button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={onClose}>Keep</button>
        {onRemove && <button className="btn ghost sm" onClick={onRemove} style={{ color: "#c0392b" }}>Remove</button>}
      </div>
    </Overlay>
  );
}
 
/* ── Shared overlay ──────────────────────────────────────────── */
function Overlay({ children, onClose, wide }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(17,17,27,0.45)", zIndex: 9998,
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "8vh 20px 20px", backdropFilter: "blur(2px)", overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: wide ? 620 : 480, background: "var(--card, #fff)",
        color: "var(--txt, #111)", borderRadius: 14, padding: "24px 24px 22px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.28)", position: "relative",
        fontFamily: "'Space Grotesk',sans-serif",
      }}>
        <button onClick={onClose} aria-label="Close" style={{
          position: "absolute", top: 12, right: 16, background: "none", border: "none",
          fontSize: 22, color: "#9a9aab", cursor: "pointer", lineHeight: 1,
        }}>×</button>
        {children}
      </div>
    </div>
  );
}
 
const inp = {
  flex: 1, background: "var(--ink, #fff)", border: "1px solid var(--line, #e3e3ec)",
  borderRadius: 9, color: "var(--txt, #111)", fontSize: 14, padding: "10px 12px",
  outline: "none", fontFamily: "'Space Grotesk',sans-serif",
};

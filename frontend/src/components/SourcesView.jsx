import React, { useState, useMemo } from "react";
import PaperChatPanel from "./PaperChatPanel.jsx";
import PdfViewer from "./PdfViewer.jsx";
import { useConfirm } from "./ConfirmModal.jsx";
import MathText from "./MathText.jsx";
import { api } from "../api/client.js";
import { Plus, Trash2, RotateCw, Download } from "./icons.jsx";

function ExportPapersButtons({ runId, included, count = 0 }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const empty = count === 0;
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
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button className="btn ghost sm" disabled={!!busy || empty} onClick={() => go("xlsx")}
        title={empty ? "No sources to export yet" : ""}>
        <Download size={13} /> {busy === "xlsx" ? "…" : "Export Excel"}
      </button>
      <button className="btn ghost sm" disabled={!!busy || empty} onClick={() => go("csv")}
        title={empty ? "No sources to export yet" : ""}>
        <Download size={13} /> {busy === "csv" ? "…" : "Export CSV"}
      </button>
      {err && <span className="tiny" style={{ color: "#f08a8a" }}>{err}</span>}
    </span>
  );
}
 
const COLUMNS = [
  { key: "paper", label: "Paper", always: true, width: 300 },
  // "Excerpt" shows the paper's abstract straight from the source (free — no
  // extraction needed). Internal key stays `abstract` (that's the paper field).
  { key: "abstract", label: "Excerpt", fromPaper: true, width: 380 },
  { key: "contribution", label: "Contribution", width: 240 },
  { key: "method", label: "Method", width: 200 },
  { key: "metrics", label: "Metrics", width: 200 },
  { key: "finding", label: "Key finding", width: 220 },
  { key: "limitation", label: "Limitation", width: 220 },
  { key: "relevance", label: "Relevance", width: 240 },
];
// Show only Paper + Abstract by default; the rest are opt-in via the toggles.
const DEFAULT_ON = ["paper", "abstract"];
 
const ACCENT = "#6d5ef6";
const badge = (bg, fg) => ({
  fontFamily: "'JetBrains Mono',monospace", fontSize: 10, fontWeight: 500,
  borderRadius: 5, padding: "2px 7px", background: bg, color: fg, whiteSpace: "nowrap",
});
// Colour a 0–100 relevance score: strong (green) / moderate (amber) / weak (grey).
const relColor = (s) =>
  s >= 70 ? ["var(--green-soft, #e7f6ee)", "var(--green, #2e9e5b)"]
  : s >= 40 ? ["rgba(224,163,62,.14)", "#b8862f"]
  : ["var(--panel2, #eef0f4)", "var(--muted)"];
 
export default function SourcesView({
  citeOrder, extractions, ranked = [], extractStats, runId, apiKey, model,
  papers = [], included = {}, scope,
  analysisStale = false, busy = false,
  onRemove, onAdd, onUpload, onReanalyze, onGenerate, hasReview = false,
}) {
  const extByIdx = {};
  (extractions || []).forEach((e) => (extByIdx[e.idx] = e));
  // Synthesizer relevance/quality score (0–100) per paper, to show in the list.
  const rankByIdx = {};
  (ranked || []).forEach((r) => { if (r && r.idx != null) rankByIdx[r.idx] = r; });
 
  const [visible, setVisible] = useState(new Set(DEFAULT_ON));
  const [chatPaper, setChatPaper] = useState(null);
  const [detailPaper, setDetailPaper] = useState(null);
  const [readPaper, setReadPaper] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmAsync, confirmModal] = useConfirm();
 
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
 
  async function removeSelected() {
    const ids = allIdx.filter((i) => selected.has(i));
    if (!ids.length) return;
    const ok = await confirmAsync(
      `Remove ${ids.length} paper${ids.length > 1 ? "s" : ""} from your sources? ` +
      "They'll be excluded from the synthesis, ranking, knowledge graph, citations and review.",
      { danger: true, confirmLabel: "Remove" }
    );
    if (!ok) return;
    onRemove(ids);
    setSelected(new Set());
  }
 
  async function removeOne(idx) {
    const ok = await confirmAsync("Remove this paper from your sources?",
      { danger: true, confirmLabel: "Remove" });
    if (!ok) return;
    onRemove([idx]);
    setSelected((prev) => { const n = new Set(prev); n.delete(idx); return n; });
    setDetailPaper(null);
  }
 
  async function generate() {
    if (!canGenerate) return;
    const ok = await confirmAsync(
      `${includedCount} papers included\n` +
      (removedCount ? `${removedCount} paper${removedCount > 1 ? "s" : ""} removed\n` : "") +
      (addedCount ? `${addedCount} paper${addedCount > 1 ? "s" : ""} manually added\n` : ""),
      { title: "Generate the literature review?", confirmLabel: "Generate" }
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
          <button className="btn ghost sm" disabled={busy || adding} onClick={() => setShowAdd(true)}>
            <Plus size={13} /> Add paper
          </button>
          <button className="btn ghost sm" disabled={busy || selected.size === 0} onClick={removeSelected}>
            <Trash2 size={13} /> Remove selected{selected.size ? ` (${selected.size})` : ""}
          </button>
          <button className="btn ghost sm" disabled={busy || !analysisStale} onClick={onReanalyze}>
            <RotateCw size={13} className={busy ? "spin" : ""} /> {busy ? "Updating…" : "Update analysis"}
          </button>
          <ExportPapersButtons runId={runId} included={included} count={includedCount} />
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
                      {rankByIdx[p.idx]?.score != null && (
                        <div style={{ marginTop: 4 }} title={rankByIdx[p.idx].reason || "Synthesizer relevance score"}>
                          <span style={badge(...relColor(rankByIdx[p.idx].score))}>
                            relevance {rankByIdx[p.idx].score}
                          </span>
                        </div>
                      )}
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
                            <button className="pt-chat-btn" onClick={() => setReadPaper(p)}>read</button>
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
                    // Abstracts (and text derived from them) often carry inline
                    // LaTeX straight from the source (e.g. "$18.44 \text{dB}$")
                    // — MathText typesets that instead of showing raw markup.
                    const value = c.fromPaper ? p[c.key] : e[c.key];
                    return (
                      <td key={c.key} className={c.key === "abstract" || c.key === "excerpt" ? "pt-excerpt" : ""}>
                        {value ? <MathText text={value} /> : <span className="pt-na">n/a</span>}
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
          onUpload={onUpload && (async (file, titleOverride) => {
            setAdding(true);
            try {
              await onUpload(file, titleOverride);
              // Closing the modal here (as this used to) only worked for a
              // single file — with multi-file upload the modal needs to stay
              // open until the whole batch finishes, so AddPaperModal closes
              // itself once every file in the batch is done.
            } catch (e) {
              throw e;   // surfaced inside the modal
            } finally {
              setAdding(false);
            }
          })}
          onUploadDone={() => setShowAdd(false)}
        />
      )}
 
      {detailPaper && (
        <PaperDetail
          paper={detailPaper}
          ext={extByIdx[detailPaper.idx] || {}}
          onClose={() => setDetailPaper(null)}
          onRemove={editable ? () => removeOne(detailPaper.idx) : null}
          onChat={() => { setChatPaper(detailPaper); setDetailPaper(null); }}
          onRead={() => { setReadPaper(detailPaper); setDetailPaper(null); }}
        />
      )}
 
      {chatPaper && (
        <PaperChatPanel runId={runId} paper={chatPaper} extraction={extByIdx[chatPaper.idx]}
          cite={citeNumOf(chatPaper.idx)} apiKey={apiKey} model={model}
          onClose={() => setChatPaper(null)} />
      )}

      {readPaper && (
        <PdfViewer runId={runId} paper={readPaper} onClose={() => setReadPaper(null)} />
      )}

      {confirmModal}
    </div>
  );
}
 
/* ── Add paper modal ─────────────────────────────────────────── */
function AddPaperModal({ runId, busy, onClose, onAdd, onUpload, onUploadDone }) {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [cands, setCands] = useState(null);
  const [err, setErr] = useState(null);
  const [uploadErr, setUploadErr] = useState(null);
  const [fileName, setFileName] = useState(null);
  // Multi-file progress: [{name, status: "pending"|"uploading"|"done"|"error", error?}]
  const [batch, setBatch] = useState(null);
  // Only meaningful for a single-file upload — title is guessed from the
  // extracted text otherwise, which can merge in an author's name or
  // truncate a wrapped title. Not offered for multi-file batches since one
  // box can't sensibly title several different papers at once.
  const [titleOverride, setTitleOverride] = useState("");

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

  async function handleFile(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";  // allow picking the same file(s) again after an error
    if (!files.length) return;
    setUploadErr(null);

    // Single file keeps the old, simpler flow (no progress list) — it's the
    // common case and closes the modal the moment it succeeds.
    if (files.length === 1) {
      setFileName(files[0].name);
      try {
        await onUpload(files[0], titleOverride);
        onUploadDone?.();
      } catch (e2) {
        setUploadErr(e2.message);
      } finally {
        setFileName(null);
      }
      return;
    }

    // Multiple files: upload one at a time (each is its own extraction call
    // server-side, and running them concurrently would just contend for the
    // same rate limits) and show live per-file status so one bad file in the
    // batch doesn't hide whether the rest went through.
    setBatch(files.map((f) => ({ name: f.name, status: "pending" })));
    let anyError = false;
    for (let i = 0; i < files.length; i++) {
      setBatch((prev) => prev.map((b, j) => (j === i ? { ...b, status: "uploading" } : b)));
      try {
        await onUpload(files[i]);
        setBatch((prev) => prev.map((b, j) => (j === i ? { ...b, status: "done" } : b)));
      } catch (e2) {
        anyError = true;
        setBatch((prev) => prev.map((b, j) => (j === i ? { ...b, status: "error", error: e2.message } : b)));
      }
    }
    if (!anyError) onUploadDone?.();
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

      {onUpload && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>Or upload a file</div>
          <div className="muted tiny" style={{ marginBottom: 10 }}>
            For material not indexed anywhere — unpublished drafts, a scan you already have, an internal report, a colleague's slide deck. PDF, Word, or PowerPoint, up to 25MB each. Select several at once to add them all.
          </div>
          <input
            value={titleOverride}
            onChange={(e) => setTitleOverride(e.target.value)}
            placeholder="Title (optional — only used for a single file; leave blank to guess from the document)"
            disabled={busy}
            style={{ ...inp, marginBottom: 8, fontSize: 12.5 }}
          />
          <label className={"btn ghost sm" + (busy ? " disabled" : "")} style={{ display: "inline-block", cursor: busy ? "default" : "pointer" }}>
            {fileName ? `Uploading ${fileName}…` : batch ? "Uploading…" : "Choose PDF, DOCX, or PPTX…"}
            <input type="file" accept=".pdf,.docx,.pptx" multiple onChange={handleFile}
              disabled={busy} style={{ display: "none" }} />
          </label>
          {uploadErr && <div style={{ color: "#c0392b", fontSize: 13, marginTop: 8 }}>{uploadErr}</div>}
          {batch && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 5, maxHeight: 220, overflowY: "auto" }}>
              {batch.map((b, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <span style={{
                    flex: "0 0 16px", textAlign: "center",
                    color: b.status === "done" ? "#1c8a4b" : b.status === "error" ? "#c0392b" : "var(--muted)",
                  }}>
                    {b.status === "done" ? "✓" : b.status === "error" ? "✕" : b.status === "uploading" ? "…" : "·"}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {b.name}
                  </span>
                  {b.status === "error" && (
                    <span style={{ color: "#c0392b", fontSize: 11.5, flex: "0 0 auto", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={b.error}>
                      {b.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Overlay>
  );
}
 
/* ── Paper detail view ───────────────────────────────────────── */
function PaperDetail({ paper, ext, onClose, onRemove, onChat, onRead }) {
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
          <div style={{ fontSize: 13.5, lineHeight: 1.55 }}><MathText text={paper.abstract} /></div>
        </div>
      )}

      {fields.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Extracted fields</div>
          {fields.map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10, fontSize: 13, marginBottom: 5 }}>
              <span style={{ minWidth: 96, color: "var(--muted)" }}>{k}</span>
              <span><MathText text={v} /></span>
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
        {onRead && <button className="btn ghost sm" onClick={onRead}>Read PDF</button>}
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

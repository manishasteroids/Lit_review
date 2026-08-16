/*
 * In-app PDF viewer with highlighting, underlining & inline comments.
 *
 * Phase 1 (read-only) fetched the PDF and rendered pages to a <canvas>.
 * Phase 2 adds a selectable text layer (pdf.js's own TextLayerBuilder) on
 * top of the canvas, a small floating toolbar that appears on text
 * selection (Highlight / Underline / Comment), and a side panel listing
 * everything you've marked up so far. Annotations are saved to the backend
 * keyed by the paper's identity (URL or uploaded file — see
 * core/annotations.py), so they persist across sessions and follow the
 * paper if it's re-added to a different run.
 *
 * Rects are stored in PDF-point space at scale=1 and multiplied by the
 * current zoom when drawn, so they stay correctly positioned at any zoom
 * level. Nothing here feeds annotations into the LLM pipeline yet — that's
 * a deliberately separate, later phase.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { TextLayerBuilder } from "pdfjs-dist/web/pdf_viewer.mjs";
// Vite's ?url import gives us a hashed, servable URL for the worker file —
// required so pdf.js can parse/render off the main thread.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../api/client.js";
import { ArrowLeft, MessageSquare, X, Trash2 } from "./icons.jsx";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const HIGHLIGHT_COLOR = "rgba(255, 213, 79, 0.45)";
const UNDERLINE_COLOR = "#e0a33e";

export default function PdfViewer({ runId, paper, onClose }) {
  const canvasRef = useRef(null);
  const textLayerContainerRef = useRef(null);
  const pageWrapRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [doc, setDoc] = useState(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scale, setScale] = useState(1.25);

  const [annotations, setAnnotations] = useState([]);
  const [annErr, setAnnErr] = useState(null);
  const [toolbar, setToolbar] = useState(null);       // {x,y,rectsAtScale,text}
  const [commentDraft, setCommentDraft] = useState(null); // {x,y,rectsAtScale,text,value}
  const [openComment, setOpenComment] = useState(null);   // annotation id being viewed
  const [showPanel, setShowPanel] = useState(false);

  // ── Load the document once when the paper changes ──────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    setPage(1);
    setNumPages(0);
    (async () => {
      try {
        const bytes = await api.getPaperPdf(runId, paper.idx);
        if (cancelled) return;
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        setDoc(pdf);
        setNumPages(pdf.numPages);
      } catch (e) {
        if (!cancelled) setError(e.message || "Couldn't load this PDF.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, paper.idx]);

  // ── Load saved annotations for this paper (independent of PDF load) ────
  useEffect(() => {
    let cancelled = false;
    setAnnotations([]);
    (async () => {
      try {
        const res = await api.listAnnotations(runId, paper.idx);
        if (!cancelled) setAnnotations(res.annotations || []);
      } catch (e) {
        /* non-critical — the paper still reads fine without saved marks */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, paper.idx]);

  // ── Render the current page (canvas + selectable text layer) ───────────
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const pdfPage = await doc.getPage(page);
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale });

      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch (e) {}
        }
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        try { await task.promise; } catch (e) { /* superseded by a newer render */ }
      }
      if (cancelled) return;

      const wrap = pageWrapRef.current;
      if (wrap) {
        wrap.style.width = `${viewport.width}px`;
        wrap.style.height = `${viewport.height}px`;
      }

      const container = textLayerContainerRef.current;
      if (container) {
        container.innerHTML = "";
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
        try {
          const textLayer = new TextLayerBuilder({ pdfPage });
          // Must match the actual render scale (the canvas below it is drawn
          // at `scale`, e.g. 1.25x) — hardcoding this to 1 sizes the invisible
          // selectable glyphs smaller than the real ones underneath, so a
          // selection's computed rects drift further right the longer the
          // line is (the overflowing "staircase" highlight bug).
          textLayer.div.style.setProperty("--total-scale-factor", String(scale));
          container.appendChild(textLayer.div);
          await textLayer.render({ viewport });
        } catch (e) {
          /* text layer is a selection nicety — a failure here shouldn't block reading */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, page, scale]);

  // ── Text-selection -> floating toolbar ──────────────────────────────────
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString();
    if (!text.trim()) return;
    const wrap = pageWrapRef.current;
    const range = sel.getRangeAt(0);
    if (!wrap || !wrap.contains(range.commonAncestorContainer)) return;

    const clientRects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!clientRects.length) return;
    const wrapRect = wrap.getBoundingClientRect();
    const rectsAtScale = clientRects.map((r) => ({
      x: r.left - wrapRect.left, y: r.top - wrapRect.top, w: r.width, h: r.height,
    }));
    const last = rectsAtScale[rectsAtScale.length - 1];
    setCommentDraft(null);
    setToolbar({
      x: Math.min(last.x + last.w + 6, (wrap.clientWidth || 0) - 190),
      y: Math.max(last.y - 6, 0),
      rectsAtScale, text,
    });
  }, []);

  useEffect(() => {
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseUp]);

  async function saveAnnotation(kind, source, commentText) {
    const rectsUnscaled = source.rectsAtScale.map((r) => ({
      x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale,
    }));
    setAnnErr(null);
    try {
      const ann = await api.addAnnotation(runId, paper.idx, {
        kind, page, rects: rectsUnscaled,
        color: kind === "underline" ? UNDERLINE_COLOR : HIGHLIGHT_COLOR,
        snippet: source.text, comment: commentText || null,
      });
      setAnnotations((prev) => [...prev, ann]);
    } catch (e) {
      setAnnErr(e.message);
    }
    window.getSelection()?.removeAllRanges();
    setToolbar(null);
    setCommentDraft(null);
  }

  async function removeAnnotation(id) {
    setAnnErr(null);
    try {
      await api.deleteAnnotation(runId, paper.idx, id);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      if (openComment === id) setOpenComment(null);
    } catch (e) {
      setAnnErr(e.message);
    }
  }

  const pageAnnotations = annotations.filter((a) => a.page === page);

  return (
    <div
      style={overlayStyle}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Minimal subset of pdf.js's own pdf_viewer.css textLayer rules —
          just enough for invisible, correctly-positioned, selectable text.
          Scoped under .pdfv-text-layer-host instead of pulling in the full
          (6000+ line) stylesheet meant for pdf.js's whole reference viewer. */}
      <style>{`
        .pdfv-text-layer-host .textLayer {
          position: absolute; inset: 0; overflow: clip; opacity: 1;
          line-height: 1; text-align: initial; transform-origin: 0 0; z-index: 2;
        }
        .pdfv-text-layer-host .textLayer span,
        .pdfv-text-layer-host .textLayer br {
          color: transparent; position: absolute; white-space: pre;
          cursor: text; transform-origin: 0% 0%; user-select: text;
        }
        .pdfv-text-layer-host .textLayer .markedContent { display: contents; }
        .pdfv-text-layer-host .textLayer span[role="img"] { user-select: none; cursor: default; }
        .pdfv-text-layer-host .textLayer ::selection { background: rgba(109,94,246,.35); }
        .pdfv-text-layer-host .textLayer .endOfContent {
          display: block; position: absolute; inset: 100% 0 0; z-index: -1;
          cursor: default; user-select: none;
        }
      `}</style>
      <div style={panelStyle}>
        <div style={headerStyle}>
          <button className="btn ghost sm" onClick={onClose}>
            <ArrowLeft size={14} /> Back
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 700, fontSize: 13.5,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}
              title={paper.title}
            >
              {paper.title}
            </div>
            <div className="muted tiny">
              {paper.authors || ""} {paper.year ? `· ${paper.year}` : ""}
            </div>
          </div>
          {numPages > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
              <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ‹ Prev
              </button>
              <span className="muted tiny" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                Page {page} / {numPages}
              </span>
              <button className="btn ghost sm" disabled={page >= numPages} onClick={() => setPage((p) => p + 1)}>
                Next ›
              </button>
              <span style={{ width: 1, height: 18, background: "var(--line)" }} />
              <button className="btn ghost sm" onClick={() => setScale((s) => Math.max(0.6, s - 0.15))}>
                −
              </button>
              <button className="btn ghost sm" onClick={() => setScale((s) => Math.min(2.5, s + 0.15))}>
                +
              </button>
              <span style={{ width: 1, height: 18, background: "var(--line)" }} />
              <button
                className={"btn ghost sm" + (showPanel ? " on" : "")}
                onClick={() => setShowPanel((v) => !v)}
                title="Highlights, underlines & comments"
              >
                <MessageSquare size={14} /> Notes{annotations.length ? ` (${annotations.length})` : ""}
              </button>
            </div>
          )}
        </div>

        <div style={{ flex: "1 1 auto", display: "flex", overflow: "hidden" }}>
          <div style={bodyStyle}>
            {loading && <div className="muted tiny" style={{ padding: 24 }}>Loading PDF…</div>}
            {error && (
              <div style={{ padding: 24, maxWidth: 440, textAlign: "center" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Couldn't load this PDF</div>
                <div className="muted tiny" style={{ marginBottom: 14 }}>{error}</div>
                {paper.url && (
                  <a href={paper.url} target="_blank" rel="noreferrer" className="btn ghost sm">
                    Open source link instead
                  </a>
                )}
              </div>
            )}
            {!loading && !error && (
              <div ref={pageWrapRef} style={{ position: "relative" }}>
                <canvas ref={canvasRef} style={{ display: "block", boxShadow: "0 4px 20px rgba(0,0,0,.15)", background: "#fff" }} />

                {/* Highlight/underline fills sit between the canvas and the
                    (invisible) text layer so they don't intercept new selections. */}
                <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                  {pageAnnotations.filter((a) => a.kind !== "comment").map((a) =>
                    a.rects.map((r, i) => (
                      <div
                        key={`${a.id}-${i}`}
                        style={{
                          position: "absolute",
                          left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale,
                          background: a.kind === "highlight" ? (a.color || HIGHLIGHT_COLOR) : "transparent",
                          borderBottom: a.kind === "underline" ? `2px solid ${a.color || UNDERLINE_COLOR}` : "none",
                          mixBlendMode: a.kind === "highlight" ? "multiply" : "normal",
                        }}
                      />
                    ))
                  )}
                  {/* comment-anchored snippets get a light tint so they're visible on the page */}
                  {pageAnnotations.filter((a) => a.kind === "comment").map((a) =>
                    a.rects.map((r, i) => (
                      <div
                        key={`${a.id}-${i}`}
                        style={{
                          position: "absolute",
                          left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale,
                          background: "rgba(109,94,246,0.16)",
                          borderBottom: "2px dotted #6d5ef6",
                        }}
                      />
                    ))
                  )}
                </div>

                {/* Selectable, invisible text layer (pdf.js TextLayerBuilder). */}
                <div ref={textLayerContainerRef} className="pdfv-text-layer-host" style={{ position: "absolute", inset: 0 }} />

                {/* Clickable comment markers, above the text layer. */}
                {pageAnnotations.filter((a) => a.kind === "comment" && a.rects[0]).map((a) => {
                  const r = a.rects[0];
                  return (
                    <div
                      key={`marker-${a.id}`}
                      onClick={() => setOpenComment(a.id)}
                      title={a.comment}
                      style={{
                        position: "absolute",
                        left: r.x * scale + r.w * scale + 3, top: r.y * scale - 3,
                        width: 15, height: 15, borderRadius: "50%", background: "#6d5ef6",
                        color: "#fff", fontSize: 10, fontWeight: 700, lineHeight: "15px", textAlign: "center",
                        cursor: "pointer", zIndex: 5, boxShadow: "0 1px 4px rgba(0,0,0,.3)",
                      }}
                    >
                      !
                    </div>
                  );
                })}

                {openComment != null && annotations.find((a) => a.id === openComment) && (
                  <CommentPopup
                    ann={annotations.find((a) => a.id === openComment)}
                    scale={scale}
                    onClose={() => setOpenComment(null)}
                    onDelete={() => removeAnnotation(openComment)}
                  />
                )}

                {toolbar && !commentDraft && (
                  <SelectionToolbar
                    toolbar={toolbar}
                    onHighlight={() => saveAnnotation("highlight", toolbar)}
                    onUnderline={() => saveAnnotation("underline", toolbar)}
                    onComment={() => setCommentDraft({ ...toolbar, value: "" })}
                    onDismiss={() => setToolbar(null)}
                  />
                )}

                {commentDraft && (
                  <CommentComposer
                    draft={commentDraft}
                    onChange={(value) => setCommentDraft((d) => ({ ...d, value }))}
                    onSave={() => saveAnnotation("comment", commentDraft, commentDraft.value)}
                    onCancel={() => {
                      setCommentDraft(null);
                      setToolbar(null);
                    }}
                  />
                )}
              </div>
            )}
          </div>

          {showPanel && (
            <AnnotationsPanel
              annotations={annotations}
              currentPage={page}
              onJump={(p) => setPage(p)}
              onDelete={removeAnnotation}
              onClose={() => setShowPanel(false)}
              err={annErr}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Floating toolbar shown on text selection ────────────────────────── */
function SelectionToolbar({ toolbar, onHighlight, onUnderline, onComment, onDismiss }) {
  return (
    <div
      style={{
        position: "absolute", left: toolbar.x, top: toolbar.y, zIndex: 20,
        display: "flex", gap: 4, background: "#26263a", borderRadius: 8,
        padding: 4, boxShadow: "0 6px 20px rgba(0,0,0,.35)",
      }}
      onMouseDown={(e) => e.preventDefault()}  // don't clear the selection when clicking
    >
      <button style={toolbarBtn} title="Highlight" onClick={onHighlight}>
        <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: HIGHLIGHT_COLOR }} />
      </button>
      <button style={toolbarBtn} title="Underline" onClick={onUnderline}>
        <span style={{ fontWeight: 800, textDecoration: "underline", textDecorationColor: UNDERLINE_COLOR, textDecorationThickness: 2 }}>U</span>
      </button>
      <button style={toolbarBtn} title="Comment" onClick={onComment}>
        <MessageSquare size={13} />
      </button>
      <button style={{ ...toolbarBtn, opacity: 0.6 }} title="Dismiss" onClick={onDismiss}>
        <X size={13} />
      </button>
    </div>
  );
}

const toolbarBtn = {
  background: "transparent", border: "none", borderRadius: 5, padding: "5px 7px",
  cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
};

/* ── Inline comment composer ─────────────────────────────────────────── */
function CommentComposer({ draft, onChange, onSave, onCancel }) {
  return (
    <div
      style={{
        position: "absolute", left: Math.max(draft.x - 120, 4), top: draft.y + 4, zIndex: 20,
        width: 240, background: "var(--card, #fff)", borderRadius: 9, padding: 10,
        boxShadow: "0 10px 30px rgba(0,0,0,.3)", border: "1px solid var(--line)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="muted tiny" style={{ marginBottom: 6, fontStyle: "italic" }}>
        "{draft.text.length > 80 ? draft.text.slice(0, 80) + "…" : draft.text}"
      </div>
      <textarea
        autoFocus
        value={draft.value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Add a comment…"
        rows={3}
        style={{
          width: "100%", resize: "vertical", fontSize: 13, fontFamily: "'Space Grotesk',sans-serif",
          border: "1px solid var(--line)", borderRadius: 6, padding: 6, outline: "none",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="btn sm" disabled={!draft.value.trim()} onClick={onSave}>Save</button>
      </div>
    </div>
  );
}

/* ── Popup shown when a comment marker is clicked ────────────────────── */
function CommentPopup({ ann, onClose, onDelete }) {
  const r = ann.rects[0] || { x: 0, y: 0, w: 0, h: 0 };
  return (
    <div
      style={{
        position: "absolute", left: Math.max(r.x - 100, 4), top: r.y + 20, zIndex: 20,
        width: 240, background: "var(--card, #fff)", borderRadius: 9, padding: 10,
        boxShadow: "0 10px 30px rgba(0,0,0,.3)", border: "1px solid var(--line)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {ann.snippet && (
        <div className="muted tiny" style={{ marginBottom: 6, fontStyle: "italic" }}>
          "{ann.snippet.length > 80 ? ann.snippet.slice(0, 80) + "…" : ann.snippet}"
        </div>
      )}
      <div style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 8, whiteSpace: "pre-wrap" }}>{ann.comment}</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
        <button className="btn ghost sm" onClick={onDelete} style={{ color: "#c0392b" }}>
          <Trash2 size={12} /> Delete
        </button>
        <button className="btn ghost sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/* ── Side panel listing every mark on this paper ─────────────────────── */
function AnnotationsPanel({ annotations, currentPage, onJump, onDelete, onClose, err }) {
  const KIND_LABEL = { highlight: "Highlight", underline: "Underline", comment: "Comment" };
  return (
    <div style={{
      width: 260, flex: "0 0 auto", borderLeft: "1px solid var(--line)",
      background: "var(--card, #fff)", overflow: "auto", padding: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Notes on this paper</div>
        <button className="btn ghost sm" onClick={onClose}><X size={13} /></button>
      </div>
      {err && <div style={{ color: "#c0392b", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      {annotations.length === 0 && (
        <div className="muted tiny">
          Select any text in the paper to highlight, underline, or add a comment.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {annotations.map((a) => (
          <div
            key={a.id}
            style={{
              border: "1px solid var(--line)", borderRadius: 8, padding: 8,
              background: a.page === currentPage ? "var(--indigo-soft)" : "transparent",
              cursor: "pointer",
            }}
            onClick={() => onJump(a.page)}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span className="muted tiny" style={{ fontFamily: "'JetBrains Mono',monospace" }}>
                p.{a.page} · {KIND_LABEL[a.kind] || a.kind}
              </span>
              <button
                className="btn ghost sm"
                style={{ padding: "2px 5px" }}
                onClick={(e) => { e.stopPropagation(); onDelete(a.id); }}
                title="Delete"
              >
                <Trash2 size={11} />
              </button>
            </div>
            {a.snippet && (
              <div style={{ fontSize: 12.5, lineHeight: 1.4, fontStyle: "italic", color: "var(--muted)" }}>
                "{a.snippet.length > 100 ? a.snippet.slice(0, 100) + "…" : a.snippet}"
              </div>
            )}
            {a.comment && (
              <div style={{ fontSize: 12.5, lineHeight: 1.4, marginTop: 4, whiteSpace: "pre-wrap" }}>{a.comment}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const overlayStyle = {
  position: "fixed", inset: 0, background: "rgba(20,20,30,.6)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 900, padding: "3vh 3vw",
};

const panelStyle = {
  width: "100%", height: "100%",
  background: "var(--bg, #f4f5f9)", borderRadius: 14,
  boxShadow: "0 30px 90px rgba(0,0,0,.35)",
  display: "flex", flexDirection: "column", overflow: "hidden",
};

const headerStyle = {
  display: "flex", alignItems: "center", gap: 14,
  padding: "12px 18px", borderBottom: "1px solid var(--line)",
  background: "var(--card, #fff)", flex: "0 0 auto",
};

const bodyStyle = {
  flex: "1 1 auto", overflow: "auto",
  display: "flex", alignItems: "flex-start", justifyContent: "center",
  padding: 24, background: "var(--panel2, #eef0f4)",
};

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
import { ArrowLeft, MessageSquare, X, Trash2, PenTool, Eraser, TypeIcon, Square, CircleShape, ChevronDown } from "./icons.jsx";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const HIGHLIGHT_COLOR = "rgba(255, 213, 79, 0.45)";
const UNDERLINE_COLOR = "#e0a33e";

// Freehand pen — a small preset palette (not a full color picker; this is a
// quick markup tool, not an illustration app) plus a fixed stroke width in
// PDF-point space so lines stay a consistent visual weight at any zoom.
const PEN_COLORS = ["#e0453e", "#3e6fe0", "#1c2128"];
const PEN_WIDTH = 2.2;
// A point within this many *screen* pixels of a stroke/shape/text is
// considered "touched" by the eraser.
const ERASE_HIT_PX = 10;

// A real pen-nib cursor instead of the generic crosshair, so it's obvious
// at a glance which tool is active. Encoded inline (no asset file) — a
// simple angled nib shape, colored to match the currently-selected pen
// color via a template so it also hints which color is loaded.
function penCursor(color) {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
    `<path d='M4 20l1.5-5L16 4.5a1.7 1.7 0 0 1 2.4 0l1.1 1.1a1.7 1.7 0 0 1 0 2.4L9 18l-5 2z' ` +
    `fill='${encodeURIComponent(color)}' stroke='%23222' stroke-width='1.1' stroke-linejoin='round'/></svg>`;
  return `url("data:image/svg+xml,${svg}") 2 22, crosshair`;
}

// Perpendicular distance from point p to segment (a,b), for eraser hit-testing.
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// pdf.js's text layer is a flat pile of absolutely-positioned <span>s (one
// per glyph run), not real inline/line-box layout. `Range.getClientRects()`
// groups fragments by approximate vertical position to guess "lines" — in a
// dense two-column paper, two spans from *different* columns often land
// within a pixel of each other vertically, so the browser merges them into
// one rect stretching from the leftmost glyph to the rightmost, spilling
// across the gutter into the margin.
//
// Fix, part 1: don't ask the browser to guess lines at all. Walk every text
// node the selection actually touches and grab its OWN bounding rect
// (clipped to the selected offsets for the first/last node) — one rect per
// span, never merged with a neighboring column.
//
// Fix, part 2: `node === range.startContainer` / `range.endContainer` only
// clips correctly when the browser resolved the drag endpoint to a
// character offset *inside* that text node. If the mouseup lands past the
// last visible glyph (very easy to do — the line is short, the column has
// empty space to its right, and a normal mouse drag overshoots), the
// browser can instead resolve the boundary to an ancestor element (pdf.js's
// invisible full-width `.endOfContent` sentinel, used so clicking below the
// last line still registers), and the identity check silently fails —
// selecting each such node in FULL rather than clipping it, which is what
// produced the "underline overflows into the margin/gutter" bug even after
// part 1. Belt-and-suspenders fix: whatever sub-range rect comes out, clamp
// it to its own span's actual rendered bounding box — a highlight/underline
// can now never extend past the real glyphs it's drawn under, regardless of
// which way the Range API resolved the selection boundary.
function getSelectionRects(range) {
  const root = range.commonAncestorContainer;
  const walkRoot = root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
  const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const rects = [];
  let node;
  while ((node = walker.nextNode())) {
    const sub = document.createRange();
    sub.selectNodeContents(node);
    if (node === range.startContainer) sub.setStart(node, range.startOffset);
    if (node === range.endContainer) sub.setEnd(node, range.endOffset);
    try {
      // Prefer per-glyph-run rects within this single text node (usually
      // just one, but a wrapped span can legitimately have more) over one
      // bounding box, so a selection that wraps within a single long span
      // still gets tightly-fit rects rather than one that spans its full width.
      const nodeRects = Array.from(sub.getClientRects());
      const spanEl = node.parentElement;
      const spanRect = spanEl ? spanEl.getBoundingClientRect() : null;
      for (const r of nodeRects) {
        if (r.width <= 0 || r.height <= 0) continue;
        if (!spanRect || spanRect.width <= 0) { rects.push(r); continue; }
        const left = Math.max(r.left, spanRect.left);
        const right = Math.min(r.right, spanRect.right);
        if (right - left <= 0) continue;
        rects.push({ left, top: r.top, width: right - left, height: r.height });
      }
    } catch (e) {
      /* a degenerate sub-range (e.g. empty text node) — skip it */
    }
  }
  return rects;
}

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

  // ── Pen / eraser / text / shapes ────────────────────────────────────
  const [tool, setTool] = useState("select");   // select | pen | eraser | text | rect | circle
  const [drawColor, setDrawColor] = useState(PEN_COLORS[0]);   // shared by pen, text & shapes
  const [penMenuOpen, setPenMenuOpen] = useState(false);
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [shapeKind, setShapeKind] = useState("rect");    // which shape the "Shapes" button's main click draws
  const [stroke, setStroke] = useState(null);   // in-progress pen stroke: [{x,y}, ...] unscaled
  const [shapePreview, setShapePreview] = useState(null);  // in-progress shape: {shape,x,y,w,h} unscaled
  const [textDraft, setTextDraft] = useState(null);         // {x,y,value} — inline text composer
  const drawingRef = useRef(false);
  const shapeStartRef = useRef(null);           // {x,y} unscaled — drag origin for the active shape
  const erasedRef = useRef(new Set());          // annotation ids already erased this drag
  const undoStackRef = useRef([]);              // ids of annotations created this session, in order

  // ── Dragging a placed text note to a new spot ───────────────────────
  const [draggingText, setDraggingText] = useState(null); // {id, dx, dy} unscaled offset from note origin
  const [liveDragPos, setLiveDragPos] = useState(null);    // {id, x, y} unscaled — live position while dragging

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
        // The canvas backing store was sized to `viewport.width/height`
        // (CSS pixels) with no separate CSS size set, so on any HiDPI/Retina
        // screen the browser was displaying it 1:1 in device pixels — i.e.
        // rendering at roughly half the real screen resolution (a third on
        // 3x displays) and then the browser stretched that up, which reads
        // as visibly softer/blurrier text and figures than the same PDF
        // open in a native viewer (which always renders at full device
        // resolution). Render the backing store at devicePixelRatio and
        // pin the CSS display size to the logical viewport size instead —
        // pdf.js's own documented pattern for crisp HiDPI canvas output.
        // Even on a standard (non-Retina) display, devicePixelRatio is 1 —
        // rendering at exactly the CSS size then produces visibly soft text,
        // since a browser's own native PDF viewer always rasterizes well
        // above 1x. Floor the backing-store scale at 2x regardless of the
        // display's actual pixel ratio, so quality doesn't regress to "blurry"
        // on ordinary monitors.
        const outputScale = Math.max(2, window.devicePixelRatio || 1);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext("2d");
        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch (e) {}
        }
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
        const task = pdfPage.render({ canvasContext: ctx, viewport, transform });
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
  // Remember exactly where the mouse went down, so mouseup can rebuild the
  // selection from those two literal pixel points instead of trusting
  // whatever the browser's native drag-selection resolved to. Native
  // selection over an invisible, absolutely-positioned text layer (no real
  // line boxes) can occasionally snap further than the mouse actually
  // moved — e.g. a quick press-drag near the start of a heading getting
  // interpreted as an extend-to-paragraph gesture — which is what produces
  // "I dragged over just the title, but it selected the abstract too."
  // caretRangeFromPoint/caretPositionFromPoint always resolve to the exact
  // nearest character under a pixel, so rebuilding from down->up removes
  // that ambiguity entirely.
  const mouseDownPtRef = useRef(null);

  const handleMouseDown = useCallback((e) => {
    const wrap = pageWrapRef.current;
    mouseDownPtRef.current = (wrap && wrap.contains(e.target))
      ? { x: e.clientX, y: e.clientY } : null;
  }, []);

  function caretRangeAt(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const pos = document.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    return r;
  }

  const handleMouseUp = useCallback((upEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString();
    if (!text.trim()) return;
    const wrap = pageWrapRef.current;
    let range = sel.getRangeAt(0);
    if (!wrap || !wrap.contains(range.commonAncestorContainer)) return;

    const down = mouseDownPtRef.current;
    if (down && upEvent) {
      try {
        const startCaret = caretRangeAt(down.x, down.y);
        const endCaret = caretRangeAt(upEvent.clientX, upEvent.clientY);
        if (startCaret && endCaret
            && wrap.contains(startCaret.startContainer) && wrap.contains(endCaret.startContainer)) {
          const rebuilt = document.createRange();
          if (startCaret.compareBoundaryPoints(Range.START_TO_START, endCaret) <= 0) {
            rebuilt.setStart(startCaret.startContainer, startCaret.startOffset);
            rebuilt.setEnd(endCaret.startContainer, endCaret.startOffset);
          } else {
            rebuilt.setStart(endCaret.startContainer, endCaret.startOffset);
            rebuilt.setEnd(startCaret.startContainer, startCaret.startOffset);
          }
          if (!rebuilt.collapsed && rebuilt.toString().trim()) {
            range = rebuilt;
            sel.removeAllRanges();
            sel.addRange(rebuilt);
          }
        }
      } catch (e) {
        /* caret APIs are best-effort — fall back to the native selection as-is */
      }
    }

    const clientRects = getSelectionRects(range).filter((r) => r.width > 0 && r.height > 0);
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
      rectsAtScale, text: range.toString(),
    });
  }, []);

  useEffect(() => {
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseDown, handleMouseUp]);

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
      undoStackRef.current.push(ann.id);
    } catch (e) {
      setAnnErr(e.message);
    }
    window.getSelection()?.removeAllRanges();
    setToolbar(null);
    setCommentDraft(null);
  }

  async function saveStroke(points) {
    if (points.length < 2) return;
    setAnnErr(null);
    try {
      const ann = await api.addAnnotation(runId, paper.idx, {
        kind: "drawing", page, rects: [{ path: points.map((p) => [p.x, p.y]) }],
        color: drawColor,
      });
      setAnnotations((prev) => [...prev, ann]);
      undoStackRef.current.push(ann.id);
    } catch (e) {
      setAnnErr(e.message);
    }
  }

  async function saveShape(shape) {
    if (Math.abs(shape.w) < 2 && Math.abs(shape.h) < 2) return; // just a click, not a real drag
    const norm = {
      shape: shape.shape,
      x: Math.min(shape.x, shape.x + shape.w),
      y: Math.min(shape.y, shape.y + shape.h),
      w: Math.abs(shape.w),
      h: Math.abs(shape.h),
    };
    setAnnErr(null);
    try {
      const ann = await api.addAnnotation(runId, paper.idx, {
        kind: "shape", page, rects: [norm], color: drawColor,
      });
      setAnnotations((prev) => [...prev, ann]);
      undoStackRef.current.push(ann.id);
    } catch (e) {
      setAnnErr(e.message);
    }
  }

  async function saveText(x, y, text) {
    if (!text.trim()) return;
    setAnnErr(null);
    try {
      const ann = await api.addAnnotation(runId, paper.idx, {
        kind: "text", page, rects: [{ x, y, text: text.trim() }], color: drawColor,
      });
      setAnnotations((prev) => [...prev, ann]);
      undoStackRef.current.push(ann.id);
    } catch (e) {
      setAnnErr(e.message);
    }
  }

  async function removeAnnotation(id) {
    setAnnErr(null);
    try {
      await api.deleteAnnotation(runId, paper.idx, id);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      if (openComment === id) setOpenComment(null);
      undoStackRef.current = undoStackRef.current.filter((i) => i !== id);
    } catch (e) {
      setAnnErr(e.message);
    }
  }

  // Cmd+Z (mac) / Ctrl+Z (win/linux) undoes the most recently created mark
  // (pen stroke, shape, text box, highlight, underline, or comment) from
  // this viewing session. Deliberately simple — one level, additions only,
  // no redo — a full undo/redo stack isn't worth the complexity for a
  // lightweight markup tool. Skipped entirely while focused in a text
  // field (comment/text composer) so the browser's native field-level undo
  // works as expected there instead of being hijacked.
  useEffect(() => {
    function onKeyDown(e) {
      if (!(e.key === "z" || e.key === "Z") || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const lastId = undoStackRef.current.pop();
      if (lastId != null) {
        e.preventDefault();
        removeAnnotation(lastId);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pageAnnotations = annotations.filter((a) => a.page === page);
  const drawings = pageAnnotations.filter((a) => a.kind === "drawing" && a.rects[0]?.path);
  const shapes = pageAnnotations.filter((a) => a.kind === "shape" && a.rects[0]);
  const texts = pageAnnotations.filter((a) => a.kind === "text" && a.rects[0]);

  // Client (viewport) coords -> page-local, unscaled (scale=1) coords —
  // same space every other annotation kind's rects are stored in, so
  // drawings redraw correctly at any zoom level too.
  function toPagePoint(e) {
    const wrap = pageWrapRef.current;
    const r = wrap.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }

  // Drag a text note to reposition it. Only active in "select" mode (the
  // default) — while a draw/erase tool is active, the SVG overlay above the
  // notes is the one capturing pointer events, so there's no conflict.
  function startDragText(e, ann) {
    if (tool !== "select") return;
    e.stopPropagation();
    e.preventDefault();
    const p = toPagePoint(e);
    const r = ann.rects[0];
    setDraggingText({ id: ann.id, dx: p.x - r.x, dy: p.y - r.y });
    setLiveDragPos({ id: ann.id, x: r.x, y: r.y });
  }

  useEffect(() => {
    if (!draggingText) return;
    function onMove(e) {
      const p = toPagePoint(e);
      setLiveDragPos({ id: draggingText.id, x: p.x - draggingText.dx, y: p.y - draggingText.dy });
    }
    function onUp() {
      setLiveDragPos((pos) => {
        if (pos) {
          const original = annotations.find((a) => a.id === pos.id);
          const text = original?.rects?.[0]?.text || "";
          api.moveAnnotation(runId, paper.idx, pos.id, [{ x: pos.x, y: pos.y, text }])
            .then(() => {
              setAnnotations((prev) => prev.map((a) =>
                a.id === pos.id ? { ...a, rects: [{ ...a.rects[0], x: pos.x, y: pos.y }] } : a
              ));
            })
            .catch((e) => setAnnErr(e.message));
        }
        return null;
      });
      setDraggingText(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingText]);

  function handleDrawPointerDown(e) {
    if (tool === "pen") {
      e.preventDefault();
      drawingRef.current = true;
      setStroke([toPagePoint(e)]);
    } else if (tool === "eraser") {
      e.preventDefault();
      erasedRef.current = new Set();
      eraseNear(toPagePoint(e));
    } else if (tool === "rect" || tool === "circle") {
      e.preventDefault();
      const p = toPagePoint(e);
      shapeStartRef.current = p;
      setShapePreview({ shape: tool, x: p.x, y: p.y, w: 0, h: 0 });
    } else if (tool === "text") {
      e.preventDefault();
      const p = toPagePoint(e);
      setTextDraft({ x: p.x, y: p.y, value: "" });
    }
  }

  function handleDrawPointerMove(e) {
    if (tool === "pen" && drawingRef.current) {
      setStroke((prev) => (prev ? [...prev, toPagePoint(e)] : prev));
    } else if (tool === "eraser" && e.buttons === 1) {
      eraseNear(toPagePoint(e));
    } else if ((tool === "rect" || tool === "circle") && shapeStartRef.current) {
      const p = toPagePoint(e);
      const s = shapeStartRef.current;
      setShapePreview({ shape: tool, x: s.x, y: s.y, w: p.x - s.x, h: p.y - s.y });
    }
  }

  function handleDrawPointerUp() {
    if (tool === "pen" && drawingRef.current) {
      drawingRef.current = false;
      setStroke((prev) => {
        if (prev && prev.length >= 2) saveStroke(prev);
        return null;
      });
    } else if ((tool === "rect" || tool === "circle") && shapeStartRef.current) {
      shapeStartRef.current = null;
      setShapePreview((prev) => {
        if (prev) saveShape(prev);
        return null;
      });
    }
  }

  // Eraser hit-tests every kind of user-drawn mark (pen strokes, shapes,
  // text boxes) — not highlights/underlines/comments, which already have
  // their own delete affordances (the selection toolbar / Notes panel).
  function eraseNear(pt) {
    const hitPx = ERASE_HIT_PX / scale;  // threshold in the same unscaled space as stored points
    for (const a of drawings) {
      if (erasedRef.current.has(a.id)) continue;
      const path = a.rects[0].path;
      for (let i = 0; i < path.length - 1; i++) {
        const seg = distToSegment(pt, { x: path[i][0], y: path[i][1] }, { x: path[i + 1][0], y: path[i + 1][1] });
        if (seg <= hitPx) { erasedRef.current.add(a.id); removeAnnotation(a.id); break; }
      }
    }
    for (const a of shapes) {
      if (erasedRef.current.has(a.id)) continue;
      const r = a.rects[0];
      // Hit the outline (not the whole filled area, since shapes are
      // outline-only) — within hitPx of any of the four edges.
      const edges = [
        [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }],
        [{ x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }],
        [{ x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }],
        [{ x: r.x, y: r.y + r.h }, { x: r.x, y: r.y }],
      ];
      if (edges.some(([a1, b1]) => distToSegment(pt, a1, b1) <= hitPx)) {
        erasedRef.current.add(a.id); removeAnnotation(a.id);
      }
    }
    for (const a of texts) {
      if (erasedRef.current.has(a.id)) continue;
      const r = a.rects[0];
      const w = Math.max(40, (r.text || "").length * 6.5), h = 18;
      if (pt.x >= r.x - hitPx && pt.x <= r.x + w + hitPx && pt.y >= r.y - hitPx && pt.y <= r.y + h + hitPx) {
        erasedRef.current.add(a.id); removeAnnotation(a.id);
      }
    }
  }

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
              {/* Pen — split button: the main half toggles the tool, the
                  chevron half opens a color picker (picking a color also
                  switches to Pen, since that's the button it lives under). */}
              <span style={splitWrapStyle}>
                <button
                  className={"btn ghost sm" + (tool === "pen" ? " on" : "")}
                  onClick={() => setTool((t) => (t === "pen" ? "select" : "pen"))}
                  title="Pen — draw freehand marks on the page"
                  style={splitMainStyle}
                >
                  <PenTool size={14} color={drawColor} /> Pen
                </button>
                <button
                  className={"btn ghost sm" + (tool === "pen" ? " on" : "")}
                  onClick={() => { setPenMenuOpen((v) => !v); setShapeMenuOpen(false); }}
                  title="Pen color"
                  style={splitChevronStyle}
                >
                  <ChevronDown size={11} />
                </button>
                {penMenuOpen && (
                  <div style={colorMenuStyle} onMouseLeave={() => setPenMenuOpen(false)}>
                    {PEN_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => { setDrawColor(c); setTool("pen"); setPenMenuOpen(false); }}
                        title={c}
                        style={{
                          width: 20, height: 20, borderRadius: "50%", background: c, cursor: "pointer",
                          border: c === drawColor && tool === "pen" ? "2px solid var(--txt)" : "1px solid var(--line)", padding: 0,
                        }}
                      />
                    ))}
                  </div>
                )}
              </span>

              <button
                className={"btn ghost sm" + (tool === "text" ? " on" : "")}
                onClick={() => setTool((t) => (t === "text" ? "select" : "text"))}
                title="Text — click anywhere on the page to type a note"
              >
                <TypeIcon size={14} /> Text
              </button>

              {/* Shapes — split button: main half toggles the last-picked
                  shape (rectangle or circle), chevron half lets you choose
                  which one. */}
              <span style={splitWrapStyle}>
                <button
                  className={"btn ghost sm" + (tool === "rect" || tool === "circle" ? " on" : "")}
                  onClick={() => setTool((t) => (t === "rect" || t === "circle" ? "select" : shapeKind))}
                  title={`Shapes — drag to draw a ${shapeKind === "circle" ? "circle" : "rectangle"}, sized by the drag`}
                  style={splitMainStyle}
                >
                  {shapeKind === "circle" ? <CircleShape size={14} /> : <Square size={14} />} Shapes
                </button>
                <button
                  className={"btn ghost sm" + (tool === "rect" || tool === "circle" ? " on" : "")}
                  onClick={() => { setShapeMenuOpen((v) => !v); setPenMenuOpen(false); }}
                  title="Choose shape"
                  style={splitChevronStyle}
                >
                  <ChevronDown size={11} />
                </button>
                {shapeMenuOpen && (
                  <div style={{ ...colorMenuStyle, flexDirection: "column", gap: 2, padding: 4 }} onMouseLeave={() => setShapeMenuOpen(false)}>
                    <button
                      className={"btn ghost sm" + (tool === "rect" ? " on" : "")}
                      style={{ justifyContent: "flex-start" }}
                      onClick={() => { setShapeKind("rect"); setTool("rect"); setShapeMenuOpen(false); }}
                    >
                      <Square size={13} /> Rectangle
                    </button>
                    <button
                      className={"btn ghost sm" + (tool === "circle" ? " on" : "")}
                      style={{ justifyContent: "flex-start" }}
                      onClick={() => { setShapeKind("circle"); setTool("circle"); setShapeMenuOpen(false); }}
                    >
                      <CircleShape size={13} /> Circle
                    </button>
                  </div>
                )}
              </span>

              <button
                className={"btn ghost sm" + (tool === "eraser" ? " on" : "")}
                onClick={() => setTool((t) => (t === "eraser" ? "select" : "eraser"))}
                title="Eraser — click or drag over a pen mark, shape, or text box to remove it"
              >
                <Eraser size={14} /> Eraser
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

                {/* Freehand pen marks — saved strokes plus the one currently
                    being drawn. Pointer-events are only "auto" while a draw
                    tool is active, so normal text selection/scrolling is
                    completely unaffected the rest of the time. */}
                <svg
                  style={{
                    position: "absolute", inset: 0, width: "100%", height: "100%",
                    zIndex: 6, pointerEvents: tool === "select" ? "none" : "auto",
                    cursor:
                      tool === "pen" ? penCursor(drawColor)
                      : tool === "eraser" ? "cell"
                      : tool === "text" ? "text"
                      : tool === "rect" || tool === "circle" ? "crosshair"
                      : "default",
                    touchAction: "none",
                  }}
                  onPointerDown={handleDrawPointerDown}
                  onPointerMove={handleDrawPointerMove}
                  onPointerUp={handleDrawPointerUp}
                  onPointerLeave={handleDrawPointerUp}
                >
                  {drawings.map((a) => (
                    <polyline
                      key={a.id}
                      points={a.rects[0].path.map(([x, y]) => `${x * scale},${y * scale}`).join(" ")}
                      fill="none"
                      stroke={a.color || PEN_COLORS[0]}
                      strokeWidth={PEN_WIDTH * scale}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                  {stroke && stroke.length > 1 && (
                    <polyline
                      points={stroke.map((p) => `${p.x * scale},${p.y * scale}`).join(" ")}
                      fill="none"
                      stroke={drawColor}
                      strokeWidth={PEN_WIDTH * scale}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.85}
                    />
                  )}
                  {shapes.map((a) => {
                    const r = a.rects[0];
                    const props = {
                      fill: "none", stroke: a.color || PEN_COLORS[0], strokeWidth: PEN_WIDTH * scale,
                    };
                    return r.shape === "circle" ? (
                      <ellipse key={a.id} cx={(r.x + r.w / 2) * scale} cy={(r.y + r.h / 2) * scale}
                        rx={(r.w / 2) * scale} ry={(r.h / 2) * scale} {...props} />
                    ) : (
                      <rect key={a.id} x={r.x * scale} y={r.y * scale} width={r.w * scale} height={r.h * scale} {...props} />
                    );
                  })}
                  {shapePreview && (() => {
                    const x = Math.min(shapePreview.x, shapePreview.x + shapePreview.w);
                    const y = Math.min(shapePreview.y, shapePreview.y + shapePreview.h);
                    const w = Math.abs(shapePreview.w), h = Math.abs(shapePreview.h);
                    const props = { fill: "none", stroke: drawColor, strokeWidth: PEN_WIDTH * scale, opacity: 0.85, strokeDasharray: "5 4" };
                    return shapePreview.shape === "circle" ? (
                      <ellipse cx={(x + w / 2) * scale} cy={(y + h / 2) * scale} rx={(w / 2) * scale} ry={(h / 2) * scale} {...props} />
                    ) : (
                      <rect x={x * scale} y={y * scale} width={w * scale} height={h * scale} {...props} />
                    );
                  })()}
                </svg>

                {/* Saved text annotations — draggable in "select" mode. */}
                {texts.map((a) => {
                  const dragged = liveDragPos && liveDragPos.id === a.id;
                  const r = dragged ? { ...a.rects[0], x: liveDragPos.x, y: liveDragPos.y } : a.rects[0];
                  return (
                    <div
                      key={`text-${a.id}`}
                      title={
                        tool === "eraser" ? "Click with the eraser to remove"
                        : tool === "select" ? "Drag to move"
                        : ""
                      }
                      onPointerDown={(e) => startDragText(e, a)}
                      style={{
                        position: "absolute", left: r.x * scale, top: r.y * scale, zIndex: dragged ? 8 : 6,
                        fontSize: 13 * scale, lineHeight: 1.35, color: a.color || PEN_COLORS[0],
                        fontWeight: 600, whiteSpace: "pre-wrap", maxWidth: 260 * scale,
                        pointerEvents: tool === "select" ? "auto" : "none",
                        cursor: tool === "select" ? (dragged ? "grabbing" : "grab") : "default",
                        opacity: dragged ? 0.75 : 1,
                        textShadow: "0 0 3px #fff, 0 0 6px #fff", touchAction: "none",
                      }}
                    >
                      {r.text}
                    </div>
                  );
                })}

                {textDraft && (
                  <TextComposer
                    draft={textDraft}
                    scale={scale}
                    color={drawColor}
                    onChange={(value) => setTextDraft((d) => ({ ...d, value }))}
                    onSave={() => { saveText(textDraft.x, textDraft.y, textDraft.value); setTextDraft(null); }}
                    onCancel={() => setTextDraft(null)}
                  />
                )}

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

/* ── Inline text-annotation composer (Text tool) ─────────────────────── */
function TextComposer({ draft, scale, color, onChange, onSave, onCancel }) {
  return (
    <div
      style={{
        position: "absolute", left: draft.x * scale, top: draft.y * scale, zIndex: 20,
        background: "var(--card, #fff)", borderRadius: 8, padding: 6,
        boxShadow: "0 10px 30px rgba(0,0,0,.3)", border: `1px solid ${color}`,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        autoFocus
        value={draft.value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type a note…"
        rows={2}
        style={{
          width: 180, resize: "vertical", fontSize: 13, fontWeight: 600, color,
          fontFamily: "'Space Grotesk',sans-serif", border: "none", outline: "none", padding: 2,
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (draft.value.trim()) onSave(); }
          if (e.key === "Escape") onCancel();
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="btn sm" disabled={!draft.value.trim()} onClick={onSave}>Add</button>
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
  const KIND_LABEL = {
    highlight: "Highlight", underline: "Underline", comment: "Comment",
    drawing: "Pen mark", text: "Text note", shape: "Shape",
  };
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
          Select text to highlight, underline, or comment — or use Pen, Text, Rectangle, or Circle above to mark up the page directly.
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
            {a.kind === "drawing" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 22, height: 3, borderRadius: 2, background: a.color || PEN_COLORS[0] }} />
                <span className="muted tiny">freehand mark</span>
              </div>
            )}
            {a.kind === "shape" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  width: 14, height: 14, border: `2px solid ${a.color || PEN_COLORS[0]}`,
                  borderRadius: a.rects[0]?.shape === "circle" ? "50%" : 3,
                }} />
                <span className="muted tiny">{a.rects[0]?.shape === "circle" ? "circle" : "rectangle"}</span>
              </div>
            )}
            {a.kind === "text" && (
              <div style={{ fontSize: 12.5, lineHeight: 1.4, fontWeight: 600, color: a.color || PEN_COLORS[0] }}>
                {a.rects[0]?.text}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Split-button pieces (Pen + color chevron, Shapes + kind chevron).
const splitWrapStyle = { position: "relative", display: "flex", gap: 1 };
const splitMainStyle = { borderTopRightRadius: 0, borderBottomRightRadius: 0 };
const splitChevronStyle = { padding: "8px 6px", borderTopLeftRadius: 0, borderBottomLeftRadius: 0 };
const colorMenuStyle = {
  position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30,
  display: "flex", gap: 6, background: "#fff", border: "1px solid var(--line)",
  borderRadius: 8, padding: 6, boxShadow: "0 8px 22px rgba(0,0,0,.18)",
};

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

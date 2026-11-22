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
import PaperChatPanel from "./PaperChatPanel.jsx";
import { ArrowLeft, MessageSquare, Sparkles, X, Trash2, PenTool, Eraser, TypeIcon, Square, CircleShape, ChevronDown, ZoomIn, ZoomOut, MousePointer } from "./icons.jsx";

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

// The paper chat lives in a resizable column on the right of the reader, so
// you can read, mark up and ask questions side by side.
const CHAT_W_KEY = "sift-reader-chat-w";
function savedChatW() {
  try { const v = parseInt(localStorage.getItem(CHAT_W_KEY), 10); return v >= 300 && v <= 900 ? v : 420; }
  catch { return 420; }
}

export default function PdfViewer({ runId, paper, onClose, extraction, cite, apiKey, model, initialChat = false }) {
  // Pages are laid out top to bottom in one scrolling column. pageEls maps a
  // page number to its element; drawPageRef is the page a pen/shape/text/
  // eraser gesture started on.
  const pageEls = useRef({});
  const scrollRef = useRef(null);
  const drawPageRef = useRef(1);
  const [sizes, setSizes] = useState([]);   // [{w,h}] per page at scale 1

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
  const [showChat, setShowChat] = useState(initialChat);
  const [chatW, setChatW] = useState(savedChatW);
  const [chatSeed, setChatSeed] = useState(null);   // {text, n}: selected passage to ask about

  function startChatResize(e) {
    e.preventDefault();
    const s = { mx: e.clientX, w: chatW };
    let last = chatW;
    const move = (ev) => {
      last = Math.max(300, Math.min(900, Math.min(window.innerWidth - 420, s.w - (ev.clientX - s.mx))));
      setChatW(last);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      try { localStorage.setItem(CHAT_W_KEY, String(last)); } catch { /* ignore */ }
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ── Pen / eraser / text / shapes ────────────────────────────────────
  const [tool, setTool] = useState("select");   // select | pen | eraser | text | rect | circle
  const [drawColor, setDrawColor] = useState(PEN_COLORS[0]);   // shared by pen, text & shapes
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
    setSizes([]);
    setPage(1);
    setNumPages(0);
    (async () => {
      try {
        const bytes = await api.getPaperPdf(runId, paper.idx);
        if (cancelled) return;
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        const sz = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const v = (await pdf.getPage(i)).getViewport({ scale: 1 });
          if (cancelled) return;
          sz.push({ w: v.width, h: v.height });
        }
        setSizes(sz);
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

  // ── Scrolling: keep the page counter in step, and jump on request ─────
  function goToPage(n) {
    const target = Math.max(1, Math.min(numPages || 1, n));
    setPage(target);
    const el = pageEls.current[target], box = scrollRef.current;
    if (el && box) box.scrollTo({ top: el.offsetTop - 12 });
  }

  function onBodyScroll() {
    const box = scrollRef.current;
    if (!box) return;
    const line = box.scrollTop + box.clientHeight * 0.35;
    let cur = 1;
    for (const [pn, el] of Object.entries(pageEls.current)) {
      if (el && el.offsetTop <= line) cur = Math.max(cur, Number(pn));
    }
    setPage((p) => (p === cur ? p : cur));
  }

  // Zooming changes every page's height: stay on the page you were reading.
  useEffect(() => {
    requestAnimationFrame(() => goToPage(page));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

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
    mouseDownPtRef.current = e.target?.closest?.("[data-pn]")
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
    let range = sel.getRangeAt(0);
    const anc = range.commonAncestorContainer;
    // One page at a time: a selection that spans two pages has no single page to sit on.
    const wrap = (anc.nodeType === 1 ? anc : anc.parentElement)?.closest?.("[data-pn]");
    if (!wrap) return;
    const pn = Number(wrap.dataset.pn);

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
      rectsAtScale, text: range.toString(), pn,
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
        kind, page: source.pn, rects: rectsUnscaled,
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
        kind: "drawing", page: drawPageRef.current, rects: [{ path: points.map((p) => [p.x, p.y]) }],
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
        kind: "shape", page: drawPageRef.current, rects: [norm], color: drawColor,
      });
      setAnnotations((prev) => [...prev, ann]);
      undoStackRef.current.push(ann.id);
    } catch (e) {
      setAnnErr(e.message);
    }
  }

  async function saveText(x, y, text, pn) {
    if (!text.trim()) return;
    setAnnErr(null);
    try {
      const ann = await api.addAnnotation(runId, paper.idx, {
        kind: "text", page: pn, rects: [{ x, y, text: text.trim() }], color: drawColor,
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

  const annsOn = (pn) => annotations.filter((a) => a.page === pn);
  const isDrawing = (a) => a.kind === "drawing" && a.rects[0]?.path;
  const isShape = (a) => a.kind === "shape" && a.rects[0];
  const isText = (a) => a.kind === "text" && a.rects[0];

  // Client (viewport) coords -> page-local, unscaled (scale=1) coords —
  // same space every other annotation kind's rects are stored in, so
  // drawings redraw correctly at any zoom level too.
  function toPagePoint(e, pn = drawPageRef.current) {
    const wrap = pageEls.current[pn];
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
    const p = toPagePoint(e, ann.page);
    const r = ann.rects[0];
    setDraggingText({ id: ann.id, page: ann.page, dx: p.x - r.x, dy: p.y - r.y });
    setLiveDragPos({ id: ann.id, x: r.x, y: r.y });
  }

  useEffect(() => {
    if (!draggingText) return;
    function onMove(e) {
      const p = toPagePoint(e, draggingText.page);
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

  function handleDrawPointerDown(e, pn) {
    drawPageRef.current = pn;
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
      setTextDraft({ x: p.x, y: p.y, value: "", pn });
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
    const on = annsOn(drawPageRef.current);
    const drawings = on.filter(isDrawing), shapes = on.filter(isShape), texts = on.filter(isText);
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
        /* Size each invisible span to its real glyphs. Without these rules
           pdf.js's --font-height / --scale-x never apply, every span takes the
           page's font size, and highlights/underlines land off the text. */
        .pdfv-text-layer-host .textLayer {
          --min-font-size: 1;
          --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
          --min-font-size-inv: calc(1 / var(--min-font-size));
        }
        .pdfv-text-layer-host .textLayer > :not(.markedContent),
        .pdfv-text-layer-host .textLayer .markedContent span:not(.markedContent) {
          z-index: 1;
          --font-height: 0;
          font-size: calc(var(--text-scale-factor) * var(--font-height));
          --scale-x: 1;
          --rotate: 0deg;
          transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
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
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
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
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 1 auto", flexWrap: "wrap", justifyContent: "flex-end", rowGap: 6 }}>
              <button className="btn ghost sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                ‹ Prev
              </button>
              <PageJump page={page} numPages={numPages} onGo={goToPage} />
              <button className="btn ghost sm" disabled={page >= numPages} onClick={() => goToPage(page + 1)}>
                Next ›
              </button>
              <span style={{ width: 1, height: 18, background: "var(--line)" }} />
              {/* Zoom: magnifier buttons, with the current zoom between them
                  (click it to go back to the default size). */}
              <button className="btn ghost sm" title="Zoom out" disabled={scale <= 0.6}
                onClick={() => setScale((s) => Math.max(0.6, +(s - 0.15).toFixed(2)))}>
                <ZoomOut size={15} />
              </button>
              <button className="btn ghost sm" title="Reset zoom" onClick={() => setScale(1.25)}
                style={{ minWidth: 52, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }}>
                {Math.round((scale / 1.25) * 100)}%
              </button>
              <button className="btn ghost sm" title="Zoom in" disabled={scale >= 2.5}
                onClick={() => setScale((s) => Math.min(2.5, +(s + 0.15).toFixed(2)))}>
                <ZoomIn size={15} />
              </button>
              <span style={{ width: 1, height: 18, background: "var(--line)" }} />
              <ToolsMenu tool={tool} setTool={setTool} color={drawColor} setColor={setDrawColor}
                setShapeKind={setShapeKind} />
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
          <button
            className={"btn sm" + (showChat ? "" : " ghost")}
            onClick={() => setShowChat((v) => !v)}
            title={showChat ? "Hide the paper chat" : "Chat with this paper while you read"}
            style={{ flex: "0 0 auto" }}
          >
            <Sparkles size={14} /> {showChat ? "Hide chat" : "Chat"}
          </button>
        </div>

        <div style={{ flex: "1 1 auto", display: "flex", overflow: "hidden" }}>
          <div style={bodyStyle} ref={scrollRef} onScroll={onBodyScroll}>
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
            {!loading && !error && doc && sizes.map((sz, i) => {
              const pn = i + 1;
              const on = annsOn(pn);
              return (
              <PdfPageView
                key={pn} doc={doc} pn={pn} scale={scale} size={sz}
                render={Math.abs(pn - page) <= 2}
                setRef={(el) => { if (el) pageEls.current[pn] = el; else delete pageEls.current[pn]; }}
                under={<>
                {/* Highlight/underline fills sit between the canvas and the
                    (invisible) text layer so they don't intercept new selections. */}
                <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                  {on.filter((a) => a.kind !== "comment").map((a) =>
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
                  {on.filter((a) => a.kind === "comment").map((a) =>
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

                </>}
              >

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
                  onPointerDown={(e) => handleDrawPointerDown(e, pn)}
                  onPointerMove={handleDrawPointerMove}
                  onPointerUp={handleDrawPointerUp}
                  onPointerLeave={handleDrawPointerUp}
                >
                  {on.filter(isDrawing).map((a) => (
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
                  {stroke && drawPageRef.current === pn && stroke.length > 1 && (
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
                  {on.filter(isShape).map((a) => {
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
                  {shapePreview && drawPageRef.current === pn && (() => {
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
                {on.filter(isText).map((a) => {
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

                {textDraft && textDraft.pn === pn && (
                  <TextComposer
                    draft={textDraft}
                    scale={scale}
                    color={drawColor}
                    onChange={(value) => setTextDraft((d) => ({ ...d, value }))}
                    onSave={() => { saveText(textDraft.x, textDraft.y, textDraft.value, pn); setTextDraft(null); }}
                    onCancel={() => setTextDraft(null)}
                  />
                )}

                {/* Clickable comment markers, above the text layer. */}
                {on.filter((a) => a.kind === "comment" && a.rects[0]).map((a) => {
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

                {openComment != null && annotations.find((a) => a.id === openComment)?.page === pn && (
                  <CommentPopup
                    ann={annotations.find((a) => a.id === openComment)}
                    scale={scale}
                    onClose={() => setOpenComment(null)}
                    onDelete={() => removeAnnotation(openComment)}
                  />
                )}

                {toolbar && toolbar.pn === pn && !commentDraft && (
                  <SelectionToolbar
                    toolbar={toolbar}
                    onHighlight={() => saveAnnotation("highlight", toolbar)}
                    onUnderline={() => saveAnnotation("underline", toolbar)}
                    onComment={() => setCommentDraft({ ...toolbar, value: "" })}
                    onAsk={() => {
                      setChatSeed({ text: toolbar.text, n: Date.now() });
                      setShowChat(true);
                      setToolbar(null);
                      window.getSelection()?.removeAllRanges();
                    }}
                    onDismiss={() => setToolbar(null)}
                  />
                )}

                {commentDraft && commentDraft.pn === pn && (
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
              </PdfPageView>
              );
            })}
          </div>

          {showPanel && (
            <AnnotationsPanel
              annotations={annotations}
              currentPage={page}
              onJump={(p) => goToPage(p)}
              onDelete={removeAnnotation}
              onClose={() => setShowPanel(false)}
              err={annErr}
            />
          )}

          {showChat && (
            <>
              <div
                onMouseDown={startChatResize}
                title="Drag to resize"
                style={{ flex: "0 0 6px", cursor: "ew-resize", background: "var(--line)", opacity: 0.7 }}
              />
              <div style={{ flex: `0 0 ${chatW}px`, minWidth: 0, background: "var(--card, #fff)", display: "flex" }}>
                <PaperChatPanel
                  docked runId={runId} paper={paper} extraction={extraction} cite={cite}
                  apiKey={apiKey} model={model} seed={chatSeed}
                  onClose={() => setShowChat(false)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Floating toolbar shown on text selection ────────────────────────── */
function SelectionToolbar({ toolbar, onHighlight, onUnderline, onComment, onAsk, onDismiss }) {
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
      {onAsk && (
        <button style={{ ...toolbarBtn, gap: 4, fontSize: 12, fontWeight: 600 }} title="Ask the chat about this passage" onClick={onAsk}>
          <Sparkles size={13} /> Ask
        </button>
      )}
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

/* ── Tools: one button that drops down Pen, Text, Shapes and Eraser ──────
   The button shows the active tool; "Select text" returns to normal reading
   (select to highlight, underline, comment or ask). */
const TOOL_OPTIONS = [
  ["select", "Select text", MousePointer, "Select text to highlight, underline, comment or ask"],
  ["pen", "Pen", PenTool, "Draw freehand marks on the page"],
  ["text", "Text", TypeIcon, "Click anywhere on the page to type a note"],
  ["rect", "Rectangle", Square, "Drag to draw a rectangle"],
  ["circle", "Circle", CircleShape, "Drag to draw a circle"],
  ["eraser", "Eraser", Eraser, "Click or drag over a pen mark, shape or text note to remove it"],
];

function ToolsMenu({ tool, setTool, color, setColor, setShapeKind }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const cur = TOOL_OPTIONS.find(([k]) => k === tool) || TOOL_OPTIONS[0];
  const CurIc = cur[2];
  const active = tool !== "select";
  const pick = (k) => {
    if (k === "rect" || k === "circle") setShapeKind(k);
    setTool(k);
    setOpen(false);
  };
  return (
    <span ref={ref} style={{ position: "relative" }}>
      <button
        className={"btn ghost sm" + (active ? " on" : "")}
        onClick={() => setOpen((v) => !v)}
        title="Markup tools: pen, text, shapes, eraser"
        aria-haspopup="menu" aria-expanded={open}
      >
        {active ? <CurIc size={14} color={tool === "eraser" ? undefined : color} /> : <PenTool size={14} />}
        {active ? cur[1] : "Tools"}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div role="menu" style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 30, minWidth: 210,
          background: "var(--card, #fff)", border: "1px solid var(--line)", borderRadius: 10,
          boxShadow: "0 10px 28px rgba(0,0,0,.18)", padding: 6,
        }}>
          {TOOL_OPTIONS.map(([k, label, Icon, tip]) => (
            <button key={k} role="menuitemradio" aria-checked={tool === k} title={tip}
              onClick={() => pick(k)}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                padding: "7px 10px", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 13,
                background: tool === k ? "var(--indigo-soft)" : "transparent",
                color: "var(--txt)", fontWeight: tool === k ? 600 : 400,
              }}>
              <Icon size={15} color={k === "select" || k === "eraser" ? undefined : color} />
              <span style={{ flex: 1 }}>{label}</span>
              {tool === k && <span style={{ color: "var(--indigo)" }}>✓</span>}
            </button>
          ))}
          <div style={{ borderTop: "1px solid var(--line)", margin: "6px 4px 0", padding: "8px 6px 2px",
            display: "flex", alignItems: "center", gap: 8 }}>
            <span className="muted tiny" style={{ flex: 1 }}>Ink colour</span>
            {PEN_COLORS.map((c) => (
              <button key={c} title={c} onClick={() => setColor(c)}
                style={{
                  width: 18, height: 18, borderRadius: "50%", background: c, cursor: "pointer", padding: 0,
                  border: c === color ? "2px solid var(--txt)" : "1px solid var(--line)",
                }} />
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

/* ── One page of the scrolling column ────────────────────────────────────
   Every page keeps its full size so the scroll bar and jumps are right, but
   only pages near the one being read are drawn (canvas + selectable text);
   the rest are blank placeholders until you scroll to them. */
function PdfPageView({ doc, pn, scale, size, render, setRef, under, children }) {
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const taskRef = useRef(null);

  useEffect(() => {
    if (!render || !doc) return;
    let cancelled = false;
    (async () => {
      const pdfPage = await doc.getPage(pn);
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      if (canvas) {
        // Render the backing store at >= 2x and pin the CSS size, so text is
        // crisp on ordinary and HiDPI screens alike.
        const outputScale = Math.max(2, window.devicePixelRatio || 1);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        try { taskRef.current?.cancel(); } catch (e) { /* already done */ }
        const task = pdfPage.render({
          canvasContext: canvas.getContext("2d"), viewport,
          transform: [outputScale, 0, 0, outputScale, 0, 0],
        });
        taskRef.current = task;
        try { await task.promise; } catch (e) { /* superseded by a newer render */ }
      }
      if (cancelled) return;
      const container = textRef.current;
      if (container) {
        container.innerHTML = "";
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
        try {
          const textLayer = new TextLayerBuilder({ pdfPage });
          // Must match the canvas scale, or selections drift off the glyphs.
          textLayer.div.style.setProperty("--total-scale-factor", String(scale));
          container.appendChild(textLayer.div);
          await textLayer.render({ viewport });
        } catch (e) {
          /* text layer is a selection nicety -- a failure here shouldn't block reading */
        }
      }
    })();
    return () => {
      cancelled = true;
      try { taskRef.current?.cancel(); } catch (e) { /* ignore */ }
    };
  }, [doc, pn, scale, render]);

  return (
    <div
      ref={setRef}
      data-pn={pn}
      style={{
        position: "relative", flex: "0 0 auto", marginBottom: 18,
        width: size.w * scale, height: size.h * scale,
        background: "#fff", boxShadow: "0 4px 20px rgba(0,0,0,.15)",
      }}
    >
      {render && <canvas ref={canvasRef} style={{ display: "block" }} />}
      {under}
      {render && <div ref={textRef} className="pdfv-text-layer-host" style={{ position: "absolute", inset: 0 }} />}
      {!render && (
        <div className="muted tiny" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          Page {pn}
        </div>
      )}
      {children}
    </div>
  );
}

/* ── "Page [ 3 ] / 15": type a number and press Enter to jump there ───── */
function PageJump({ page, numPages, onGo }) {
  const [val, setVal] = useState(String(page));
  useEffect(() => { setVal(String(page)); }, [page]);
  function go() {
    const n = parseInt(val, 10);
    if (Number.isFinite(n)) onGo(Math.min(numPages, Math.max(1, n)));
    else setVal(String(page));
  }
  return (
    <span className="muted tiny" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "'JetBrains Mono', monospace" }}>
      Page
      <input
        value={val}
        inputMode="numeric"
        aria-label="Go to page"
        title="Type a page number and press Enter"
        onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") { go(); e.currentTarget.blur(); }
          if (e.key === "Escape") { setVal(String(page)); e.currentTarget.blur(); }
        }}
        onBlur={go}
        onFocus={(e) => e.currentTarget.select()}
        style={{
          width: `${Math.max(2, String(numPages).length) + 1.6}ch`, textAlign: "center",
          font: "inherit", color: "var(--txt)", padding: "3px 4px",
          border: "1px solid var(--line)", borderRadius: 6, background: "var(--card, #fff)",
        }}
      />
      / {numPages}
    </span>
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
  display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", rowGap: 8,
  padding: "12px 18px", borderBottom: "1px solid var(--line)",
  background: "var(--card, #fff)", flex: "0 0 auto",
};

const bodyStyle = {
  flex: "1 1 auto", overflow: "auto", position: "relative",
  display: "flex", flexDirection: "column", alignItems: "safe center",
  padding: 24, background: "var(--panel2, #eef0f4)",
};

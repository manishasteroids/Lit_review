import React, { useState, useCallback, useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api } from "../api/client.js";
import {
  ArrowLeft, BarChart3, FileText, Trash2, Download, AlertTriangle,
  RotateCw, Check, Maximize, ExternalLink, X, Clock, Sigma,
} from "./icons.jsx";

/**
 * Data Analysis Agent — Phase 1a: upload a CSV/XLSX, pick columns and a
 * chart type by hand, render. No LLM calls anywhere in this view (see
 * data_analysis_agent_architecture.md SS2/SS11) — the Planner-assisted
 * "suggest what to plot" path is Phase 1b, a later addition on top of the
 * same upload/profile/render flow, not a replacement for this screen.
 *
 * Standalone by default (no projectId required) — the `which` prop just
 * controls the page label; the tool works identically either way per
 * SS9.1 decision 3.
 */

const CHART_TYPES = [
  { value: "scatter", label: "Scatter" },
  { value: "line", label: "Line" },
  { value: "bar", label: "Bar" },
  { value: "box", label: "Box" },
  { value: "histogram", label: "Histogram" },
  { value: "heatmap", label: "Correlation heatmap" },
];

const AGGS = ["mean", "sum", "count", "median"];

// Axis zoom range lives on the spec itself (core/plot_models.py's PlotSpec)
// so "zoom" here means a fresh full-resolution render cropped to that data
// range, not a magnified image — kept as strings in form state, parsed to
// numbers (or dropped, if blank) right before a render call.
const DEFAULT_SPEC = {
  chart_type: "scatter", x: "", y: "", group: "", agg: "mean", title: "",
  x_min: "", x_max: "", y_min: "", y_max: "",
};

const panelStyle = {
  background: "var(--panel2, #f7f7fb)",
  border: "1px solid var(--line, #e3e4ea)",
  borderRadius: 10,
  padding: 16,
};

const labelStyle = {
  fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
  color: "var(--muted, #5b6472)", marginBottom: 6, display: "block",
};

const selectStyle = {
  width: "100%", padding: "7px 10px", borderRadius: 7, border: "1px solid var(--line, #e3e4ea)",
  fontSize: 13, fontFamily: "inherit", background: "var(--bg, #fff)", color: "var(--txt, #1a1d24)",
};

const iconBtnStyle = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
  background: "var(--bg, #fff)", border: "1px solid var(--line, #e3e4ea)", borderRadius: 6,
  padding: "5px 8px", fontSize: 11.5, fontWeight: 600, color: "var(--muted, #5b6472)",
  cursor: "pointer", fontFamily: "inherit",
};

const statCellStyle = { padding: "6px 10px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

// Trims a stats value to 3 significant-ish decimals without trailing zeros;
// null/undefined (missing/too-few-samples fields, e.g. skew on <3 values)
// renders as an em dash rather than "null" or "NaN".
function fmtStat(v) {
  if (v == null) return "—";
  if (Number.isInteger(v)) return v.toLocaleString();
  return Number(v.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function Chip({ children, tone = "default" }) {
  const colors = {
    default: { bg: "var(--panel2, #f3f4f8)", fg: "var(--muted, #5b6472)" },
    numeric: { bg: "#eef2ff", fg: "#4338ca" },
    categorical: { bg: "#fef3e8", fg: "#c2650a" },
    timeseries: { bg: "#e8f7f0", fg: "#0a8a55" },
    tabular: { bg: "#eef2ff", fg: "#4338ca" },
  }[tone] || {};
  return (
    <span style={{
      display: "inline-block", fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5,
      fontWeight: 600, background: colors.bg, color: colors.fg, borderRadius: 5,
      padding: "2px 7px", marginRight: 6, marginBottom: 4,
    }}>
      {children}
    </span>
  );
}

// Full-screen zoom lightbox for a single figure. Opened by clicking any
// figure thumbnail in the gallery; closes on backdrop click, the X button,
// or Escape.
function ZoomModal({ figure, seriesEntry, onClose, onOpenNewWindow, onRefine, onDelete, onDownloadScript }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!figure) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(15, 17, 24, 0.82)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 32,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg, #fff)", borderRadius: 10, padding: 16, maxWidth: "94vw",
          maxHeight: "94vh", display: "flex", flexDirection: "column", gap: 10,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            {figure.spec?.title || `${figure.spec?.chart_type} · ${[figure.spec?.x, figure.spec?.y].filter(Boolean).join(" vs ")}`}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={iconBtnStyle} onClick={() => onRefine(figure)}
                    title="Load this into the form to set an axis zoom range and re-render">
              Refine / zoom range
            </button>
            <button type="button" style={iconBtnStyle} onClick={() => onOpenNewWindow(figure)}>
              <ExternalLink size={12} /> Open in new window
            </button>
            <button type="button" style={iconBtnStyle} onClick={() => onDownloadScript(figure)}
                    title="Download a standalone matplotlib script that reproduces this figure">
              <Download size={12} /> matplotlib script
            </button>
            <button type="button" style={iconBtnStyle} onClick={() => onDelete(figure)}>
              <Trash2 size={12} /> Delete
            </button>
            <button type="button" style={iconBtnStyle} onClick={onClose}>
              <X size={12} /> Close
            </button>
          </div>
        </div>
        <div style={{ overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {seriesEntry?.status === "ready" ? (
            <div style={{ width: "min(86vw, 900px)" }}>
              <InteractiveSeriesChart
                xLabel={seriesEntry.data.x_label}
                x={seriesEntry.data.x}
                series={seriesEntry.data.series}
                chartType={figure.spec?.chart_type}
                height={520}
                initialXRange={figure.spec?.x_min != null && figure.spec?.x_max != null
                  ? [figure.spec.x_min, figure.spec.x_max] : null}
                initialYRange={figure.spec?.y_min != null && figure.spec?.y_max != null
                  ? [figure.spec.y_min, figure.spec.y_max] : null}
              />
            </div>
          ) : (
            <img
              src={figure.url} alt="Rendered figure (zoomed)"
              style={{ maxWidth: "90vw", maxHeight: "80vh", borderRadius: 6, objectFit: "contain" }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Lets the researcher decide whether this analysis belongs to a project or
// stands alone, independent of whatever project the rest of the app is
// currently "inside" — changeable at any time, before or after upload.
// Only these chart types map cleanly onto a real numeric x/y pair uPlot
// can draw and drag-zoom — bar/box/histogram/heatmap stay static images,
// and a grouped figure needs per-group series the /series endpoint
// doesn't split out (yet), so it stays static too.
function isInteractiveEligible(spec) {
  return !!spec && ["scatter", "line"].includes(spec.chart_type) && !spec.group;
}

function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function ProjectLinkControl({ value, onChange, projects, disabled, busy, error }) {
  return (
    <div>
      <label style={labelStyle}>Project</label>
      <select
        style={selectStyle} value={value || ""} disabled={disabled || busy}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Standalone (not linked to a project)</option>
        {(projects || []).map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {error && (
        <div style={{ marginTop: 6, color: "#c0392b", fontSize: 11.5, display: "flex",
                      alignItems: "center", gap: 5 }}>
          <AlertTriangle size={11} /> {error}
        </div>
      )}
    </div>
  );
}

// Which kind of analysis to run — picked up front, in the sidebar, so it's
// decided before (or independent of) uploading a dataset, not just a tab
// that only appears afterward. "plot" shows the chart builder + interactive
// view + figure gallery; "stats" shows the descriptive-stats table. Upload
// itself is the same either way — this only decides what to land on once
// the dataset is in.
const ANALYSIS_MODES = [
  ["plot", BarChart3, "2D Plot", "Chart builder, interactive view, and figure gallery"],
  ["stats", Sigma, "Statistics", "Descriptive stats for every column"],
];

function AnalysisModePicker({ value, onChange }) {
  return (
    <div style={panelStyle}>
      <div style={labelStyle}>Analysis type</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ANALYSIS_MODES.map(([key, Icon, label, desc]) => {
          const active = value === key;
          return (
            <button
              key={key} type="button" onClick={() => onChange(key)}
              style={{
                display: "flex", alignItems: "flex-start", gap: 9, textAlign: "left",
                border: `1px solid ${active ? "var(--indigo, #6d5df6)" : "var(--line, #e3e4ea)"}`,
                borderRadius: 8, padding: "9px 10px", cursor: "pointer", fontFamily: "inherit",
                background: active ? "#eef2ff" : "var(--bg, #fff)",
              }}
            >
              <Icon
                size={14}
                style={{ marginTop: 1, flexShrink: 0, color: active ? "var(--indigo, #6d5df6)" : "var(--muted, #5b6472)" }}
              />
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: active ? "var(--indigo, #6d5df6)" : "var(--txt, #1a1d24)" }}>
                  {label}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted, #5b6472)", marginTop: 1 }}>{desc}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const SERIES_PALETTE = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#000000"];

function minMax(arrays) {
  let lo = Infinity, hi = -Infinity;
  for (const arr of arrays) {
    for (const v of arr) {
      if (v == null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : [0, 1];
}

// One interactive, real-data chart the researcher can pan/zoom/overlay
// columns in directly — this is the alternative to re-rendering a fresh
// static image every time they want a closer look. uPlot's own
// click-drag box selection rescales the view; the reset button restores
// the full data range. Purely an exploration aid: the downloadable
// publication figure still comes from the deterministic matplotlib
// render (pipeline/plot_renderer.py), not from this canvas.
function InteractiveSeriesChart({
  xLabel, x, series, height = 380, chartType = "line",
  initialXRange = null, initialYRange = null, compact = false,
}) {
  const containerRef = useRef(null);
  const plotRef = useRef(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(Math.max(160, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!containerRef.current || !x?.length || !series?.length) return undefined;
    const data = [x, ...series.map((s) => s.y)];
    const isScatter = chartType === "scatter";
    const opts = {
      width, height,
      scales: { x: { time: false } },
      axes: compact ? [{ show: false }, { show: false }] : [
        { label: xLabel, stroke: "var(--muted, #5b6472)", grid: { stroke: "#e3e4ea", width: 1 } },
        { label: series.length === 1 ? series[0].name : "value", stroke: "var(--muted, #5b6472)",
          grid: { stroke: "#e3e4ea", width: 1 } },
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.name, stroke: SERIES_PALETTE[i % SERIES_PALETTE.length],
          width: isScatter ? 0 : 1.4,
          points: { show: isScatter, size: 4, fill: SERIES_PALETTE[i % SERIES_PALETTE.length] },
        })),
      ],
      cursor: { drag: { x: true, y: true } },
      legend: { show: !compact && series.length > 1 },
    };
    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data, containerRef.current);
    if (initialXRange) plotRef.current.setScale("x", { min: initialXRange[0], max: initialXRange[1] });
    if (initialYRange) plotRef.current.setScale("y", { min: initialYRange[0], max: initialYRange[1] });
    return () => { plotRef.current?.destroy(); plotRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, series, width, height, xLabel, chartType, compact]);

  const resetZoom = () => {
    const u = plotRef.current;
    if (!u || !x?.length) return;
    const [xMin, xMax] = minMax([x]);
    const [yMin, yMax] = minMax(series.map((s) => s.y));
    u.setScale("x", { min: xMin, max: xMax });
    u.setScale("y", { min: yMin, max: yMax });
  };

  return (
    <div>
      <div ref={containerRef} style={{ width: "100%" }} />
      {!compact && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "var(--muted, #5b6472)" }}>
            Drag to zoom into a region · use Reset to zoom back out
          </div>
          <button type="button" style={iconBtnStyle} onClick={resetZoom}>Reset zoom</button>
        </div>
      )}
    </div>
  );
}

export default function DataAnalysisAgentView({ which, projectId, projects, onBack }) {
  const label = which === "timeseries" ? "Time Series Analysis" : "Data Visualization";

  const [run, setRun] = useState(null);          // {run_id, filename, profile, metadata}
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  // Which project (if any) this analysis is filed under. Standalone by
  // default (data_analysis_agent_architecture.md SS9.1 decision 3) — this
  // only pre-fills from whichever project the app happens to be "inside"
  // right now, it never forces linking. The researcher can change it here
  // at any time, before or after uploading, independent of the app's
  // current project context.
  const [linkedProjectId, setLinkedProjectId] = useState(projectId || "");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState(null);

  const [spec, setSpec] = useState({ ...DEFAULT_SPEC });
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState(null);
  const [figures, setFigures] = useState([]);          // this run's rendered figures, newest first
  const [zoomFigure, setZoomFigure] = useState(null);  // figure shown in the lightbox, or null
  // When set (via "Refine"), the next Render updates THIS figure in place
  // — same gallery slot, old PNG/SVG replaced — instead of appending a new
  // card, so tweaking the zoom range doesn't pile up separate images.
  const [refiningFigure, setRefiningFigure] = useState(null);
  const fileInputRef = useRef(null);
  const formRef = useRef(null);

  // Per-figure real data for the drag-zoomable on-screen chart, keyed by
  // svgFilename: {status: "loading"|"ready"|"error"|"unsupported", data?}.
  // Fetched lazily once per figure and reused between the gallery card and
  // the zoom modal — the static PNG/SVG stays what's downloaded, this is
  // only how it's *shown* while exploring.
  const [seriesCache, setSeriesCache] = useState({});
  const requestedSeriesRef = useRef(new Set());

  useEffect(() => {
    figures.forEach((f) => {
      const key = f.svgFilename;
      if (!key || requestedSeriesRef.current.has(key)) return;
      requestedSeriesRef.current.add(key);
      if (!isInteractiveEligible(f.spec)) {
        setSeriesCache((c) => ({ ...c, [key]: { status: "unsupported" } }));
        return;
      }
      setSeriesCache((c) => ({ ...c, [key]: { status: "loading" } }));
      api.getDataAnalysisSeries(f.runId, f.spec.x || undefined, [f.spec.y])
        .then((data) => setSeriesCache((c) => ({ ...c, [key]: { status: "ready", data } })))
        .catch(() => setSeriesCache((c) => ({ ...c, [key]: { status: "error" } })));
    });
  }, [figures]);

  // ── Interactive view: pan/zoom/overlay real data in one live chart,
  // instead of re-rendering a fresh static image for every closer look
  // or every extra column to compare. Independent of the static-render
  // `spec` above — this never touches the publication PNG/SVG pipeline.
  const [showInteractive, setShowInteractive] = useState(false);
  const [interactiveX, setInteractiveX] = useState("");
  const [interactiveYs, setInteractiveYs] = useState([]);
  const [seriesData, setSeriesData] = useState(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState(null);

  // ── Analysis type: which top-level view the right-hand panel shows —
  // "plot" (chart builder + interactive view + figure gallery) or "stats"
  // (descriptive-stats table). Picking one is the explicit ask that
  // triggers computation; nothing runs on the uploaded data until the
  // researcher chooses what kind of analysis they want.
  const [analysisMode, setAnalysisMode] = useState("plot");

  // Per-column descriptive stats (mean/median/std/quartiles/skew for
  // numeric columns, top values for categorical ones) for the whole
  // dataset — fetched once, the first time "Statistics" mode is opened,
  // and cached until the run changes. See core/stats_analysis.py /
  // GET .../stats.
  const [statsData, setStatsData] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState(null);

  // Revoke object URLs on unmount / replacement so we don't leak blobs.
  const urlsRef = useRef([]);
  const track = (url) => { urlsRef.current.push(url); return url; };
  useEffect(() => () => { urlsRef.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  // ── History: every upload is already persisted server-side (its profile
  // and every rendered figure live in `data_analysis_runs`) — this just
  // surfaces that so leaving the page and coming back doesn't lose the
  // work. See core/data_analysis_db.py / GET /api/data-analysis/runs.
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [resumingId, setResumingId] = useState(null);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const rows = await api.listDataAnalysisRuns();
      setHistory(rows || []);
    } catch (e) {
      setHistoryError(e.message || "Could not load past analyses");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const handleResume = useCallback(async (summary) => {
    setResumingId(summary.id);
    setHistoryError(null);
    try {
      const full = await api.getDataAnalysisRun(summary.id);
      const storedFigures = full.data.figures || [];
      // Oldest-first in storage (each render appends); flip to newest-first
      // to match how a fresh session builds up `figures` here.
      const withUrls = await Promise.all(storedFigures.map(async (fig) => {
        const pngName = fig.png_path.split("/").pop();
        const svgFilename = fig.svg_path.split("/").pop();
        const url = track(await api.getFigureUrl(full.id, pngName));
        return { ...fig, url, runId: full.id, svgFilename };
      }));
      setRun({
        run_id: full.id, filename: full.filename, project_id: full.project_id,
        profile: full.data.profile, metadata: full.data.metadata || {},
      });
      setLinkedProjectId(full.project_id || "");
      setFigures(withUrls.reverse());
      setZoomFigure(null);
      setRefiningFigure(null);
      setShowHistory(false);
      const nums = (full.data.profile?.columns || []).filter((c) => c.dtype === "numeric");
      setInteractiveX(nums[0]?.name || "");
      setInteractiveYs(nums[1] ? [nums[1].name] : (nums[0] ? [nums[0].name] : []));
      setSeriesData(null);
      setSeriesError(null);
      setSeriesCache({});
      requestedSeriesRef.current = new Set();
      setStatsData(null);
      setStatsError(null);
    } catch (e) {
      setHistoryError(e.message || "Could not reopen this analysis");
    } finally {
      setResumingId(null);
    }
  }, []);

  const handleDeleteHistoryRow = useCallback(async (id, e) => {
    e.stopPropagation();
    try {
      await api.deleteDataAnalysisRun(id);
      setHistory((h) => h.filter((r) => r.id !== id));
      if (run?.run_id === id) {
        setRun(null); setFigures([]); setZoomFigure(null); setRefiningFigure(null);
        setSeriesCache({}); requestedSeriesRef.current = new Set();
        setStatsData(null); setStatsError(null);
      }
    } catch (e2) {
      setHistoryError(e2.message || "Could not delete this analysis");
    }
  }, [run]);

  const columns = run?.profile?.columns || [];
  const numericColumns = columns.filter((c) => c.dtype === "numeric");
  const categoricalColumns = columns.filter((c) => c.dtype === "categorical");
  const metadataEntries = run?.metadata ? Object.entries(run.metadata) : [];

  const handleUpload = useCallback(async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const res = await api.uploadDataset(file, linkedProjectId || undefined);
      setRun(res);
      setFigures([]);
      setZoomFigure(null);
      setRefiningFigure(null);
      refreshHistory();
      // Default the picker to the first two numeric columns so a
      // researcher who just wants "plot column A vs column B" can hit
      // Render immediately without hunting through dropdowns.
      const nums = (res.profile.columns || []).filter((c) => c.dtype === "numeric");
      setSpec({
        ...DEFAULT_SPEC,
        x: nums[0]?.name || "",
        y: nums[1]?.name || nums[0]?.name || "",
        chart_type: res.profile.kind === "timeseries" ? "line" : "scatter",
      });
      setInteractiveX(nums[0]?.name || "");
      setInteractiveYs(nums[1] ? [nums[1].name] : (nums[0] ? [nums[0].name] : []));
      setSeriesData(null);
      setSeriesError(null);
      setSeriesCache({});
      requestedSeriesRef.current = new Set();
      setStatsData(null);
      setStatsError(null);
    } catch (e) {
      setUploadError(e.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [linkedProjectId, refreshHistory]);

  // Change which project this run is filed under, including moving an
  // already-uploaded run back to standalone (empty selection). No-op on
  // the pending (pre-upload) selection — that just takes effect at the
  // next upload.
  const handleChangeProjectLink = useCallback(async (newProjectId) => {
    setLinkedProjectId(newProjectId);
    if (!run) return;
    setLinking(true);
    setLinkError(null);
    try {
      const updated = await api.assignDataAnalysisRunProject(run.run_id, newProjectId || null);
      setRun((r) => (r ? { ...r, project_id: updated.project_id } : r));
    } catch (e) {
      setLinkError(e.message || "Could not update project link");
    } finally {
      setLinking(false);
    }
  }, [run]);

  // mode: "new" always appends a fresh card. "update" (only reachable when
  // `refiningFigure` is set, i.e. after clicking Refine) replaces that same
  // card in place — old PNG/SVG deleted server-side — so tweaking a zoom
  // range doesn't pile up a new image every time.
  const handleRender = useCallback(async (mode = "new") => {
    if (!run) return;
    setRendering(true);
    setRenderError(null);
    try {
      const body = { ...spec };
      if (!body.group) delete body.group;
      if (!body.title) delete body.title;
      if (body.chart_type !== "bar") delete body.agg;
      // Zoom range fields are plain strings in form state (so an input can
      // sit empty) — parse to numbers here, or drop the field entirely so
      // an unset side stays auto-scaled (core/plot_models.py's PlotSpec).
      ["x_min", "x_max", "y_min", "y_max"].forEach((k) => {
        const n = body[k] === "" || body[k] === undefined || body[k] === null ? NaN : Number(body[k]);
        if (Number.isNaN(n)) delete body[k]; else body[k] = n;
      });
      const res = await api.renderPlot(run.run_id, body);
      const url = track(await api.getFigureUrl(run.run_id, res.png_url.split("/").pop()));
      const svgFilename = res.svg_url.split("/").pop();
      const newFigure = { ...res.figure, url, runId: run.run_id, svgFilename };

      if (mode === "update" && refiningFigure) {
        const old = refiningFigure;
        setFigures((f) => f.map((x) => (x === old ? newFigure : x)));
        setRefiningFigure(newFigure);
        // Best-effort cleanup of the old render — a stale figure here is
        // harmless (it's just no longer shown), so don't surface a delete
        // failure as a render error.
        api.deleteFigure(old.runId, old.svgFilename).catch(() => {});
      } else {
        setFigures((f) => [newFigure, ...f]);
        setRefiningFigure(null);
      }
      refreshHistory();
    } catch (e) {
      setRenderError(e.message || "Render failed");
    } finally {
      setRendering(false);
    }
  }, [run, spec, refiningFigure, refreshHistory]);

  const toggleInteractiveY = useCallback((name) => {
    setInteractiveYs((ys) => (ys.includes(name) ? ys.filter((y) => y !== name) : [...ys, name]));
  }, []);

  const handleLoadSeries = useCallback(async () => {
    if (!run || interactiveYs.length === 0) return;
    setSeriesLoading(true);
    setSeriesError(null);
    try {
      const data = await api.getDataAnalysisSeries(run.run_id, interactiveX || undefined, interactiveYs);
      setSeriesData(data);
    } catch (e) {
      setSeriesError(e.message || "Could not load data for the interactive view");
    } finally {
      setSeriesLoading(false);
    }
  }, [run, interactiveX, interactiveYs]);

  // Switching into "Statistics" mode is the explicit ask — fetch lazily the
  // first time, then reuse the cached result for the rest of the session
  // (cleared alongside the run at every upload/resume/delete point above).
  useEffect(() => {
    if (analysisMode !== "stats" || !run || statsData || statsLoading) return;
    setStatsLoading(true);
    setStatsError(null);
    api.getDataAnalysisStats(run.run_id)
      .then(setStatsData)
      .catch((e) => setStatsError(e.message || "Could not load statistics"))
      .finally(() => setStatsLoading(false));
  }, [analysisMode, run, statsData, statsLoading]);

  const handleOpenNewWindow = useCallback((figure) => {
    // The URL is a blob: object URL, valid only in this tab's origin/session,
    // but window.open() happily opens it in a brand-new tab/window.
    window.open(figure.url, "_blank", "noopener");
  }, []);

  const handleDownloadSvg = useCallback(async (figure) => {
    try {
      const svgUrl = await api.getFigureUrl(figure.runId, figure.svgFilename);
      const a = document.createElement("a");
      a.href = svgUrl;
      a.download = "figure.svg";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(svgUrl), 4000);
    } catch (e) {
      setRenderError(e.message || "Could not download SVG");
    }
  }, []);

  const handleDownloadScript = useCallback(async (figure) => {
    try {
      const scriptUrl = await api.getFigureScript(figure.runId, figure.svgFilename);
      const a = document.createElement("a");
      a.href = scriptUrl;
      a.download = "figure_script.py";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(scriptUrl), 4000);
    } catch (e) {
      setRenderError(e.message || "Could not download the script");
    }
  }, []);

  const handleDeleteFigure = useCallback(async (figure) => {
    try {
      await api.deleteFigure(figure.runId, figure.svgFilename);
      setFigures((f) => f.filter((x) => x !== figure));
      setZoomFigure((z) => (z === figure ? null : z));
      setRefiningFigure((r) => (r === figure ? null : r));
      refreshHistory();
    } catch (e) {
      setRenderError(e.message || "Could not delete this figure");
    }
  }, [refreshHistory]);

  const showsX = spec.chart_type !== "heatmap";
  const showsY = spec.chart_type !== "heatmap";
  const showsGroup = ["scatter", "line", "bar", "histogram"].includes(spec.chart_type);
  const showsAgg = spec.chart_type === "bar";
  // Axis zoom only makes sense against a continuous axis — bar/box's X is
  // categories, and heatmap's axes are column names, not a numeric range.
  const showsXRange = ["scatter", "line", "histogram"].includes(spec.chart_type);
  const showsYRange = spec.chart_type !== "heatmap" && spec.chart_type !== "bar" && spec.chart_type !== "box";

  // Reopen a previously-rendered figure's spec into the form so its axis
  // range (or chart type/columns) can be tweaked and re-rendered — this is
  // how "zoom into this region" actually works: a fresh full-resolution
  // render cropped to a data range, not a magnified image.
  const handleEditSpec = useCallback((figure) => {
    if (!figure?.spec) return;
    setSpec({
      chart_type: figure.spec.chart_type || "scatter",
      x: figure.spec.x || "", y: figure.spec.y || "", group: figure.spec.group || "",
      agg: figure.spec.agg || "mean", title: figure.spec.title || "",
      x_min: figure.spec.x_min ?? "", x_max: figure.spec.x_max ?? "",
      y_min: figure.spec.y_min ?? "", y_max: figure.spec.y_max ?? "",
    });
    setZoomFigure(null);
    setRefiningFigure(figure);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div style={{ width: "100%", maxWidth: 1680, margin: "0 auto", padding: "28px clamp(16px, 4vw, 40px)", boxSizing: "border-box" }}>
      {onBack && (
        <button
          type="button" onClick={onBack}
          style={{
            display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
            color: "var(--muted, #5b6472)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
            padding: 0, margin: "0 0 18px", fontFamily: "inherit",
          }}
        >
          <ArrowLeft size={13} /> Home
        </button>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BarChart3 size={20} style={{ color: "var(--indigo, #6d5df6)" }} />
          <div style={{ fontSize: 19, fontWeight: 700 }}>{label}</div>
        </div>
        <button
          type="button" onClick={() => setShowHistory((v) => !v)}
          style={{
            ...iconBtnStyle, padding: "6px 12px",
            background: showHistory ? "var(--indigo, #6d5df6)" : "var(--bg, #fff)",
            color: showHistory ? "#fff" : "var(--muted, #5b6472)",
            borderColor: showHistory ? "var(--indigo, #6d5df6)" : "var(--line, #e3e4ea)",
          }}
        >
          <Clock size={12} /> Past analyses{history.length > 0 ? ` (${history.length})` : ""}
        </button>
      </div>
      <div style={{ color: "var(--muted, #5b6472)", fontSize: 13, marginBottom: 22 }}>
        Upload a dataset, pick what to plot, get a publication-styled figure back. No AI calls —
        you're in full control of what gets drawn. Every analysis is saved automatically — reopen
        it any time from Past analyses.
      </div>

      {showHistory && (
        <div style={{ ...panelStyle, marginBottom: 20 }}>
          <div style={labelStyle}>Past analyses</div>
          {historyLoading && (
            <div style={{ fontSize: 12.5, color: "var(--muted, #5b6472)" }}>Loading…</div>
          )}
          {historyError && (
            <div style={{ color: "#c0392b", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <AlertTriangle size={12} /> {historyError}
            </div>
          )}
          {!historyLoading && history.length === 0 && (
            <div style={{ fontSize: 12.5, color: "var(--muted, #5b6472)" }}>
              Nothing here yet — upload a dataset below and it'll show up here for next time.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {history.map((h) => {
              const proj = h.project_id ? (projects || []).find((p) => p.id === h.project_id) : null;
              const isCurrent = run?.run_id === h.id;
              return (
                <div
                  key={h.id} onClick={() => handleResume(h)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                    padding: "8px 10px", borderRadius: 7, cursor: "pointer",
                    background: isCurrent ? "#eef2ff" : "var(--bg, #fff)",
                    border: "1px solid var(--line, #e3e4ea)",
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden",
                                  textOverflow: "ellipsis" }}>
                      {h.filename}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted, #5b6472)", marginTop: 2 }}>
                      {timeAgo(h.updated_at)}{proj ? ` · ${proj.name}` : " · Standalone"}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {resumingId === h.id
                      ? <RotateCw size={13} className="spin" />
                      : <span style={{ fontSize: 11.5, color: "var(--indigo, #6d5df6)", fontWeight: 600 }}>Open</span>}
                    <button
                      type="button" title="Delete this analysis"
                      onClick={(e) => handleDeleteHistoryRow(h.id, e)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted, #5b6472)", padding: 2 }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!run && (
        <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={panelStyle}>
              <ProjectLinkControl
                value={linkedProjectId} onChange={setLinkedProjectId} projects={projects}
              />
              <div style={{ fontSize: 11, color: "var(--muted, #5b6472)", marginTop: 6 }}>
                Optional — leave as Standalone to use this tool without filing it under any project.
              </div>
            </div>

            <AnalysisModePicker value={analysisMode} onChange={setAnalysisMode} />
          </div>

          <div
            style={{
              ...panelStyle, textAlign: "center", padding: "40px 24px", borderStyle: "dashed",
              cursor: "pointer",
            }}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleUpload(e.dataTransfer.files?.[0]); }}
          >
            <input
              ref={fileInputRef} type="file" accept=".csv,.tsv,.xlsx,.xls" style={{ display: "none" }}
              onChange={(e) => handleUpload(e.target.files?.[0])}
            />
            <FileText size={26} style={{ color: "var(--muted, #5b6472)", marginBottom: 10 }} />
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {uploading ? "Uploading & profiling…" : "Drop a CSV or XLSX file, or click to browse"}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted, #5b6472)" }}>
              Up to 50MB · CSV, TSV, or Excel
            </div>
            {uploadError && (
              <div style={{ marginTop: 14, color: "#c0392b", fontSize: 12.5, display: "flex",
                            alignItems: "center", justifyContent: "center", gap: 6 }}>
                <AlertTriangle size={13} /> {uploadError}
              </div>
            )}
          </div>
        </div>
      )}

      {run && (
        <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 20, alignItems: "start" }}>
          {/* ── Left: dataset profile ───────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, position: "sticky", top: 20 }}>
            <div style={panelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, wordBreak: "break-all" }}>{run.filename}</div>
                <button
                  type="button" title="Upload a different file"
                  onClick={() => {
                    setRun(null); setFigures([]); setZoomFigure(null); setRefiningFigure(null);
                    setSeriesCache({}); requestedSeriesRef.current = new Set();
                    setStatsData(null); setStatsError(null);
                  }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted, #5b6472)", padding: 2 }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div style={{ marginTop: 8 }}>
                <Chip>{run.profile.row_count.toLocaleString()} rows</Chip>
                <Chip>{run.profile.column_count} columns</Chip>
                <Chip tone={run.profile.kind}>{run.profile.kind}</Chip>
              </div>
            </div>

            <div style={panelStyle}>
              <ProjectLinkControl
                value={run.project_id} onChange={handleChangeProjectLink} projects={projects}
                busy={linking} error={linkError}
              />
              <div style={{ fontSize: 11, color: "var(--muted, #5b6472)", marginTop: 6 }}>
                {run.project_id
                  ? "This analysis is filed under this project."
                  : "Standalone — not filed under any project."}
              </div>
            </div>

            <AnalysisModePicker value={analysisMode} onChange={setAnalysisMode} />

            <div style={panelStyle}>
              <div style={labelStyle}>Columns</div>
              <div style={{ maxHeight: 260, overflowY: "auto" }}>
                {columns.map((c) => (
                  <div key={c.name} style={{ display: "flex", justifyContent: "space-between",
                                              alignItems: "center", padding: "4px 0", fontSize: 12.5 }}>
                    <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{c.name}</span>
                    <Chip tone={c.dtype}>{c.dtype}</Chip>
                  </div>
                ))}
              </div>
            </div>

            {metadataEntries.length > 0 && (
              <div style={panelStyle}>
                <div style={labelStyle}>
                  Detected metadata ({metadataEntries.length})
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted, #5b6472)", marginBottom: 8 }}>
                  A sparse key/value block found alongside the main table and kept separate from
                  the plottable columns.
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto" }}>
                  {metadataEntries.map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8,
                                           padding: "3px 0", fontSize: 11, fontFamily: "'JetBrains Mono',monospace" }}>
                      <span style={{ color: "var(--muted, #5b6472)" }}>{k}</span>
                      <span>{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Right: whichever view the sidebar's Analysis type picker selects ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            {analysisMode === "plot" && (
            <>
            <div style={panelStyle} ref={formRef}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                <div>
                  <label style={labelStyle}>Chart type</label>
                  <select style={selectStyle} value={spec.chart_type}
                          onChange={(e) => setSpec((s) => ({ ...s, chart_type: e.target.value }))}>
                    {CHART_TYPES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                {showsX && (
                  <div>
                    <label style={labelStyle}>X column</label>
                    <select style={selectStyle} value={spec.x}
                            onChange={(e) => setSpec((s) => ({ ...s, x: e.target.value }))}>
                      <option value="">—</option>
                      {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                )}
                {showsY && (
                  <div>
                    <label style={labelStyle}>Y column</label>
                    <select style={selectStyle} value={spec.y}
                            onChange={(e) => setSpec((s) => ({ ...s, y: e.target.value }))}>
                      <option value="">—</option>
                      {(spec.chart_type === "bar" ? numericColumns : columns).map((c) =>
                        <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                )}
                {showsGroup && (
                  <div>
                    <label style={labelStyle}>Group by (optional)</label>
                    <select style={selectStyle} value={spec.group}
                            onChange={(e) => setSpec((s) => ({ ...s, group: e.target.value }))}>
                      <option value="">None</option>
                      {categoricalColumns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                )}
                {showsAgg && (
                  <div>
                    <label style={labelStyle}>Aggregation</label>
                    <select style={selectStyle} value={spec.agg}
                            onChange={(e) => setSpec((s) => ({ ...s, agg: e.target.value }))}>
                      {AGGS.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label style={labelStyle}>Title (optional)</label>
                  <input style={selectStyle} value={spec.title}
                         onChange={(e) => setSpec((s) => ({ ...s, title: e.target.value }))}
                         placeholder="Figure title" />
                </div>
              </div>

              {(showsXRange || showsYRange) && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line, #e3e4ea)" }}>
                  <label style={labelStyle}>Zoom range (optional)</label>
                  <div style={{ fontSize: 11, color: "var(--muted, #5b6472)", marginBottom: 8 }}>
                    Narrow the axis range and render again for a full-resolution close-up of that
                    region — leave a field blank to auto-scale that side.
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10 }}>
                    {showsXRange && (
                      <>
                        <div>
                          <label style={{ ...labelStyle, fontSize: 10.5 }}>X min</label>
                          <input type="number" style={selectStyle} value={spec.x_min}
                                 onChange={(e) => setSpec((s) => ({ ...s, x_min: e.target.value }))} placeholder="auto" />
                        </div>
                        <div>
                          <label style={{ ...labelStyle, fontSize: 10.5 }}>X max</label>
                          <input type="number" style={selectStyle} value={spec.x_max}
                                 onChange={(e) => setSpec((s) => ({ ...s, x_max: e.target.value }))} placeholder="auto" />
                        </div>
                      </>
                    )}
                    {showsYRange && (
                      <>
                        <div>
                          <label style={{ ...labelStyle, fontSize: 10.5 }}>Y min</label>
                          <input type="number" style={selectStyle} value={spec.y_min}
                                 onChange={(e) => setSpec((s) => ({ ...s, y_min: e.target.value }))} placeholder="auto" />
                        </div>
                        <div>
                          <label style={{ ...labelStyle, fontSize: 10.5 }}>Y max</label>
                          <input type="number" style={selectStyle} value={spec.y_max}
                                 onChange={(e) => setSpec((s) => ({ ...s, y_max: e.target.value }))} placeholder="auto" />
                        </div>
                      </>
                    )}
                  </div>
                  {(spec.x_min !== "" || spec.x_max !== "" || spec.y_min !== "" || spec.y_max !== "") && (
                    <button
                      type="button"
                      onClick={() => setSpec((s) => ({ ...s, x_min: "", x_max: "", y_min: "", y_max: "" }))}
                      style={{ ...iconBtnStyle, marginTop: 8 }}
                    >
                      <X size={11} /> Clear zoom range
                    </button>
                  )}
                </div>
              )}

              {refiningFigure && (
                <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--muted, #5b6472)", display: "flex",
                              alignItems: "center", gap: 6 }}>
                  <RotateCw size={11} />
                  Editing an existing figure — Update replaces it in place instead of adding a new one.
                  <button
                    type="button" onClick={() => setRefiningFigure(null)}
                    style={{ background: "none", border: "none", color: "var(--indigo, #6d5df6)",
                              fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}
                  >
                    Stop editing
                  </button>
                </div>
              )}
              <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
                {refiningFigure && (
                  <button
                    type="button" onClick={() => handleRender("update")} disabled={rendering}
                    style={{
                      background: "var(--indigo, #6d5df6)", color: "#fff", border: "none",
                      borderRadius: 7, padding: "8px 18px", fontWeight: 600, fontSize: 13,
                      cursor: rendering ? "default" : "pointer", opacity: rendering ? 0.7 : 1,
                      display: "inline-flex", alignItems: "center", gap: 7,
                    }}
                  >
                    {rendering ? <RotateCw size={13} className="spin" /> : <Check size={13} />}
                    {rendering ? "Updating…" : "Update this figure"}
                  </button>
                )}
                <button
                  type="button" onClick={() => handleRender("new")} disabled={rendering}
                  style={{
                    background: refiningFigure ? "var(--bg, #fff)" : "var(--indigo, #6d5df6)",
                    color: refiningFigure ? "var(--muted, #5b6472)" : "#fff",
                    border: refiningFigure ? "1px solid var(--line, #e3e4ea)" : "none",
                    borderRadius: 7, padding: "8px 18px", fontWeight: 600, fontSize: 13,
                    cursor: rendering ? "default" : "pointer", opacity: rendering ? 0.7 : 1,
                    display: "inline-flex", alignItems: "center", gap: 7,
                  }}
                >
                  {rendering && !refiningFigure ? <RotateCw size={13} className="spin" /> : <Check size={13} />}
                  {rendering && !refiningFigure ? "Rendering…" : refiningFigure ? "Render as new figure instead" : "Render"}
                </button>
              </div>
              {renderError && (
                <div style={{ marginTop: 10, color: "#c0392b", fontSize: 12.5, display: "flex",
                              alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={13} /> {renderError}
                </div>
              )}
            </div>

            <div style={panelStyle}>
              <button
                type="button" onClick={() => setShowInteractive((v) => !v)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                  background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                }}
              >
                <span style={labelStyle}>
                  Interactive view — pan, zoom, and overlay columns in one live chart
                </span>
                <span style={{ fontSize: 11, color: "var(--indigo, #6d5df6)", fontWeight: 700 }}>
                  {showInteractive ? "Hide" : "Show"}
                </span>
              </button>

              {showInteractive && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--muted, #5b6472)", marginBottom: 10 }}>
                    Explore the real data directly — drag to zoom into any region, and pick more than
                    one Y column to overlay them on the same chart. No new image is rendered until
                    you're ready to export one from the form above.
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                    <div>
                      <label style={labelStyle}>X column</label>
                      <select style={selectStyle} value={interactiveX}
                              onChange={(e) => setInteractiveX(e.target.value)}>
                        <option value="">Row index</option>
                        {numericColumns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </select>
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <label style={labelStyle}>Y columns (select one or more to overlay)</label>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {numericColumns.map((c) => (
                          <label
                            key={c.name}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12,
                              border: "1px solid var(--line, #e3e4ea)", borderRadius: 6, padding: "4px 9px",
                              cursor: "pointer",
                              background: interactiveYs.includes(c.name) ? "#eef2ff" : "var(--bg, #fff)",
                            }}
                          >
                            <input
                              type="checkbox" checked={interactiveYs.includes(c.name)}
                              onChange={() => toggleInteractiveY(c.name)}
                              style={{ margin: 0 }}
                            />
                            {c.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button" onClick={handleLoadSeries} disabled={seriesLoading || interactiveYs.length === 0}
                    style={{
                      marginTop: 12, background: "var(--indigo, #6d5df6)", color: "#fff", border: "none",
                      borderRadius: 7, padding: "8px 18px", fontWeight: 600, fontSize: 13,
                      cursor: seriesLoading ? "default" : "pointer", opacity: seriesLoading || interactiveYs.length === 0 ? 0.6 : 1,
                      display: "inline-flex", alignItems: "center", gap: 7,
                    }}
                  >
                    {seriesLoading ? <RotateCw size={13} className="spin" /> : <Check size={13} />}
                    {seriesLoading ? "Loading…" : "Load"}
                  </button>
                  {seriesError && (
                    <div style={{ marginTop: 10, color: "#c0392b", fontSize: 12.5, display: "flex",
                                  alignItems: "center", gap: 6 }}>
                      <AlertTriangle size={13} /> {seriesError}
                    </div>
                  )}

                  {seriesData && (
                    <div style={{ marginTop: 16 }}>
                      {seriesData.downsampled && (
                        <div style={{ fontSize: 11, color: "var(--muted, #5b6472)", marginBottom: 8 }}>
                          Showing {seriesData.points_returned.toLocaleString()} of{" "}
                          {seriesData.total_rows.toLocaleString()} rows (every {seriesData.stride}
                          {seriesData.stride === 2 ? "nd" : seriesData.stride === 3 ? "rd" : "th"} row) for
                          performance — zoom still works across the full range.
                        </div>
                      )}
                      <InteractiveSeriesChart
                        xLabel={seriesData.x_label} x={seriesData.x} series={seriesData.series}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {figures.length > 0 && (
              <div style={panelStyle}>
                <div style={labelStyle}>
                  Figures this session ({figures.length}) — drag directly on a chart to zoom into a region,
                  or click Zoom to open it larger
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                    gap: 14,
                  }}
                >
                  {figures.map((f, i) => (
                    <div
                      key={i}
                      style={{
                        border: "1px solid var(--line, #e3e4ea)", borderRadius: 8,
                        background: "var(--bg, #fff)", overflow: "hidden",
                        display: "flex", flexDirection: "column",
                      }}
                    >
                      {seriesCache[f.svgFilename]?.status === "ready" ? (
                        <InteractiveSeriesChart
                          xLabel={seriesCache[f.svgFilename].data.x_label}
                          x={seriesCache[f.svgFilename].data.x}
                          series={seriesCache[f.svgFilename].data.series}
                          chartType={f.spec?.chart_type}
                          height={220}
                          compact
                          initialXRange={f.spec?.x_min != null && f.spec?.x_max != null
                            ? [f.spec.x_min, f.spec.x_max] : null}
                          initialYRange={f.spec?.y_min != null && f.spec?.y_max != null
                            ? [f.spec.y_min, f.spec.y_max] : null}
                        />
                      ) : (
                        <button
                          type="button" onClick={() => setZoomFigure(f)}
                          title="Click to zoom"
                          style={{
                            border: "none", background: "none", padding: 0, cursor: "zoom-in",
                            display: "block", width: "100%",
                          }}
                        >
                          <img src={f.url} alt="Rendered figure" style={{ width: "100%", display: "block" }} />
                        </button>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                                    padding: "8px 10px", borderTop: "1px solid var(--line, #e3e4ea)", gap: 8 }}>
                        <div style={{ fontSize: 11.5, color: "var(--muted, #5b6472)", overflow: "hidden",
                                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {f.spec?.title || `${f.spec?.chart_type}${f.spec?.y ? ` · ${f.spec.y}` : ""}`}
                        </div>
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          <button type="button" style={iconBtnStyle} title="Zoom" onClick={() => setZoomFigure(f)}>
                            <Maximize size={11} />
                          </button>
                          <button type="button" style={iconBtnStyle}
                                  title="Load this into the form to set an axis zoom range and re-render"
                                  onClick={() => handleEditSpec(f)}>
                            Refine
                          </button>
                          <button type="button" style={iconBtnStyle} title="Open in new window"
                                  onClick={() => handleOpenNewWindow(f)}>
                            <ExternalLink size={11} />
                          </button>
                          <a href={f.url} download="figure.png" title="Download PNG" style={{ ...iconBtnStyle, textDecoration: "none" }}>
                            <Download size={11} /> PNG
                          </a>
                          <button type="button" style={iconBtnStyle} title="Download SVG"
                                  onClick={() => handleDownloadSvg(f)}>
                            <Download size={11} /> SVG
                          </button>
                          <button type="button" style={iconBtnStyle}
                                  title="Download a standalone matplotlib script that reproduces this figure"
                                  onClick={() => handleDownloadScript(f)}>
                            <Download size={11} /> PY
                          </button>
                          <button type="button" style={iconBtnStyle} title="Delete this figure"
                                  onClick={() => handleDeleteFigure(f)}>
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </>
            )}

            {analysisMode === "stats" && (
            <div style={panelStyle}>
              <div style={labelStyle}>Statistics — descriptive stats for every column</div>
              <div style={{ fontSize: 11, color: "var(--muted, #5b6472)", marginBottom: 14 }}>
                Mean, median, standard deviation, and quartiles for numeric columns; the most
                common values for categorical ones. Computed directly from the uploaded data —
                no AI involved, same as the rest of this tool.
              </div>
              {statsLoading && (
                <div style={{ fontSize: 12.5, color: "var(--muted, #5b6472)" }}>Computing…</div>
              )}
              {statsError && (
                <div style={{ color: "#c0392b", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={13} /> {statsError}
                </div>
              )}
              {statsData && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        {["Column", "Count", "Mean", "Median", "Std dev", "Min", "Max", "Q1", "Q3", "Skew", "Unique", "Top values"].map((h) => (
                          <th
                            key={h}
                            style={{
                              textAlign: "left", padding: "6px 10px", whiteSpace: "nowrap",
                              borderBottom: "1px solid var(--line, #e3e4ea)",
                              color: "var(--muted, #5b6472)", fontWeight: 600,
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {statsData.columns.map((c) => (
                        <tr key={c.name} style={{ borderBottom: "1px solid var(--line, #e3e4ea)" }}>
                          <td style={{ ...statCellStyle, fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>
                            {c.name}
                          </td>
                          <td style={statCellStyle}>{c.count.toLocaleString()}</td>
                          {c.dtype === "numeric" ? (
                            <>
                              <td style={statCellStyle}>{fmtStat(c.mean)}</td>
                              <td style={statCellStyle}>{fmtStat(c.median)}</td>
                              <td style={statCellStyle}>{fmtStat(c.std)}</td>
                              <td style={statCellStyle}>{fmtStat(c.min)}</td>
                              <td style={statCellStyle}>{fmtStat(c.max)}</td>
                              <td style={statCellStyle}>{fmtStat(c.q1)}</td>
                              <td style={statCellStyle}>{fmtStat(c.q3)}</td>
                              <td style={statCellStyle}>{fmtStat(c.skew)}</td>
                              <td style={statCellStyle}>{c.n_unique.toLocaleString()}</td>
                              <td style={statCellStyle}>—</td>
                            </>
                          ) : (
                            <>
                              <td style={statCellStyle} colSpan={7}>—</td>
                              <td style={statCellStyle}>{c.n_unique.toLocaleString()}</td>
                              <td style={{ ...statCellStyle, whiteSpace: "normal" }}>
                                {(c.top_values || []).map((t) => `${t.value} (${t.count})`).join(", ") || "—"}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      )}

      <ZoomModal
        figure={zoomFigure}
        seriesEntry={zoomFigure ? seriesCache[zoomFigure.svgFilename] : null}
        onClose={() => setZoomFigure(null)}
        onOpenNewWindow={handleOpenNewWindow}
        onRefine={handleEditSpec}
        onDelete={handleDeleteFigure}
        onDownloadScript={handleDownloadScript}
      />
    </div>
  );
}

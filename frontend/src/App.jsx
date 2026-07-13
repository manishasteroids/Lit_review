import React, { useState, useRef, useEffect, useCallback } from "react";
import { api } from "./api/client.js";

import PipelineRail from "./components/PipelineRail.jsx";
import QueryInput, { ModelBar } from "./components/QueryInput.jsx";
import PaperFilter from "./components/PaperFilter.jsx";
import ReviewView from "./components/ReviewView.jsx";
import SourcesView from "./components/SourcesView.jsx";
import CritiqueView from "./components/CritiqueView.jsx";
import KnowledgeGraphView from "./components/KnowledgeGraphView.jsx";
import DataAnalysisView from "./components/DataAnalysisView.jsx";
import EvaluationView from "./components/EvaluationView.jsx";
import UsageView from "./components/UsageView.jsx";
import {
  RotateCw, AlertTriangle, Sparkles, PenTool,
  BookOpen, Layers, Brain, Network, BarChart3, FlaskConical,
  Plus, Trash2, Coins,
} from "./components/icons.jsx";

// Source icons shown in the progress feed
const SOURCE_ICON = {
  semantic_scholar: "🔬",
  arxiv: "📄",
  pubmed: "🧬",
};

const TOOLS = [
  ["review", BookOpen, "Review"],
  ["sources", Layers, "Sources"],
  ["critique", Brain, "Critique"],
  ["graph", Network, "Knowledge graph"],
  ["data", BarChart3, "Data analysis"],
  ["eval", FlaskConical, "Evaluation"],
  ["usage", Coins, "Token usage"],
];

// ── History helpers ──────────────────────────────────────────────
function relativeTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 2592000) return Math.floor(diff / 86400) + "d ago";
  return new Date(iso).toLocaleDateString();
}

function groupSessions(sessions) {
  const now = Date.now();
  const buckets = { Today: [], Yesterday: [], "This week": [], Older: [] };
  for (const s of sessions) {
    const diff = (now - new Date(s.updated_at).getTime()) / 1000;
    if (diff < 86400) buckets["Today"].push(s);
    else if (diff < 172800) buckets["Yesterday"].push(s);
    else if (diff < 604800) buckets["This week"].push(s);
    else buckets["Older"].push(s);
  }
  return buckets;
}

// Inline styles for the History list (no extra CSS needed)
const H = {
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  newBtn: { background: "none", border: "1px solid var(--line)", borderRadius: 7, color: "var(--muted)", cursor: "pointer", padding: "3px 5px", display: "flex", alignItems: "center" },
  empty: { fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "var(--muted2)", lineHeight: 1.6, padding: "8px 2px" },
  scroll: { maxHeight: "calc(100vh - 340px)", overflowY: "auto", margin: "0 -4px", padding: "0 4px" },
  bucket: { fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted2)", padding: "10px 4px 4px" },
  item: { padding: "8px 9px", borderRadius: 8, cursor: "pointer", marginBottom: 2 },
  itemActive: { background: "var(--indigo-soft)" },
  itemTop: { display: "flex", alignItems: "flex-start", gap: 4, justifyContent: "space-between" },
  itemTopic: { fontSize: 12.5, color: "var(--txt)", lineHeight: 1.35, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", flex: 1, minWidth: 0 },
  del: { background: "none", border: "none", cursor: "pointer", color: "var(--muted2)", padding: "2px 3px", borderRadius: 4, display: "flex", alignItems: "center", flexShrink: 0 },
  delConfirm: { color: "#f08a8a" },
  meta: { display: "flex", alignItems: "center", gap: 4, marginTop: 5, fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)" },
  dot: { color: "var(--muted2)" },
  badge: { fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, fontWeight: 500, borderRadius: 4, padding: "1px 5px" },
  badgeDone: { background: "var(--green-soft)", color: "var(--green)" },
  badgeFilter: { background: "rgba(224,163,62,.14)", color: "var(--amber)" },
  foot: { marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)", fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, color: "var(--muted2)", lineHeight: 1.5 },
};

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [topic, setTopic] = useState("");
  const [stage, setStage] = useState("query");
  const [done, setDone] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [notes, setNotes] = useState({}); // paper idx -> note text

  const [runId, setRunId] = useState(null);
  const [reform, setReform] = useState(null);
  const [papers, setPapers] = useState([]);
  const [approved, setApproved] = useState({});
  const [extractions, setExtractions] = useState([]);
  const [synth, setSynth] = useState(null);
  const [sections, setSections] = useState({});
  const [sideModules, setSideModules] = useState(null);
  const [evalRes, setEvalRes] = useState(null);
  const [tab, setTab] = useState("review");
  const reviewRef = useRef(null);
  const isDone = stage === "done";

  // Live progress messages during search
  const [progressMsgs, setProgressMsgs] = useState([]);

  // Session list from backend (no LLM) + delete-confirm state
  const [sessions, setSessions] = useState([]);
  const [confirmId, setConfirmId] = useState(null);

  const refreshSessions = useCallback(() => {
    api.listSessions().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  function reset() {
    setRunId(null); setReform(null); setPapers([]); setApproved({});
    setExtractions([]); setSynth(null); setSections({}); setSideModules(null);
    setEvalRes(null); setError(null); setDone({}); setStage("query");
    setTab("review"); setProgressMsgs([]);
    setTab("review"); setProgressMsgs([]); setNotes({});
  }

  // Restore a session — zero LLM calls
  async function restoreSession(sessionId) {
    if (busy) return;
    try {
      const s = await api.getSession(sessionId);
      const d = s.data;
      reset();
      setTopic(d.topic || "");
      setRunId(d.runId || null);
      setReform(d.reform || null);
      setPapers(d.papers || []);
      setApproved(d.approved || {});
      if (s.stage === "done") {
        const secs = d.sections || {};
        const hasReview = Object.keys(secs).length > 0;
        setExtractions(d.extractions || []);
        setSynth(d.synth || null);
        setSections(secs);
        setSideModules(d.sideModules || null);
        setNotes(d.notes || {});
        setDone({ query: true, reformulate: true, search: true, extract: true, synthesize: true, write: hasReview });
        setStage("done");
        setTab(hasReview ? "review" : "sources");
        setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
      } else {
        setDone({ query: true, reformulate: true, search: true });
        setStage("filter");
      }
    } catch (e) {
      setError({ stage: "Session restore", msg: e.message });
    }
  }

  async function deleteSession(id) {
    await api.deleteSession(id);
    refreshSessions();
  }

  const approvedList = papers.filter((p) => approved[p.idx]);
  const citeOrder = approvedList.length
    ? (synth?.ranked?.length
        ? synth.ranked.map((r) => approvedList.find((p) => p.idx === r.idx)).filter(Boolean)
        : approvedList)
    : [];
  const citeNum = {};
  citeOrder.forEach((p, i) => (citeNum[p.idx] = i + 1));

  async function runStart() {
    setBusy(true); setError(null); setStage("reformulate"); setProgressMsgs([]);
    try {
      const res = await api.createRunStream(
        topic.trim(),
        apiKey || undefined,
        model,
        (event) => {
          if (event.type === "progress") {
            setProgressMsgs((prev) => {
              const last = prev[prev.length - 1];
              if (last?.message === event.message) return prev;
              return [...prev, event];
            });
            if (event.step === "reformulate") setStage("reformulate");
            if (event.step === "search") setStage("search");
          }
        }
      );
      setRunId(res.run_id);
      setReform(res.reform);
      const p = res.papers || [];
      setPapers(p);
      const ap = {}; p.forEach((x) => (ap[x.idx] = true));
      setApproved(ap);
      setDone((d) => ({ ...d, query: true, reformulate: true, search: true }));
      setStage("filter");
      refreshSessions();
    } catch (e) {
      setError({ stage: "Query Reformulator / Academic Search", msg: e.message });
      setStage("query");
    } finally {
      setBusy(false);
    }
  }

  async function runApprove() {
    const approvedIndices = Object.entries(approved).filter(([, v]) => v).map(([k]) => Number(k));
    if (approvedIndices.length < 2) {
      setError({ stage: "Paper Filter", msg: "Approve at least 2 papers to synthesize a review." });
      return;
    }
    setBusy(true); setError(null);
    try {
      await api.filterPapers(runId, approvedIndices);
      setStage("extract");
      const synRes = await api.synthesize(runId, apiKey || undefined, model, notes);
      setExtractions(synRes.extractions);
      setSynth(synRes.synthesis);
      setSideModules(synRes.side_modules);
      setDone((d) => ({ ...d, extract: true, synthesize: true }));
      setStage("done");
      setTab("sources");
      refreshSessions();
      setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (e) {
      setError({ stage: "Reader & Extractor / Critic & Synthesizer", msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  // generate the written cited review (Writer agent) on demand.
  async function runWrite() {
    // switch to the "write" stage so the Writer Agent progress card shows while
    // the review is being drafted (otherwise the pipeline is already "done" and
    // no status is visible during generation).
    setBusy(true); setError(null); setStage("write");
    try {
      const writeRes = await api.write(runId, apiKey || undefined, model, notes);
      setSections(writeRes.sections);
      if (writeRes.side_modules) setSideModules(writeRes.side_modules);
      setDone((d) => ({ ...d, write: true }));
      setTab("review");
      refreshSessions();
    } catch (e) {
      setError({ stage: "Writer Agent", msg: e.message });
    } finally {
      setBusy(false); setStage("done");
    }
  }

  async function runEvaluate() {
    setBusy(true); setError(null);
    try {
      const res = await api.evaluate(runId, apiKey || undefined, model);
      setEvalRes(res.eval_result);
    } catch (e) {
      setError({ stage: "Evaluator", msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  function download(filename, text, type = "text/plain;charset=utf-8") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function exportShortlist(fmt) {
    const extByIdx = {};
    (extractions || []).forEach((e) => (extByIdx[e.idx] = e));
    const rows = citeOrder.map((p, i) => ({
      n: i + 1, ...p, ...(extByIdx[p.idx] || {}), note: notes[p.idx] || "",
    }));
    const slug = (topic || "shortlist").replace(/[^\w]+/g, "-").slice(0, 40).replace(/^-|-$/g, "") || "shortlist";

    if (fmt === "md") {
      let md = `# Literature shortlist — ${topic}\n\n_${rows.length} papers_\n\n`;
      rows.forEach((r) => {
        md += `## [${r.n}] ${r.title}\n`;
        md += `${r.authors || "—"} · ${r.year || "—"} · ${r.venue || "preprint"}\n`;
        if (r.url) md += `${r.url}\n`;
        md += "\n";
        if (r.method && r.method !== "n/a") md += `- **Method:** ${r.method}\n`;
        if (r.finding && r.finding !== "n/a") md += `- **Finding:** ${r.finding}\n`;
        if (r.metrics && r.metrics !== "n/a") md += `- **Metrics:** ${r.metrics}\n`;
        if (r.contribution && r.contribution !== "n/a") md += `- **Contribution:** ${r.contribution}\n`;
        if (r.note) md += `- **My notes:** ${r.note}\n`;
        md += "\n";
      });
      download(`${slug}.md`, md, "text/markdown;charset=utf-8");
    } else if (fmt === "csv") {
      const cols = ["n", "title", "authors", "year", "venue", "url", "method", "finding", "metrics", "contribution", "relevance", "note"];
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [cols.join(",")].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(","))).join("\n");
      download(`${slug}.csv`, csv, "text/csv;charset=utf-8");
    } else if (fmt === "bib") {
      const bib = rows.map((r) => {
        const first = (r.authors || "unknown").split(/[ ,]/)[0].toLowerCase().replace(/[^a-z]/g, "") || "ref";
        const key = `${first}${r.year || ""}_${r.idx}`;
        return `@article{${key},
  title   = {${r.title || ""}},
  author  = {${r.authors || ""}},
  year    = {${r.year || ""}},
  journal = {${r.venue || ""}},
  url     = {${r.url || ""}},
  note    = {${(r.note || "").replace(/[{}]/g, "")}}
}`;
      }).join("\n\n");
      download(`${slug}.bib`, bib, "application/x-bibtex;charset=utf-8");
    }
  }

  const grouped = groupSessions(sessions);

  return (
    <div className="sm-root">
      <div className="sm-wrap wide">
        <div className="sm-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Multi-agent literature review · live pipeline</div>
            <div className="sm-title"><b>Saṃhitā</b> <span style={{ color: "var(--muted)", fontWeight: 400 }}>/ lit-review agent</span></div>
            <div className="sm-gloss">
              Enter a research question and watch it move through the agent pipeline — reformulate,
              search the live web, filter sources, extract, critique, and write a cited review.
            </div>
          </div>
        </div>

        <div className="grid3">
          {/* LEFT: Tools + History */}
          <div className="lcol">
            <div className="panel">
              <div className="eyebrow" style={{ marginBottom: 12 }}>Tools</div>
              {TOOLS.map(([k, Ic, lab]) => (
                <button
                  key={k}
                  className={"tool-item" + (isDone && tab === k ? " on" : "") + (isDone ? "" : " disabled")}
                  disabled={!isDone}
                  onClick={() => isDone && setTab(k)}
                >
                  <Ic size={14} /> {lab}
                </button>
              ))}
            </div>

            <div className="panel">
              <div style={H.head}>
                <span className="eyebrow">History</span>
                <button
                  style={H.newBtn}
                  disabled={busy}
                  onClick={() => { if (!busy) { reset(); setTopic(""); } }}
                  title="New review"
                >
                  <Plus size={14} />
                </button>
              </div>

              {sessions.length === 0 ? (
                <div style={H.empty}>No runs yet. Run a search to start.</div>
              ) : (
                <div style={H.scroll}>
                  {Object.entries(grouped).map(([bucket, items]) => (
                    items.length ? (
                      <div key={bucket}>
                        <div style={H.bucket}>{bucket}</div>
                        {items.map((s) => (
                          <div
                            key={s.id}
                            style={{ ...H.item, ...(s.id === runId ? H.itemActive : {}) }}
                            onClick={() => !busy && restoreSession(s.id)}
                            onMouseLeave={() => setConfirmId(null)}
                            title={s.topic}
                          >
                            <div style={H.itemTop}>
                              <span style={H.itemTopic}>{s.topic}</span>
                              <button
                                style={{ ...H.del, ...(confirmId === s.id ? H.delConfirm : {}) }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirmId === s.id) { deleteSession(s.id); setConfirmId(null); }
                                  else setConfirmId(s.id);
                                }}
                                title={confirmId === s.id ? "Click again to confirm" : "Delete"}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                            <div style={H.meta}>
                              <span style={{ ...H.badge, ...(s.stage === "done" ? H.badgeDone : H.badgeFilter) }}>
                                {s.stage === "done" ? "✓ review" : "◦ filter"}
                              </span>
                              <span style={H.dot}>·</span>
                              <span>{s.paper_count}p</span>
                              <span style={H.dot}>·</span>
                              <span>{relativeTime(s.updated_at)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null
                  ))}
                </div>
              )}

              <div style={H.foot}>Sessions saved locally · no LLM needed to restore</div>
            </div>
          </div>

          {/* CENTER: Model selection + prompt / stage content */}
          <div className="ccol">
            <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
              <ModelBar model={model} setModel={setModel} apiKey={apiKey} setApiKey={setApiKey} />
            </div>

            {error && (
              <div className="err" style={{ marginBottom: 16 }}>
                <AlertTriangle size={18} style={{ flex: "0 0 18px", marginTop: 1 }} />
                <div>
                  <b>{error.stage} failed.</b> {error.msg}
                  <div style={{ marginTop: 8 }}>
                    <button className="btn ghost sm" onClick={() => { setError(null); if (papers.length) runApprove(); else runStart(); }}>
                      <RotateCw size={13} /> Retry stage
                    </button>
                  </div>
                </div>
              </div>
            )}

            {stage === "query" && <QueryInput topic={topic} setTopic={setTopic} busy={busy} onRun={runStart} />}

            {busy && (stage === "reformulate" || stage === "search") && (
              <div className="card">
                <div className="card-h">
                  <div className="ic"><RotateCw size={16} className="spin" /></div>
                  <h3>{stage === "reformulate" ? "Query Reformulator" : "Academic Search"}</h3>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  {progressMsgs.length === 0 && (
                    <div className="muted tiny pulse">Starting up…</div>
                  )}
                  {progressMsgs.map((ev, i) => {
                    const isLatest = i === progressMsgs.length - 1;
                    const icon = SOURCE_ICON[ev.detail] || (ev.step === "reformulate" ? "🤖" : "🔍");
                    return (
                      <div key={i} style={{
                        display: "flex", alignItems: "flex-start", gap: 8,
                        opacity: isLatest ? 1 : 0.45,
                        fontSize: 12, lineHeight: 1.5,
                        transition: "opacity 0.3s",
                      }}>
                        <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{icon}</span>
                        <span style={{ color: isLatest ? "var(--fg)" : "var(--muted)" }}>
                          {ev.message}
                          {isLatest && <span className="pulse" style={{ marginLeft: 4 }}>…</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {stage === "filter" && papers.length > 0 && (
              <PaperFilter
                papers={papers}
                approved={approved}
                scope={reform?.scope}
                busy={busy}
                onToggle={(idx) => setApproved((a) => ({ ...a, [idx]: !a[idx] }))}
                onApprove={runApprove}
                onRestart={reset}
                runId={runId}
                apiKey={apiKey}
                model={model}
                notes={notes}
                onNote={(idx, text) => setNotes((n) => ({ ...n, [idx]: text }))}
              />
            )}

            {busy && (stage === "extract" || stage === "synthesize" || stage === "write") && (
              <div className="card">
                <div className="card-h">
                  <div className="ic"><RotateCw size={16} className="spin" /></div>
                  <h3>{stage === "write" ? "Writer Agent" : "Reader & Extractor / Critic & Synthesizer"}</h3>
                </div>
                <div className="muted tiny pulse">
                  {stage === "write" ? "Reading your kept papers and drafting the review — introduction, thematic synthesis, gaps, and conclusion…" : "Extracting structured info and detecting themes/gaps/biases…"}
                </div>
              </div>
            )}

            {isDone && (
              <div ref={reviewRef}>
                <div className="card">
                  {tab === "review" && (
                    Object.keys(sections || {}).length > 0
                      ? <ReviewView topic={topic} sections={sections} citeOrder={citeOrder} />
                      : (
                        <div style={{ textAlign: "center", padding: "28px 16px" }}>
                          <div className="eyebrow" style={{ marginBottom: 8 }}></div>
                          <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>No written review yet</h3>
                          <div className="muted tiny" style={{ maxWidth: 460, margin: "0 auto 16px", lineHeight: 1.6 }}>
                            Your papers are reviewed and ready to explore in Sources, Critique and the
                            other tools. If you'd like, the Writer agent can draft a cited literature
                            review from your kept papers.
                          </div>
                          <button className="btn" disabled={busy} onClick={runWrite}>
                            <PenTool size={15} /> Generate cited review
                          </button>
                        </div>
                      )
                  )}
                  {tab === "sources" && <SourcesView citeOrder={citeOrder} extractions={extractions} runId={runId} apiKey={apiKey} model={model} />}
                  {tab === "critique" && <CritiqueView synth={synth} />}
                  {tab === "graph" && <KnowledgeGraphView concepts={sideModules?.knowledge_graph} citeNum={citeNum} />}
                  {tab === "data" && (
                    <DataAnalysisView
                      yearDistribution={sideModules?.year_distribution}
                      comparisonTable={sideModules?.comparison_table}
                    />
                  )}
                  {tab === "eval" && <EvaluationView evalRes={evalRes} busy={busy} onEvaluate={runEvaluate} />}
                  {tab === "usage" && <UsageView runId={runId} />}
                </div>

                <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button className="btn ghost" onClick={() => { const old = topic; reset(); setTopic(old); }}>
                    <RotateCw size={14} /> New run
                  </button>
                  <button className="btn ghost" onClick={() => { reset(); setTopic(""); }}>
                    <Sparkles size={14} /> New topic
                  </button>
                  <span style={{ width: 1, alignSelf: "stretch", background: "var(--line)", margin: "0 2px" }} />
                  <button className="btn ghost sm" disabled={!citeOrder.length} onClick={() => exportShortlist("md")}>Export .md</button>
                  <button className="btn ghost sm" disabled={!citeOrder.length} onClick={() => exportShortlist("csv")}>Export .csv</button>
                  <button className="btn ghost sm" disabled={!citeOrder.length} onClick={() => exportShortlist("bib")}>Export .bib</button>
                </div>
              </div>
            )}

            <div className="foot">
              Talks to the Saṃhitā backend (FastAPI) running at the address in <code>VITE_API_BASE</code>.
              The Anthropic key lives server-side by default — only paste one above if you want to
              override the server's key for this run.
            </div>
          </div>

          {/* Agent Pipeline status */}
          <div className="rcol">
            <PipelineRail
              stage={stage}
              busy={busy}
              done={done}
              kg={sideModules?.knowledge_graph}
              ranked={synth?.ranked?.length}
              dataReady={!!sideModules}
              showMemory={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

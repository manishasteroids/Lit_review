import React, { useState, useRef } from "react";
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
import {
  RotateCw, AlertTriangle, BookOpen, Layers, Brain, Network, BarChart3, FlaskConical, Sparkles,
} from "./components/icons.jsx";

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [topic, setTopic] = useState("");
  const [stage, setStage] = useState("query");
  const [done, setDone] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [runId, setRunId] = useState(null);
  const [reform, setReform] = useState(null);
  const [papers, setPapers] = useState([]);
  const [approved, setApproved] = useState({});
  const [extractions, setExtractions] = useState([]);
  const [synth, setSynth] = useState(null);
  const [sections, setSections] = useState({});
  const [sideModules, setSideModules] = useState(null);
  const [evalRes, setEvalRes] = useState(null);
  const [memory, setMemory] = useState([]);
  const [tab, setTab] = useState("review");
  const reviewRef = useRef(null);

  function reset() {
    setRunId(null); setReform(null); setPapers([]); setApproved({});
    setExtractions([]); setSynth(null); setSections({}); setSideModules(null);
    setEvalRes(null); setError(null); setDone({}); setStage("query"); setTab("review");
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
    setBusy(true); setError(null); setStage("reformulate");
    try {
      const res = await api.createRun(topic, apiKey || undefined, model);
      setRunId(res.run_id);
      setReform(res.reform);
      setStage("search");
      setDone((d) => ({ ...d, query: true, reformulate: true, search: true }));
      const p = res.papers || [];
      setPapers(p);
      const ap = {}; p.forEach((x) => (ap[x.idx] = true));
      setApproved(ap);
      setStage("filter");
    } catch (e) {
      setError({ stage: "Query Reformulator / Academic Search", msg: e.message });
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
      const synRes = await api.synthesize(runId, apiKey || undefined, model);
      setExtractions(synRes.extractions);
      setSynth(synRes.synthesis);
      setDone((d) => ({ ...d, extract: true, synthesize: true }));

      setStage("write");
      const writeRes = await api.write(runId, apiKey || undefined, model);
      setSections(writeRes.sections);
      setSideModules(writeRes.side_modules);
      setDone((d) => ({ ...d, write: true }));
      setStage("done");
      setMemory((m) => (m.includes(topic) ? m : [topic, ...m].slice(0, 6)));
      setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (e) {
      setError({ stage: "Reader & Extractor / Critic & Synthesizer / Writer", msg: e.message });
    } finally {
      setBusy(false);
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

  return (
    <div className="sm-root">
      <div className="sm-wrap">
        <div className="sm-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Multi-agent literature review · live pipeline</div>
            <div className="sm-title"><b>Saṃhitā</b> <span style={{ color: "var(--muted)", fontWeight: 400 }}>/ lit-review agent</span></div>
            <div className="sm-gloss">
              Enter a research question and watch it move through the agent pipeline — reformulate,
              search the live web, filter sources, extract, critique, and write a cited review.
            </div>
          </div>
          <ModelBar model={model} setModel={setModel} apiKey={apiKey} setApiKey={setApiKey} />
        </div>

        <div className="grid">
          <PipelineRail
            stage={stage}
            busy={busy}
            done={done}
            kg={sideModules?.knowledge_graph}
            ranked={synth?.ranked?.length}
            dataReady={!!sideModules}
            memory={memory}
            onRecall={(m) => { if (!busy) { reset(); setTopic(m); } }}
          />

          <div>
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
                <div className="card-h"><div className="ic"><RotateCw size={16} className="spin" /></div><h3>Running search stages</h3></div>
                <div className="muted tiny pulse">Reformulating the query and searching the live web for real papers…</div>
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
              />
            )}

            {busy && (stage === "extract" || stage === "synthesize" || stage === "write") && (
              <div className="card">
                <div className="card-h"><div className="ic"><RotateCw size={16} className="spin" /></div>
                  <h3>{stage === "write" ? "Writing the review" : "Reading, critiquing & ranking sources"}</h3>
                </div>
                <div className="muted tiny pulse">
                  {stage === "write" ? "Drafting cited sections…" : "Extracting structured info and detecting themes/gaps/biases…"}
                </div>
              </div>
            )}

            {stage === "done" && (
              <div ref={reviewRef}>
                <div className="card" style={{ paddingBottom: 0 }}>
                  <div className="tabs">
                    {[
                      ["review", BookOpen, "Review"],
                      ["sources", Layers, "Sources"],
                      ["critique", Brain, "Critique"],
                      ["graph", Network, "Knowledge graph"],
                      ["data", BarChart3, "Data analysis"],
                      ["eval", FlaskConical, "Evaluation"],
                    ].map(([k, Ic, lab]) => (
                      <button key={k} className={"tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>
                        <Ic size={13} /> {lab}
                      </button>
                    ))}
                  </div>
                  <div style={{ padding: "20px 0" }}>
                    {tab === "review" && <ReviewView topic={topic} sections={sections} citeOrder={citeOrder} />}
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
                  </div>
                </div>

                <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button className="btn ghost" onClick={() => { const old = topic; reset(); setTopic(old); }}>
                    <RotateCw size={14} /> New run
                  </button>
                  <button className="btn ghost" onClick={() => { reset(); setTopic(""); }}>
                    <Sparkles size={14} /> New topic
                  </button>
                </div>
              </div>
            )}

            <div className="foot">
              Talks to the Saṃhitā backend (FastAPI) running at the address in <code>VITE_API_BASE</code>.
              The Anthropic key lives server-side by default — only paste one above if you want to
              override the server's key for this run.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

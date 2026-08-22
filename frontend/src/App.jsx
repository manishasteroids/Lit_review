import React, { useState, useRef, useEffect, useCallback } from "react";
import { api } from "./api/client.js";
import { ensureAuth, AuthButtons, useSession } from "./Auth.jsx";
import { authEnabled } from "./supabase.js";

import PipelineRail from "./components/PipelineRail.jsx";
import QueryInput, { ModeBar } from "./components/QueryInput.jsx";
import UnderstandingCard from "./components/UnderstandingCard.jsx";
import PaperFilter from "./components/PaperFilter.jsx";
import ReviewView from "./components/ReviewView.jsx";
import SourcesView from "./components/SourcesView.jsx";
import CritiqueView from "./components/CritiqueView.jsx";
import KnowledgeGraphView from "./components/KnowledgeGraphView.jsx";
import DataAnalysisView from "./components/DataAnalysisView.jsx";
import EvaluationView from "./components/EvaluationView.jsx";
import UsageView from "./components/UsageView.jsx";
import LandingPage from "./components/LandingPage.jsx";
import ProfileModal from "./components/ProfileModal.jsx";
import ProjectsModal from "./components/ProjectsModal.jsx";
import ExportBar from "./components/ExportBar.jsx";
import StudioView from "./components/StudioView.jsx";
import { useConfirm } from "./components/ConfirmModal.jsx";
import {
  RotateCw, AlertTriangle, Sparkles, PenTool,
  BookOpen, Layers, Brain, Network, BarChart3, FlaskConical,
  Plus, Trash2, Coins, MessageSquare, ArrowLeft, Folder, ChevronDown,
} from "./components/icons.jsx";

import MethodsPanel from "./components/MethodsPanel.jsx";

// Source icons shown in the progress feed
const SOURCE_ICON = {
  semantic_scholar: "🔬",
  arxiv: "📄",
  pubmed: "🧬",
  openalex: "🌐",
  crossref: "🔗",
  clinicaltrials: "⚕️",
  ieee: "⚡",
  patents: "📜",
};

const TOOLS = [
  ["review", BookOpen, "Review"],
  ["sources", Layers, "Sources"],
  ["studio", MessageSquare, "Studio"],
  ["critique", Brain, "Critique"],
  ["graph", Network, "Knowledge graph"],
  ["data", BarChart3, "Data analysis"],
  ["eval", FlaskConical, "Evaluation"],
  ["methods", FlaskConical, "Methods"],
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

// Absolute timestamp in the user's chosen profile timezone (falls back to
// the browser's own timezone when `tz` is empty/invalid — see ProfileModal's
// "Auto-detect" option, which saves "" for exactly this reason).
function formatTimestamp(iso, tz) {
  if (!iso) return "";
  const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Date(iso).toLocaleString(undefined, tz ? { ...opts, timeZone: tz } : opts);
  } catch {
    return new Date(iso).toLocaleString(undefined, opts);
  }
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
  // Signed-out history prompt (SciSpace-style)
  loginCard: { border: "1px solid var(--line)", borderRadius: 10, padding: "12px 12px 13px", background: "var(--indigo-soft)" },
  loginText: { fontSize: 12, color: "var(--txt)", lineHeight: 1.5, marginBottom: 10 },
};

// "+ New" dropdown menu + inline "New project" popover, anchored under the button.
const NEWMENU = {
  menu: {
    position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30,
    background: "var(--card,#fff)", border: "1px solid var(--line)", borderRadius: 10,
    boxShadow: "0 10px 28px rgba(0,0,0,.14)", padding: 5,
  },
  item: {
    display: "block", width: "100%", textAlign: "left", background: "none", border: "none",
    borderRadius: 7, padding: "8px 9px", fontSize: 12.5, color: "var(--txt)", cursor: "pointer",
    fontFamily: "inherit",
  },
  item2: {
    display: "flex", alignItems: "flex-start", gap: 10, width: "100%", textAlign: "left",
    background: "none", border: "none", borderRadius: 8, padding: "9px 10px", cursor: "pointer",
    fontFamily: "inherit",
  },
  itemIc: {
    flex: "0 0 26px", width: 26, height: 26, borderRadius: 7, background: "var(--indigo-soft)",
    color: "var(--indigo)", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1,
  },
  itemTitle: { display: "block", fontSize: 13, fontWeight: 600, color: "var(--txt)" },
  itemSub: { display: "block", fontSize: 11, color: "var(--muted)", marginTop: 1 },
  popover: {
    position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 31,
    background: "var(--card,#fff)", border: "1px solid var(--line)", borderRadius: 10,
    boxShadow: "0 10px 28px rgba(0,0,0,.14)", padding: 10,
  },
  input: {
    width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid var(--line)",
    fontFamily: "inherit", fontSize: 13, color: "var(--txt)", background: "var(--ink)",
    outline: "none", boxSizing: "border-box",
  },
};

// "File next search under…" chip + popover in the sidebar Project panel.
const PICK = {
  chip: {
    display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
    background: "var(--card,#fff)", border: "1px solid var(--line)", borderRadius: 8,
    padding: "7px 9px", cursor: "pointer", fontFamily: "inherit", color: "var(--txt)",
  },
  chipLabel: {
    flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    fontSize: 12.5, fontWeight: 500,
  },
  itemActive: { background: "var(--indigo-soft)", color: "var(--indigo)", fontWeight: 600 },
};

export default function App() {
  const session = useSession();
  const signedOut = authEnabled && !session;

  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-6");  // still used for paper chat
  const [confirmAsync, confirmModal] = useConfirm();
  const [mode, setMode] = useState("medium");               // search mode drives the pipeline
  const [modes, setModes] = useState([]);
  const [topic, setTopic] = useState("");
  const [stage, setStage] = useState("query");
  const [done, setDone] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [notes, setNotes] = useState({}); // paper idx -> note text
  const [accountTab, setAccountTab] = useState(null);  // "profile" | "settings" | null
  const [showProjects, setShowProjects] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState("");  // project to file the NEXT run under
  const [currentProject, setCurrentProject] = useState(null);  // the project workspace you're "inside", if any
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectErr, setNewProjectErr] = useState(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false); // "file next search under..." popover
  const [pickerNewOpen, setPickerNewOpen] = useState(false);
  const [pickerNewName, setPickerNewName] = useState("");
  const [pickerBusy, setPickerBusy] = useState(false);

  const refreshProjects = useCallback(() => {
    if (signedOut) { setProjects([]); return; }
    api.listProjects().then((d) => setProjects(d.projects || [])).catch(() => {});
  }, [signedOut]);
  useEffect(() => { refreshProjects(); }, [refreshProjects]);

  // Re-fetch the project you're currently "inside" (its run list, mainly) —
  // used after an action that changes which runs belong to it, e.g. filing
  // an existing History run under it. Set via setCurrentProject with a
  // functional update so it only touches state if you're still in the same
  // project by the time the fetch resolves (nothing to do if you navigated
  // away, and nothing to overwrite with if you'd switched to a different one).
  const refreshCurrentProject = useCallback(() => {
    setCurrentProject((cur) => {
      if (!cur) return cur;
      api.getProject(cur.id).then((p) => {
        if (p && !p.error) setCurrentProject((now) => (now && now.id === p.id ? p : now));
      }).catch(() => {});
      return cur;
    });
  }, []);

  // Timezone the user picked in Settings, for absolute History timestamps.
  // "" means auto-detect (browser timezone) — see formatTimestamp() above.
  const [profileTz, setProfileTz] = useState("");
  const refreshProfileTz = useCallback(() => {
    if (signedOut) { setProfileTz(""); return; }
    api.getProfile().then((p) => setProfileTz(p.timezone_pref || "")).catch(() => {});
  }, [signedOut]);
  useEffect(() => { refreshProfileTz(); }, [refreshProfileTz]);

  async function createProjectAndOpen(e) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setNewProjectBusy(true); setNewProjectErr(null);
    try {
      const p = await api.createProject(newProjectName.trim(), "");
      refreshProjects();
      setNewProjectOpen(false); setNewProjectName("");
      openProject(p);
    } catch (e2) {
      setNewProjectErr(e2.message || "Could not create project.");
    } finally {
      setNewProjectBusy(false);
    }
  }

  // Create a project from the "file next search under…" picker without
  // entering its workspace — just selects it so the next run gets filed there.
  async function createProjectAndSelect(e) {
    e.preventDefault();
    if (!pickerNewName.trim()) return;
    setPickerBusy(true);
    try {
      const p = await api.createProject(pickerNewName.trim(), "");
      refreshProjects();
      setSelectedProject(p.id);
      setPickerNewOpen(false); setPickerNewName(""); setProjectPickerOpen(false);
    } catch (e2) {
      setError(e2.message || "Could not create project.");
    } finally {
      setPickerBusy(false);
    }
  }

  const [runId, setRunId] = useState(null);
  const [reform, setReform] = useState(null);
  const [papers, setPapers] = useState([]);
  const [approved, setApproved] = useState({});
  const [extractions, setExtractions] = useState([]);
  const [extractStats, setExtractStats] = useState(null);  // full-text coverage (Deep)
  const [synth, setSynth] = useState(null);
  const [sections, setSections] = useState({});
  const [sideModules, setSideModules] = useState(null);
  const [evalRes, setEvalRes] = useState(null);
  const [experimentPlan, setExperimentPlan] = useState(null);
  const [experimentCritique, setExperimentCritique] = useState(null);
  const [experimentIterations, setExperimentIterations] = useState(0);
  const [experimentDebate, setExperimentDebate] = useState({});  // hypothesis index -> [{argument,stance,response}]
  const [experimentKgBridges, setExperimentKgBridges] = useState([]);  // see backend pipeline/knowledge_graph.find_bridge_candidates
  const [tab, setTab] = useState("review");
  const [prevTab, setPrevTab] = useState("review"); // Studio opens full-screen — Back returns here
  const reviewRef = useRef(null);
  const isDone = stage === "done";

  // Editable Sources state (post-synthesis): which papers are included, and
  // whether the downstream analysis (synth/critique/graph/data/draft) is stale.
  const [included, setIncluded] = useState({}); // idx -> bool
  const [analysisStale, setAnalysisStale] = useState(false);

  // Live progress messages during search
  const [progressMsgs, setProgressMsgs] = useState([]);

  // Session list from backend (no LLM) + delete-confirm state
  const [sessions, setSessions] = useState([]);
  const [confirmId, setConfirmId] = useState(null);
  const [fileMenuId, setFileMenuId] = useState(null); // which History row's "add to project" popover is open
  const [fileMenuNewOpen, setFileMenuNewOpen] = useState(false);
  const [fileMenuNewName, setFileMenuNewName] = useState("");
  const [fileMenuBusy, setFileMenuBusy] = useState(false);

  // History is per-user: skip the fetch entirely while signed out.
  const refreshSessions = useCallback(() => {
    if (signedOut) { setSessions([]); return; }
    api.listSessions()
      .then((d) => setSessions(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [signedOut]);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  // Which model each pipeline stage runs on (per-purpose routing), for the rail.
  const [pipelineModels, setPipelineModels] = useState(null);
  useEffect(() => {
    api.pipelineModels(model, mode).then(setPipelineModels).catch(() => {});
  }, [model, mode]);
  useEffect(() => {
    api.getModes().then((r) => setModes(r.modes || [])).catch(() => {});
  }, []);

  function reset() {
    setRunId(null); setReform(null); setPapers([]); setApproved({});
    setExtractions([]); setExtractStats(null); setSynth(null); setSections({}); setSideModules(null);
    setEvalRes(null); setError(null); setDone({}); setStage("query");
    setExperimentPlan(null); setExperimentCritique(null); setExperimentIterations(0); setExperimentDebate({});
    setExperimentKgBridges([]);
    setTab("review"); setProgressMsgs([]); setNotes({});
    setIncluded({}); setAnalysisStale(false);
  }

  // Leave whatever project you're in (if any) and start a blank, unfiled chat.
  function startNewChat() {
    setCurrentProject(null);
    setSelectedProject("");
    reset();
    setTopic("");
  }

  // Enter a project's workspace: every new search now files under it
  // (selectedProject), the header shows its name, and we jump straight to
  // its most recently updated run (or, optionally, a specific one) so
  // opening a project always resumes prior work instead of a blank slate.
  function openProject(proj, runIdToOpen) {
    setShowProjects(false);
    setCurrentProject(proj);
    setSelectedProject(proj.id);
    const target = runIdToOpen || (proj.runs || [])[0]?.id;
    if (target) restoreSession(target);
    else { reset(); setTopic(""); }
  }

  function exitProject() {
    setCurrentProject(null);
    setSelectedProject("");
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
        setExperimentPlan(d.experimentPlan || null);
        setExperimentCritique(d.experimentCritique || null);
        setExperimentIterations((d.experimentIterations || []).length);
        setExperimentDebate(d.experimentDebate || {});
        setExperimentKgBridges(d.experimentKgBridges || []);
        const inc = {};
        Object.entries(d.approved || {}).forEach(([k, v]) => { if (v) inc[Number(k)] = true; });
        setIncluded(inc);
        setAnalysisStale(false);
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

  // File an already-searched History run under a project (existing or new)
  // after the fact — separate from `selectedProject`/`currentProject`, which
  // only apply to runs started FROM INSIDE a project going forward.
  async function fileSessionUnderProject(sessionId, projectId) {
    setFileMenuBusy(true);
    try {
      await api.assignRunProject(sessionId, projectId);
      setFileMenuId(null);
      setFileMenuNewOpen(false);
      setFileMenuNewName("");
      refreshSessions();
      refreshProjects();
      refreshCurrentProject();
    } catch (e) {
      setError({ stage: "File under project", msg: e.message });
    } finally {
      setFileMenuBusy(false);
    }
  }

  async function createProjectAndFile(sessionId, e) {
    e.preventDefault();
    if (!fileMenuNewName.trim()) return;
    setFileMenuBusy(true);
    try {
      const p = await api.createProject(fileMenuNewName.trim(), "");
      await fileSessionUnderProject(sessionId, p.id);
    } catch (e2) {
      setError({ stage: "File under project", msg: e2.message || "Could not create project." });
      setFileMenuBusy(false);
    }
  }

  // What shows in Sources/Review: a paper the user hasn't removed. `included`
  // is the Sources-stage source of truth (set after filtering, toggled by
  // remove/add); before it's populated we fall back to the filter `approved`.
  const approvedList = papers.filter((p) =>
    included[p.idx] !== undefined ? included[p.idx] : approved[p.idx]
  );
  // Keep the SEARCH-RELEVANCE order the user approved — stable from Paper Filter
  // through Sources and matching the Writer's citation numbering (backend orders
  // citations the same way). The synthesizer's scores still show in the Ranking
  // module and the comparison-table Rank column; they no longer reshuffle this list.
  const citeOrder = approvedList;
  const citeNum = {};
  citeOrder.forEach((p, i) => (citeNum[p.idx] = i + 1));

  async function runStart() {
    // Gated action: anyone can browse, but running the pipeline needs an account.
    if (!(await ensureAuth())) return;

    setBusy(true); setError(null); setStage("reformulate"); setProgressMsgs([]);
    try {
      const res = await api.createRunStream(
        topic.trim(),
        apiKey || undefined,
        model,
        mode,
        (event) => {
          if (event.type === "progress") {
            // The reformulator's output arrives before the slow search — show
            // the "Understanding your question" card as soon as it does.
            if (event.reform) setReform(event.reform);
            setProgressMsgs((prev) => {
              const last = prev[prev.length - 1];
              if (last?.message === event.message) return prev;
              return [...prev, event];
            });
            if (event.step === "reformulate") setStage("reformulate");
            if (event.step === "search") setStage("search");
          }
        },
        selectedProject || undefined
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
      if (selectedProject) { refreshProjects(); refreshCurrentProject(); }
    } catch (e) {
      setError({ stage: "Query Reformulator / Academic Search", msg: e.message, retry: runStart });
      setStage("query");
    } finally {
      setBusy(false);
    }
  }

  // Studio-only entry: skip search entirely, land on Sources with an empty
  // paper list ready for "+ Add paper" > "Or upload a file" — once at least
  // one document is uploaded, Studio (and everything else — Update analysis,
  // Generate literature review — all still work, since this is just a run
  // with papers=[] rather than a different kind of run).
  async function startAnalyzeDocs() {
    if (!(await ensureAuth())) return;
    setBusy(true); setError(null);
    try {
      const res = await api.createBlankRun(topic.trim() || undefined, selectedProject || undefined);
      reset();
      setRunId(res.run_id);
      setTopic(res.topic || "");
      setStage("done");
      setDone({ query: true, reformulate: true, search: true, extract: true, synthesize: true });
      setTab("sources");
      refreshSessions();
      if (selectedProject) { refreshProjects(); refreshCurrentProject(); }
    } catch (e) {
      setError({ stage: "Analyze your own documents", msg: e.message, retry: startAnalyzeDocs });
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
    setBusy(true); setError(null); setProgressMsgs([]);
    try {
      await api.filterPapers(runId, approvedIndices);
      setStage("extract");
      // Streamed: rows tick in as each batch of papers is read, then the
      // synthesizer runs — instead of one blank "Extracting…" spinner.
      const doneEv = await api.synthesizeStream(
        runId, apiKey || undefined, model, notes,
        (event) => {
          if (event.type === "progress") {
            setProgressMsgs((prev) => {
              const last = prev[prev.length - 1];
              if (last?.message === event.message) return prev;
              return [...prev, event];
            });
            if (event.step === "synthesize") setStage("synthesize");
          }
        }
      );
      setExtractions(doneEv.extractions);
      setExtractStats(doneEv.extract_stats || null);
      setSynth(doneEv.synthesis);
      setSideModules(doneEv.side_modules);
      // Everything approved at the filter stage starts "included" on the Sources page.
      const inc = {}; approvedIndices.forEach((i) => (inc[i] = true));
      setIncluded(inc);
      setAnalysisStale(false);
      setDone((d) => ({ ...d, extract: true, synthesize: true }));
      setStage("done");
      setTab("sources");
      refreshSessions();
      setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (e) {
      setError({ stage: "Reader & Extractor / Critic & Synthesizer", msg: e.message, retry: runApprove });
    } finally {
      setBusy(false);
    }
  }

  // ── Sources page editing ────────────────────────────────────────────
  function removeSources(indices) {
    setIncluded((prev) => {
      const n = { ...prev };
      indices.forEach((i) => { n[i] = false; });
      return n;
    });
    setAnalysisStale(true);
  }

  async function addPaperToSources(paper) {
    const res = await api.addPaper(runId, paper, apiKey || undefined, model, notes);
    const np = { ...res.paper, added: true };
    setPapers((prev) => [...prev, np]);
    if (res.extraction) {
      setExtractions((prev) => [...prev.filter((e) => e.idx !== np.idx), res.extraction]);
    }
    setIncluded((prev) => ({ ...prev, [np.idx]: true }));
    setAnalysisStale(true);
    refreshSessions();
    return np;
  }

  // Same as addPaperToSources, but for a locally-uploaded PDF/DOCX instead of
  // a resolved search result — extraction happens server-side in one call.
  async function uploadPaperToSources(file) {
    const res = await api.uploadPaper(runId, file, apiKey || undefined, model, notes);
    const np = { ...res.paper, added: true };
    setPapers((prev) => [...prev, np]);
    if (res.extraction) {
      setExtractions((prev) => [...prev.filter((e) => e.idx !== np.idx), res.extraction]);
    }
    setIncluded((prev) => ({ ...prev, [np.idx]: true }));
    setAnalysisStale(true);
    refreshSessions();
    return np;
  }

  async function reanalyzeSources() {
    const includedIndices = papers.filter((p) => included[p.idx]).map((p) => p.idx);
    if (includedIndices.length < 1) {
      setError({ stage: "Update analysis", msg: "Include at least one source." });
      return;
    }
    setBusy(true); setError(null);
    try {
      const r = await api.reanalyze(runId, includedIndices, apiKey || undefined, model, notes);
      setExtractions(r.extractions);
      setSynth(r.synthesis);
      setSideModules(r.side_modules);
      setSections(r.sections || {});
      setDone((d) => ({ ...d, write: Object.keys(r.sections || {}).length > 0 }));
      setAnalysisStale(false);
      refreshSessions();
    } catch (e) {
      setError({ stage: "Update analysis", msg: e.message, retry: reanalyzeSources });
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
      const writeRes = await api.write(runId, apiKey || undefined, model, notes, mode);
      setSections(writeRes.sections);
      if (writeRes.side_modules) setSideModules(writeRes.side_modules);
      setDone((d) => ({ ...d, write: true }));
      setTab("review");
      refreshSessions();
    } catch (e) {
      setError({ stage: "Writer Agent", msg: e.message, retry: runWrite });
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
      setError({ stage: "Evaluator", msg: e.message, retry: runEvaluate });
    } finally {
      setBusy(false);
    }
  }

  async function runDesignExperiments() {
    setBusy(true); setError(null);
    try {
      const res = await api.designExperiments(runId, apiKey || undefined, model);
      setExperimentPlan(res.experiment_plan);
      setExperimentCritique(null);
      setExperimentIterations(0);
      setExperimentKgBridges(res.experiment_kg_bridges || []);
    } catch (e) {
      setError({ stage: "Experiment Designer", msg: e.message, retry: runDesignExperiments });
    } finally {
      setBusy(false);
    }
  }

  // Recursive self-improvement pass: critique the current plan and revise
  // any weak hypothesis, up to a couple of rounds server-side. Safe to call
  // with no existing plan — the backend designs one first in that case.
  async function runRefineExperiments() {
    setBusy(true); setError(null);
    try {
      const res = await api.refineExperiments(runId, apiKey || undefined, model);
      setExperimentPlan(res.experiment_plan);
      setExperimentCritique(res.experiment_critique);
      setExperimentIterations(res.iterations);
      setExperimentKgBridges(res.experiment_kg_bridges || []);
    } catch (e) {
      setError({ stage: "Hypothesis Refinement", msg: e.message, retry: runRefineExperiments });
    } finally {
      setBusy(false);
    }
  }

  // Direct edit — the user overrules/tweaks a hypothesis by hand. Instant,
  // no LLM call, so no busy/spinner state.
  async function updateHypothesis(index, edits) {
    try {
      const res = await api.updateHypothesis(runId, index, edits);
      setExperimentPlan((plan) => {
        if (!plan) return plan;
        const hypotheses = [...(plan.hypotheses || [])];
        hypotheses[index] = res.hypothesis;
        return { ...plan, hypotheses };
      });
      setExperimentCritique((c) =>
        c ? { ...c, critiques: (c.critiques || []).filter((x) => x.index !== index) } : c
      );
    } catch (e) {
      setError({ stage: "Hypothesis Edit", msg: e.message });
    }
  }

  // Argue with one hypothesis — the designer revises it or defends it with a
  // specific counter-reason (never just concedes to be agreeable). Doesn't
  // touch the hypothesis itself: "both agree" means the human decides
  // whether to apply the proposed revision, via acceptRevision() below.
  async function disputeHypothesis(index, argument) {
    setBusy(true); setError(null);
    try {
      const res = await api.disputeHypothesis(runId, index, argument, apiKey || undefined, model);
      setExperimentDebate((d) => ({ ...d, [index]: res.history }));
      return res;
    } catch (e) {
      setError({ stage: "Hypothesis Dispute", msg: e.message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  // The human agrees with a proposed revision from a dispute round — apply
  // it via the same instant, no-LLM-call path as a manual edit.
  function acceptRevision(index, proposed) {
    return updateHypothesis(index, proposed);
  }

  async function exportExperiments(fmt) {
    try {
      await api.downloadExperimentsExport(runId, fmt);
    } catch (e) {
      setError({ stage: "Methods Export", msg: e.message });
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

  // Signed-out visitors see the public landing page; the tools app is gated
  // behind login. (All hooks above run unconditionally, so this early return
  // is safe.)
  if (signedOut) return <LandingPage />;

  return (
    <div className="sm-root">
      {confirmModal}

      {/* Studio opens as a near-full-screen overlay instead of a cramped
          embedded panel — it's a whole workspace (chat + report/deck/brief
          generation), not a small side tool. Back returns to whatever tab
          was showing before Studio was opened. */}
      {tab === "studio" && isDone && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(20,20,30,.55)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 800, padding: "3vh 3vw",
          }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setTab(prevTab); }}
        >
          <div
            style={{
              width: "100%", height: "100%", maxWidth: "100%",
              background: "var(--bg, #f4f5f9)", borderRadius: 14,
              boxShadow: "0 30px 90px rgba(0,0,0,.35)",
              display: "flex", flexDirection: "column", overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "12px 18px", borderBottom: "1px solid var(--line)",
                background: "var(--card, #fff)", flex: "0 0 auto",
              }}
            >
              <button className="btn ghost sm" onClick={() => setTab(prevTab)}>
                <ArrowLeft size={14} /> Back
              </button>
              <span style={{ fontWeight: 700, fontSize: 14.5 }}>Studio</span>
              <span className="muted tiny">Chat, report, deck & briefing across your sources</span>
            </div>
            <div style={{ flex: "1 1 auto", overflow: "auto", padding: 18 }}>
              <StudioView runId={runId} papers={citeOrder} extractions={extractions} apiKey={apiKey} />
            </div>
          </div>
        </div>
      )}

      {accountTab && (
        <ProfileModal user={session?.user} tab={accountTab}
          onClose={() => { setAccountTab(null); refreshProfileTz(); }} />
      )}

      {showProjects && (
        <ProjectsModal
          onClose={() => { setShowProjects(false); refreshProjects(); }}
          onOpenRun={(id, proj) => openProject(proj, id)}
          onOpenProject={(proj) => openProject(proj)}
        />
      )}
      <div className="sm-wrap wide">
        <div className="sm-head" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              {currentProject ? "Project workspace" : "Multi-agent literature review · live pipeline"}
            </div>
            <div className="sm-title">
              <b>Sift</b>{" "}
              <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                / {currentProject ? currentProject.name : "lit-review agent"}
              </span>
            </div>
            <div className="sm-gloss">
              {currentProject
                ? "Every search you run here is filed under this project — papers, notes and review history all stay together."
                : "Enter a research question and watch it move through the agent pipeline — reformulate, search the live web, filter sources, extract, critique, and write a cited review."}
            </div>
          </div>
          <div style={{ flexShrink: 0, paddingTop: 4, display: "flex", alignItems: "center", gap: 10 }}>
            <AuthButtons
              extraItems={[{
                label: "Profile",
                onClick: () => setAccountTab("profile"),
              }, {
                label: "Settings",
                onClick: () => setAccountTab("settings"),
              }, {
                label: "Delete all my data",
                danger: true,
                onClick: async () => {
                  const ok = await confirmAsync("Permanently delete all your saved runs? This cannot be undone.",
                    { title: "Delete all data?", danger: true, confirmLabel: "Delete everything" });
                  if (!ok) return;
                  try {
                    await api.deleteAllSessions();
                    reset(); setTopic("");
                    refreshSessions();
                  } catch (e) {
                    setError({ stage: "Delete data", msg: e.message });
                  }
                },
              }]}
            />
          </div>
        </div>

        <div className="grid3">
          {/* LEFT: Tools + History */}
          <div className="lcol">
            <div style={{ position: "relative" }}>
              <button
                className="btn"
                disabled={busy}
                onClick={() => setNewMenuOpen((o) => !o)}
                style={{ width: "100%", justifyContent: "center", display: "flex", alignItems: "center", gap: 6 }}
              >
                <Plus size={14} /> New {newMenuOpen ? "▴" : "▾"}
              </button>
              {newMenuOpen && (
                <div style={NEWMENU.menu} onMouseLeave={() => setNewMenuOpen(false)}>
                  <button style={NEWMENU.item2} onClick={() => { setNewMenuOpen(false); if (!busy) startNewChat(); }}>
                    <span style={NEWMENU.itemIc}><MessageSquare size={15} /></span>
                    <span>
                      <span style={NEWMENU.itemTitle}>New chat</span>
                      <span style={NEWMENU.itemSub}>Start a fresh research question</span>
                    </span>
                  </button>
                  <button style={NEWMENU.item2} onClick={() => { setNewMenuOpen(false); setNewProjectOpen(true); }}>
                    <span style={NEWMENU.itemIc}><Folder size={15} /></span>
                    <span>
                      <span style={NEWMENU.itemTitle}>New project</span>
                      <span style={NEWMENU.itemSub}>Group searches, papers &amp; notes together</span>
                    </span>
                  </button>
                  <button style={NEWMENU.item2} onClick={() => { setNewMenuOpen(false); setShowProjects(true); }}>
                    <span style={NEWMENU.itemIc}><Layers size={15} /></span>
                    <span>
                      <span style={NEWMENU.itemTitle}>Open existing project</span>
                      <span style={NEWMENU.itemSub}>Browse, share &amp; manage your projects</span>
                    </span>
                  </button>
                </div>
              )}
              {newProjectOpen && (
                <form onSubmit={createProjectAndOpen} style={NEWMENU.popover}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>New project</div>
                  <input autoFocus style={NEWMENU.input} placeholder="Project name"
                    value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} />
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button type="submit" disabled={newProjectBusy} className="btn sm" style={{ flex: 1 }}>
                      {newProjectBusy ? "Creating…" : "Create & open"}
                    </button>
                    <button type="button" className="btn ghost sm" onClick={() => setNewProjectOpen(false)}>Cancel</button>
                  </div>
                  {newProjectErr && <div style={{ color: "#f08a8a", fontSize: 11.5, marginTop: 6 }}>{newProjectErr}</div>}
                </form>
              )}
            </div>

            <div className="panel">
              <div className="panel-head-label" style={{ marginBottom: 12 }}>Tools</div>
              {TOOLS.map(([k, Ic, lab]) => {
                // Token usage isn't tied to any one run — it's useful with no
                // active session too (spend trend, all-time totals) — so it
                // stays enabled regardless of where the current run is.
                const enabled = isDone || k === "usage";
                return (
                  <button
                    key={k}
                    className={"tool-item" + (enabled && tab === k ? " on" : "") + (enabled ? "" : " disabled")}
                    disabled={!enabled}
                    onClick={() => {
                      if (!enabled) return;
                      // Studio opens as a full-screen overlay (see below) —
                      // remember what was showing underneath so Back returns
                      // to it instead of an arbitrary tab.
                      if (k === "studio" && tab !== "studio") setPrevTab(tab);
                      setTab(k);
                    }}
                  >
                    <Ic size={14} /> {lab}
                  </button>
                );
              })}
            </div>

            {!signedOut && (
              <div className="panel">
                <div style={H.head}>
                  <span className="panel-head-label">Project</span>
                  {!currentProject && (
                    <button style={H.newBtn} onClick={() => setShowProjects(true)} title="Manage projects">
                      <Plus size={14} />
                    </button>
                  )}
                </div>
                {currentProject ? (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--txt)" }}>{currentProject.name}</div>
                    <div style={{ ...H.empty, padding: "4px 2px 8px" }}>
                      New searches file under this project. Pick a run below to reopen it.
                    </div>
                    {(currentProject.runs || []).length === 0 ? (
                      <div style={{ ...H.empty, padding: "0 2px 8px" }}>No runs in this project yet.</div>
                    ) : (
                      <div style={{ ...H.scroll, maxHeight: 220, marginBottom: 8 }}>
                        {currentProject.runs.map((r) => (
                          <div
                            key={r.id}
                            style={{ ...H.item, ...(r.id === runId ? H.itemActive : {}) }}
                            onClick={() => !busy && restoreSession(r.id)}
                            title={r.topic}
                          >
                            <div style={H.itemTopic}>{r.topic || "Untitled review"}</div>
                            <div style={H.meta}>
                              <span style={{ ...H.badge, ...(r.stage === "done" ? H.badgeDone : H.badgeFilter) }}>
                                {r.stage === "done" ? "✓ review" : "◦ filter"}
                              </span>
                              <span style={H.dot}>·</span>
                              <span>{r.paper_count}p</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={H.newBtn} onClick={() => { reset(); setTopic(""); }}>+ New search</button>
                      <button style={H.newBtn} onClick={() => setShowProjects(true)}>Manage</button>
                      <button style={H.newBtn} onClick={exitProject}>Exit project</button>
                    </div>
                  </div>
                ) : stage === "query" ? (
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      style={PICK.chip}
                      onClick={() => { setPickerNewOpen(false); setProjectPickerOpen((o) => !o); }}
                    >
                      <Folder size={13} />
                      <span style={PICK.chipLabel}>
                        {selectedProject
                          ? (projects.find((p) => p.id === selectedProject)?.name || "Project")
                          : "File under a project…"}
                      </span>
                      <ChevronDown size={13} style={{ flexShrink: 0, opacity: .6 }} />
                    </button>

                    {projectPickerOpen && (
                      <div style={NEWMENU.menu} onClick={(e) => e.stopPropagation()}
                        onMouseLeave={() => { if (!pickerNewOpen) setProjectPickerOpen(false); }}>
                        <button
                          style={{ ...NEWMENU.item, ...(!selectedProject ? PICK.itemActive : {}) }}
                          onClick={() => { setSelectedProject(""); setProjectPickerOpen(false); }}
                        >
                          No project (unfiled)
                        </button>
                        {projects.map((p) => (
                          <button
                            key={p.id}
                            style={{ ...NEWMENU.item, ...(p.id === selectedProject ? PICK.itemActive : {}) }}
                            onClick={() => { setSelectedProject(p.id); setProjectPickerOpen(false); }}
                          >
                            {p.id === selectedProject ? "✓ " : ""}{p.name}
                          </button>
                        ))}
                        {projects.length === 0 && !pickerNewOpen && (
                          <div style={{ ...H.empty, padding: "4px 9px" }}>No projects yet.</div>
                        )}
                        {pickerNewOpen ? (
                          <form onSubmit={createProjectAndSelect} style={{ padding: 6 }}>
                            <input autoFocus style={NEWMENU.input} placeholder="Project name"
                              value={pickerNewName} onChange={(e) => setPickerNewName(e.target.value)} />
                            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                              <button type="submit" disabled={pickerBusy} className="btn sm" style={{ flex: 1 }}>
                                {pickerBusy ? "Creating…" : "Create & select"}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <button style={{ ...NEWMENU.item, color: "var(--indigo)" }}
                            onClick={() => setPickerNewOpen(true)}>
                            + New project
                          </button>
                        )}
                      </div>
                    )}

                    {!selectedProject && projects.length === 0 && (
                      <div style={{ ...H.empty, padding: "6px 2px 0" }}>
                        File this search under a project to keep its papers, notes and history together.
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}

            <div className="panel">
              <div style={H.head}>
                <span className="panel-head-label">History</span>
              </div>

              {signedOut ? (
                <div style={H.loginCard}>
                  <div style={H.loginText}>
                    Log in to save your runs and access your history and library.
                  </div>
                  <button className="btn sm" style={{ width: "100%" }} onClick={() => ensureAuth()}>
                    Log in
                  </button>
                </div>
              ) : sessions.length === 0 ? (
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
                            style={{ ...H.item, position: "relative", ...(s.id === runId ? H.itemActive : {}) }}
                            onClick={() => !busy && restoreSession(s.id)}
                            onMouseLeave={() => setConfirmId(null)}
                            title={s.topic}
                          >
                            <div style={H.itemTop}>
                              <span style={H.itemTopic}>{s.topic}</span>
                              <span style={{ display: "flex", flexShrink: 0 }}>
                                <button
                                  style={{ ...H.del, ...(fileMenuId === s.id ? { color: "var(--indigo)" } : {}) }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setFileMenuNewOpen(false);
                                    setFileMenuId((id) => (id === s.id ? null : s.id));
                                  }}
                                  title="Add to project"
                                >
                                  <Folder size={12} />
                                </button>
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
                              </span>
                            </div>
                            <div style={H.meta}>
                              <span style={{ ...H.badge, ...(s.stage === "done" ? H.badgeDone : H.badgeFilter) }}>
                                {s.stage === "done" ? "✓ review" : "◦ filter"}
                              </span>
                              <span style={H.dot}>·</span>
                              <span>{s.paper_count}p</span>
                              <span style={H.dot}>·</span>
                              <span title={relativeTime(s.updated_at)}>{formatTimestamp(s.updated_at, profileTz)}</span>
                              {s.project_id && (
                                <>
                                  <span style={H.dot}>·</span>
                                  <span title="Filed under this project">
                                    📁 {projects.find((p) => p.id === s.project_id)?.name || "project"}
                                  </span>
                                </>
                              )}
                            </div>

                            {fileMenuId === s.id && (
                              <div style={NEWMENU.menu} onClick={(e) => e.stopPropagation()}>
                                {s.project_id && (
                                  <button style={NEWMENU.item} disabled={fileMenuBusy}
                                    onClick={() => fileSessionUnderProject(s.id, null)}>
                                    Remove from project
                                  </button>
                                )}
                                {projects.filter((p) => p.id !== s.project_id).map((p) => (
                                  <button key={p.id} style={NEWMENU.item} disabled={fileMenuBusy}
                                    onClick={() => fileSessionUnderProject(s.id, p.id)}>
                                    {p.name}
                                  </button>
                                ))}
                                {projects.length === 0 && !fileMenuNewOpen && (
                                  <div style={{ ...H.empty, padding: "4px 9px" }}>No projects yet.</div>
                                )}
                                {fileMenuNewOpen ? (
                                  <form onSubmit={(e) => createProjectAndFile(s.id, e)} style={{ padding: 6 }}>
                                    <input autoFocus style={NEWMENU.input} placeholder="Project name"
                                      value={fileMenuNewName} onChange={(e) => setFileMenuNewName(e.target.value)} />
                                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                                      <button type="submit" disabled={fileMenuBusy} className="btn sm" style={{ flex: 1 }}>
                                        {fileMenuBusy ? "Creating…" : "Create & file"}
                                      </button>
                                    </div>
                                  </form>
                                ) : (
                                  <button style={{ ...NEWMENU.item, color: "var(--indigo)" }}
                                    onClick={() => setFileMenuNewOpen(true)}>
                                    + New project
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null
                  ))}
                </div>
              )}

              <div style={H.foot}>
                {signedOut
                  ? "Your runs are saved to your account · nothing is stored while signed out"
                  : "Sessions saved to your account · no LLM needed to restore"}
              </div>
            </div>
          </div>

          {/* CENTER: Model selection + prompt / stage content */}
          <div className="ccol">
            {/* Sticky + same top offset as the Tools/Project/History rail
                (lcol) and the Agent Pipeline rail (rcol) — otherwise this
                scrolls out of sync with them and no longer lines up once
                the page is scrolled. */}
            <div style={{
              marginBottom: 16, display: "flex", justifyContent: "flex-end",
              position: "sticky", top: 18, zIndex: 5, background: "var(--ink)", paddingBottom: 4,
            }}>
              <ModeBar modes={modes} mode={mode} setMode={setMode} apiKey={apiKey} setApiKey={setApiKey} />
            </div>

            {error && (
              <div className="err" style={{ marginBottom: 16 }}>
                <AlertTriangle size={18} style={{ flex: "0 0 18px", marginTop: 1 }} />
                <div>
                  <b>{error.stage} failed.</b> {error.msg}
                  <div style={{ marginTop: 8 }}>
                    <button
                      className="btn ghost sm"
                      onClick={() => {
                        const retry = error.retry || (papers.length ? runApprove : runStart);
                        setError(null);
                        retry();
                      }}
                    >
                      <RotateCw size={13} /> Retry stage
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Don't compete with the Token Usage card below: before any run
                starts, stage stays "query" indefinitely, and Token Usage is
                the one tab reachable at that point (see `enabled` above) —
                without this check both the topic-input form AND the usage
                card would stack in the same column, making usage look like
                it "doesn't show" until you scroll past the form, or start a
                run (which permanently moves stage off "query"). */}
            {stage === "query" && tab !== "usage" && (
              <QueryInput topic={topic} setTopic={setTopic} busy={busy} onRun={runStart}
                onAnalyzeDocs={startAnalyzeDocs} />
            )}

            {busy && (stage === "reformulate" || stage === "search") && (
              reform ? (
                <UnderstandingCard topic={topic} reform={reform} progressMsgs={progressMsgs} stage={stage} />
              ) : (
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
              )
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

            {busy && (stage === "extract" || stage === "synthesize") && (
              <div className="card">
                <div className="card-h">
                  <div className="ic"><RotateCw size={16} className="spin" /></div>
                  <h3>Reader &amp; Extractor / Critic &amp; Synthesizer</h3>
                  <span className="tag">{stage === "synthesize" ? "synthesizing…" : "reading…"}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 4, maxHeight: 300, overflowY: "auto" }}>
                  {progressMsgs.length === 0 && (
                    <div className="muted tiny pulse">Reading papers…</div>
                  )}
                  {progressMsgs.map((ev, i) => {
                    const isLatest = i === progressMsgs.length - 1;
                    const icon = ev.step === "synthesize" ? "🧩" : "📄";
                    return (
                      <div key={i} style={{
                        display: "flex", alignItems: "flex-start", gap: 8,
                        opacity: isLatest ? 1 : 0.5, fontSize: 12, lineHeight: 1.5,
                        transition: "opacity 0.3s",
                      }}>
                        <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>{icon}</span>
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

            {busy && stage === "write" && (
              <div className="card">
                <div className="card-h">
                  <div className="ic"><RotateCw size={16} className="spin" /></div>
                  <h3>Writer Agent</h3>
                </div>
                <div className="muted tiny pulse">
                  Reading your kept papers and drafting the review — introduction, thematic synthesis, gaps, and conclusion…
                </div>
              </div>
            )}

            {isDone && (
              <div ref={reviewRef}>
                <div className="card">
                  {tab === "review" && (
                    Object.keys(sections || {}).length > 0
                      ? <>
                          <ExportBar runId={runId} onError={(m) => setError({ stage: "Export", msg: m })} />
                          <ReviewView topic={topic} sections={sections} citeOrder={citeOrder} />
                        </>
                      : (
                        <div style={{ textAlign: "center", padding: "28px 16px" }}>
                          <div className="eyebrow" style={{ marginBottom: 8 }}></div>
                          <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>No written review yet</h3>
                          <div className="muted tiny" style={{ maxWidth: 460, margin: "0 auto 16px", lineHeight: 1.6 }}>
                            Your papers are reviewed and ready to explore in Sources, Critique and the
                            other tools. If you'd like, the Writer agent can draft a cited literature
                            review from your kept papers.
                          </div>
                          <button className="btn" disabled={busy || analysisStale} onClick={runWrite}>
                            <PenTool size={15} /> Generate cited review
                          </button>
                          {analysisStale && (
                            <div className="muted tiny" style={{ marginTop: 10 }}>
                              Update the analysis on the Sources tab first.
                            </div>
                          )}
                        </div>
                      )
                  )}
                  {tab === "sources" && (
                    <SourcesView
                      citeOrder={citeOrder} extractions={extractions} ranked={synth?.ranked}
                      extractStats={extractStats} runId={runId} apiKey={apiKey} model={model}
                      papers={papers} included={included} scope={reform?.scope}
                      analysisStale={analysisStale} busy={busy}
                      onRemove={removeSources} onAdd={addPaperToSources}
                      onUpload={uploadPaperToSources}
                      onReanalyze={reanalyzeSources} onGenerate={runWrite}
                      hasReview={Object.keys(sections || {}).length > 0}
                    />
                  )}
                  {tab === "critique" && <CritiqueView synth={synth} />}
                  {tab === "graph" && (
                    <KnowledgeGraphView concepts={sideModules?.knowledge_graph} citeNum={citeNum} papers={citeOrder} />
                  )}
                  {tab === "data" && (
                    <DataAnalysisView
                      reform={reform}
                      yearDistribution={sideModules?.year_distribution}
                      comparisonTable={sideModules?.comparison_table}
                    />
                  )}
                  {tab === "eval" && <EvaluationView evalRes={evalRes} busy={busy} onEvaluate={runEvaluate} />}
                  {tab === "methods" && (
                    <MethodsPanel
                      plan={experimentPlan}
                      critique={experimentCritique}
                      iterations={experimentIterations}
                      debate={experimentDebate}
                      kgBridges={experimentKgBridges}
                      busy={busy}
                      onDesign={runDesignExperiments}
                      onRefine={runRefineExperiments}
                      onUpdate={updateHypothesis}
                      onDispute={disputeHypothesis}
                      onAcceptRevision={acceptRevision}
                      onExport={exportExperiments}
                      papers={papers}
                      extractions={extractions}
                    />
                  )}
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
                  <button className="btn ghost sm" disabled={!citeOrder.length} onClick={() => exportShortlist("bib")}>Export .bib</button>
                </div>
              </div>
            )}

            {/* Token usage stands alone from the pipeline stage — usable with
                no active run (falls back to the all-time spend trend) or
                mid-run/done (shows this session's live totals so far). Kept
                outside the {isDone && ...} block above so it doesn't need a
                finished run to be reachable. */}
            {tab === "usage" && (
              <div className="card">
                <UsageView runId={runId} />
              </div>
            )}

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
              models={pipelineModels}
              showMemory={false}
              hasPlan={!!experimentPlan}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useRef } from "react";
import { api } from "../api/client.js";
import { Sparkles, BarChart3, BookOpen, Lightbulb, Folder, Clock, ChevronDown } from "./icons.jsx";

/**
 * The post-login dashboard home (architecture doc: claude/architecture-
 * dashboard-upgrade.md). Everything on this page reads real data already
 * available to the app (recent projects, real usage totals) rather than the
 * placeholder "research highlights" content from the original visualization
 * mockup — those stay out until Phase 3 actually builds the profile/domain
 * matching they'd need to be real.
 *
 * "Discuss with Sift AI" has two modes (the user picks with the pills below
 * the label):
 *   - "projects": a quick-ask call (api.quickAsk, scope="projects") that
 *     searches the user's own projects/notes/runs and does a brief live web
 *     lookup, answered on the open-weight model (see backend
 *     settings.quick_ask_model) — cheap, not a real Literature Review.
 *   - "review": skips the quick-answer step entirely and starts a real
 *     Literature Review run in Lite mode (onStartLiteReview) — a real,
 *     if shallower, cited pipeline run, not a chat answer.
 */
// The quick-ask model answers in light markdown (mainly **bold**) but this
// box is plain text, not a markdown renderer -- without this, literal "**"
// showed up in the answer. Only handles **bold**, which covers what the
// model actually produces here; upgrade to a real markdown lib if that changes.
function renderLiteMarkdown(text) {
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

export default function HomePage({
  userName, projects, onStartTopic, onStartLiteReview, onOpenLitReview, onOpenHypothesisPicker,
  onOpenDataAnalysis, onOpenProject,
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("projects"); // "projects" | "review"
  const [usage, setUsage] = useState(null);

  // asked()/answer/sources describe the question actually answered (kept
  // separate from the live `q` input so they don't change while the user
  // edits the box for their next question).
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState([]);
  const [askErr, setAskErr] = useState(null);

  // Last few days of this user's quick-ask searches (auto-expires on the
  // backend -- core/quick_ask_history.py) so they can reopen one instead of
  // retyping it, rather than a permanent chat log.
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyWrap = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.getUsageTrend(30).then((d) => { if (!cancelled) setUsage(d); }).catch(() => {});
    api.quickAskHistory().then((d) => { if (!cancelled) setHistory(d.items || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    const onDoc = (e) => { if (historyWrap.current && !historyWrap.current.contains(e.target)) setHistoryOpen(false); };
    const onKey = (e) => e.key === "Escape" && setHistoryOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [historyOpen]);

  async function submit(e) {
    e.preventDefault();
    const t = q.trim();
    if (!t || asking) return;

    if (scope === "review") {
      onStartLiteReview(t);
      return;
    }

    setAsking(true); setAskErr(null); setAnswer(""); setSources([]); setAsked(t);
    try {
      const res = await api.quickAsk(t, { scope: "projects" });
      setAnswer(res.answer || "");
      setSources(res.sources || []);
      setHistory((h) => [
        { id: `local-${Date.now()}`, scope: "projects", question: t, answer: res.answer || "",
          sources: res.sources || [], created_at: new Date().toISOString() },
        ...h,
      ]);
    } catch (err) {
      setAskErr(err.message || "Couldn't get an answer.");
    } finally {
      setAsking(false);
    }
  }

  function reopenHistoryEntry(h) {
    setAsked(h.question);
    setAnswer(h.answer);
    setSources(h.sources || []);
    setAskErr(null);
    setQ(h.question);
    setHistoryOpen(false);
  }

  async function removeHistoryEntry(id, e) {
    e.stopPropagation();
    setHistory((hs) => hs.filter((h) => h.id !== id));
    if (!String(id).startsWith("local-")) {
      try { await api.deleteQuickAskHistory(id); } catch (err) {}
    }
  }

  const recentProjects = [...(projects || [])]
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
    .slice(0, 5);

  const byId = Object.fromEntries((projects || []).map((p) => [p.id, p]));

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 32px" }}>
      <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
        Welcome back{userName ? `, ${userName}` : ""}
      </div>
      <div style={{ color: "var(--muted, #5b6472)", fontSize: 14, marginBottom: 24 }}>
        Here's what's happening across your projects.
      </div>

      <form onSubmit={submit} style={S.searchCard}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          <div style={{ ...S.searchLabel, marginBottom: 0 }}>
            <Sparkles size={13} /> Discuss with Sift AI
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {history.length > 0 && (
              <div ref={historyWrap} style={{ position: "relative" }}>
                <button
                  type="button"
                  style={S.historyTrigger}
                  onClick={() => setHistoryOpen((o) => !o)}
                >
                  <Clock size={12} /> Recent
                  <ChevronDown size={11} style={{ opacity: 0.6, transform: historyOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
                </button>
                {historyOpen && (
                  <div style={S.historyPopover}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted2, #98a0af)", padding: "2px 8px 8px" }}>
                      Recent searches (kept 3 days)
                    </div>
                    {history.slice(0, 8).map((h) => (
                      <div key={h.id} style={S.historyRow} onClick={() => reopenHistoryEntry(h)}>
                        <span style={S.historyQ}>{h.question}</span>
                        <button type="button" style={S.historyDel} onClick={(e) => removeHistoryEntry(h.id, e)} title="Remove">
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              style={S.scopeSelect}
            >
              <option value="projects">Search my projects</option>
              <option value="review">Literature Review (lite)</option>
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={scope === "projects"
              ? "Ask about anything in your projects, or a quick general question"
              : "What should this lite Literature Review look into?"}
            style={S.searchInput}
          />
          <button type="submit" style={S.searchBtn} disabled={asking}>
            {scope === "review" ? "Run" : asking ? "Asking…" : "Ask"}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted2, #98a0af)", marginTop: 8 }}>
          {scope === "projects"
            ? "Searches your own projects/notes/runs plus a quick web lookup — one quick answer, not a cited survey."
            : "Starts a real Literature Review run in Lite mode — fewer papers, faster, still a real cited pipeline."}
        </div>

        {askErr && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: "#c0392b" }}>{askErr}</div>
        )}

        {(asking || answer) && (
          <div style={S.answerBox}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--muted2, #98a0af)", marginBottom: 6 }}>
              {asked}
            </div>
            {asking ? (
              <div style={{ fontSize: 13, color: "var(--muted, #5b6472)" }}>Thinking…</div>
            ) : (
              <>
                <div style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{renderLiteMarkdown(answer)}</div>
                {sources.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
                    <span style={{ fontSize: 11, color: "var(--muted2, #98a0af)", marginRight: 2, alignSelf: "center" }}>
                      Found in:
                    </span>
                    {sources.map((s, i) => (
                      <button
                        key={i} type="button" style={S.sourceChip}
                        onClick={() => byId[s.project_id] && onOpenProject(byId[s.project_id])}
                        title={s.title}
                      >
                        {s.project_name}{s.type !== "project" ? ` · ${s.title}` : ""}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  style={S.escalateBtn}
                  onClick={() => onStartTopic(asked)}
                >
                  Run a full Literature Review on this →
                </button>
              </>
            )}
          </div>
        )}

      </form>

      <div style={S.sectionTitle}>Quick Access</div>
      <div style={S.tileGrid}>
        <Tile icon={<BarChart3 size={20} />} name="Data Visualizations"
          desc="Explore datasets and generate figures" onClick={() => onOpenDataAnalysis("dataviz")} />
        <Tile icon={<BookOpen size={20} />} name="Lit Review"
          desc="Run Sift on a new or existing project" onClick={onOpenLitReview} />
        <Tile icon={<Lightbulb size={20} />} name="Hypothesis Workflow"
          desc="Generate & rank hypotheses from a project" onClick={onOpenHypothesisPicker} />
      </div>

      <div style={S.twoCol}>
        <div style={S.panel}>
          <div style={S.panelTitle}><Folder size={13} /> Recent projects</div>
          {recentProjects.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted, #5b6472)" }}>
              No projects yet — start a Literature Review and file it under a project to see it here.
            </div>
          ) : (
            recentProjects.map((p) => (
              <div key={p.id} style={S.projRow} onClick={() => onOpenProject(p)}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted2, #98a0af)" }}>
                    {p.run_count} run{p.run_count === 1 ? "" : "s"}
                  </div>
                </div>
                <span style={{ color: "var(--muted2, #98a0af)" }}>→</span>
              </div>
            ))
          )}
        </div>
        <div style={S.panel}>
          <div style={S.panelTitle}>Token usage (last 30 days)</div>
          {usage ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 700 }}>
                {((usage.total?.in_tok || 0) + (usage.total?.out_tok || 0)).toLocaleString()} tokens
              </div>
              <div style={{ fontSize: 12.5, color: "var(--muted, #5b6472)", marginTop: 2 }}>
                ${(usage.total?.cost_usd || 0).toFixed(2)} · {usage.total?.calls || 0} calls, all time
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: "var(--muted, #5b6472)" }}>Loading…</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Tile({ icon, name, desc, onClick }) {
  return (
    <button type="button" onClick={onClick} style={S.tile}>
      <div style={{ marginBottom: 10, color: "var(--indigo, #6d5df6)" }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>{name}</div>
      <div style={{ fontSize: 12.5, color: "var(--muted, #5b6472)", lineHeight: 1.4 }}>{desc}</div>
    </button>
  );
}

const S = {
  searchCard: {
    background: "var(--panel, #fff)", border: "1px solid var(--line, #e4e7ef)", borderRadius: 14,
    padding: "18px 20px", marginBottom: 22,
  },
  searchLabel: {
    display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600,
    color: "var(--indigo, #6d5df6)", textTransform: "uppercase", letterSpacing: ".03em", marginBottom: 10,
  },
  scopeSelect: {
    border: "1px solid var(--line, #e4e7ef)", borderRadius: 8, padding: "6px 10px",
    fontSize: 12.5, fontWeight: 600, color: "var(--indigo, #6d5df6)", background: "var(--bg, #f4f5f9)",
    cursor: "pointer", fontFamily: "inherit", outline: "none",
  },
  searchInput: {
    flex: 1, border: "1px solid var(--line, #e4e7ef)", borderRadius: 9, padding: "11px 14px",
    fontSize: 14, outline: "none", fontFamily: "inherit",
  },
  searchBtn: {
    background: "var(--indigo, #6d5df6)", color: "#fff", border: "none", borderRadius: 9,
    padding: "0 18px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  answerBox: {
    marginTop: 14, padding: "12px 14px", background: "var(--bg, #f4f5f9)",
    border: "1px solid var(--line, #e4e7ef)", borderRadius: 10,
  },
  sourceChip: {
    background: "var(--panel, #fff)", border: "1px solid var(--line, #e4e7ef)", borderRadius: 20,
    padding: "3px 10px", fontSize: 11, fontWeight: 600, color: "var(--indigo, #6d5df6)",
    cursor: "pointer", fontFamily: "inherit",
  },
  escalateBtn: {
    marginTop: 10, background: "none", border: "none", color: "var(--indigo, #6d5df6)",
    fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit", display: "block",
  },
  historyTrigger: {
    display: "flex", alignItems: "center", gap: 5, background: "none",
    border: "1px solid var(--line, #e4e7ef)", borderRadius: 8, padding: "6px 10px",
    fontSize: 12, fontWeight: 600, color: "var(--muted, #5b6472)", cursor: "pointer", fontFamily: "inherit",
  },
  historyPopover: {
    position: "absolute", top: "calc(100% + 6px)", right: 0, width: 320, maxHeight: 320, overflowY: "auto",
    background: "var(--panel, #fff)", border: "1px solid #e3e3ec", borderRadius: 12,
    boxShadow: "0 14px 40px rgba(0,0,0,0.16)", padding: "8px 6px", zIndex: 50,
  },
  historyRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    padding: "7px 8px", borderRadius: 7, cursor: "pointer", fontSize: 12.5,
  },
  historyQ: {
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--txt, #1c2128)",
  },
  historyDel: {
    flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: "var(--muted2, #98a0af)",
    fontSize: 15, lineHeight: 1, padding: "2px 6px", fontFamily: "inherit",
  },
  sectionTitle: {
    fontSize: 12.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em",
    color: "var(--muted, #5b6472)", margin: "26px 0 12px",
  },
  tileGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 },
  tile: {
    background: "var(--panel, #fff)", border: "1px solid var(--line, #e4e7ef)", borderRadius: 12,
    padding: 18, cursor: "pointer", textAlign: "left", fontFamily: "inherit",
  },
  twoCol: { display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 20, marginTop: 26 },
  panel: {
    background: "var(--panel, #fff)", border: "1px solid var(--line, #e4e7ef)", borderRadius: 12,
    padding: "16px 18px",
  },
  panelTitle: {
    display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, textTransform: "uppercase",
    letterSpacing: ".03em", color: "var(--muted, #5b6472)", marginBottom: 12, fontWeight: 700,
  },
  projRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0",
    borderBottom: "1px solid var(--line-soft, #eef0f6)", cursor: "pointer",
  },
};

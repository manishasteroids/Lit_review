import React, { useState, useEffect, useRef } from "react";
import { api } from "../api/client.js";
import { BarChart3, BookOpen, Lightbulb, Clock, ChevronDown } from "./icons.jsx";
import WatchList, { WATCH_CHANGED } from "./WatchList.jsx";
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
  onOpenDataAnalysis, onOpenProject, onManageFollowing,
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
  // Earlier turns of the conversation on screen ([{question, answer, sources}]).
  // The current turn lives in asked/answer/sources; a follow-up moves it here.
  const [thread, setThread] = useState([]);
  const [followUp, setFollowUp] = useState("");
  // "From the frontier": new papers in the user's own areas (backend core/frontier.py).
  const [frontier, setFrontier] = useState(null);
  const [frontierBusy, setFrontierBusy] = useState(false);
  // Scholars / laboratories the user follows, and their new papers.
  const [watch, setWatch] = useState(null);
  const watchRef = useRef(null);
  const loadWatch = (refresh) => api.getWatchlist(refresh).then(setWatch)
    .catch(() => setWatch((w) => w || { follows: [], new_total: 0 }));
  const loadFrontier = (refresh) => {
    setFrontierBusy(true);
    return api.getFrontier(refresh).then(setFrontier).catch(() => setFrontier((f) => f || { areas: [] }))
      .finally(() => setFrontierBusy(false));
  };

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
    loadFrontier(false);
    loadWatch(false);
    const reloadWatch = () => loadWatch(false);
    window.addEventListener(WATCH_CHANGED, reloadWatch);
    return () => { cancelled = true; window.removeEventListener(WATCH_CHANGED, reloadWatch); };
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

    setThread([]);                      // the top box always starts a new conversation
    await ask(t, []);
  }

  async function submitFollowUp(e) {
    e.preventDefault();
    const t = followUp.trim();
    if (!t || asking || !answer) return;
    const earlier = [...thread, { question: asked, answer, sources }];
    setThread(earlier); setFollowUp("");
    await ask(t, earlier);
  }

  async function ask(t, earlier) {
    setAsking(true); setAskErr(null); setAnswer(""); setSources([]); setAsked(t);
    try {
      const res = await api.quickAsk(t, {
        scope: "projects", history: earlier.map((x) => ({ question: x.question, answer: x.answer })),
      });
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
    setThread([]); setFollowUp("");
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

  // ---- presentation only below: everything shown is data the page already had
  const firstName = (userName || "").trim().split(/\s+/)[0];
  const hour = new Date().getHours();
  const greeting = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon"
    : hour >= 18 && hour < 23 ? "Good evening" : "Welcome back";
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const totalRuns = (projects || []).reduce((n, p) => n + (p.run_count || 0), 0);
  const [lead, ...rest] = recentProjects;
  const days = (usage?.by_day || []).map((d) => (d.in_tok || 0) + (d.out_tok || 0));
  const peak = Math.max(1, ...days);
  const tokens = (usage?.total?.in_tok || 0) + (usage?.total?.out_tok || 0);
  const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const since = (iso) => {
    if (!iso) return "";
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };

  return (
    <div className="hp">
      <style>{HP_CSS}</style>

      {watch?.new_total > 0 && (
        <button type="button" className="wl-banner"
          onClick={() => watchRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          <i aria-hidden="true" />
          <span>
            <b>{watch.new_total} new paper{watch.new_total === 1 ? "" : "s"}</b> from{" "}
            {(() => {
              const who = watch.follows.filter((f) => f.new_count > 0).map((f) => f.name);
              return who.length <= 2 ? who.join(" and ") : `${who.slice(0, 2).join(", ")} and ${who.length - 2} more`;
            })()}
          </span>
          <span>See them ↓</span>
        </button>
      )}

      <header className="hp-head">
        <div className="hp-eyebrow">{today}</div>
        <h1 className="hp-hello">{greeting}{firstName ? <>, <em>{firstName}</em></> : ""}.</h1>
        <p className="hp-sub">
          {(projects || []).length === 0
            ? "Start with a question below, and your first project will appear here."
            : <>{(projects || []).length} project{(projects || []).length === 1 ? "" : "s"} and {totalRuns} run{totalRuns === 1 ? "" : "s"} in your workspace{lead ? <>. You were last in <b>{lead.name}</b></> : ""}.</>}
        </p>
      </header>

      <form onSubmit={submit} className="hp-ask">
        <div className="hp-ask-top">
          <div className="hp-seg" role="tablist" aria-label="What to do with your question">
            <button type="button" role="tab" aria-selected={scope === "projects"} className={scope === "projects" ? "on" : ""}
              onClick={() => setScope("projects")}>Ask my projects</button>
            <button type="button" role="tab" aria-selected={scope === "review"} className={scope === "review" ? "on" : ""}
              onClick={() => setScope("review")}>Start a lite review</button>
          </div>
          {history.length > 0 && (
            <div ref={historyWrap} style={{ position: "relative", marginLeft: "auto" }}>
              <button type="button" className="hp-ghost" onClick={() => setHistoryOpen((o) => !o)} aria-expanded={historyOpen}>
                <Clock size={12} /> Recent
                <ChevronDown size={11} style={{ opacity: 0.6, transform: historyOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
              </button>
              {historyOpen && (
                <div className="hp-pop">
                  <div className="hp-pop-h">Recent questions · kept 3 days</div>
                  {history.slice(0, 8).map((h) => (
                    <div key={h.id} className="hp-pop-row" onClick={() => reopenHistoryEntry(h)}>
                      <span>{h.question}</span>
                      <button type="button" onClick={(e) => removeHistoryEntry(h.id, e)} title="Remove" aria-label="Remove this question">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="hp-ask-row">
          <input
            value={q} onChange={(e) => setQ(e.target.value)} aria-label="Your question"
            placeholder={scope === "projects"
              ? "What do you want to know?"
              : "What should the review look into?"}
          />
          <button type="submit" disabled={asking}>
            {scope === "review" ? "Run review" : asking ? "Asking…" : "Ask"} <span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="hp-ask-note">
          {scope === "projects"
            ? "Searches your projects, notes and runs, plus a quick web lookup. One short answer, not a cited survey."
            : "Starts a real Literature Review in Lite mode: fewer papers and faster, still fully cited."}
        </div>

        {askErr && <div className="hp-err" role="alert">{askErr}</div>}

        {thread.map((t, i) => (
          <div key={i} className="hp-answer hp-answer-old">
            <div className="hp-answer-q">{t.question}</div>
            <div className="hp-answer-a">{renderLiteMarkdown(t.answer)}</div>
          </div>
        ))}

        {(asking || answer) && (
          <div className="hp-answer">
            <div className="hp-answer-q">{asked}</div>
            {asking ? (
              <div className="hp-muted">Thinking…</div>
            ) : (
              <>
                <div className="hp-answer-a">{renderLiteMarkdown(answer)}</div>
                {sources.length > 0 && (
                  <div className="hp-chips">
                    <span className="hp-muted" style={{ fontSize: 11.5 }}>Found in</span>
                    {sources.map((s, i) => (
                      <button key={i} type="button" title={s.title}
                        onClick={() => byId[s.project_id] && onOpenProject(byId[s.project_id])}>
                        {s.project_name}{s.type !== "project" ? ` · ${s.title}` : ""}
                      </button>
                    ))}
                  </div>
                )}
                <button type="button" className="hp-link" onClick={() => onStartTopic(asked)}>
                  Run a full Literature Review on this →
                </button>
              </>
            )}
          </div>
        )}
      </form>

      {/* Follow-up: its own form (a form cannot sit inside the one above), shown
          once there is an answer to follow up on. */}
      {answer && !asking && scope === "projects" && (
        <form onSubmit={submitFollowUp} className="hp-follow">
          <input value={followUp} onChange={(e) => setFollowUp(e.target.value)} aria-label="Ask a follow-up question"
            placeholder="Ask a follow-up…" autoComplete="off" />
          <button type="submit" disabled={!followUp.trim()}>Send <span aria-hidden="true">→</span></button>
          <button type="button" className="hp-ghost" onClick={() => { setThread([]); setAnswer(""); setAsked(""); setSources([]); setQ(""); setFollowUp(""); }}>
            New question
          </button>
        </form>
      )}

      <div className="hp-grid">
        <section aria-label="Your projects">
          <div className="hp-label">Pick up where you left off</div>
          {!lead ? (
            <div className="hp-empty">
              No projects yet. Run a Literature Review and file it under a project to see it here.
            </div>
          ) : (
            <>
              <button type="button" className="hp-lead" onClick={() => onOpenProject(lead)}>
                <span className="hp-lead-meta">Most recent · {since(lead.updated_at)}</span>
                <span className="hp-lead-name">{lead.name}</span>
                <span className="hp-lead-foot">
                  <span>{lead.run_count} run{lead.run_count === 1 ? "" : "s"}</span>
                  <span className="hp-go">Open project →</span>
                </span>
              </button>
              <div className="hp-list">
                {rest.map((p) => (
                  <button type="button" key={p.id} className="hp-row" onClick={() => onOpenProject(p)}>
                    <span className="hp-row-name">{p.name}</span>
                    <span className="hp-row-meta">{p.run_count} run{p.run_count === 1 ? "" : "s"} · {since(p.updated_at)}</span>
                    <span className="hp-go" aria-hidden="true">→</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        <aside>
          <div className="hp-label">Start something</div>
          <div className="hp-tools">
            <Tool tag="Sift" icon={<BookOpen size={17} />} name="Literature review"
              desc="Search, filter and synthesise the papers on a question." onClick={onOpenLitReview} />
            <Tool tag="Infinity" icon={<Lightbulb size={17} />} name="Hypothesis generation"
              desc="Turn a finished review into ranked, testable hypotheses." onClick={onOpenHypothesisPicker} />
            <Tool tag="Data" icon={<BarChart3 size={17} />} name="Data visualisation"
              desc="Explore a dataset and build figures from it." onClick={() => onOpenDataAnalysis("dataviz")} />
          </div>

          <div className="hp-label" style={{ marginTop: 26 }}>Usage</div>
          <div className="hp-usage">
            {usage ? (
              <>
                <div className="hp-stats">
                  <div><b>{compact(tokens)}</b><span>tokens</span></div>
                  <div><b>${(usage.total?.cost_usd || 0).toFixed(2)}</b><span>spent</span></div>
                  <div><b>{(usage.total?.calls || 0).toLocaleString()}</b><span>model calls</span></div>
                </div>
                <div className="hp-muted" style={{ fontSize: 11.5, marginTop: 2 }}>All time</div>
                {days.length > 1 && (
                  <>
                    <div className="hp-spark" role="img" aria-label={`Daily token use over the last ${days.length} active days`}>
                      {days.map((v, i) => <i key={i} style={{ height: `${Math.max(4, Math.round((v / peak) * 100))}%` }} />)}
                    </div>
                    <div className="hp-muted" style={{ fontSize: 11.5 }}>Tokens per day, last {days.length} active days</div>
                  </>
                )}
              </>
            ) : (
              <div className="hp-muted">Loading…</div>
            )}
          </div>
        </aside>
      </div>

      <WatchList watch={watch} onChanged={() => loadWatch(false)} sectionRef={watchRef} onManage={onManageFollowing} />

      {(frontier?.areas?.length > 0 || (frontier === null && (projects || []).length > 0)) && (
        <section className="hp-frontier" aria-label="New papers in your research areas">
          <div className="hp-frontier-head">
            <div>
              <div className="hp-label" style={{ marginBottom: 6 }}>From the frontier</div>
              <h2 className="hp-h2">New in your research areas, and who is publishing it</h2>
            </div>
            {frontier && (
              <button type="button" className="hp-ghost" disabled={frontierBusy} onClick={() => loadFrontier(true)}>
                {frontierBusy ? "Checking…" : "Refresh"}
              </button>
            )}
          </div>
          {!frontier ? (
            <div className="hp-muted">Looking for recent papers in your areas…</div>
          ) : (
            <>
              <div className="hp-areas">
                {frontier.areas.map((a) => (
                  <div key={a.label} className="hp-area">
                    <div className="hp-area-name" title={a.topic}>{a.label}</div>
                    {a.items.map((it) => (
                      <a key={it.url} className="hp-paper" href={it.url} target="_blank" rel="noopener noreferrer">
                        <span className="hp-paper-title">{it.title}</span>
                        <span className="hp-paper-meta">
                          {[
                            (it.authors || []).join(", ") + (it.more_authors ? ` +${it.more_authors}` : ""),
                            (it.institutions || [])[0],
                            it.venue,
                            it.date ? new Date(it.date + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "",
                          ].filter(Boolean).join(" · ")}
                        </span>
                      </a>
                    ))}

                    {(a.labs || []).length > 0 && (
                      <div className="hp-who">
                        <div className="hp-who-h">Institutions publishing here</div>
                        {a.labs.map((l) => (
                          <div key={l.name} className="hp-who-row">
                            {l.url
                              ? <a href={l.url} target="_blank" rel="noopener noreferrer" className="hp-who-name">{l.name}</a>
                              : <span className="hp-who-name">{l.name}</span>}
                            <span className="hp-who-n">{l.papers} paper{l.papers === 1 ? "" : "s"}{l.country ? ` · ${l.country}` : ""}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {(a.people || []).length > 0 && (
                      <div className="hp-who">
                        <div className="hp-who-h">Researchers</div>
                        {a.people.map((p) => (
                          <div key={p.openalex || p.name} className="hp-person">
                            <div className="hp-who-row">
                              <span className="hp-who-name">{p.name}</span>
                              <span className="hp-who-n">{p.papers} paper{p.papers === 1 ? "" : "s"}</span>
                            </div>
                            {p.institution && <div className="hp-person-inst">{p.institution}</div>}
                            <div className="hp-person-links">
                              <a href={p.scholar_search} target="_blank" rel="noopener noreferrer">Find on Google Scholar</a>
                              {p.orcid && <a href={p.orcid} target="_blank" rel="noopener noreferrer">ORCID</a>}
                              {p.openalex && <a href={p.openalex} target="_blank" rel="noopener noreferrer">All works</a>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="hp-muted" style={{ fontSize: 11.5, marginTop: 16, lineHeight: 1.6, maxWidth: 860 }}>
                Recent papers matched to the questions in your own runs, from OpenAlex and arXiv; papers already in
                your sources are left out. Institutions and researchers are the ones that recur as authors across
                those recent papers, counted over up to 40 per area — a signal of who is active, not a ranking.
                The Google Scholar link searches Scholar for that name, because Scholar offers no way to look up a
                profile's address; check you have the right person. Updated daily.
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Tool({ tag, icon, name, desc, onClick }) {
  return (
    <button type="button" onClick={onClick} className="hp-tool">
      <span className="hp-tool-ic">{icon}</span>
      <span className="hp-tool-txt">
        <span className="hp-tool-tag">{tag}</span>
        <span className="hp-tool-name">{name}</span>
        <span className="hp-tool-desc">{desc}</span>
      </span>
      <span className="hp-go" aria-hidden="true">→</span>
    </button>
  );
}

// Home has its own type system, scoped under .hp so no other page changes:
// Newsreader (serif) for the things you read as headlines -- the greeting and
// project names -- Inter for running text and controls, JetBrains Mono for
// labels and figures. One accent (the app's indigo), used sparingly.
const HP_CSS = `
.hp{max-width:1080px;margin:0 auto;padding:32px 36px 64px;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:0;color:var(--txt,#1c2128);}
.hp button{font-family:inherit;}
.hp-eyebrow,.hp-label{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted2,#98a0af);}
.hp-label{margin:0 0 12px;}
.hp-hello{font-family:'Newsreader',Georgia,serif;font-weight:500;font-size:clamp(26px,2.6vw,32px);line-height:1.15;letter-spacing:-.015em;margin:10px 0 0;overflow-wrap:anywhere;}
.hp-hello em{font-style:italic;color:var(--indigo,#6d5df6);}
.hp-sub{font-size:14.5px;line-height:1.6;color:var(--muted,#5b6472);margin:8px 0 0;max-width:640px;}
.hp-sub b{color:var(--txt,#1c2128);font-weight:600;}
.hp-muted{color:var(--muted,#5b6472);font-size:13px;}

.hp-ask{margin:24px 0 34px;background:var(--panel,#fff);border:1px solid var(--line,#e4e7ef);border-radius:18px;padding:18px 20px 16px;box-shadow:0 1px 2px rgba(20,28,50,.04),0 12px 32px -18px rgba(60,50,160,.28);}
.hp-ask-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;}
.hp-seg{display:inline-flex;flex-wrap:wrap;max-width:100%;background:var(--panel2,#f1f3f9);border-radius:10px;padding:3px;}
.hp-seg button{border:none;background:none;padding:7px 13px;border-radius:8px;font-size:13px;font-weight:500;color:var(--muted,#5b6472);cursor:pointer;}
.hp-seg button.on{background:var(--panel,#fff);color:var(--txt,#1c2128);font-weight:600;box-shadow:0 1px 2px rgba(20,28,50,.1);}
.hp-ghost{display:inline-flex;align-items:center;gap:5px;background:none;border:1px solid var(--line,#e4e7ef);border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:500;color:var(--muted,#5b6472);cursor:pointer;}
.hp-ghost:hover{border-color:var(--indigo,#6d5df6);color:var(--txt,#1c2128);}
.hp-ask-row{display:flex;gap:10px;align-items:stretch;}
.hp-ask-row input{flex:1;min-width:0;border:none;border-bottom:1.5px solid var(--line,#e4e7ef);background:none;padding:8px 2px 10px;font-family:'Newsreader',Georgia,serif;font-size:18.5px;letter-spacing:-.005em;color:var(--txt,#1c2128);outline:none;transition:border-color .15s;}
.hp-ask-row input::placeholder{color:var(--muted2,#98a0af);font-style:italic;}
.hp-ask-row input:focus{border-bottom-color:var(--indigo,#6d5df6);}
.hp-ask-row button{flex-shrink:0;background:var(--indigo,#6d5df6);color:#fff;border:none;border-radius:11px;padding:0 20px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;}
.hp-ask-row button:hover{filter:brightness(1.08);}
.hp-ask-row button:disabled{opacity:.55;cursor:default;}
.hp-ask-note{font-size:12.5px;color:var(--muted2,#98a0af);margin-top:10px;}
.hp-err{margin-top:12px;font-size:13px;color:#c0392b;}
.hp-answer{margin-top:16px;padding:16px 18px;background:var(--ink,#f6f7fb);border-radius:12px;border-left:3px solid var(--indigo,#6d5df6);}
.hp-answer-old{border-left-color:var(--line,#e4e7ef);opacity:.85;}
.hp-follow{display:flex;gap:10px;align-items:center;margin:-22px 0 34px;padding:12px 14px;background:var(--panel,#fff);border:1px solid var(--line,#e4e7ef);border-radius:14px;flex-wrap:wrap;}
.hp-follow input{flex:1 1 240px;min-width:0;border:1px solid var(--line,#e4e7ef);border-radius:10px;padding:10px 13px;font-family:inherit;font-size:14px;color:var(--txt,#1c2128);outline:none;background:var(--ink,#f6f7fb);}
.hp-follow input:focus{border-color:var(--indigo,#6d5df6);background:var(--panel,#fff);}
.hp-follow button[type=submit]{background:var(--indigo,#6d5df6);color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:13.5px;font-weight:600;cursor:pointer;}
.hp-follow button[type=submit]:disabled{opacity:.45;cursor:default;}
.hp-answer-q{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.04em;color:var(--muted2,#98a0af);margin-bottom:8px;}
.hp-answer-a{font-family:'Newsreader',Georgia,serif;font-size:17px;line-height:1.6;white-space:pre-wrap;}
.hp-chips{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.hp-chips button{background:var(--panel,#fff);border:1px solid var(--line,#e4e7ef);border-radius:20px;padding:4px 11px;font-size:11.5px;font-weight:500;color:var(--indigo,#6d5df6);cursor:pointer;}
.hp-link{margin-top:12px;background:none;border:none;color:var(--indigo,#6d5df6);font-size:13px;font-weight:600;cursor:pointer;padding:0;display:block;}
.hp-pop{position:absolute;top:calc(100% + 6px);right:0;width:340px;max-height:320px;overflow-y:auto;background:var(--panel,#fff);border:1px solid var(--line,#e4e7ef);border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.16);padding:8px 6px;z-index:50;}
.hp-pop-h{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted2,#98a0af);padding:4px 8px 8px;}
.hp-pop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px;border-radius:8px;cursor:pointer;font-size:13px;}
.hp-pop-row:hover{background:var(--panel2,#f1f3f9);}
.hp-pop-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hp-pop-row button{flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--muted2,#98a0af);font-size:16px;line-height:1;padding:2px 6px;}

.hp-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:40px;align-items:start;}
.hp-go{color:var(--muted2,#98a0af);transition:transform .15s ease,color .15s ease;flex-shrink:0;}
.hp-empty{font-size:14px;color:var(--muted,#5b6472);line-height:1.6;padding:22px;border:1px dashed var(--line,#e4e7ef);border-radius:14px;}

.hp-lead{display:flex;flex-direction:column;gap:6px;width:100%;text-align:left;cursor:pointer;color:var(--txt,#1c2128);background:var(--panel,#fff);
  border:1px solid var(--line,#e4e7ef);border-left:3px solid var(--indigo,#6d5df6);border-radius:14px;padding:16px 18px 14px;transition:border-color .15s ease,box-shadow .15s ease;}
.hp-lead:hover{border-color:var(--indigo,#6d5df6);box-shadow:0 10px 24px -18px rgba(60,50,160,.45);}
.hp-lead-meta{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--indigo,#6d5df6);}
.hp-lead-name{font-family:'Newsreader',Georgia,serif;font-size:21px;line-height:1.2;letter-spacing:-.01em;font-weight:500;}
.hp-lead-foot{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--muted,#5b6472);margin-top:4px;}
.hp-lead .hp-go{color:var(--indigo,#6d5df6);font-weight:600;}
.hp-lead:hover .hp-go{transform:translateX(4px);}

.hp-list{margin-top:4px;}
.hp-row{display:flex;align-items:baseline;gap:14px;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid var(--line-soft,#eef0f6);padding:11px 4px;cursor:pointer;color:var(--txt,#1c2128);}
.hp-row:last-child{border-bottom:none;}
.hp-row-name{font-family:'Newsreader',Georgia,serif;font-size:16.5px;letter-spacing:-.01em;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .15s;}
.hp-row-meta{font-size:12.5px;color:var(--muted2,#98a0af);white-space:nowrap;}
.hp-row:hover .hp-row-name{color:var(--indigo,#6d5df6);}
.hp-row:hover .hp-go{transform:translateX(4px);color:var(--indigo,#6d5df6);}

.hp-tools{display:flex;flex-direction:column;gap:10px;}
.hp-tool{display:flex;align-items:center;gap:14px;width:100%;text-align:left;background:var(--panel,#fff);border:1px solid var(--line,#e4e7ef);border-radius:14px;padding:14px 16px;cursor:pointer;color:var(--txt,#1c2128);transition:border-color .15s,transform .15s;}
.hp-tool:hover{border-color:var(--indigo,#6d5df6);transform:translateY(-1px);}
.hp-tool:hover .hp-go{transform:translateX(4px);color:var(--indigo,#6d5df6);}
.hp-tool-ic{width:38px;height:38px;border-radius:11px;background:var(--indigo-soft,#eceafe);color:var(--indigo,#6d5df6);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.hp-tool-txt{display:flex;flex-direction:column;flex:1;min-width:0;}
.hp-tool-tag{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--indigo,#6d5df6);}
.hp-tool-name{font-size:15px;font-weight:600;margin-top:1px;}
.hp-tool-desc{font-size:12.5px;color:var(--muted,#5b6472);line-height:1.45;margin-top:2px;}

.hp-usage{border-top:1px solid var(--line,#e4e7ef);padding-top:14px;}
.hp-stats{display:flex;gap:26px;flex-wrap:wrap;}
.hp-stats div{display:flex;flex-direction:column;}
.hp-stats b{font-family:'Newsreader',Georgia,serif;font-weight:500;font-size:22px;letter-spacing:-.02em;line-height:1.1;font-variant-numeric:tabular-nums;}
.hp-stats span{font-size:12px;color:var(--muted,#5b6472);}
.hp-spark{display:flex;align-items:flex-end;gap:2px;height:44px;margin:16px 0 6px;}
.hp-spark i{flex:1;background:var(--indigo,#6d5df6);opacity:.75;border-radius:2px 2px 0 0;min-width:2px;}

.hp-frontier{margin-top:44px;padding-top:26px;border-top:1px solid var(--line,#e4e7ef);}
.hp-frontier-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:18px;}
.hp-h2{font-family:'Newsreader',Georgia,serif;font-weight:500;font-size:22px;letter-spacing:-.012em;margin:0;}
.hp-areas{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:28px;}
.hp-area{min-width:0;}
.hp-area-name{font-size:12.5px;font-weight:600;color:var(--indigo,#6d5df6);padding-bottom:8px;border-bottom:1px solid var(--line,#e4e7ef);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hp-paper{display:block;padding:11px 0;border-bottom:1px solid var(--line-soft,#eef0f6);text-decoration:none;color:var(--txt,#1c2128);}
.hp-paper:last-child{border-bottom:none;}
.hp-paper-title{display:block;font-family:'Newsreader',Georgia,serif;font-size:16px;line-height:1.3;letter-spacing:-.005em;transition:color .15s;}
.hp-paper:hover .hp-paper-title{color:var(--indigo,#6d5df6);text-decoration:underline;text-underline-offset:3px;}
.hp-paper-meta{display:block;font-size:12px;color:var(--muted,#5b6472);margin-top:4px;line-height:1.45;}
.hp-who{margin-top:16px;}
.hp-who-h{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted2,#98a0af);margin-bottom:6px;}
.hp-who-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:3px 0;}
.hp-who-name{font-size:13.5px;font-weight:500;color:var(--txt,#1c2128);text-decoration:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
a.hp-who-name:hover{color:var(--indigo,#6d5df6);text-decoration:underline;text-underline-offset:3px;}
.hp-who-n{font-size:11.5px;color:var(--muted2,#98a0af);white-space:nowrap;flex-shrink:0;}
.hp-person{padding:5px 0 7px;border-bottom:1px solid var(--line-soft,#eef0f6);}
.hp-person:last-child{border-bottom:none;}
.hp-person-inst{font-size:12px;color:var(--muted,#5b6472);margin-top:-1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hp-person-links{display:flex;gap:12px;flex-wrap:wrap;margin-top:3px;}
.hp-person-links a{font-size:12px;font-weight:500;color:var(--indigo,#6d5df6);text-decoration:none;}
.hp-person-links a:hover{text-decoration:underline;text-underline-offset:3px;}
.hp a:focus-visible{outline:2px solid var(--indigo,#6d5df6);outline-offset:2px;border-radius:4px;}
.hp button:focus-visible,.hp input:focus-visible{outline:2px solid var(--indigo,#6d5df6);outline-offset:2px;}
.hp-ask-row input:focus-visible{outline:none;}
@media (max-width:900px){.hp{padding:28px 18px 56px;}.hp-grid{grid-template-columns:1fr;gap:34px;}.hp-ask-row{flex-direction:column;}.hp-ask-row button{padding:12px 20px;}.hp-ask-row input{font-size:20px;}.hp-row-meta{display:none;}}
@media (prefers-reduced-motion:reduce){.hp *{transition:none!important;}}
`;

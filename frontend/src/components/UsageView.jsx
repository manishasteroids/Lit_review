import React, { useState, useEffect, useCallback } from "react";
import { api } from "../api/client.js";
import { TIER_META } from "../modelTiers.js";
import { Coins, RotateCw } from "./icons.jsx";

const STAGE_LABEL = {
  reformulate: "Query Reformulator",
  search: "Academic Search",
  extract: "Reader & Extractor",
  synthesize: "Critic & Synthesizer",
  write: "Writer",
  evaluate: "Evaluator",
  chat: "Paper chat",
  assess: "Paper triage",
  misc: "Other",
};

const fmtUSD = (n) => "$" + (n ?? 0).toFixed(4);
const fmtTok = (n) => (n ?? 0).toLocaleString();
const fmtSec = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : (ms ?? 0) + "ms");

// local date+time label for a UTC ISO timestamp
const fmtDT = (iso) => {
  try {
    return new Date(iso).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return iso || ""; }
};

// One time-series bar chart (per run) — X = date+time, Y = per-run value.
// If `showCumulative`, overlay a running-total line on its own (right) scale.
const CUM_COLOR = "#e0a33e";
function SeriesChart({ points, valueOf, fmtValue, color, title, showCumulative }) {
  const [hover, setHover] = useState(null);
  if (!points || points.length === 0) {
    return <div className="muted tiny">No runs yet — run a review to start the trend.</div>;
  }
  const W = 320, H = 120, padB = 22;
  const max = Math.max(...points.map(valueOf), 1e-9);
  const bw = (W - 4) / points.length;
  // running cumulative total (own scale, since it's much bigger than one run)
  let run = 0;
  const cum = points.map((p) => (run += valueOf(p)));
  const cumMax = Math.max(cum[cum.length - 1] || 0, 1e-9);
  const cx = (i) => 2 + i * bw + bw / 2;
  const cy = (v) => (H - padB) - (v / cumMax) * (H - padB - 8);
  const cumPath = cum.map((v, i) => `${cx(i)},${cy(v)}`).join(" ");
  const hp = hover != null ? points[hover] : null;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted2)" }}>{title}</span>
        {showCumulative && (
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, color: CUM_COLOR }}>
            ▬ cumulative → {fmtValue(cumMax)}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}
        onMouseLeave={() => setHover(null)}>
        {points.map((p, i) => {
          const h = (valueOf(p) / max) * (H - padB - 6);
          const x = 2 + i * bw;
          return (
            <g key={p.id || i} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={0} width={bw} height={H} fill="transparent" />
              <rect x={x + 0.7} y={H - padB - h} width={Math.max(1.2, bw - 1.4)} height={Math.max(1, h)}
                rx={1.2} fill={color} opacity={hover === i ? 1 : 0.72} />
            </g>
          );
        })}
        {showCumulative && (
          <>
            <polyline points={cumPath} fill="none" stroke={CUM_COLOR} strokeWidth="1.5" strokeLinejoin="round" />
            {hp && <circle cx={cx(hover)} cy={cy(cum[hover])} r="2.5" fill={CUM_COLOR} />}
          </>
        )}
        <line x1="0" y1={H - padB} x2={W} y2={H - padB} stroke="var(--line)" strokeWidth="1" />
        {points.length > 1 && (
          <>
            <text x="2" y={H - 6} fontSize="8" fill="var(--muted2)" fontFamily="monospace">{fmtDT(points[0].at)}</text>
            <text x={W - 2} y={H - 6} fontSize="8" fill="var(--muted2)" fontFamily="monospace" textAnchor="end">{fmtDT(points[points.length - 1].at)}</text>
          </>
        )}
      </svg>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)", marginTop: 2, minHeight: 14 }}>
        {hp
          ? `${fmtDT(hp.at)} · ${fmtValue(valueOf(hp))}${showCumulative ? ` · total so far ${fmtValue(cum[hover])}` : ""}`
          : "Hover a bar for a run"}
      </div>
    </div>
  );
}

const S = {
  card: { border: "1px solid var(--line)", borderRadius: 10, padding: "14px 16px", background: "var(--card, #fff)" },
  bignum: { fontFamily: "'JetBrains Mono',monospace", fontSize: 30, fontWeight: 600, color: "var(--indigo)", lineHeight: 1.1 },
  label: { fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted2)" },
  th: { textAlign: "left", fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted2)", padding: "6px 8px", borderBottom: "1px solid var(--line)" },
  td: { padding: "8px 8px", fontSize: 12.5, borderBottom: "1px solid var(--line)", color: "var(--txt)" },
  tdNum: { padding: "8px 8px", fontSize: 12.5, borderBottom: "1px solid var(--line)", textAlign: "right", fontFamily: "'JetBrains Mono',monospace", color: "var(--txt)" },
  badge: (t) => ({ fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, fontWeight: 600, borderRadius: 4, padding: "1px 6px", color: TIER_META[t]?.color, background: TIER_META[t]?.bg }),
};

/* Usage grouped by Time / Project / Search, with a time-range filter.
   Project and Search come from /api/usage/breakdown (re-fetched when the range
   changes); Time reuses the per-day rows already loaded in `trend`. */
const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "All time"]];

function UsageGroups({ trend }) {
  const [group, setGroup] = useState("project"); // time | project | run
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState("");   // "" = all, "none" = Unassigned
  const [model, setModel] = useState("");           // "" = all models
  const [data, setData] = useState(null);
  const [options, setOptions] = useState({ projects: [], models: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [openRun, setOpenRun] = useState(null);       // session_id being expanded
  const [runDetail, setRunDetail] = useState({});      // session_id -> usage

  // One fetch serves all three views, so switching Group by is instant and
  // filters apply consistently to Time, Project and Search.
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setErr(null);
    api.getUsageBreakdown(days, projectId, model)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Keep the dropdown options stable while a filter is active: only
        // refresh them when no project/model filter is narrowing the list.
        if (!projectId && !model) setOptions(d.options || { projects: [], models: [] });
      })
      .catch((e) => { if (!cancelled) setErr(e.message || "Failed to load breakdown"); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [days, projectId, model]);

  // CSV of whatever view + filters are currently showing.
  function exportCsv() {
    if (!data) return;
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    let head, rows;
    if (group === "time") {
      head = ["day", "calls", "input_tokens", "output_tokens", "cost_usd"];
      rows = (data.by_day || []).map((d) => [d.day, d.calls, d.in_tok, d.out_tok, d.cost_usd.toFixed(6)]);
    } else if (group === "project") {
      head = ["project", "runs", "calls", "input_tokens", "output_tokens", "cost_usd"];
      rows = data.by_project.map((p) => [p.project_name, p.runs, p.calls, p.in_tok, p.out_tok, p.cost_usd.toFixed(6)]);
    } else {
      head = ["search", "project", "last_activity_utc", "calls", "input_tokens", "output_tokens", "cost_usd"];
      rows = data.by_run.map((r) => [r.topic, r.project_name || "", r.at, r.calls, r.in_tok, r.out_tok, r.cost_usd.toFixed(6)]);
    }
    const csv = [head, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sift-usage-${group}-${days ? days + "d" : "all"}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function toggleRun(id) {
    if (openRun === id) { setOpenRun(null); return; }
    setOpenRun(id);
    if (!runDetail[id]) {
      api.getUsage(id).then((u) => setRunDetail((m) => ({ ...m, [id]: u }))).catch(() => {});
    }
  }

  const sel = {
    fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "4px 8px", borderRadius: 8,
    border: "1px solid var(--line)", background: "var(--card, #fff)", color: "var(--txt)", maxWidth: 220,
  };
  const pill = (active) => ({
    fontFamily: "'JetBrains Mono',monospace", fontSize: 11, padding: "4px 10px", borderRadius: 999,
    border: "1px solid " + (active ? "var(--indigo)" : "var(--line)"),
    background: active ? "var(--indigo)" : "transparent",
    color: active ? "#fff" : "var(--txt)", cursor: "pointer",
  });

  // Time view: per-day rows (newest first) from the same filtered fetch.
  const dayRows = data?.by_day || [];

  const maxProjCost = Math.max(...(data?.by_project || []).map((p) => p.cost_usd), 1e-9);

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...S.label, marginRight: 4 }}>group by</span>
          {[["time", "Time"], ["project", "Project"], ["run", "Search"]].map(([k, l]) => (
            <button key={k} style={pill(group === k)} onClick={() => setGroup(k)}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...S.label, marginRight: 4 }}>range</span>
          {RANGES.map(([d, l]) => (
            <button key={d} style={pill(days === d)} onClick={() => setDays(d)}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <span style={{ ...S.label, marginRight: 2 }}>filter</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={sel}>
          <option value="">All projects</option>
          {options.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={sel}>
          <option value="">All models</option>
          {options.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {(projectId || model) && (
          <button style={pill(false)} onClick={() => { setProjectId(""); setModel(""); }}>Clear</button>
        )}
        <span style={{ flex: 1 }} />
        <button style={pill(false)} onClick={exportCsv} disabled={!data}>Export CSV</button>
      </div>

      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
      {busy && <div className="muted tiny">Loading…</div>}

      {group === "time" && data && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={S.th}>Day</th><th style={{ ...S.th, textAlign: "right" }}>Calls</th>
            <th style={{ ...S.th, textAlign: "right" }}>Tokens</th><th style={{ ...S.th, textAlign: "right" }}>Cost</th>
          </tr></thead>
          <tbody>
            {dayRows.length === 0 && <tr><td style={S.td} colSpan={4}>No usage in this range.</td></tr>}
            {dayRows.map((d) => (
              <tr key={d.day}>
                <td style={S.td}>{d.day}</td>
                <td style={S.tdNum}>{d.calls}</td>
                <td style={S.tdNum}>{fmtTok((d.in_tok || 0) + (d.out_tok || 0))}</td>
                <td style={S.tdNum}>{fmtUSD(d.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {group === "project" && data && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={S.th}>Project</th><th style={{ ...S.th, textAlign: "right" }}>Runs</th>
            <th style={{ ...S.th, textAlign: "right" }}>Tokens</th><th style={{ ...S.th, textAlign: "right" }}>Cost</th>
            <th style={S.th}>Share</th>
          </tr></thead>
          <tbody>
            {data.by_project.length === 0 && <tr><td style={S.td} colSpan={5}>No usage in this range.</td></tr>}
            {data.by_project.map((p) => (
              <tr key={p.project_id || "none"}>
                <td style={{ ...S.td, fontStyle: p.project_id ? "normal" : "italic" }}>{p.project_name}</td>
                <td style={S.tdNum}>{p.runs}</td>
                <td style={S.tdNum}>{fmtTok(p.in_tok + p.out_tok)}</td>
                <td style={S.tdNum}>{fmtUSD(p.cost_usd)}</td>
                <td style={{ ...S.td, width: 140 }}>
                  <div style={{ height: 8, borderRadius: 4, background: "var(--line)" }}>
                    <div style={{ height: 8, borderRadius: 4, background: "var(--indigo)", width: Math.max(2, (p.cost_usd / maxProjCost) * 100) + "%" }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {group === "run" && data && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={S.th}>Search</th><th style={S.th}>Project</th><th style={S.th}>Last activity</th>
            <th style={{ ...S.th, textAlign: "right" }}>Tokens</th><th style={{ ...S.th, textAlign: "right" }}>Cost</th>
          </tr></thead>
          <tbody>
            {data.by_run.length === 0 && <tr><td style={S.td} colSpan={5}>No usage in this range.</td></tr>}
            {data.by_run.map((r) => (
              <React.Fragment key={r.session_id}>
                <tr style={{ cursor: "pointer" }} onClick={() => toggleRun(r.session_id)}>
                  <td style={S.td}>{openRun === r.session_id ? "▾ " : "▸ "}{r.topic}</td>
                  <td style={S.td}>{r.project_name || <span className="muted">—</span>}</td>
                  <td style={S.td}>{fmtDT(r.at)}</td>
                  <td style={S.tdNum}>{fmtTok(r.in_tok + r.out_tok)}</td>
                  <td style={S.tdNum}>{fmtUSD(r.cost_usd)}</td>
                </tr>
                {openRun === r.session_id && (
                  <tr><td style={{ ...S.td, background: "var(--card, #fafafa)" }} colSpan={5}>
                    {!runDetail[r.session_id] ? <span className="muted tiny">Loading stages…</span> : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 12 }}>
                        {runDetail[r.session_id].by_stage.map((s) => (
                          <span key={s.stage}>{STAGE_LABEL[s.stage] || s.stage}: <b>{fmtUSD(s.cost_usd)}</b></span>
                        ))}
                      </div>
                    )}
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
      {group === "run" && data && data.by_run.length >= 200 && (
        <div className="muted tiny" style={{ marginTop: 6 }}>Showing the 200 most recent searches.</div>
      )}
    </div>
  );
}

// Stale-while-revalidate cache (module scope survives tab unmount/remount) so
// re-opening the Token usage tab renders instantly and refreshes in the
// background instead of showing a blank page for a few seconds each time.
let _trendCache = null;
const _usageCache = new Map();  // runId -> usage

export default function UsageView({ runId }) {
  const [usage, setUsage] = useState(() => (runId ? _usageCache.get(runId) || null : null));
  const [trend, setTrend] = useState(_trendCache);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [trendErr, setTrendErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    setTrendErr(null);
    // Only block with a spinner when we have nothing cached to show yet.
    const haveCached = _trendCache != null && (!runId || _usageCache.has(runId));
    setLoading(!haveCached);
    api.getUsageTrend()
      .then((t) => { _trendCache = t; setTrend(t); })
      .catch((e) => {
        // This used to be swallowed entirely, so the "usage over time" charts
        // would just silently vanish with no indication why (usually an
        // expired session token). Surface it instead.
        console.warn("getUsageTrend failed:", e);
        setTrendErr(e.message || "Failed to load usage trend");
      });
    if (!runId) { setUsage(null); setLoading(false); return; }
    api.getUsage(runId)
      .then((u) => { _usageCache.set(runId, u); setUsage(u); })
      .catch((e) => setErr(e.message || "Failed to load usage"))
      .finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  // When a run is open, show that run's breakdown; otherwise fall back to the
  // all-time breakdown (across every session) so the tab is useful with no
  // active session instead of going blank.
  const scoped = runId ? usage : trend;
  const total = scoped?.total || { calls: 0, in_tok: 0, out_tok: 0, cost_usd: 0, latency_ms: 0 };
  const hasData = total.calls > 0;
  const scopeLabel = runId ? "this run" : "all time";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div className="card-h" style={{ margin: 0 }}>
          <div className="ic"><Coins size={16} /></div>
          <h3 style={{ margin: 0 }}>Token usage &amp; cost</h3>
        </div>
        <button className="btn ghost sm" onClick={load} disabled={loading}>
          <RotateCw size={13} className={loading ? "spin" : ""} /> Refresh
        </button>
      </div>

      {/* First load with nothing cached — show a spinner instead of a blank page */}
      {loading && !trend && !usage && (
        <div className="muted tiny" style={{ display: "flex", alignItems: "center", gap: 8, padding: "24px 0" }}>
          <RotateCw size={13} className="spin" /> Loading usage…
        </div>
      )}

      {trendErr && !trend && (
        <div className="err" style={{ marginBottom: 16 }}>
          Couldn't load your usage-over-time trend: {trendErr}
        </div>
      )}

      {/* Your usage over time — across all sessions, independent of the current run */}
      {trend && (
        <div style={{ marginBottom: 22 }}>
          <div style={S.label}>your usage over time</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, margin: "8px 0 14px" }}>
            <div style={S.card}>
              <div style={S.bignum}>{fmtUSD(trend.this_month?.cost_usd)}</div>
              <div style={S.label}>spent this month</div>
            </div>
            <div style={S.card}>
              <div style={S.bignum}>{fmtUSD(trend.total.cost_usd)}</div>
              <div style={S.label}>total spent (all runs)</div>
            </div>
            <div style={S.card}>
              <div style={S.bignum}>{fmtTok((trend.total.in_tok || 0) + (trend.total.out_tok || 0))}</div>
              <div style={S.label}>total tokens</div>
            </div>
            <div style={S.card}>
              <div style={S.bignum}>{trend.total.calls || 0}</div>
              <div style={S.label}>total model calls</div>
            </div>
          </div>
          <div className="muted tiny" style={{ margin: "-6px 0 14px" }}>
            "Spent this month" tracks your actual model-call cost for the current calendar month —
            Sift doesn't have a billing/subscription plan, so this isn't an amount owed anywhere,
            just what your API usage has cost so far.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <SeriesChart
              points={trend.by_session}
              valueOf={(p) => (p.in_tok || 0) + (p.out_tok || 0)}
              fmtValue={(v) => fmtTok(v) + " tokens"}
              color="var(--indigo)"
              title="Tokens per run (over time)"
            />
            <SeriesChart
              points={trend.by_session}
              valueOf={(p) => p.cost_usd || 0}
              fmtValue={fmtUSD}
              color="#3aa981"
              title="Cost per run (over time)"
              showCumulative
            />
          </div>
          <UsageGroups trend={trend} />
        </div>
      )}

      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      {!hasData && !loading && (
        <div className="muted tiny">
          {runId ? "No model calls recorded for this session yet." : "No model calls recorded yet."}
        </div>
      )}

      {hasData && (
        <>
          <div style={{ ...S.label, marginBottom: 6 }}>breakdown — {scopeLabel}</div>
          {/* Totals */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 18 }}>
            <div style={S.card}>
              <div style={S.bignum}>{fmtUSD(total.cost_usd)}</div>
              <div style={S.label}>total cost</div>
            </div>
            <div style={S.card}>
              <div style={S.bignum}>{fmtTok(total.in_tok + total.out_tok)}</div>
              <div style={S.label}>total tokens</div>
            </div>
            <div style={S.card}>
              <div style={S.bignum}>{total.calls}</div>
              <div style={S.label}>model calls</div>
            </div>
            <div style={S.card}>
              <div style={S.bignum}>{fmtSec(total.latency_ms)}</div>
              <div style={S.label}>model time</div>
            </div>
          </div>

          {/* Per model */}
          <div style={S.label}>by model</div>
          <table style={{ width: "100%", borderCollapse: "collapse", margin: "6px 0 18px" }}>
            <thead>
              <tr>
                <th style={S.th}>Model</th>
                <th style={S.th}>Tier</th>
                <th style={{ ...S.th, textAlign: "right" }}>Calls</th>
                <th style={{ ...S.th, textAlign: "right" }}>Tokens</th>
                <th style={{ ...S.th, textAlign: "right" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {(scoped.by_model || []).map((r) => (
                <tr key={r.model + r.tier}>
                  <td style={S.td}>{r.model}</td>
                  <td style={S.td}><span style={S.badge(r.tier)}>{TIER_META[r.tier]?.label || r.tier}</span></td>
                  <td style={S.tdNum}>{r.calls}</td>
                  <td style={S.tdNum}>{fmtTok(r.in_tok + r.out_tok)}</td>
                  <td style={S.tdNum}>{fmtUSD(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Per stage */}
          <div style={S.label}>by pipeline stage</div>
          <table style={{ width: "100%", borderCollapse: "collapse", margin: "6px 0 12px" }}>
            <thead>
              <tr>
                <th style={S.th}>Stage</th>
                <th style={{ ...S.th, textAlign: "right" }}>Calls</th>
                <th style={{ ...S.th, textAlign: "right" }}>In</th>
                <th style={{ ...S.th, textAlign: "right" }}>Out</th>
                <th style={{ ...S.th, textAlign: "right" }}>Searches</th>
                <th style={{ ...S.th, textAlign: "right" }}>Time</th>
                <th style={{ ...S.th, textAlign: "right" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {(scoped.by_stage || []).map((r) => (
                <tr key={r.stage}>
                  <td style={S.td}>{STAGE_LABEL[r.stage] || r.stage}</td>
                  <td style={S.tdNum}>{r.calls}</td>
                  <td style={S.tdNum}>{fmtTok(r.in_tok)}</td>
                  <td style={S.tdNum}>{fmtTok(r.out_tok)}</td>
                  <td style={S.tdNum}>{r.web_searches ? r.web_searches : "—"}</td>
                  <td style={S.tdNum}>{fmtSec(r.latency_ms)}</td>
                  <td style={S.tdNum}>{fmtUSD(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {(total.web_searches > 0 || total.cache_read_tok > 0 || total.cache_write_tok > 0) && (
            <div className="muted tiny" style={{ marginBottom: 8, lineHeight: 1.6 }}>
              {total.web_searches > 0 && (
                <div>
                  Includes <b>{total.web_searches}</b> web-search request
                  {total.web_searches === 1 ? "" : "s"} billed at $10 / 1,000 (≈
                  {fmtUSD((total.web_searches / 1000) * 10)}) on top of tokens.
                </div>
              )}
              {(total.cache_read_tok > 0 || total.cache_write_tok > 0) && (
                <div>
                  Cache: {fmtTok(total.cache_read_tok)} read (0.1×) ·{" "}
                  {fmtTok(total.cache_write_tok)} write (1.25×).
                </div>
              )}
            </div>
          )}

          <div className="muted tiny" style={{ marginTop: 6, lineHeight: 1.6 }}>
            Costs computed from list prices effective {scoped.prices_effective}, using actual
            token counts returned by the model — including cache tokens and server-side
            web-search fees. Free-tier models show $0 but still record tokens.
          </div>
        </>
      )}
    </div>
  );
}

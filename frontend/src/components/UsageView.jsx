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

// One time-series bar chart (per run) — X = date+time, Y = the chosen value.
function SeriesChart({ points, valueOf, fmtValue, color, title }) {
  const [hover, setHover] = useState(null);
  if (!points || points.length === 0) {
    return <div className="muted tiny">No runs yet — run a review to start the trend.</div>;
  }
  const W = 320, H = 120, padB = 22;
  const max = Math.max(...points.map(valueOf), 1e-9);
  const bw = (W - 4) / points.length;
  const hp = hover != null ? points[hover] : null;
  return (
    <div>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted2)", marginBottom: 4 }}>{title}</div>
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
        <line x1="0" y1={H - padB} x2={W} y2={H - padB} stroke="var(--line)" strokeWidth="1" />
        {points.length > 1 && (
          <>
            <text x="2" y={H - 6} fontSize="8" fill="var(--muted2)" fontFamily="monospace">{fmtDT(points[0].at)}</text>
            <text x={W - 2} y={H - 6} fontSize="8" fill="var(--muted2)" fontFamily="monospace" textAnchor="end">{fmtDT(points[points.length - 1].at)}</text>
          </>
        )}
      </svg>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: "var(--muted)", marginTop: 2, minHeight: 14 }}>
        {hp ? `${fmtDT(hp.at)} · ${fmtValue(valueOf(hp))}` : "Hover a bar for a run"}
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

export default function UsageView({ runId }) {
  const [usage, setUsage] = useState(null);
  const [trend, setTrend] = useState(null);   // per-user over-time totals
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    api.getUsageTrend().then(setTrend).catch(() => {});
    if (!runId) { setUsage(null); setLoading(false); return; }
    api.getUsage(runId)
      .then((u) => setUsage(u))
      .catch((e) => setErr(e.message || "Failed to load usage"))
      .finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  const total = usage?.total || { calls: 0, in_tok: 0, out_tok: 0, cost_usd: 0, latency_ms: 0 };
  const hasData = total.calls > 0;

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

      {/* Your usage over time — across all sessions, independent of the current run */}
      {trend && (
        <div style={{ marginBottom: 22 }}>
          <div style={S.label}>your usage over time</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, margin: "8px 0 14px" }}>
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
            />
          </div>
        </div>
      )}

      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      {runId && !hasData && !loading && (
        <div className="muted tiny">No model calls recorded for this session yet.</div>
      )}
      {!runId && (
        <div className="muted tiny" style={{ marginBottom: 8 }}>Open a review to see its per-stage breakdown below.</div>
      )}

      {hasData && (
        <>
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
              {(usage.by_model || []).map((r) => (
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
              {(usage.by_stage || []).map((r) => (
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
            Costs computed from list prices effective {usage.prices_effective} (USD per 1M tokens),
            using actual token counts returned by the model — including cache tokens and
            server-side web-search fees. Free-tier models show $0 but still record tokens.
          </div>
        </>
      )}
    </div>
  );
}

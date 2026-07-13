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
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    if (!runId) return;
    setLoading(true); setErr(null);
    api.getUsage(runId)
      .then((u) => setUsage(u))
      .catch((e) => setErr(e.message || "Failed to load usage"))
      .finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  if (!runId) return <div className="muted tiny">Run a review first — usage is tracked per session.</div>;

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

      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      {!hasData && !loading && (
        <div className="muted tiny">No model calls recorded for this session yet.</div>
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

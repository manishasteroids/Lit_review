import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";

/* Owner-only list of everyone who has signed in. Access is enforced on the
   server (ADMIN_EMAILS); this page just displays what the API returns. */

const PLAN_STYLE = {
  pro: ["#e8e5fd", "#5b4fe5"], max: ["#e8e5fd", "#5b4fe5"], trial: ["#eaf5d3", "#4f8a00"],
  free: ["#eef0f4", "#5b6472"], "not started": ["#eef0f4", "#98a0af"],
};

function csvCell(v) { return '"' + String(v ?? "").replace(/"/g, '""') + '"'; }

export default function AdminUsers() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState("all");

  const load = () => {
    setErr(null);
    api.adminUsers().then(setData).catch((e) => setErr(e.message || "Couldn't load users."));
  };
  useEffect(load, []);

  const rows = useMemo(() => {
    const list = data?.users || [];
    return list.filter((u) =>
      (plan === "all" || u.plan === plan) && (!q || u.email.toLowerCase().includes(q.toLowerCase())));
  }, [data, q, plan]);

  const exportCsv = () => {
    const head = ["email", "plan", "last_seen", "trial_started_at", "runs", "cost_usd", "user_id"];
    const body = rows.map((u) => head.map((h) => csvCell(u[h])).join(","));
    const blob = new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "orcus-users.csv"; a.click();
    URL.revokeObjectURL(a.href);
  };

  const ACTIONS = [
    ["grant_pro", "Grant Pro"], ["grant_max", "Grant Max"], ["set_free", "Set to Free"],
    ["extend_trial", "Extend trial +7 days"], ["reset_trial", "Reset trial"], ["delete_data", "Delete their data…"],
  ];
  const doAction = async (u, action) => {
    if (!action) return;
    const label = ACTIONS.find((a) => a[0] === action)[1];
    const msg = action === "delete_data"
      ? `Permanently delete ALL data for ${u.email}? This can't be undone. (Their login in Supabase is not removed.)`
      : `${label} for ${u.email}?`;
    if (!window.confirm(msg)) return;
    try {
      await api.adminUserAction(u.user_id, action, action === "extend_trial" ? 7 : undefined);
      load();
    } catch (e) { setErr(e.message || "Action failed."); }
  };

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
  const counts = useMemo(() => {
    const c = {};
    (data?.users || []).forEach((u) => { c[u.plan] = (c[u.plan] || 0) + 1; });
    return c;
  }, [data]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Users {data ? `(${data.count})` : ""}</div>
          <div className="muted tiny">
            {Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input placeholder="Search email" value={q} onChange={(e) => setQ(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }} />
          <select value={plan} onChange={(e) => setPlan(e.target.value)}
            style={{ padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}>
            {["all", "trial", "free", "pro", "max", "not started"].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button className="btn ghost sm" onClick={load}>Refresh</button>
          <button className="btn ghost sm" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
        </div>
      </div>

      {err && <div className="err">{err}</div>}
      {!data && !err && <div className="muted">Loading…</div>}

      {data && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".05em" }}>
                {["Email", "Plan", "Last seen", "Trial started", "Runs", "Cost", "Actions"].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)", textAlign: h === "Runs" || h === "Cost" ? "right" : "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const [bg, fg] = PLAN_STYLE[u.plan] || PLAN_STYLE.free;
                return (
                  <tr key={u.user_id}>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>{u.email}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
                      <span style={{ background: bg, color: fg, borderRadius: 12, padding: "2px 9px", fontSize: 12, fontWeight: 600 }}>{u.plan}</span>
                    </td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>{fmt(u.last_seen)}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>{fmt(u.trial_started_at)}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)", textAlign: "right" }}>{u.runs}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)", textAlign: "right" }}>${u.cost_usd.toFixed(2)}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
                      <select value="" onChange={(e) => doAction(u, e.target.value)}
                        style={{ padding: "4px 6px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }}>
                        <option value="">Choose…</option>
                        {ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr><td colSpan={7} style={{ padding: 16, color: "var(--muted)" }}>No users match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted tiny" style={{ marginTop: 10 }}>
        Shows accounts that have signed in to the app. Accounts that never confirmed their email appear only in the Supabase dashboard.
      </div>
    </div>
  );
}

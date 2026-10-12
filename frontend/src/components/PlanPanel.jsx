import React, { useEffect, useState } from "react";
import { api } from "../api/client.js";

/* Current plan + free-trial progress + upgrade buttons.
   `compact` = a one-line banner for the Home page; the full card lives on
   Account and Billing. Hidden entirely for bypass (team) accounts. */

const fmtUSD = (n) => "$" + (n ?? 0).toFixed(2);

export function usePlan() {
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let off = false;
    api.getBillingStatus().then((p) => !off && setPlan(p)).catch((e) => !off && setErr(e.message));
    return () => { off = true; };
  }, []);
  return { plan, err };
}

async function startCheckout(plan, setBusy, setErr) {
  setBusy(plan); setErr(null);
  try {
    const { url } = await api.getCheckoutUrl(plan);
    window.location.href = url;
  } catch (e) {
    setErr(e.message || "Couldn't open checkout.");
    setBusy(null);
  }
}

export default function PlanPanel({ compact = false }) {
  const { plan: p } = usePlan();
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  if (!p || p.source === "bypass") return null;

  const t = p.trial;
  const paid = p.source === "subscription";
  const trialing = p.source === "trial";
  const pct = t.credits_total > 0 ? Math.min(100, (t.credits_used / t.credits_total) * 100) : 100;

  let title, sub;
  if (paid) {
    title = `${p.limits.label} plan`;
    sub = p.current_period_end
      ? `Renews or ends ${new Date(p.current_period_end).toLocaleDateString()}`
      : "Active subscription";
  } else if (trialing) {
    title = "Pro free trial";
    sub = `${t.days_left} day${t.days_left === 1 ? "" : "s"} left · ${fmtUSD(t.credits_left)} of ${fmtUSD(t.credits_total)} credits left`;
  } else {
    title = "Free plan";
    sub = t.state === "credits_used"
      ? "Your trial credits are used up — Lite mode only."
      : t.state === "expired" ? "Your 7-day trial has ended — Lite mode only." : "Lite mode only.";
  }

  const canBuy = (k) => p.checkout_available?.[k];
  const upgradeBtns = !paid && (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button className="btn sm" disabled={!!busy || !canBuy("pro")} onClick={() => startCheckout("pro", setBusy, setErr)}
        title={canBuy("pro") ? "" : "Checkout isn't set up yet"}>
        {busy === "pro" ? "Opening…" : "Upgrade to Pro — $10/mo"}
      </button>
      <button className="btn ghost sm" disabled={!!busy || !canBuy("max")} onClick={() => startCheckout("max", setBusy, setErr)}
        title={canBuy("max") ? "" : "Checkout isn't set up yet"}>
        {busy === "max" ? "Opening…" : "Max — $16/mo"}
      </button>
    </div>
  );

  if (compact) {
    // Quiet for healthy paid accounts; only trial/free get a banner.
    if (paid) return null;
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10,
        border: "1px solid var(--line)", borderRadius: 10, padding: "10px 14px", marginBottom: 16,
        background: trialing ? "var(--card, #fff)" : "rgba(224,163,62,.10)", fontSize: 13,
      }}>
        <div><b>{title}</b> <span className="muted">· {sub}</span></div>
        {upgradeBtns}
        {err && <div className="err" style={{ width: "100%" }}>{err}</div>}
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
          <div className="muted tiny" style={{ marginTop: 3 }}>{sub}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {upgradeBtns}
          {paid && p.portal_url && (
            <a className="btn ghost sm" href={p.portal_url} target="_blank" rel="noopener noreferrer">Manage subscription</a>
          )}
        </div>
      </div>

      {trialing && (
        <div style={{ marginTop: 14 }}>
          <div style={{ height: 8, borderRadius: 4, background: "var(--line)" }}>
            <div style={{ height: 8, borderRadius: 4, background: pct > 85 ? "#e0a33e" : "var(--indigo)", width: Math.max(2, pct) + "%" }} />
          </div>
          <div className="muted tiny" style={{ marginTop: 5 }}>
            {fmtUSD(t.credits_used)} of {fmtUSD(t.credits_total)} trial credits used. The trial ends when the days
            or the credits run out, whichever comes first — then you stay on Free and keep all your saved work.
          </div>
        </div>
      )}
      {!p.enforced && !paid && (
        <div className="muted tiny" style={{ marginTop: 10 }}>
          Limits aren't being applied yet — everything is currently unlocked.
        </div>
      )}
      {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}

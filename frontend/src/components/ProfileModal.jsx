import React, { useState, useEffect } from "react";
import { api } from "../api/client.js";

/**
 * Account dialog with two tabs:
 *   Profile  — read-only view of who you are (name, email, ORCID, Scholar)
 *   Settings — edit display name, affiliation, ORCID and Scholar profile
 *
 * `tab` sets which one opens first (from the account dropdown).
 */
// Full IANA zone list where supported (modern browsers); a short curated
// fallback otherwise so the picker still works everywhere.
const TIMEZONES = (() => {
  try {
    if (typeof Intl.supportedValuesOf === "function") return Intl.supportedValuesOf("timeZone");
  } catch { /* fall through */ }
  return [
    "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
    "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
    "Africa/Cairo", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Kathmandu",
    "Asia/Dhaka", "Asia/Bangkok", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney",
    "Pacific/Auckland",
  ];
})();
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function ProfileModal({ user, tab = "profile", onClose }) {
  const [active, setActive] = useState(tab);
  const [form, setForm] = useState({ display_name: "", affiliation: "", orcid: "", scholar_url: "", timezone_pref: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const authName = user?.user_metadata?.full_name || user?.user_metadata?.name || "";
  const email = user?.email || "";

  useEffect(() => { setActive(tab); }, [tab]);

  useEffect(() => {
    let alive = true;
    api.getProfile()
      .then((p) => { if (alive) setForm((f) => ({ ...f, ...clean(p) })); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      const saved = await api.saveProfile(form);
      setForm((f) => ({ ...f, ...clean(saved) }));
      setMsg({ ok: true, text: "Profile saved." });
    } catch (err) {
      setMsg({ ok: false, text: err.message || "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  const shownName = form.display_name || authName || email.split("@")[0];

  return (
    <div style={S.scrim} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={S.close} aria-label="Close">×</button>

        <div style={S.tabs}>
          {[["profile", "Profile"], ["settings", "Settings"]].map(([id, label]) => (
            <button key={id} onClick={() => setActive(id)}
              style={{ ...S.tab, ...(active === id ? S.tabOn : null) }}>{label}</button>
          ))}
        </div>

        {loading ? (
          <div style={S.muted}>Loading…</div>
        ) : active === "profile" ? (
          <div>
            <div style={S.name}>{shownName}</div>
            <div style={S.email}>{email}</div>
            <dl style={S.dl}>
              <Row label="Display name" value={form.display_name || authName || "—"} />
              <Row label="Affiliation" value={form.affiliation || "—"} />
              <Row label="ORCID" value={form.orcid}
                href={form.orcid ? `https://orcid.org/${form.orcid.replace(/^https?:\/\/orcid\.org\//, "")}` : null} />
              <Row label="Google Scholar" value={form.scholar_url} href={form.scholar_url || null} />
              <Row label="Timezone" value={form.timezone_pref || `${BROWSER_TZ} (auto-detected)`} />
            </dl>
            <button style={S.linkBtn} onClick={() => setActive("settings")}>Edit in Settings →</button>
          </div>
        ) : (
          <form onSubmit={save}>
            <Field label="Display name" value={form.display_name} onChange={set("display_name")}
              placeholder={authName || "How your name appears"} />
            <Field label="Affiliation" value={form.affiliation} onChange={set("affiliation")}
              placeholder="University, lab or company" />
            <Field label="ORCID iD" value={form.orcid} onChange={set("orcid")}
              placeholder="0000-0002-1825-0097" />
            <Field label="Google Scholar profile" value={form.scholar_url} onChange={set("scholar_url")}
              placeholder="https://scholar.google.com/citations?user=…" />
            <label style={{ display: "block", marginBottom: 14 }}>
              <span style={S.lbl}>Timezone</span>
              <select value={form.timezone_pref} onChange={set("timezone_pref")} style={S.input}>
                <option value="">Auto-detect ({BROWSER_TZ})</option>
                {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
              <span style={{ ...S.muted, fontSize: 11.5, display: "block", marginTop: 5 }}>
                Used to show absolute timestamps (e.g. run history) in your own timezone.
              </span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18 }}>
              <button type="submit" disabled={saving} style={S.save}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              {msg && (
                <span style={{ fontSize: 13, color: msg.ok ? "#2e9e5b" : "#c0392b" }}>{msg.text}</span>
              )}
            </div>
            <div style={{ ...S.muted, marginTop: 16, fontSize: 12 }}>
              Email is managed by your sign-in provider and can't be changed here.
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function clean(p) {
  const out = {};
  for (const k of ["display_name", "affiliation", "orcid", "scholar_url", "timezone_pref"]) out[k] = p?.[k] || "";
  return out;
}

function Row({ label, value, href }) {
  return (
    <div style={S.row}>
      <dt style={S.dt}>{label}</dt>
      <dd style={S.dd}>
        {value && href
          ? <a href={href} target="_blank" rel="noreferrer" style={{ color: "#5b4ff0" }}>{value}</a>
          : (value || "—")}
      </dd>
    </div>
  );
}

function Field({ label, ...rest }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <span style={S.lbl}>{label}</span>
      <input {...rest} style={S.input} />
    </label>
  );
}

const S = {
  scrim: {
    position: "fixed", inset: 0, background: "rgba(17,17,27,.45)", backdropFilter: "blur(2px)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20,
  },
  modal: {
    width: "100%", maxWidth: 460, background: "#fff", borderRadius: 16, padding: "26px 28px 28px",
    boxShadow: "0 20px 60px rgba(0,0,0,.25)", fontFamily: "'Space Grotesk',sans-serif",
    color: "#111", position: "relative",
  },
  close: {
    position: "absolute", top: 12, right: 15, background: "none", border: "none",
    fontSize: 22, color: "#9a9aab", cursor: "pointer", lineHeight: 1,
  },
  tabs: { display: "flex", gap: 4, borderBottom: "1px solid #eeeef4", marginBottom: 20 },
  tab: {
    background: "none", border: "none", borderBottom: "2px solid transparent", cursor: "pointer",
    fontFamily: "inherit", fontSize: 14, fontWeight: 600, color: "#6b6b7b", padding: "8px 12px 10px",
  },
  tabOn: { color: "#5b4ff0", borderBottomColor: "#5b4ff0" },
  name: { fontSize: 19, fontWeight: 700 },
  email: { fontSize: 13.5, color: "#6b6b7b", marginTop: 2, marginBottom: 18 },
  dl: { margin: 0 },
  row: { display: "flex", gap: 14, padding: "10px 0", borderTop: "1px solid #f1f1f6" },
  dt: { flex: "0 0 132px", fontSize: 13, color: "#6b6b7b", margin: 0 },
  dd: { margin: 0, fontSize: 13.5, wordBreak: "break-word" },
  lbl: { display: "block", fontSize: 12.5, fontWeight: 600, color: "#4a4a5a", marginBottom: 6 },
  input: {
    width: "100%", padding: "10px 12px", borderRadius: 9, border: "1px solid #e3e3ec",
    fontFamily: "inherit", fontSize: 14, color: "#111", outline: "none", boxSizing: "border-box",
  },
  save: {
    padding: "10px 20px", borderRadius: 9, border: "none", background: "#5b4ff0",
    color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  linkBtn: {
    marginTop: 18, background: "none", border: "none", color: "#5b4ff0", fontWeight: 600,
    fontSize: 13.5, cursor: "pointer", padding: 0, fontFamily: "inherit",
  },
  muted: { color: "#6b6b7b", fontSize: 13.5 },
};

import React, { useState, useEffect, useRef } from "react";
import { authEnabled, supabase } from "./supabase.js";
 
const ACCENT = "#6d5ef6";
 
/* Imperative gate                                                     */
 
// Set by <AuthModalHost/>. Opens the modal and resolves true/false.
let openLogin = null;
 
/**
 * Call before any action that requires an account.
 * Returns true if the user is signed in, false if they dismiss.
 */
export async function ensureAuth() {
  if (!authEnabled) return true;
  const { data } = await supabase.auth.getSession();
  if (data?.session) return true;
  if (!openLogin) return false;
  return openLogin();
}
 
export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
 
/** Current session (null when signed out or auth disabled). */
export function useSession() {
  const [session, setSession] = useState(null);
  useEffect(() => {
    if (!authEnabled) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  return session;
}
 
/* ------------------------------------------------------------------ */
/* Header widget — drop <AuthButtons /> anywhere                       */
/* ------------------------------------------------------------------ */
 
/**
 * @param {object[]} [extraItems] optional menu rows: { label, onClick, danger }
 */
export function AuthButtons({ extraItems = [] }) {
  const session = useSession();
  if (!authEnabled) return null;
 
  if (session) return <AccountMenu session={session} extraItems={extraItems} />;
 
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button onClick={() => ensureAuth()} style={btnGhost}>Log in</button>
      <button onClick={() => ensureAuth()} style={btnSolid}>Sign up</button>
    </div>
  );
}
 
/** Display name: Google full name -> metadata name -> email local-part. */
function displayName(user) {
  const m = user?.user_metadata || {};
  return m.full_name || m.name || (user?.email || "").split("@")[0] || "Account";
}
 
function initials(name) {
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}
 
function AccountMenu({ session, extraItems }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const user = session.user;
  const name = displayName(user);
  const avatarUrl = user?.user_metadata?.avatar_url;
 
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
 
  return (
    <div ref={wrap} style={{ position: "relative", fontFamily: "'Space Grotesk',sans-serif" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 9, padding: "6px 10px 6px 6px",
          borderRadius: 10, border: "1px solid var(--line)", background: "var(--card, #fff)",
          cursor: "pointer", fontFamily: "inherit", color: "var(--txt, #111)",
        }}
      >
        <Avatar name={name} url={avatarUrl} />
        <span style={{ fontSize: 13.5, fontWeight: 500, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" style={{ opacity: 0.5, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
 
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0, minWidth: 250,
          background: "#fff", border: "1px solid #e3e3ec", borderRadius: 12,
          boxShadow: "0 14px 40px rgba(0,0,0,0.16)", padding: 6, zIndex: 1000, color: "#111",
        }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 10px 12px" }}>
            <Avatar name={name} url={avatarUrl} size={36} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
              <div style={{ fontSize: 12, color: "#6b6b7b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.email}</div>
            </div>
          </div>
 
          <div style={{ height: 1, background: "#eeeef4", margin: "2px 0 6px" }} />
 
          {extraItems.map((it) => (
            <MenuItem key={it.label} danger={it.danger}
              onClick={() => { setOpen(false); it.onClick?.(); }}>
              {it.label}
            </MenuItem>
          ))}
 
          <MenuItem danger onClick={() => { setOpen(false); signOut(); }}>Log out</MenuItem>
        </div>
      )}
    </div>
  );
}
 
function Avatar({ name, url, size = 26 }) {
  if (url) {
    return <img src={url} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: ACCENT, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      fontSize: size * 0.42, fontWeight: 600, letterSpacing: 0.2,
    }}>{initials(name)}</div>
  );
}
 
function MenuItem({ children, onClick, danger }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
        padding: "9px 10px", borderRadius: 8, border: "none", cursor: "pointer",
        background: hover ? (danger ? "#fdecec" : "#f3f3f8") : "transparent",
        color: danger ? "#c0392b" : "#111", fontSize: 13.5, fontWeight: 500,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}
 
const btnGhost = {
  padding: "7px 14px", borderRadius: 8, border: "1px solid #e3e3ec", background: "#fff",
  fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", color: "#111",
};
const btnSolid = {
  padding: "7px 14px", borderRadius: 8, border: "none", background: ACCENT,
  fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: "#fff",
};
 
/* ------------------------------------------------------------------ */
/* Modal host — render once, as a sibling of <App/>                    */
/* ------------------------------------------------------------------ */
 
export function AuthModalHost() {
  const [open, setOpen] = useState(false);
  const resolver = useRef(null);
 
  useEffect(() => {
    if (!authEnabled) return;
    openLogin = () =>
      new Promise((resolve) => {
        resolver.current = resolve;
        setOpen(true);
      });
    // Resolve as soon as a session appears (covers OAuth redirect too).
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s && resolver.current) {
        resolver.current(true);
        resolver.current = null;
        setOpen(false);
      }
    });
    return () => {
      openLogin = null;
      sub.subscription.unsubscribe();
    };
  }, []);
 
  function dismiss() {
    if (resolver.current) { resolver.current(false); resolver.current = null; }
    setOpen(false);
  }
 
  if (!open) return null;
  return <LoginModal onDismiss={dismiss} />;
}
 
/* ------------------------------------------------------------------ */
/* The modal itself                                                    */
/* ------------------------------------------------------------------ */
 
const inp = {
  background: "#fff", border: "1px solid #e3e3ec", borderRadius: 10,
  color: "#111", fontSize: 15, padding: "12px 14px", outline: "none", width: "100%",
  fontFamily: "'Space Grotesk',sans-serif", boxSizing: "border-box",
};
 
function LoginModal({ onDismiss }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
 
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onDismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);
 
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const { error } = mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
      if (error) setMsg(error.message);
      else if (mode === "signup") setMsg("Account created — check your email to confirm, then sign in.");
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }
 
  async function google() {
    setMsg(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) setMsg(error.message);
  }
 
  return (
    <div
      onClick={onDismiss}
      style={{
        position: "fixed", inset: 0, background: "rgba(17,17,27,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 9999, padding: 20, backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 400, background: "#fff", borderRadius: 16,
          padding: "32px 30px", boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          fontFamily: "'Space Grotesk',sans-serif", color: "#111", position: "relative",
        }}
      >
        <button onClick={onDismiss} aria-label="Close" style={{
          position: "absolute", top: 14, right: 16, background: "none", border: "none",
          fontSize: 22, lineHeight: 1, color: "#9a9aab", cursor: "pointer",
        }}>×</button>
 
        <div style={{ fontSize: 11, letterSpacing: 1.6, textTransform: "uppercase", color: "#9a9aab" }}>
          Multi-agent literature review
        </div>
        <h2 style={{ fontSize: 23, fontWeight: 700, margin: "8px 0 6px" }}>
          {mode === "signin" ? "Sign in to continue" : "Create your account"}
        </h2>
        <p style={{ color: "#6b6b7b", fontSize: 14, marginTop: 0, marginBottom: 22 }}>
          Saṃhitā saves your searches, notes and reviews to your account.
        </p>
 
        <button onClick={google} type="button" style={{
          width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #e3e3ec",
          background: "#fff", fontSize: 15, fontWeight: 500, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          fontFamily: "inherit",
        }}>
          <GoogleIcon /> Continue with Google
        </button>
 
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0", color: "#a0a0b0", fontSize: 13 }}>
          <div style={{ flex: 1, height: 1, background: "#e3e3ec" }} /> or <div style={{ flex: 1, height: 1, background: "#e3e3ec" }} />
        </div>
 
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input type="email" required placeholder="Email address" value={email}
            onChange={(e) => setEmail(e.target.value)} style={inp} autoFocus />
          <input type="password" required placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} style={inp} />
          <button disabled={busy} type="submit" style={{
            width: "100%", padding: "12px 14px", borderRadius: 10, border: "none",
            background: ACCENT, color: "#fff", fontSize: 15, fontWeight: 600,
            cursor: busy ? "default" : "pointer", fontFamily: "inherit", marginTop: 4,
            opacity: busy ? 0.7 : 1,
          }}>
            {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
 
        {msg && <div style={{ color: "#c0392b", fontSize: 13, marginTop: 12 }}>{msg}</div>}
 
        <div style={{ fontSize: 14, color: "#6b6b7b", marginTop: 18 }}>
          {mode === "signin" ? "New here? " : "Already have an account? "}
          <button onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setMsg(null); }}
            style={{ background: "none", border: "none", color: ACCENT, fontWeight: 600, cursor: "pointer", fontSize: 14, padding: 0 }}>
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
 
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}
 
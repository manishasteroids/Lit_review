import React, { useState, useEffect, useRef } from "react";
import { authEnabled, supabase, authRedirectError, authRecoveryLink } from "./supabase.js";

// True when frontend/.env still has the template value from .env.example, in
// which case every sign-in request goes to a host that doesn't exist.
// const SUPABASE_PLACEHOLDER = /your-project\.supabase\.co/.test(import.meta.env.VITE_SUPABASE_URL || "");
const url = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_PLACEHOLDER = !url || /your-project\.supabase\.co/.test(url);
const NOT_CONFIGURED_MSG = "Sign-in isn't set up on this build: VITE_SUPABASE_URL in frontend/.env is still the placeholder. Put your real Supabase URL and anon key there, then restart the dev server.";
// A browser reports any unreachable server as "Failed to fetch" — say what that means instead.
function friendlyAuthError(err) {
  const m = (err && err.message) || "";
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return SUPABASE_PLACEHOLDER ? NOT_CONFIGURED_MSG
      : "We couldn't reach the sign-in service. Check your connection and try again.";
  }
  return m || "Something went wrong. Please try again.";
}
 
const ACCENT = "#6d5ef6";
 
/* Imperative gate                                                     */
 
// Set by <AuthModalHost/>. Opens the modal and resolves true/false.
let openLogin = null;
 
/**
 * Call before any action that requires an account.
 * Returns true if the user is signed in, false if they dismiss.
 * @param {{mode?: "signin"|"signup"}} [opts] which tab the modal should open
 *   on — e.g. a "Sign up" button shouldn't dump someone onto the sign-in
 *   form and make them find the "Create an account" toggle themselves.
 */
export async function ensureAuth(opts) {
  if (!authEnabled) return true;
  const { data } = await supabase.auth.getSession();
  if (data?.session) return true;
  if (!openLogin) return false;
  return openLogin(opts?.mode);
}
 
export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
 
/** Current session (null when signed out or auth disabled). */
// False until Supabase has finished working out whether someone is signed in
// (reading the saved session, or the tokens in the address after a Google /
// GitHub return). App waits for this before choosing between the landing page
// and the workspace, so a signed-in visitor never sees the landing page flash.
export function useAuthReady() {
  const [ready, setReady] = useState(!authEnabled);
  useEffect(() => {
    if (!authEnabled) return;
    let live = true;
    supabase.auth.getSession().finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);
  return ready;
}

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
      <button onClick={() => ensureAuth({ mode: "signin" })} style={btnGhost}>Log in</button>
      <button onClick={() => ensureAuth({ mode: "signup" })} style={btnSolid}>Sign up</button>
    </div>
  );
}
 
/** Display name: Google full name -> metadata name -> email local-part. */
export function displayName(user) {
  const m = user?.user_metadata || {};
  return m.full_name || m.name || (user?.email || "").split("@")[0] || "Account";
}
 
export function initials(name) {
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
 
export function Avatar({ name, url, size = 26 }) {
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
  const [initialMode, setInitialMode] = useState("signin");
  const resolver = useRef(null);
  const recoveryRef = useRef(false); // true while the "set a new password" form is showing
  const [redirectError, setRedirectError] = useState(null);

  // Arrived from the reset-password email: show the new-password form.
  useEffect(() => {
    if (!authEnabled || !authRecoveryLink) return;
    recoveryRef.current = true;
    setInitialMode("recovery");
    setOpen(true);
  }, []);

  // Came back from Google/GitHub with a failure: open the dialog and say why,
  // then drop the error from the address so a refresh doesn't show it again.
  useEffect(() => {
    if (!authEnabled || !authRedirectError) return;
    setRedirectError(`Sign-in didn't complete: ${authRedirectError.description}`);
    setInitialMode("signin");
    setOpen(true);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (!authEnabled) return;
    openLogin = (mode) =>
      new Promise((resolve) => {
        resolver.current = resolve;
        setInitialMode(mode === "signup" ? "signup" : "signin");
        setOpen(true);
      });
    // Resolve as soon as a session appears (covers OAuth redirect too).
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (_e === "PASSWORD_RECOVERY") {
        recoveryRef.current = true;
        setInitialMode("recovery");
        setOpen(true);
        return;
      }
      if (s && resolver.current && !recoveryRef.current) {
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
 
  function recoveryDone() {
    recoveryRef.current = false;
    if (resolver.current) { resolver.current(true); resolver.current = null; }
    setOpen(false);
  }

  function dismiss() {
    // Closing the reset form without choosing a password must not leave the
    // person signed in on the strength of the emailed link alone.
    if (recoveryRef.current) { recoveryRef.current = false; signOut(); }
    if (resolver.current) { resolver.current(false); resolver.current = null; }
    setOpen(false);
  }
 
  if (!open) return null;
  return <LoginModal key={initialMode} onDismiss={dismiss} onRecoveryDone={recoveryDone} initialMode={initialMode} initialMsg={redirectError} />;
}
 
/* ------------------------------------------------------------------ */
/* The modal itself                                                    */
/* ------------------------------------------------------------------ */
 
const inp = {
  background: "#fff", border: "1px solid #e3e3ec", borderRadius: 10,
  color: "#111", fontSize: 15, padding: "12px 14px", outline: "none", width: "100%",
  fontFamily: "'Space Grotesk',sans-serif", boxSizing: "border-box",
};

const lbl = {
  fontSize: 12.5, fontWeight: 600, color: "#6b6b7b", marginBottom: 5, display: "block",
};

// With six stacked inputs on signup, a placeholder alone stops being
// enough to tell fields apart once the browser autofills email/password
// (autofill replaces the placeholder with dots/blue highlight and there's
// no other cue) — a visible label above every field removes the ambiguity
// regardless of autofill state.
function Field({ label, ...props }) {
  return (
    <label style={{ display: "block" }}>
      <span style={lbl}>{label}</span>
      <input {...props} style={inp} />
    </label>
  );
}

function LoginModal({ onDismiss, onRecoveryDone, initialMode, initialMsg = null }) {
  const [mode, setMode] = useState(initialMode || "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState(""); // confirm, for the new-password form
  // Signup-only profile fields — collected once at account creation and
  // stashed in Supabase's user_metadata (no separate profiles table needed;
  // displayName() above already reads user_metadata.full_name).
  const [fullName, setFullName] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [msg, setMsg] = useState(initialMsg);
  // "success" renders green, "error" red — the signup confirmation notice
  // used to share the error colour and read like a failure.
  const [msgKind, setMsgKind] = useState("error");
  const [busy, setBusy] = useState(false);
  const [forgotEmailHint, setForgotEmailHint] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onDismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  // While the dialog is open the page behind it must not scroll — otherwise
  // the wheel moves the page instead of the form.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg(null); setMsgKind("error");
    const cleanEmail = email.trim();
    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo: window.location.origin });
        if (error && !/rate|too many|seconds/i.test(error.message)) { setMsg(friendlyAuthError(error)); return; }
        if (error) { setMsg("Please wait a minute before requesting another link."); return; }
        // Same message whether or not the address has an account, so this
        // form can't be used to find out who is registered.
        setMsgKind("success");
        setMsg(`If an account exists for ${cleanEmail}, we've sent a link to reset your password. It can take a minute; check spam too.`);
        return;
      }
      if (mode === "recovery") {
        if (password.length < 8) { setMsg("Use at least 8 characters."); return; }
        if (password !== password2) { setMsg("The two passwords don't match."); return; }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) { setMsg(friendlyAuthError(error)); return; }
        setMsgKind("success");
        setMsg("Password updated. You're signed in.");
        // Drop the recovery tokens from the address, then close.
        window.history.replaceState(null, "", window.location.pathname);
        setTimeout(() => onRecoveryDone?.(), 1200);
        return;
      }
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
        if (error) {
          // Supabase reports an unconfirmed address as "Email not confirmed"
          // (or, on some configs, the generic "Invalid login credentials").
          // Point people at the likely cause instead of just "invalid".
          const m = /not confirmed/i.test(error.message)
            ? "Please confirm your email first — open the link we sent you, then sign in."
            : /invalid login/i.test(error.message)
              ? "Invalid email or password. If you just signed up, confirm your email via the link we sent first."
              : friendlyAuthError(error);
          setMsg(m);
        }
        // On success, onAuthStateChange in AuthModalHost closes the modal.
        return;
      }

      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail, password,
        options: {
          // Where the confirmation link sends people (and signs them in).
          emailRedirectTo: window.location.origin,
          data: {
            full_name: fullName.trim() || undefined,
            affiliation: affiliation.trim() || undefined,
            phone: phone.trim() || undefined,
            address: address.trim() || undefined,
          },
        },
      });
      if (error) { setMsg(friendlyAuthError(error)); return; }
      if (data?.session) return; // email confirmation off → already signed in
      // With confirmation on, an already-registered address comes back as a
      // user with no identities rather than an error.
      if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        setMsg("An account with this email already exists — try signing in instead.");
        return;
      }
      setMsgKind("success");
      setMsg(`Account created! We sent a confirmation link to ${cleanEmail}. Open it to finish — you'll be signed in automatically. (Check spam if you don't see it.)`);
    } catch (err) {
      setMsg(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function oauth(provider) {
    setMsg(null); setMsgKind("error");
    if (SUPABASE_PLACEHOLDER) { setMsg(NOT_CONFIGURED_MSG); return; }
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) setMsg(friendlyAuthError(error));
  }
  const google = () => oauth("google");
  const github = () => oauth("github");
 
  return (
    <div
      onClick={onDismiss}
      style={{
        position: "fixed", inset: 0,
        // The reset form opens on a temporary session from the emailed link;
        // cover the app completely so the account isn't visible behind it.
        background: mode === "recovery" ? "#f3f2fb" : "rgba(17,17,27,0.45)",
        // The overlay itself scrolls: a form taller than the window (signup on
        // a laptop) scrolls inside it, and margin:auto on the card still
        // centres it whenever it does fit.
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        overflowY: "auto", overscrollBehavior: "contain",
        zIndex: 9999, padding: 20, backdropFilter: mode === "recovery" ? "none" : "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 400, background: "#fff", borderRadius: 16, margin: "auto",
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
          {mode === "signin" ? "Sign in to continue"
            : mode === "signup" ? "Create your account"
            : mode === "forgot" ? "Reset your password"
            : "Choose a new password"}
        </h2>
        <p style={{ color: "#6b6b7b", fontSize: 14, marginTop: 0, marginBottom: 22 }}>
          {mode === "forgot"
            ? "Enter the email you signed up with and we'll send you a reset link."
            : mode === "recovery"
              ? "Enter a new password for your account."
              : "Sift saves your searches, notes and reviews to your account."}
        </p>
        {(mode === "signin" || mode === "signup") && (<>
 
        <button onClick={google} type="button" style={{
          width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #e3e3ec",
          background: "#fff", fontSize: 15, fontWeight: 500, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          fontFamily: "inherit",
        }}>
          <GoogleIcon /> Continue with Google
        </button>

        <button onClick={github} type="button" style={{
          width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #e3e3ec",
          background: "#fff", fontSize: 15, fontWeight: 500, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          fontFamily: "inherit", marginTop: 10,
        }}>
          <GitHubIcon /> Continue with GitHub
        </button>
 
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0", color: "#a0a0b0", fontSize: 13 }}>
          <div style={{ flex: 1, height: 1, background: "#e3e3ec" }} /> or <div style={{ flex: 1, height: 1, background: "#e3e3ec" }} />
        </div>
        </>)}
 
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {mode === "signup" && (
            <>
              <Field label="Full name" type="text" required placeholder="Ada Lovelace" value={fullName}
                onChange={(e) => setFullName(e.target.value)} autoFocus />
              <Field label="Affiliation" type="text" placeholder="University, lab or company" value={affiliation}
                onChange={(e) => setAffiliation(e.target.value)} />
            </>
          )}
          {mode !== "recovery" && (
            <Field label="Email address" type="email" required placeholder="you@example.com" value={email}
              onChange={(e) => setEmail(e.target.value)} autoFocus={mode === "signin" || mode === "forgot"} autoComplete="email" />
          )}
          {mode !== "forgot" && (
            <Field label={mode === "recovery" ? "New password" : "Password"} type="password" required placeholder="••••••••" value={password}
              onChange={(e) => setPassword(e.target.value)} autoFocus={mode === "recovery"}
              autoComplete={mode === "signin" ? "current-password" : "new-password"} />
          )}
          {mode === "recovery" && (
            <Field label="Confirm new password" type="password" required placeholder="••••••••" value={password2}
              onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" />
          )}
          {mode === "signin" && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: -4 }}>
              <button type="button" onClick={() => { setMode("forgot"); setMsg(null); }}
                style={{ background: "none", border: "none", color: ACCENT, fontWeight: 600, cursor: "pointer", padding: 0, fontSize: 13, fontFamily: "inherit" }}>
                Forgot password?
              </button>
              <button type="button" onClick={() => { setMode("forgot"); setMsg(null); setMsgKind("error"); setForgotEmailHint(true); }}
                style={{ background: "none", border: "none", color: "#6b6b7b", cursor: "pointer", padding: 0, fontSize: 13, fontFamily: "inherit" }}>
                Forgot email?
              </button>
            </div>
          )}
          {mode === "signup" && (
            <>
              <Field label="Phone number (optional)" type="tel" placeholder="+1 555 000 1234" value={phone}
                onChange={(e) => setPhone(e.target.value)} />
              <Field label="Address (optional)" type="text" placeholder="City, country" value={address}
                onChange={(e) => setAddress(e.target.value)} />
            </>
          )}
          <button disabled={busy} type="submit" style={{
            width: "100%", padding: "12px 14px", borderRadius: 10, border: "none",
            background: ACCENT, color: "#fff", fontSize: 15, fontWeight: 600,
            cursor: busy ? "default" : "pointer", fontFamily: "inherit", marginTop: 4,
            opacity: busy ? 0.7 : 1,
          }}>
            {busy ? "…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account"
              : mode === "forgot" ? "Send reset link" : "Update password"}
          </button>
        </form>
 
        {msg && (
          <div style={{ color: msgKind === "success" ? "#1b7a3d" : "#c0392b", fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>
            {msg}
          </div>
        )}
 
        {mode === "forgot" && forgotEmailHint && (
          <div style={{ fontSize: 13, color: "#6b6b7b", marginTop: 12, lineHeight: 1.5 }}>
            Don't remember which email you used? Try <b>Continue with Google</b> or <b>GitHub</b> on the
            sign-in screen (it's the same account if the email matches), or write to{" "}
            <a href="mailto:contact@orcusintelligencelab.com" style={{ color: ACCENT }}>contact@orcusintelligencelab.com</a>.
          </div>
        )}
        {mode === "forgot" && (
          <div style={{ fontSize: 14, color: "#6b6b7b", marginTop: 18 }}>
            <button onClick={() => { setMode("signin"); setMsg(null); setForgotEmailHint(false); }}
              style={{ background: "none", border: "none", color: ACCENT, fontWeight: 600, cursor: "pointer", fontSize: 14, padding: 0 }}>
              ← Back to sign in
            </button>
          </div>
        )}
        {(mode === "signin" || mode === "signup") && (
        <div style={{ fontSize: 14, color: "#6b6b7b", marginTop: 18 }}>
          {mode === "signin" ? "New here? " : "Already have an account? "}
          <button onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin"); setMsg(null);
            setFullName(""); setAffiliation(""); setPhone(""); setAddress("");
          }}
            style={{ background: "none", border: "none", color: ACCENT, fontWeight: 600, cursor: "pointer", fontSize: 14, padding: 0 }}>
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </div>
        )}
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

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="#181717" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  );
}
 
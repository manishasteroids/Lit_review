import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

// When a Google/GitHub sign-in fails, Supabase sends the visitor back here
// with the reason in the address (…#error=…&error_description=…). Read it
// now, before the client below starts up and tidies the address, so the
// sign-in dialog can show it instead of silently landing on the home page.
function readAuthRedirectError() {
  try {
    const grab = (str) => {
      const q = new URLSearchParams(str.replace(/^[#?]/, ""));
      const code = q.get("error_code") || q.get("error");
      const desc = q.get("error_description");
      return code || desc ? { code: code || "", description: (desc || code || "").replace(/\+/g, " ") } : null;
    };
    return grab(window.location.hash) || grab(window.location.search);
  } catch {
    return null;
  }
}
export const authRedirectError = readAuthRedirectError();

export const authEnabled = Boolean(url && anon);
export const supabase = authEnabled
  ? createClient(url, anon, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// Force a token refresh (used after a 401 from the backend). Returns the new
// access token, or null if the refresh token itself is gone (real re-login).
export async function refreshAccessToken() {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.refreshSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}

// Access token to attach to backend requests (null when auth is off / signed
// out). Proactively refreshes when the current token is expired or within 60s
// of expiry, so a long-open tab doesn't hit the backend with a stale token.
export async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  let session = data?.session;
  const now = Math.floor(Date.now() / 1000);
  if (session && session.expires_at && session.expires_at - now < 60) {
    session = (await refreshAccessToken()) ? (await supabase.auth.getSession()).data?.session : session;
  }
  return session?.access_token || null;
}

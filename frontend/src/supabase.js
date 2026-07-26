import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

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

import { getAccessToken, refreshAccessToken } from "../supabase.js";

const BASE = import.meta.env.VITE_API_BASE || "http://localhost:8015";

// Attach the signed-in user's token so the backend scopes data to them.
async function authHeaders(extra = {}) {
  const token = await getAccessToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

// Requests that call an LLM can legitimately take a while (large corpora,
// Deep mode), but must never hang forever — a stalled call should surface an
// error the UI can show, not spin indefinitely. 75s covers a slow single-call
// answer over many sources with headroom.
const REQUEST_TIMEOUT_MS = 75_000;

// The Writer agent isn't one call — it writes title/abstract/intro/synthesis/
// gaps/future as 6 sequential LLM calls in one request so each section stays
// focused. Even at a normal ~10-15s per call that's over a minute end-to-end,
// so it needs real headroom instead of the single-call timeout tripping on
// ordinary latency.
const WRITE_TIMEOUT_MS = 240_000;

async function request(path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const send = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(BASE + path, {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        throw new Error("Timed out waiting for a response. The model may be rate-limited — try again in a moment.");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  let res = await send();
  // A 401 usually means the access token expired mid-session — refresh once and
  // retry before surfacing an error to the user.
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await send();
  }
  if (!res.ok) {
    let detail = "Request failed (" + res.status + ")";
    try {
      const j = await res.json();
      if (j.detail) detail = j.detail;
    } catch (e) {}
    throw new Error(detail);
  }
  return res.json();
}

// Generic SSE POST: calls onEvent for each streamed event, resolves with the
// final "done" event, throws on "error". Used by search + synthesize streams.
async function streamPost(path, body, onEvent) {
  const send = async () =>
    fetch(BASE + path, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body || {}),
    });
  let res = await send();
  // Refresh an expired token once and retry, so a long-open tab doesn't fail
  // the whole run with "please sign in again".
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await send();
  }
  if (!res.ok) {
    let detail = "Request failed (" + res.status + ")";
    try { const j = await res.json(); if (j.detail) detail = j.detail; } catch (e) {}
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6));
      onEvent(event);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") return event;
    }
  }
}

/**
 * Stream progress events from the search stage via SSE.
 */
function streamRun(topic, apiKey, model, mode, onEvent, projectId) {
  return streamPost("/api/runs/stream",
    { topic, api_key: apiKey || undefined, model, mode, project_id: projectId || undefined }, onEvent);
}

/* One function per pipeline stage — mirrors backend/api/routes.py 1:1 */
export const api = {
  createRunStream: streamRun,

  filterPapers: (runId, approvedIndices) =>
    request(`/api/runs/${runId}/filter`, { approved_indices: approvedIndices }),

  synthesize: (runId, apiKey, model, notes) =>
    request(`/api/runs/${runId}/synthesize`, { api_key: apiKey, model, notes }),

  // Streamed extract + synthesize — rows tick in as each batch is read.
  synthesizeStream: (runId, apiKey, model, notes, onEvent) =>
    streamPost(`/api/runs/${runId}/synthesize/stream`,
      { api_key: apiKey, model, notes }, onEvent),

  write: (runId, apiKey, model, notes) =>
    request(`/api/runs/${runId}/write`, { api_key: apiKey, model, notes }, WRITE_TIMEOUT_MS),

  evaluate: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/evaluate`, { api_key: apiKey, model }),

  designExperiments: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/experiments`, { api_key: apiKey, model }),

  // Sources-page editing
  resolvePaper: (runId, identifier) =>
    request(`/api/runs/${runId}/resolve`, { identifier }),

  addPaper: (runId, paper, apiKey, model, notes) =>
    request(`/api/runs/${runId}/add_paper`, { paper, api_key: apiKey, model, notes }),

  reanalyze: (runId, includedIndices, apiKey, model, notes) =>
    request(`/api/runs/${runId}/reanalyze`, {
      included_indices: includedIndices, api_key: apiKey, model, notes,
    }),

  chatAboutPaper: (runId, paper, question, history, apiKey, model, images, chatMode) =>
    request(`/api/runs/${runId}/chat`, {
      paper_idx: paper?.idx,
      paper,
      question,
      history: history || [],
      images: images || [],
      api_key: apiKey,
      model,
      chat_mode: chatMode,
    }),

  assessPaper: (runId, paper, scope, apiKey, model) =>
    request(`/api/runs/${runId}/assess`, {
      paper_idx: paper?.idx,
      paper,
      scope,
      api_key: apiKey,
      model,
    }),

  // ── Studio: multi-paper chat + artifacts ────────────────────────────────
  studioChat: (runId, question, paperIdxs, history, chatMode, apiKey) =>
    request(`/api/runs/${runId}/studio/chat`, {
      question, paper_idxs: paperIdxs || [], history: history || [],
      chat_mode: chatMode, api_key: apiKey,
    }),

  studioArtifact: (runId, artifact, paperIdxs, chatMode, apiKey) =>
    request(`/api/runs/${runId}/studio/${artifact}`, {
      question: "", paper_idxs: paperIdxs || [], chat_mode: chatMode, api_key: apiKey,
    }),

  // Download a generated Studio artifact — no extra model cost
  studioExport: async (runId, fmt, content, title, paperIdxs) => {
    const res = await fetch(`${BASE}/api/runs/${runId}/studio/export/${fmt}`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ content, title, paper_idxs: paperIdxs || [] }),
    });
    if (!res.ok) {
      let detail = `Export failed (${res.status})`;
      try { const j = await res.json(); if (j.detail) detail = j.detail; } catch (e) {}
      throw new Error(detail);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = m ? m[1] : `studio.${fmt}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  // Download the written review as pptx / pdf / docx (template: ieee | arxiv).
  // Generated server-side from existing content — no LLM cost.
  downloadExport: async (runId, fmt, template) => {
    const qs = template ? `?template=${encodeURIComponent(template)}` : "";
    const res = await fetch(`${BASE}/api/runs/${runId}/export/${fmt}${qs}`, {
      headers: await authHeaders(),
    });
    if (!res.ok) {
      let detail = `Export failed (${res.status})`;
      try { const j = await res.json(); if (j.detail) detail = j.detail; } catch (e) {}
      throw new Error(detail);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = m ? m[1] : `review.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  // Public science/AI news for the landing page — no auth, no LLM, cached server-side
  getNews: () =>
    fetch(BASE + "/api/news").then((r) => (r.ok ? r.json() : { items: [] }))
      .catch(() => ({ items: [] })),

  // Researcher profile (display name, ORCID, Google Scholar) — no LLM calls
  getProfile: async () =>
    fetch(BASE + "/api/profile", { headers: await authHeaders() })
      .then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  saveProfile: (data) => request("/api/profile", data),

  // Per-paper chat history (keyed by paper URL, scoped to the user) — no LLM calls
  getChatHistory: async (paperKey) =>
    fetch(BASE + "/api/chat/history?paper_key=" + encodeURIComponent(paperKey || ""),
      { headers: await authHeaders() }).then((r) => (r.ok ? r.json() : { messages: [] })),
  saveChatHistory: async (paperKey, messages) =>
    fetch(BASE + "/api/chat/history", {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ paper_key: paperKey, messages: messages || [] }),
    }).then((r) => (r.ok ? r.json() : { ok: false })).catch(() => ({ ok: false })),

  // Search modes for the selector — no LLM calls
  getModes: () => fetch(BASE + "/api/modes").then((r) => r.json()),

  // Which model each pipeline stage runs on, given a mode — no LLM calls
  pipelineModels: (model, mode) =>
    fetch(BASE + "/api/pipeline/models?model=" + encodeURIComponent(model || "") +
      "&mode=" + encodeURIComponent(mode || "")).then((r) => r.json()),

  // Token usage & cost for a session — no LLM calls
  getUsage: async (runId) =>
    fetch(BASE + "/api/sessions/" + runId + "/usage", { headers: await authHeaders() }).then((r) => r.json()),

  // Per-day token + cost trend for the signed-in user (grouped in local time)
  getUsageTrend: async (days = 30) =>
    fetch(BASE + "/api/usage/trend?days=" + days + "&tz_offset=" + new Date().getTimezoneOffset(),
      { headers: await authHeaders() }).then((r) => r.json()),

  // ── Projects: folder a line of research (runs + saved papers + notes) ──
  listProjects: async () =>
    fetch(BASE + "/api/projects", { headers: await authHeaders() }).then((r) => r.json()),
  createProject: (name, description) =>
    request("/api/projects", { name, description }),
  getProject: async (id) =>
    fetch(BASE + "/api/projects/" + id, { headers: await authHeaders() }).then((r) => r.json()),
  updateProject: async (id, patch) =>
    fetch(BASE + "/api/projects/" + id, {
      method: "PATCH",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(patch || {}),
    }).then((r) => r.json()),
  deleteProject: async (id, keepRuns = true) =>
    fetch(BASE + "/api/projects/" + id + "?keep_runs=" + keepRuns, {
      method: "DELETE",
      headers: await authHeaders(),
    }).then((r) => r.json()),
  assignRunProject: (runId, projectId) =>
    request(`/api/runs/${runId}/project`, { project_id: projectId }),
  addProjectPaper: (projectId, paper, source) =>
    request(`/api/projects/${projectId}/papers`, { paper, source: source || "manual" }),
  removeProjectPaper: async (projectId, paperId) =>
    fetch(BASE + `/api/projects/${projectId}/papers/${paperId}`, {
      method: "DELETE", headers: await authHeaders(),
    }).then((r) => r.json()),
  addProjectNote: (projectId, title, body) =>
    request(`/api/projects/${projectId}/notes`, { title, body }),
  updateProjectNote: async (projectId, noteId, patch) =>
    fetch(BASE + `/api/projects/${projectId}/notes/${noteId}`, {
      method: "PATCH",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(patch || {}),
    }).then((r) => r.json()),
  removeProjectNote: async (projectId, noteId) =>
    fetch(BASE + `/api/projects/${projectId}/notes/${noteId}`, {
      method: "DELETE", headers: await authHeaders(),
    }).then((r) => r.json()),
  zoteroImport: (projectId, apiKey, libraryId, libraryType) =>
    request(`/api/projects/${projectId}/zotero/import`, {
      api_key: apiKey, library_id: libraryId, library_type: libraryType || "user",
    }),

  // Session history — no LLM calls
  listSessions: async () =>
    fetch(BASE + "/api/sessions", { headers: await authHeaders() }).then((r) => r.json()),
  getSession: async (id) =>
    fetch(BASE + "/api/sessions/" + id, { headers: await authHeaders() }).then((r) => r.json()),
  deleteSession: async (id) =>
    fetch(BASE + "/api/sessions/" + id, { method: "DELETE", headers: await authHeaders() }).then((r) => r.json()),
  deleteAllSessions: async () =>
    fetch(BASE + "/api/sessions", { method: "DELETE", headers: await authHeaders() }).then((r) => r.json()),
};

import { getAccessToken } from "../supabase.js";

const BASE = import.meta.env.VITE_API_BASE || "http://localhost:8015";

// Attach the signed-in user's token so the backend scopes data to them.
async function authHeaders(extra = {}) {
  const token = await getAccessToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function request(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
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
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
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
function streamRun(topic, apiKey, model, mode, onEvent) {
  return streamPost("/api/runs/stream",
    { topic, api_key: apiKey || undefined, model, mode }, onEvent);
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
    request(`/api/runs/${runId}/write`, { api_key: apiKey, model, notes }),

  evaluate: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/evaluate`, { api_key: apiKey, model }),

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

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

/**
 * Stream progress events from the search stage via SSE.
 * onEvent(event) is called for each parsed event object.
 * Resolves with the final "done" event payload, or throws on "error".
 */
async function streamRun(topic, apiKey, model, onEvent) {
  const res = await fetch(BASE + "/api/runs/stream", {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ topic, api_key: apiKey || undefined, model }),
  });
  if (!res.ok) {
    let detail = "Search failed (" + res.status + ")";
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

/* One function per pipeline stage â€” mirrors backend/api/routes.py 1:1 */
export const api = {
  createRunStream: streamRun,

  filterPapers: (runId, approvedIndices) =>
    request(`/api/runs/${runId}/filter`, { approved_indices: approvedIndices }),

  synthesize: (runId, apiKey, model, notes) =>
    request(`/api/runs/${runId}/synthesize`, { api_key: apiKey, model, notes }),

  write: (runId, apiKey, model, notes) =>
    request(`/api/runs/${runId}/write`, { api_key: apiKey, model, notes }),

  evaluate: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/evaluate`, { api_key: apiKey, model }),

  chatAboutPaper: (runId, paper, question, history, apiKey, model, images) =>
    request(`/api/runs/${runId}/chat`, {
      paper_idx: paper?.idx,
      paper,
      question,
      history: history || [],
      images: images || [],
      api_key: apiKey,
      model,
    }),

  assessPaper: (runId, paper, scope, apiKey, model) =>
    request(`/api/runs/${runId}/assess`, {
      paper_idx: paper?.idx,
      paper,
      scope,
      api_key: apiKey,
      model,
    }),

  // Session history â€” no LLM calls
  listSessions: async () =>
    fetch(BASE + "/api/sessions", { headers: await authHeaders() }).then((r) => r.json()),
  getSession: async (id) =>
    fetch(BASE + "/api/sessions/" + id, { headers: await authHeaders() }).then((r) => r.json()),
  deleteSession: async (id) =>
    fetch(BASE + "/api/sessions/" + id, { method: "DELETE", headers: await authHeaders() }).then((r) => r.json()),
  deleteAllSessions: async () =>
    fetch(BASE + "/api/sessions", { method: "DELETE", headers: await authHeaders() }).then((r) => r.json()),
};

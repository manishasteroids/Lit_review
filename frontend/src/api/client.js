const BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

async function request(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

/* One function per pipeline stage — mirrors backend/api/routes.py 1:1 */
export const api = {
  createRun: (topic, apiKey, model) =>
    request("/api/runs", { topic, api_key: apiKey, model }),

  filterPapers: (runId, approvedIndices) =>
    request(`/api/runs/${runId}/filter`, { approved_indices: approvedIndices }),

  synthesize: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/synthesize`, { api_key: apiKey, model }),

  write: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/write`, { api_key: apiKey, model }),

  evaluate: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/evaluate`, { api_key: apiKey, model }),
};

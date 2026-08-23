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
// ordinary latency. A large source count (40-50 papers) means a bigger corpus
// block on every one of those 6 calls, and if the account is anywhere near an
// Anthropic rate limit the SDK's own internal retry/backoff can silently add
// tens of seconds PER call — so this needs real headroom even outside Deep
// mode. Deep mode writes meaningfully longer sections on top of that (up to
// 3000 output tokens each, on Opus), so it gets the largest allowance.
const WRITE_TIMEOUT_MS = 360_000;
const WRITE_TIMEOUT_MS_DEEP = 600_000;

// Same problem as the Writer, one flight up: refine_experiments() chains
// design (1 call) -> critique (1 call) -> refine EACH weak hypothesis (up to
// 2 calls) -> critique again -> refine again, up to 2 rounds — worst case 7
// sequential Claude calls in one request. The default 75s timeout trips on
// that well before anything is actually wrong (see "Hypothesis Refinement
// failed: Timed out" — that was this, not a real backend hang).
const REFINE_TIMEOUT_MS = 300_000;

// Paper chat is a single LLM call, but not always a cheap one: "Report" and
// "Diagram" chips (and any figure/table question) attach the FULL PDF and,
// in Deep mode, run it through Sonnet — that alone can take well past 75s on
// a long paper, especially with any provider-side latency. The generic 75s
// budget was tripping on ordinary Deep-mode latency and showing a misleading
// "may be rate-limited" message for what was really just a slow-but-healthy
// call. Quick mode (Gemini, abstract/text only) rarely needs this long, but
// giving both modes the same headroom is simplest and costs nothing when the
// call finishes early anyway.
const CHAT_TIMEOUT_MS = 180_000;

// Authenticated GET with the same 401-refresh-retry + real error surfacing as
// request() below — several GET endpoints (usage trend, etc.) used to bypass
// this with a raw fetch(...).then(r => r.json()), so an expired token (or any
// non-2xx) just resolved with a wrong-shaped body or silently rejected,
// leaving the caller's .catch(() => {}) with nothing to show the user and a
// whole UI section (e.g. the usage trend charts) quietly vanishing.
async function getJSON(path) {
  const send = async () => fetch(BASE + path, { headers: await authHeaders() });
  let res = await send();
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

// Same 401-refresh-retry pattern as getJSON, but for a binary body (the
// paper PDF viewer needs raw bytes, not JSON) — used by api.getPaperPdf().
async function getBinary(path) {
  const send = async () => fetch(BASE + path, { headers: await authHeaders() });
  let res = await send();
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await send();
  }
  if (!res.ok) {
    let detail = res.status === 404
      ? "No open-access PDF found for this paper."
      : "Request failed (" + res.status + ")";
    try {
      const j = await res.json();
      if (j.detail) detail = j.detail;
    } catch (e) {}
    throw new Error(detail);
  }
  return res.arrayBuffer();
}

// Same 401-refresh-retry pattern as getJSON, but DELETE with no body.
async function del(path) {
  const send = async () => fetch(BASE + path, { method: "DELETE", headers: await authHeaders() });
  let res = await send();
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

async function patch(path, body) {
  const send = async () => fetch(BASE + path, {
    method: "PATCH",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
  let res = await send();
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

// Multipart POST for file uploads (Sources > "Upload a file") — same
// 401-refresh-retry + error surfacing as request(), but the body is
// FormData so the browser sets its own Content-Type (multipart boundary).
async function postForm(path, formData, timeoutMs = REQUEST_TIMEOUT_MS) {
  const send = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(BASE + path, {
        method: "POST",
        headers: await authHeaders(),
        body: formData,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        throw new Error("Timed out waiting for a response. Try again in a moment.");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  let res = await send();
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

  // Studio-only entry: a run with no search — just a place to upload your
  // own PDFs/DOCX/PPTX and use Studio (chat/report/deck) directly, without
  // the reformulate -> search -> filter -> write pipeline.
  createBlankRun: (topic, projectId) =>
    request("/api/runs/blank", { topic: topic || undefined, project_id: projectId || undefined }),

  filterPapers: (runId, approvedIndices) =>
    request(`/api/runs/${runId}/filter`, { approved_indices: approvedIndices }),

  synthesize: (runId, apiKey, model, notes) =>
    request(`/api/runs/${runId}/synthesize`, { api_key: apiKey, model, notes }),

  // Streamed extract + synthesize — rows tick in as each batch is read.
  synthesizeStream: (runId, apiKey, model, notes, onEvent) =>
    streamPost(`/api/runs/${runId}/synthesize/stream`,
      { api_key: apiKey, model, notes }, onEvent),

  write: (runId, apiKey, model, notes, mode) =>
    request(`/api/runs/${runId}/write`, { api_key: apiKey, model, notes },
      mode === "deep" ? WRITE_TIMEOUT_MS_DEEP : WRITE_TIMEOUT_MS),

  evaluate: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/evaluate`, { api_key: apiKey, model }),

  // Raw PDF bytes for the in-app read-only viewer (Phase 1 of paper
  // annotation). Throws with a friendly message on 404 (no open-access copy).
  getPaperPdf: (runId, idx) =>
    getBinary(`/api/runs/${runId}/papers/${idx}/pdf`),

  // Phase 2 — highlights/underlines/comments made while reading a paper.
  listAnnotations: (runId, idx) =>
    getJSON(`/api/runs/${runId}/papers/${idx}/annotations`),

  addAnnotation: (runId, idx, { kind, page, rects, color, snippet, comment }) =>
    request(`/api/runs/${runId}/papers/${idx}/annotations`,
      { kind, page, rects, color, snippet, comment }),

  deleteAnnotation: (runId, idx, annotationId) =>
    del(`/api/runs/${runId}/papers/${idx}/annotations/${annotationId}`),

  // Reposition an existing annotation (currently used for dragging text
  // notes to a new spot on the page) — only `rects` moves, everything else
  // about the mark stays the same.
  moveAnnotation: (runId, idx, annotationId, rects) =>
    patch(`/api/runs/${runId}/papers/${idx}/annotations/${annotationId}`, { rects }),

  designExperiments: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/experiments`, { api_key: apiKey, model }),

  refineExperiments: (runId, apiKey, model) =>
    request(`/api/runs/${runId}/experiments/refine`, { api_key: apiKey, model },
      REFINE_TIMEOUT_MS),

  // Direct human edit to one hypothesis — instant, no LLM call.
  updateHypothesis: async (runId, index, edits) =>
    fetch(BASE + `/api/runs/${runId}/experiments/${index}`, {
      method: "PATCH",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ edits }),
    }).then((r) => r.json()),

  // Argue with a hypothesis — the designer either revises it or defends it
  // with a specific counter-reason. One LLM call, but give it real headroom
  // for the same reason as Refine (rate-limit retries can add tens of
  // seconds on top of ordinary latency).
  disputeHypothesis: (runId, index, argument, apiKey, model) =>
    request(`/api/runs/${runId}/experiments/${index}/dispute`,
      { argument, api_key: apiKey, model }, 120_000),

  // Download the hypothesis + experiment plan as .docx or .pdf — same
  // generated-from-existing-content, no-LLM-cost approach as downloadExport.
  downloadExperimentsExport: async (runId, fmt) => {
    const res = await fetch(`${BASE}/api/runs/${runId}/experiments/export/${fmt}`, {
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
    a.download = m ? m[1] : `experiments.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  // Sources-page editing
  resolvePaper: (runId, identifier) =>
    request(`/api/runs/${runId}/resolve`, { identifier }),

  addPaper: (runId, paper, apiKey, model, notes) =>
    request(`/api/runs/${runId}/add_paper`, { paper, api_key: apiKey, model, notes }),

  // Add a source from a local PDF/DOCX file — extraction runs server-side in
  // the same call, so this returns {paper, extraction} just like addPaper.
  uploadPaper: (runId, file, apiKey, model, notes, titleOverride) => {
    const fd = new FormData();
    fd.append("file", file);
    if (apiKey) fd.append("api_key", apiKey);
    if (model) fd.append("model", model);
    if (notes) fd.append("notes", JSON.stringify(notes));
    // Title is guessed from the extracted text when omitted — a heuristic
    // that has no real notion of "title" vs. "author line" and can merge or
    // truncate wrong. Letting the user type the real one skips the guess
    // entirely instead of asking them to fix a wrong title after the fact.
    if (titleOverride && titleOverride.trim()) fd.append("title", titleOverride.trim());
    return postForm(`/api/runs/${runId}/upload_paper`, fd, WRITE_TIMEOUT_MS);
  },

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
    }, CHAT_TIMEOUT_MS),

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

  // Studio chat history (per run, scoped to the user) — no LLM calls
  getStudioHistory: async (runId) =>
    fetch(BASE + `/api/runs/${runId}/studio/history`, { headers: await authHeaders() })
      .then((r) => (r.ok ? r.json() : { messages: [] })).catch(() => ({ messages: [] })),
  saveStudioHistory: async (runId, messages) =>
    fetch(BASE + `/api/runs/${runId}/studio/history`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ messages: messages || [] }),
    }).then((r) => (r.ok ? r.json() : { ok: false })).catch(() => ({ ok: false })),

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
  // Generated server-side from existing content — no LLM cost, UNLESS
  // `illustrate` is set (pptx only): that's an explicit opt-in that generates
  // one AI image per section and costs real money — see ExportBar.jsx's cost
  // disclosure before this is ever called with illustrate=true. Images are
  // cached server-side per run, so re-downloading doesn't recharge.
  downloadExport: async (runId, fmt, template, illustrate) => {
    const params = new URLSearchParams();
    if (template) params.set("template", template);
    if (illustrate) params.set("illustrate", "true");
    const qs = params.toString() ? `?${params.toString()}` : "";
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

  // Download the papers TABLE (not the written review) as CSV/XLSX — works
  // at the Filter stage (extraction columns just come back blank) or the
  // Sources stage. `included` (idx -> bool) is optional; pass the Filter
  // page's live checkbox state so the export reflects what's on screen even
  // before "Review N papers" has been submitted to the backend.
  downloadPaperList: async (runId, fmt, included) => {
    const res = await fetch(`${BASE}/api/runs/${runId}/papers/export`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fmt, included: included || null }),
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
    a.download = m ? m[1] : `papers.${fmt}`;
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
  getUsage: (runId) => getJSON("/api/sessions/" + runId + "/usage"),

  // Per-day token + cost trend for the signed-in user (grouped in local time)
  getUsageTrend: (days = 30) =>
    getJSON("/api/usage/trend?days=" + days + "&tz_offset=" + new Date().getTimezoneOffset()),

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

  // ── Project sharing: collaborators (full access) + read-only email links ──
  listCollaborators: async (projectId) =>
    fetch(BASE + `/api/projects/${projectId}/collaborators`, { headers: await authHeaders() }).then((r) => r.json()),
  addCollaborator: async (projectId, email) => {
    const res = await fetch(BASE + `/api/projects/${projectId}/collaborators`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not add collaborator.");
    return data;
  },
  removeCollaborator: async (projectId, userId) =>
    fetch(BASE + `/api/projects/${projectId}/collaborators/${userId}`, {
      method: "DELETE", headers: await authHeaders(),
    }).then((r) => r.json()),
  listShareLinks: async (projectId) =>
    fetch(BASE + `/api/projects/${projectId}/share-links`, { headers: await authHeaders() }).then((r) => r.json()),
  createShareLink: async (projectId, emails) => {
    const res = await fetch(BASE + `/api/projects/${projectId}/share-links`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ emails }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not create share link.");
    return data;
  },
  revokeShareLink: async (projectId, linkId) =>
    fetch(BASE + `/api/projects/${projectId}/share-links/${linkId}`, {
      method: "DELETE", headers: await authHeaders(),
    }).then((r) => r.json()),

  // Public share viewer — no auth headers, token + email in the request itself
  shareVerify: async (token, email) => {
    const res = await fetch(BASE + `/api/share/${token}/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Access denied.");
    return data;
  },
  shareGetProject: async (token, email) => {
    const res = await fetch(BASE + `/api/share/${token}/project?email=` + encodeURIComponent(email));
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Access denied.");
    return data;
  },
  shareGetRun: async (token, runId, email) => {
    const res = await fetch(BASE + `/api/share/${token}/runs/${runId}?email=` + encodeURIComponent(email));
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Access denied.");
    return data;
  },

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

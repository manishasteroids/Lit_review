import React, { useState, useRef, useEffect } from "react";
import { api } from "../api/client.js";

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true });
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;  // 5 MB per attached image

const chipStyle = {
  background: "var(--panel2, transparent)", border: "1px solid var(--line)",
  borderRadius: 7, color: "var(--muted)", cursor: "pointer", fontSize: 11,
  padding: "3px 9px", whiteSpace: "nowrap",
};

export default function PaperChatPanel({ runId, paper, extraction, cite, apiKey, model, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState([]); // [{ media_type, data, preview }]
  const [sending, setSending] = useState(false);
  const [chatMode, setChatMode] = useState("quick"); // quick (Gemini) | deep (Sonnet)
  const logRef = useRef(null);
  const fileRef = useRef(null);

  // ── Cache-first answers: rendered instantly from the extraction, no LLM call ──
  function pushCached(question, text) {
    setMessages((prev) => [...prev,
      { role: "user", content: question },
      { role: "assistant", content: text, cached: true }]);
  }
  function summarizeFromCache() {
    const e = extraction || {};
    const rows = [];
    if (e.contribution) rows.push(`**Contribution.** ${e.contribution}`);
    if (e.method) rows.push(`**Method.** ${e.method}`);
    if (e.finding) rows.push(`**Key finding.** ${e.finding}`);
    if (e.metrics && e.metrics !== "n/a") rows.push(`**Metrics.** ${e.metrics}`);
    if (e.data && e.data !== "n/a") rows.push(`**Data.** ${e.data}`);
    if (e.limitation) rows.push(`**Limitation.** ${e.limitation}`);
    if (e.concepts?.length) rows.push(`**Concepts.** ${e.concepts.join(", ")}`);
    const abs = paper?.abstract ? `\n\n**Abstract.** ${paper.abstract}` : "";
    const body = rows.length ? rows.join("\n\n") + abs
      : (paper?.abstract || "No cached extraction yet — ask a question to read the paper.");
    pushCached("Summarize this paper", `*From the cached extraction — no model call.*\n\n${body}`);
  }
  const FACTS = [["Method", "method"], ["Finding", "finding"], ["Metrics", "metrics"],
                 ["Limitation", "limitation"], ["Contribution", "contribution"]];
  function askFact(label, key) {
    const v = (extraction || {})[key];
    pushCached(`${label}?`, v && v !== "n/a"
      ? `**${label}.** ${v}`
      : "That isn't in the cached extraction — ask in the box below to read the paper.");
  }

  // Send a text question to the model (chips use this in Deep mode).
  async function askLLM(question) {
    if (sending) return;
    const history = messages;
    const next = [...history, { role: "user", content: question }];
    setMessages(next); setSending(true);
    try {
      const res = await api.chatAboutPaper(runId, paper, question, history,
        apiKey || undefined, model, [], chatMode);
      setMessages([...next, { role: "assistant", content: res.answer }]);
    } catch (err) {
      setMessages([...next, { role: "assistant", content: "⚠ " + err.message }]);
    } finally { setSending(false); }
  }

  // Chips: Quick = instant from cache (free); Deep = re-read the paper with Sonnet.
  function onSummarize() {
    if (chatMode === "deep")
      askLLM("Summarize this paper: objective, method, key results with numbers, and limitations.");
    else summarizeFromCache();
  }
  function onFact(label, key) {
    if (chatMode === "deep")
      askLLM(`Explain this paper's ${label.toLowerCase()} in detail, grounded in the full text.`);
    else askFact(label, key);
  }

  // History follows the PAPER (by URL), not the run — so it persists across runs
  // and devices. The DB is authoritative; localStorage is an offline cache.
  const paperKey = paper?.url || paper?.doi || paper?.title || "";
  const storeKey = `samhita-chat:${paperKey}`;
  const loadedKey = useRef(null);

  useEffect(() => {
    setDraft(""); setImages([]);
    if (!paperKey) { setMessages([]); return; }
    let cached = [];
    try {
      const saved = localStorage.getItem(storeKey);
      cached = saved ? JSON.parse(saved) : [];
    } catch { cached = []; }
    setMessages(cached);            // show instantly from local cache
    loadedKey.current = null;       // block saves until the server load resolves
    let alive = true;
    api.getChatHistory(paperKey)
      .then((r) => {
        if (!alive) return;
        const server = r?.messages || [];
        if (server.length) setMessages(server);   // server wins if it has history
      })
      .catch(() => {})
      .finally(() => { if (alive) loadedKey.current = paperKey; });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperKey]);

  useEffect(() => {
    if (!paper || !paperKey) return;
    // don't overwrite storage until this paper's history has finished loading
    if (loadedKey.current !== paperKey) return;
    try {
      localStorage.setItem(storeKey, JSON.stringify(messages));
    } catch {
      try {
        localStorage.setItem(storeKey, JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content }))));
      } catch { /* give up quietly */ }
    }
    api.saveChatHistory(paperKey, messages);   // persist to DB (fire-and-forget)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, paperKey]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, sending]);

  function onFiles(e) {
    const files = Array.from(e.target.files || []);
    files.forEach((f) => {
      if (!f.type.startsWith("image/")) return;
      if (f.size > MAX_IMAGE_BYTES) {
        alert(`"${f.name}" is too large (max 5 MB).`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);         // data:image/png;base64,XXXX
        const [meta, data] = dataUrl.split(",");
        const media_type = meta.slice(5).split(";")[0]; // image/png
        setImages((prev) => [...prev, { media_type, data, preview: dataUrl }]);
      };
      reader.readAsDataURL(f);
    });
    e.target.value = "";
  }

  async function send() {
    const q = draft.trim();
    if ((!q && images.length === 0) || sending) return;
    const question = q || "Explain the attached image(s) in relation to this paper.";
    const history = messages;
    const previews = images.map((im) => im.preview);
    const next = [...history, { role: "user", content: q, images: previews }];
    const imgs = images.map(({ media_type, data }) => ({ media_type, data }));
    setMessages(next); setDraft(""); setImages([]); setSending(true);
    try {
      const res = await api.chatAboutPaper(runId, paper, question, history, apiKey || undefined, model, imgs, chatMode);
      setMessages([...next, { role: "assistant", content: res.answer }]);
    } catch (err) {
      setMessages([...next, { role: "assistant", content: "⚠ " + err.message }]);
    } finally { setSending(false); }
  }

  if (!paper) return null;

  return (
    <>
      <div className="chat-scrim" onClick={onClose} />
      <div className="chat-panel">
        <div className="chat-head">
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">Chat · source [{cite}]</div>
            <div className="chat-paper-title">{paper.title}</div>
            <div className="chat-paper-meta">{paper.authors || "—"} · {paper.year || "—"}</div>
          </div>
          <button className="chat-close" onClick={onClose}>✕</button>
        </div>

        {/* Mode toggle + cache-first quick actions (instant, no LLM call) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 7, overflow: "hidden" }}>
            {[["quick", "Quick", "Gemini · cheap"], ["deep", "Deep", "Sonnet · best"]].map(([id, lab, tip]) => (
              <button key={id} title={tip} onClick={() => setChatMode(id)}
                style={{ border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, padding: "3px 10px",
                  background: chatMode === id ? "var(--indigo)" : "transparent",
                  color: chatMode === id ? "#fff" : "var(--muted)" }}>{lab}</button>
            ))}
          </div>
          <span style={{ width: 1, height: 16, background: "var(--line)" }} />
          <button onClick={onSummarize}
            title={chatMode === "deep" ? "Deep: re-reads the paper with Sonnet" : "Instant, from cached extraction"}
            style={chipStyle}>Summarize {chatMode === "deep" ? "" : "⚡"}</button>
          {FACTS.map(([lab, key]) => (
            <button key={key} onClick={() => onFact(lab, key)} style={chipStyle}>{lab}</button>
          ))}
        </div>

        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="chat-hint">
              <b>Quick</b> — chips answer instantly from the cached extraction (free); typed
              questions read the full PDF on Gemini (cheap). <b>Deep</b> — chips and questions
              re-read the full paper with Sonnet for thorough, reasoned answers (costs more).
              You can also attach a figure and ask it to explain or compare it with the paper.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={"chat-msg " + m.role}>
              {m.images && m.images.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: m.content ? 6 : 0 }}>
                  {m.images.map((src, j) => (
                    <img key={j} src={src} alt="" style={{ maxWidth: 180, maxHeight: 180, borderRadius: 8, display: "block" }} />
                  ))}
                </div>
              )}
              {m.role === "assistant" && m.content
                ? <div className="chat-md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(m.content)) }} />
                : m.content}
            </div>
          ))}
          {sending && <div className="chat-msg assistant chat-hint">thinking…</div>}
        </div>

        {images.length > 0 && (
          <div style={{ display: "flex", gap: 8, padding: "10px 14px 0", flexWrap: "wrap" }}>
            {images.map((im, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img src={im.preview} alt="" style={{ height: 46, width: 46, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }} />
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  style={{ position: "absolute", top: -6, right: -6, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: "50%", width: 16, height: 16, color: "var(--muted)", cursor: "pointer", fontSize: 10, lineHeight: 1, padding: 0 }}
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div className="chat-input">
          <button
            type="button"
            title="Attach image"
            onClick={() => fileRef.current?.click()}
            style={{ background: "var(--ink)", border: "1px solid var(--line)", borderRadius: 9, color: "var(--muted)", cursor: "pointer", fontSize: 16, padding: "0 12px" }}
          >＋</button>
          <input autoFocus value={draft} placeholder="Ask about this paper"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()} />
          <button onClick={send} disabled={sending || (!draft.trim() && images.length === 0)}>send</button>
        </div>

        <input ref={fileRef} type="file" accept="image/*" multiple onChange={onFiles} style={{ display: "none" }} />
      </div>
    </>
  );
}

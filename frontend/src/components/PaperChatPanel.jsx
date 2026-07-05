import React, { useState, useRef, useEffect } from "react";
import { api } from "../api/client.js";

export default function PaperChatPanel({ runId, paper, cite, apiKey, model, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef(null);

  useEffect(() => { setMessages([]); setDraft(""); }, [paper?.idx]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, sending]);

  async function send() {
    const q = draft.trim();
    if (!q || sending) return;
    const history = messages;
    const next = [...history, { role: "user", content: q }];
    setMessages(next); setDraft(""); setSending(true);
    try {
      const res = await api.chatAboutPaper(runId, paper.idx, q, history, apiKey || undefined, model);
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
        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="chat-hint">
              Ask anything about this paper — its method, findings, limitations, or how it
              compares to the others. Answers come only from this paper's abstract and the
              extracted fields.
            </div>
          )}
          {messages.map((m, i) => <div key={i} className={"chat-msg " + m.role}>{m.content}</div>)}
          {sending && <div className="chat-msg assistant chat-hint">thinking…</div>}
        </div>
        <div className="chat-input">
          <input autoFocus value={draft} placeholder="Ask about this paper"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()} />
          <button onClick={send} disabled={sending || !draft.trim()}>send</button>
        </div>
      </div>
    </>
  );
}

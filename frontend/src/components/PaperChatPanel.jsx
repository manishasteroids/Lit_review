import React, { useState, useRef, useEffect } from "react";
import { api } from "../api/client.js";

export default function PaperChatPanel({ runId, paper, cite, apiKey, model, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState([]); // [{ media_type, data, preview }]
  const [sending, setSending] = useState(false);
  const logRef = useRef(null);
  const fileRef = useRef(null);

  const storeKey = `samhita-chat:${runId}:${paper?.idx}`;

  // Load this paper's saved chat when the panel opens / paper changes.
  useEffect(() => {
    setDraft(""); setImages([]);
    try {
      const saved = localStorage.getItem(storeKey);
      setMessages(saved ? JSON.parse(saved) : []);
    } catch {
      setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, paper?.idx]);

  // Persist the chat so it survives a refresh.
  useEffect(() => {
    if (!paper) return;
    try {
      localStorage.setItem(storeKey, JSON.stringify(messages));
    } catch {
      // quota exceeded (big images) — save text-only as a fallback
      try {
        localStorage.setItem(storeKey, JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content }))));
      } catch { /* give up quietly */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, runId, paper?.idx]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, sending]);

  function onFiles(e) {
    const files = Array.from(e.target.files || []);
    files.forEach((f) => {
      if (!f.type.startsWith("image/")) return;
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
      const res = await api.chatAboutPaper(runId, paper, question, history, apiKey || undefined, model, imgs);
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
              Ask anything about this paper — its method, findings, figures, limitations, or how
              it compares to others. For open-access papers it reads the full PDF (figures
              included); otherwise it falls back to the abstract. You can also attach an image
              (a figure or screenshot) and ask it to explain or compare it with the paper.
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
              {m.content}
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

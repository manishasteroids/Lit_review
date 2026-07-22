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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const DOCK_W = 460;   // default docked width (right side)
const MARGIN = 12;

// macOS-style traffic-light window button. Glyph shows on hover.
function TrafficLight({ color, glyph, title, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}   // don't start a window drag
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 13, height: 13, borderRadius: "50%", border: "none", padding: 0,
        cursor: "pointer", background: color, display: "flex",
        alignItems: "center", justifyContent: "center",
        fontSize: 10, lineHeight: 1, color: "rgba(0,0,0,0.55)", fontWeight: 700,
      }}
    >
      {hover ? glyph : ""}
    </button>
  );
}

function TrafficLights({ onClose, onMinimize, onToggleMax, maximized }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <TrafficLight color="#ff5f57" glyph="✕" title="Close" onClick={onClose} />
      <TrafficLight color="#febc2e" glyph="—" title="Minimize" onClick={onMinimize} />
      <TrafficLight color="#28c840" glyph={maximized ? "–" : "+"}
        title={maximized ? "Restore" : "Maximize"} onClick={onToggleMax} />
    </div>
  );
}

// Windows/Linux-style square controls (top-right; close goes red on hover).
function WinButton({ glyph, title, onClick, danger }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 34, height: 28, border: "none", cursor: "pointer",
        fontSize: 12, lineHeight: 1, borderRadius: 6,
        background: hover ? (danger ? "#e81123" : "rgba(128,128,128,0.18)") : "transparent",
        color: hover && danger ? "#fff" : "var(--muted)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >{glyph}</button>
  );
}

function WinControls({ onClose, onMinimize, onToggleMax, maximized }) {
  return (
    <div style={{ display: "flex", gap: 2 }}>
      <WinButton glyph="—" title="Minimize" onClick={onMinimize} />
      <WinButton glyph={maximized ? "❐" : "▢"} title={maximized ? "Restore" : "Maximize"} onClick={onToggleMax} />
      <WinButton glyph="✕" title="Close" onClick={onClose} danger />
    </div>
  );
}

// OS detection — chrome is per-OS, not per-browser, so this is all we need.
function detectOS() {
  const p = (
    (navigator.userAgentData && navigator.userAgentData.platform) ||
    navigator.platform || navigator.userAgent || ""
  ).toLowerCase();
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
  return "win"; // Windows + Linux both use right-side square controls
}

// One place picks the right control set for the OS; handlers are shared.
function WindowControls({ os, side, ...props }) {
  return os === "mac" ? <TrafficLights {...props} /> : <WinControls {...props} />;
}

export default function PaperChatPanel({ runId, paper, extraction, cite, apiKey, model, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState([]); // [{ media_type, data, preview }]
  const [sending, setSending] = useState(false);
  const [chatMode, setChatMode] = useState("quick"); // quick (Gemini) | deep (Sonnet)
  const logRef = useRef(null);
  const fileRef = useRef(null);

  // ── Window state: position, size, minimized, maximized ───────────────
  const MIN_W = 340, MIN_H = 240;
  const [pos, setPos] = useState(null); // {x,y} — set on mount
  const [size, setSize] = useState({ w: DOCK_W, h: 560 });
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [os] = useState(detectOS);   // "mac" | "win" — decided once
  const prevRect = useRef(null); // remembers size/pos before maximize

  useEffect(() => {
    // Open docked to the right edge as a tall side panel.
    const w = Math.min(DOCK_W, window.innerWidth - 2 * MARGIN);
    const h = window.innerHeight - 2 * MARGIN;
    setSize({ w, h });
    setPos({ x: window.innerWidth - w - MARGIN, y: MARGIN });
  }, []);

  function toggleMaximize() {
    if (maximized) {
      const r = prevRect.current;
      if (r) { setPos({ x: r.x, y: r.y }); setSize({ w: r.w, h: r.h }); }
      setMaximized(false);
    } else {
      prevRect.current = { x: pos.x, y: pos.y, w: size.w, h: size.h };
      setPos({ x: 12, y: 12 });
      setSize({ w: window.innerWidth - 24, h: window.innerHeight - 24 });
      setMaximized(true);
    }
  }

  function startDrag(e) {
    if (e.target.closest("button")) return;    // don't drag from the header buttons
    if (maximized) return;                      // maximized window doesn't move
    e.preventDefault();
    const s = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y };
    const move = (ev) => {
      setPos({
        x: clamp(s.x + ev.clientX - s.mx, 0, window.innerWidth - 140),
        y: clamp(s.y + ev.clientY - s.my, 0, window.innerHeight - 44),
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // Resize from any edge/corner. `dir` is a subset of {n,s,e,w}.
  function startResize(dir, e) {
    e.preventDefault();
    e.stopPropagation();
    if (maximized) setMaximized(false);
    const s = { mx: e.clientX, my: e.clientY, x: pos.x, y: pos.y, w: size.w, h: size.h };
    const move = (ev) => {
      const dx = ev.clientX - s.mx, dy = ev.clientY - s.my;
      let { x, y, w, h } = s;
      if (dir.includes("e")) w = s.w + dx;
      if (dir.includes("s")) h = s.h + dy;
      if (dir.includes("w")) { w = s.w - dx; x = s.x + dx; }
      if (dir.includes("n")) { h = s.h - dy; y = s.y + dy; }
      if (w < MIN_W) { if (dir.includes("w")) x -= (MIN_W - w); w = MIN_W; }
      if (h < MIN_H) { if (dir.includes("n")) y -= (MIN_H - h); h = MIN_H; }
      x = clamp(x, 0, window.innerWidth - w);
      y = clamp(y, 0, window.innerHeight - h);
      setPos({ x, y }); setSize({ w, h });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // 8 resize handles (edges + corners) with matching cursors.
  const HANDLES = [
    ["n", { top: -4, left: 8, right: 8, height: 8, cursor: "ns-resize" }],
    ["s", { bottom: -4, left: 8, right: 8, height: 8, cursor: "ns-resize" }],
    ["e", { top: 8, bottom: 8, right: -4, width: 8, cursor: "ew-resize" }],
    ["w", { top: 8, bottom: 8, left: -4, width: 8, cursor: "ew-resize" }],
    ["nw", { top: -4, left: -4, width: 14, height: 14, cursor: "nwse-resize" }],
    ["ne", { top: -4, right: -4, width: 14, height: 14, cursor: "nesw-resize" }],
    ["sw", { bottom: -4, left: -4, width: 14, height: 14, cursor: "nesw-resize" }],
    ["se", { bottom: -4, right: -4, width: 14, height: 14, cursor: "nwse-resize" }],
  ];

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
  if (!pos) return null;

  // ── Minimized: a slim title bar docked at bottom-left ────────────────
  if (minimized) {
    return (
      <div className="chat-panel" style={{
        position: "fixed", left: 16, bottom: 16, top: "auto", right: "auto",
        width: 320, height: "auto", margin: 0, transform: "none",
        display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
        boxShadow: "0 10px 30px rgba(0,0,0,0.25)", zIndex: 9999, cursor: "pointer",
      }} onClick={() => setMinimized(false)}>
        <WindowControls os={os} maximized={false}
          onClose={(e) => { e?.stopPropagation?.(); onClose(); }}
          onMinimize={(e) => { e?.stopPropagation?.(); setMinimized(false); }}
          onToggleMax={(e) => { e?.stopPropagation?.(); setMinimized(false); }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          Chat · [{cite}] {paper.title}
        </span>
      </div>
    );
  }

  // Window container overrides the .chat-panel CSS (fixed/centered) with a
  // draggable, resizable, maximizable floating window. No scrim = non-blocking.
  const panelStyle = {
    position: "fixed", left: pos.x, top: pos.y,
    width: size.w, height: size.h,
    right: "auto", bottom: "auto", margin: 0, transform: "none",
    display: "flex", flexDirection: "column", maxHeight: "none",
    boxShadow: "0 18px 50px rgba(0,0,0,0.28)",
    zIndex: 9999, overflow: "hidden",
  };

  return (
    <div className="chat-panel" style={panelStyle}>
      <div className="chat-head" onMouseDown={startDrag} onDoubleClick={toggleMaximize}
        style={{ cursor: maximized ? "default" : "move", userSelect: "none", flexShrink: 0,
          display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10,
          flexDirection: os === "win" ? "row-reverse" : "row" }}>
          <WindowControls os={os} onClose={onClose} onMinimize={() => setMinimized(true)}
            onToggleMax={toggleMaximize} maximized={maximized} />
          <span className="eyebrow" style={{ flex: 1, minWidth: 0,
            marginLeft: os === "win" ? 0 : 2 }}>Chat · source [{cite}]</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="chat-paper-title">{paper.title}</div>
          <div className="chat-paper-meta">{paper.authors || "—"} · {paper.year || "—"}</div>
        </div>
      </div>

      {(
        <>
          {/* Mode toggle + cache-first quick actions (instant, no LLM call) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", flexShrink: 0 }}>
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

          <div className="chat-log" ref={logRef} style={{ flex: 1, minHeight: 0 }}>
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
            <div style={{ display: "flex", gap: 8, padding: "10px 14px 0", flexWrap: "wrap", flexShrink: 0 }}>
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

          <div className="chat-input" style={{ flexShrink: 0 }}>
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
        </>
      )}

      {/* Resize handles — every edge and corner */}
      {!maximized && HANDLES.map(([dir, style]) => (
        <div key={dir} onMouseDown={(e) => startResize(dir, e)}
          style={{ position: "absolute", zIndex: 5, ...style }} />
      ))}
    </div>
  );
}

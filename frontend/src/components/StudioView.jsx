import React, { useState, useRef, useEffect } from "react";
import { api } from "../api/client.js";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true });

/* Lazy Mermaid renderer — turns ```mermaid blocks into real diagrams. */
let _mermaid = null;
let _id = 0;
async function renderMermaid(root) {
  const blocks = root?.querySelectorAll?.("code.language-mermaid");
  if (!blocks || !blocks.length) return;
  if (!_mermaid) {
    const mod = await import("mermaid");
    _mermaid = mod.default;
    _mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict",
      flowchart: { curve: "basis", useMaxWidth: true } });
  }
  for (const code of blocks) {
    const host = code.closest("pre") || code;
    if (host.dataset.mmDone) continue;
    host.dataset.mmDone = "1";
    try {
      const { svg } = await _mermaid.render(`smm${++_id}`, code.textContent || "");
      const wrap = document.createElement("div");
      wrap.className = "chat-diagram";
      wrap.innerHTML = svg;
      host.replaceWith(wrap);
    } catch { host.dataset.mmDone = "err"; }
  }
}

const md = (t) => DOMPurify.sanitize(marked.parse(t || ""));

const TOOLS = [
  ["report", "▤", "Report", "Structured research report across the selected sources"],
  ["deck", "◼", "Slide deck", "Slide-by-slide outline you can export to PowerPoint"],
  ["briefing", "✦", "Briefing doc", "One-page primer for someone new to the topic"],
];

export default function StudioView({ runId, papers = [], extractions = [], apiKey }) {
  const all = papers.map((p) => p.idx);
  const [selected, setSelected] = useState(new Set(all));
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState("quick");
  const [followups, setFollowups] = useState([]);
  const [artifact, setArtifact] = useState(null);   // {kind,title,content}
  const [working, setWorking] = useState(null);
  const [err, setErr] = useState(null);
  const logRef = useRef(null);
  const artRef = useRef(null);

  const extByIdx = {};
  extractions.forEach((e) => (extByIdx[e.idx] = e));
  const idxs = [...selected];

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    renderMermaid(logRef.current);
  }, [messages, sending]);
  useEffect(() => { renderMermaid(artRef.current); }, [artifact]);

  const toggle = (idx) => setSelected((s) => {
    const n = new Set(s); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });
  const allOn = selected.size === papers.length && papers.length > 0;

  async function ask(question) {
    const q = (question ?? draft).trim();
    if (!q || sending) return;
    if (!idxs.length) { setErr("Select at least one source."); return; }
    setErr(null);
    const history = messages;
    const next = [...history, { role: "user", content: q }];
    setMessages(next); setDraft(""); setSending(true); setFollowups([]);
    try {
      const r = await api.studioChat(runId, q, idxs, history, mode, apiKey || undefined);
      setMessages([...next, { role: "assistant", content: r.answer }]);
      setFollowups(r.followups || []);
    } catch (e) {
      setMessages([...next, { role: "assistant", content: "⚠ " + e.message }]);
    } finally { setSending(false); }
  }

  async function generate(kind, label) {
    if (working || !idxs.length) { if (!idxs.length) setErr("Select at least one source."); return; }
    setWorking(kind); setErr(null);
    try {
      const r = await api.studioArtifact(runId, kind, idxs, mode, apiKey || undefined);
      setArtifact({ kind, title: label, content: r.content });
    } catch (e) { setErr(e.message); }
    finally { setWorking(null); }
  }

  async function download(fmt) {
    if (!artifact) return;
    setWorking(`dl-${fmt}`);
    try {
      await api.studioExport(runId, fmt, artifact.content, artifact.title, idxs);
    } catch (e) { setErr(e.message); }
    finally { setWorking(null); }
  }

  return (
    <div className="studio">
      {/* ── Left: sources ─────────────────────────────── */}
      <aside className="studio-col">
        <div className="studio-h">
          <span>Sources</span>
          <span className="studio-count">{selected.size}/{papers.length}</span>
        </div>
        <div className="studio-selall">
          <label>
            <input type="checkbox" checked={allOn}
              onChange={() => setSelected(allOn ? new Set() : new Set(all))} />
            <span>Select all</span>
          </label>
        </div>
        <div className="studio-list">
          {papers.map((p, i) => (
            <label key={p.idx} className={"studio-src" + (selected.has(p.idx) ? " on" : "")}>
              <input type="checkbox" checked={selected.has(p.idx)} onChange={() => toggle(p.idx)} />
              <span className="studio-n">[{i + 1}]</span>
              <span className="studio-st">
                {p.title}
                <span className="studio-sm">
                  {(p.authors || "—").split(",")[0]} · {p.year || "—"}
                  {extByIdx[p.idx] ? "" : " · no data"}
                </span>
              </span>
            </label>
          ))}
          {papers.length === 0 && <div className="muted tiny">No sources yet — run a review first.</div>}
        </div>
        <div className="studio-foot muted tiny">
          Add or remove papers from the <b>Sources</b> tab.
        </div>
      </aside>

      {/* ── Center: chat ──────────────────────────────── */}
      <section className="studio-col studio-chat">
        <div className="studio-h">
          <span>Chat</span>
          <div className="studio-modes">
            {[["quick", "Quick"], ["deep", "Deep"]].map(([id, lab]) => (
              <button key={id} onClick={() => setMode(id)}
                className={"studio-mode" + (mode === id ? " on" : "")}>{lab}</button>
            ))}
          </div>
        </div>

        <div className="studio-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="studio-empty">
              <div className="studio-empty-t">Ask across {selected.size} selected source{selected.size === 1 ? "" : "s"}</div>
              <div className="muted tiny" style={{ marginBottom: 14 }}>
                Answers cite sources as [n] and are grounded in what was extracted from them.
              </div>
              {["What are the main themes across these papers?",
                "Where do these sources disagree?",
                "Compare the methods used.",
              ].map((s) => (
                <button key={s} className="studio-chip" onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={"studio-msg " + m.role}>
              {m.role === "assistant"
                ? <div className="chat-md" dangerouslySetInnerHTML={{ __html: md(m.content) }} />
                : m.content}
            </div>
          ))}
          {sending && <div className="studio-msg assistant muted tiny">thinking…</div>}

          {followups.length > 0 && !sending && (
            <div className="studio-follow">
              <div className="muted tiny" style={{ marginBottom: 6 }}>Suggested follow-ups</div>
              {followups.map((f) => (
                <button key={f} className="studio-chip" onClick={() => ask(f)}>{f}</button>
              ))}
            </div>
          )}
        </div>

        {err && <div className="err" style={{ margin: "0 14px 8px" }}>{err}</div>}

        <div className="studio-input">
          <input value={draft} placeholder={`Ask about ${selected.size} source${selected.size === 1 ? "" : "s"}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()} />
          <button onClick={() => ask()} disabled={sending || !draft.trim()}>send</button>
        </div>
      </section>

      {/* ── Right: tools ──────────────────────────────── */}
      <aside className="studio-col">
        <div className="studio-h"><span>Studio</span></div>
        <div className="studio-tools">
          {TOOLS.map(([kind, ic, label, desc]) => (
            <button key={kind} className="studio-tool" title={desc}
              disabled={!!working} onClick={() => generate(kind, label)}>
              <span className="studio-tool-ic">{ic}</span>
              <span>
                <span className="studio-tool-t">{working === kind ? "Generating…" : label}</span>
                <span className="studio-tool-d">{desc}</span>
              </span>
            </button>
          ))}
        </div>

        {artifact && (
          <div className="studio-art">
            <div className="studio-art-h">
              <b>{artifact.title}</b>
              <button className="studio-x" onClick={() => setArtifact(null)}>×</button>
            </div>
            <div className="studio-dl">
              {[["pdf", "PDF"], ["docx", "Word"], ["pptx", "PPT"]].map(([f, l]) => (
                <button key={f} className="btn ghost sm" disabled={!!working}
                  onClick={() => download(f)}>
                  {working === `dl-${f}` ? "…" : `↓ ${l}`}
                </button>
              ))}
            </div>
            <div className="studio-art-body chat-md" ref={artRef}
              dangerouslySetInnerHTML={{ __html: md(artifact.content) }} />
          </div>
        )}
        {!artifact && (
          <div className="studio-foot muted tiny">
            Generate a report, deck or briefing from the selected sources — then download it
            as PDF, Word or PowerPoint.
          </div>
        )}
      </aside>
    </div>
  );
}

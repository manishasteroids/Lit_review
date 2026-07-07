import React, { useState } from "react";
import { Plus, Trash2 } from "./icons.jsx";

function relativeTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 2592000) return Math.floor(diff / 86400) + "d ago";
  return new Date(iso).toLocaleDateString();
}

function groupSessions(sessions) {
  const now = Date.now();
  const buckets = { Today: [], Yesterday: [], "This week": [], Older: [] };
  for (const s of sessions) {
    const diff = (now - new Date(s.updated_at).getTime()) / 1000;
    if (diff < 86400) buckets["Today"].push(s);
    else if (diff < 172800) buckets["Yesterday"].push(s);
    else if (diff < 604800) buckets["This week"].push(s);
    else buckets["Older"].push(s);
  }
  return buckets;
}

export default function SessionSidebar({ sessions = [], currentRunId, busy, onSelect, onDelete, onNewChat }) {
  const [hoverId, setHoverId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const grouped = groupSessions(sessions);

  function handleDelete(e, id) {
    e.stopPropagation();
    if (confirmId === id) { onDelete(id); setConfirmId(null); }
    else setConfirmId(id);
  }

  return (
    <aside style={styles.sidebar}>
      <div style={styles.header}>
        <span style={styles.logo}>Saṃhitā</span>
        <button style={styles.newBtn} onClick={onNewChat} disabled={busy} title="New review">
          <Plus size={16} />
        </button>
      </div>

      <div style={styles.list}>
        {sessions.length === 0 && (
          <div style={styles.empty}>No sessions yet.<br />Run a search to start.</div>
        )}
        {Object.entries(grouped).map(([bucket, items]) => {
          if (!items.length) return null;
          return (
            <div key={bucket}>
              <div style={styles.bucket}>{bucket}</div>
              {items.map((s) => {
                const active = s.id === currentRunId;
                const hovered = hoverId === s.id;
                return (
                  <div
                    key={s.id}
                    style={{ ...styles.item, ...(active ? styles.itemActive : hovered ? styles.itemHover : {}) }}
                    onClick={() => !busy && onSelect(s.id)}
                    onMouseEnter={() => setHoverId(s.id)}
                    onMouseLeave={() => { setHoverId(null); setConfirmId(null); }}
                    title={s.topic}
                  >
                    <div style={styles.itemTop}>
                      <span style={styles.itemTopic}>{s.topic}</span>
                      <button
                        style={{ ...styles.delBtn, ...(hovered ? styles.delBtnVisible : {}), ...(confirmId === s.id ? styles.delBtnConfirm : {}) }}
                        onClick={(e) => handleDelete(e, s.id)}
                        title={confirmId === s.id ? "Click again to confirm" : "Delete"}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div style={styles.itemMeta}>
                      <span style={{ ...styles.badge, ...(s.stage === "done" ? styles.badgeDone : styles.badgeFilter) }}>
                        {s.stage === "done" ? "✓ review" : "◦ filter"}
                      </span>
                      <span style={styles.metaDot}>·</span>
                      <span style={styles.metaInfo}>{s.paper_count}p</span>
                      <span style={styles.metaDot}>·</span>
                      <span style={styles.metaInfo}>{relativeTime(s.updated_at)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div style={styles.footer}>Sessions saved locally · no LLM needed to restore</div>
    </aside>
  );
}

const styles = {
  sidebar: { width: 240, minWidth: 240, maxWidth: 240, height: "100vh", position: "sticky", top: 0, display: "flex", flexDirection: "column", background: "var(--surface, #0f0f0f)", borderRight: "1px solid var(--border, rgba(255,255,255,0.07))", overflow: "hidden", flexShrink: 0 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 14px 12px", borderBottom: "1px solid var(--border, rgba(255,255,255,0.07))", flexShrink: 0 },
  logo: { fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--fg, #e8e8e8)", fontFamily: "serif" },
  newBtn: { background: "none", border: "none", cursor: "pointer", color: "var(--muted, #888)", padding: 4, borderRadius: 6, display: "flex", alignItems: "center" },
  list: { flex: 1, overflowY: "auto", padding: "8px 0" },
  empty: { color: "var(--muted, #888)", fontSize: 12, textAlign: "center", padding: "32px 16px", lineHeight: 1.6 },
  bucket: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted, #666)", padding: "10px 14px 4px" },
  item: { padding: "8px 14px", cursor: "pointer", borderRadius: 6, margin: "1px 6px", transition: "background 0.12s" },
  itemHover: { background: "var(--card-bg, rgba(255,255,255,0.05))" },
  itemActive: { background: "var(--accent-muted, rgba(139,92,246,0.15))" },
  itemTop: { display: "flex", alignItems: "flex-start", gap: 4, justifyContent: "space-between" },
  itemTopic: { fontSize: 13, color: "var(--fg, #e8e8e8)", lineHeight: 1.35, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", flex: 1, minWidth: 0 },
  delBtn: { background: "none", border: "none", cursor: "pointer", color: "var(--muted, #666)", padding: "2px 3px", borderRadius: 4, display: "flex", alignItems: "center", opacity: 0, transition: "opacity 0.15s, color 0.15s", flexShrink: 0 },
  delBtnVisible: { opacity: 1 },
  delBtnConfirm: { opacity: 1, color: "var(--err, #f87171)" },
  itemMeta: { display: "flex", alignItems: "center", gap: 4, marginTop: 4 },
  badge: { fontSize: 10, fontWeight: 600, borderRadius: 4, padding: "1px 5px" },
  badgeDone: { background: "rgba(52,211,153,0.12)", color: "#34d399" },
  badgeFilter: { background: "rgba(251,191,36,0.12)", color: "#fbbf24" },
  metaDot: { color: "var(--muted, #555)", fontSize: 10 },
  metaInfo: { fontSize: 10, color: "var(--muted, #888)" },
  footer: { padding: "10px 14px", fontSize: 10, color: "var(--muted, #555)", borderTop: "1px solid var(--border, rgba(255,255,255,0.07))", lineHeight: 1.5, flexShrink: 0 },
};

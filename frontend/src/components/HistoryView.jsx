import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, Trash2, Search, X, ArrowUp, ArrowDown } from "lucide-react";

/**
 * Full-size History: every saved run in a searchable, sortable table.
 *
 * App opens this as an overlay from the "History" tab above the Sift
 * workspace. It owns no data of its own — App passes the sessions and the
 * open / delete / file-under-project handlers. Rendered through a portal on
 * <body> so nothing in the page layout can sit on top of it.
 */

const S = {
  veil: {
    position: "fixed", inset: 0, zIndex: 900, background: "rgba(17,17,27,.45)", backdropFilter: "blur(2px)",
    display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 20px", overflowY: "auto",
  },
  card: {
    width: "100%", maxWidth: 1080, background: "var(--card,#fff)", color: "var(--txt)", borderRadius: 16,
    border: "1px solid var(--line)", boxShadow: "0 24px 70px rgba(0,0,0,.25)", display: "flex", flexDirection: "column",
    maxHeight: "90vh", margin: "auto",
    // Rendered on <body>, outside the app's root, so it has to name the font itself.
    fontFamily: "'Space Grotesk',-apple-system,BlinkMacSystemFont,sans-serif",
  },
  head: { display: "flex", alignItems: "center", gap: 12, padding: "20px 24px 14px" },
  title: { fontSize: 20, fontWeight: 700, letterSpacing: "-.01em", margin: 0 },
  count: { fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: "var(--muted)" },
  close: { marginLeft: "auto", background: "none", border: "1px solid var(--line)", borderRadius: 8, padding: 6, cursor: "pointer", color: "var(--muted)", display: "flex" },
  bar: { display: "flex", flexWrap: "wrap", gap: 10, padding: "0 24px 16px", alignItems: "center" },
  searchWrap: { position: "relative", flex: "1 1 260px", minWidth: 0 },
  searchIc: { position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--muted2)", pointerEvents: "none" },
  input: {
    width: "100%", boxSizing: "border-box", padding: "9px 12px 9px 34px", borderRadius: 9, border: "1px solid var(--line)",
    background: "var(--card,#fff)", color: "var(--txt)", fontFamily: "inherit", fontSize: 14, outline: "none",
  },
  select: {
    padding: "9px 10px", borderRadius: 9, border: "1px solid var(--line)", background: "var(--card,#fff)",
    color: "var(--txt)", fontFamily: "inherit", fontSize: 13.5, maxWidth: 220,
  },
  scroll: { overflow: "auto", borderTop: "1px solid var(--line)" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: {
    position: "sticky", top: 0, background: "var(--card,#fff)", textAlign: "left", padding: "10px 12px",
    fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, fontWeight: 500, letterSpacing: ".1em",
    textTransform: "uppercase", color: "var(--muted2)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap", zIndex: 1,
  },
  sortBtn: { background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", letterSpacing: "inherit", textTransform: "inherit", display: "inline-flex", alignItems: "center", gap: 4 },
  td: { padding: "12px", borderBottom: "1px solid var(--line)", verticalAlign: "middle" },
  topic: { fontWeight: 500, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
  badge: { fontFamily: "'JetBrains Mono',monospace", fontSize: 11, fontWeight: 500, borderRadius: 5, padding: "2px 7px", whiteSpace: "nowrap" },
  done: { background: "var(--green-soft)", color: "var(--green)" },
  filter: { background: "rgba(224,163,62,.14)", color: "var(--amber)" },
  num: { fontFamily: "'JetBrains Mono',monospace", fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap" },
  projSel: {
    padding: "6px 8px", borderRadius: 7, border: "1px solid var(--line)", background: "var(--card,#fff)",
    color: "var(--txt)", fontFamily: "inherit", fontSize: 12.5, maxWidth: 190, width: "100%",
  },
  del: { background: "none", border: "1px solid transparent", borderRadius: 7, padding: "5px 8px", cursor: "pointer", color: "var(--muted2)", display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "inherit", fontSize: 12 },
  delArmed: { color: "#c0392b", borderColor: "#f0b4ac", background: "#fdf0ee" },
  empty: { padding: "40px 24px", textAlign: "center", color: "var(--muted)", fontSize: 14 },
  foot: { padding: "12px 24px", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "var(--muted2)", borderTop: "1px solid var(--line)" },
};

function fmt(iso, tz) {
  if (!iso) return "";
  const o = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try { return new Date(iso).toLocaleString(undefined, tz ? { ...o, timeZone: tz } : o); }
  catch { return new Date(iso).toLocaleString(undefined, o); }
}

const COLS = [
  ["topic", "Research question"],
  ["stage", "Status"],
  ["paper_count", "Papers"],
  ["updated_at", "Last updated"],
];

export default function HistoryView({ sessions, projects, tz, activeId, busy, onOpen, onDelete, onFile, onClose }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");      // all | done | filter
  const [project, setProject] = useState("all");    // all | none | <project id>
  const [sort, setSort] = useState({ key: "updated_at", dir: -1 });
  const [armed, setArmed] = useState(null);         // run whose Delete is waiting for a second click
  const [moving, setMoving] = useState(null);       // run currently being filed under a project

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const nameOf = (id) => projects.find((p) => p.id === id)?.name || "";

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = sessions.filter((s) => {
      if (status === "done" && s.stage !== "done") return false;
      if (status === "filter" && s.stage === "done") return false;
      if (project === "none" && s.project_id) return false;
      if (project !== "all" && project !== "none" && s.project_id !== project) return false;
      if (!needle) return true;
      return (s.topic || "").toLowerCase().includes(needle) || nameOf(s.project_id).toLowerCase().includes(needle);
    });
    const { key, dir } = sort;
    out.sort((a, b) => {
      const x = a[key] ?? "", y = b[key] ?? "";
      if (key === "paper_count") return (Number(x) - Number(y)) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
    return out;
  }, [sessions, projects, q, status, project, sort]);

  const flip = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "topic" ? 1 : -1 }));

  async function file(id, value) {
    setMoving(id);
    try { await onFile(id, value || null); } finally { setMoving(null); }
  }

  return createPortal(
    <div style={S.veil} onClick={onClose}>
      <div style={S.card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="History">
        <div style={S.head}>
          <h2 style={S.title}>History</h2>
          <span style={S.count}>
            {rows.length === sessions.length ? `${sessions.length} runs` : `${rows.length} of ${sessions.length} runs`}
          </span>
          <button style={S.close} onClick={onClose} aria-label="Close history"><X size={16} /></button>
        </div>

        <div style={S.bar}>
          <div style={S.searchWrap}>
            <Search size={15} style={S.searchIc} />
            <input id="history-all-search" autoFocus type="search" style={S.input} placeholder="Search by question or project"
              aria-label="Search history" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select id="history-all-status" style={S.select} aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="done">Review written</option>
            <option value="filter">Stopped at filter</option>
          </select>
          <select id="history-all-project" style={S.select} aria-label="Filter by project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="all">All projects</option>
            <option value="none">Not in a project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div style={S.scroll}>
          {rows.length === 0 ? (
            <div style={S.empty}>No runs match these filters.</div>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  {COLS.map(([key, label]) => (
                    <th key={key} style={S.th} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                      <button style={S.sortBtn} onClick={() => flip(key)}>
                        {label}
                        {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </button>
                    </th>
                  ))}
                  <th style={S.th}>Project</th>
                  <th style={S.th} />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="hist-row"
                    style={{ cursor: busy ? "default" : "pointer", background: s.id === activeId ? "var(--indigo-soft)" : undefined }}
                    onClick={() => { if (!busy) { onOpen(s.id); onClose(); } }}
                    onMouseLeave={() => armed === s.id && setArmed(null)}>
                    <td style={{ ...S.td, width: "42%" }}><div style={S.topic} title={s.topic}>{s.topic}</div></td>
                    <td style={S.td}>
                      <span style={{ ...S.badge, ...(s.stage === "done" ? S.done : S.filter) }}>
                        {s.stage === "done" ? "✓ review" : "◦ filter"}
                      </span>
                    </td>
                    <td style={{ ...S.td, ...S.num }}>{s.paper_count}</td>
                    <td style={{ ...S.td, ...S.num }}>{fmt(s.updated_at, tz)}</td>
                    <td style={S.td} onClick={(e) => e.stopPropagation()}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Folder size={13} style={{ color: "var(--muted2)", flexShrink: 0 }} />
                        <select style={S.projSel} aria-label="Project for this run" disabled={moving === s.id}
                          value={s.project_id || ""} onChange={(e) => file(s.id, e.target.value)}>
                          <option value="">No project</option>
                          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </span>
                    </td>
                    <td style={{ ...S.td, textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                      <button style={{ ...S.del, ...(armed === s.id ? S.delArmed : {}) }}
                        title={armed === s.id ? "Click again to delete this run" : "Delete"}
                        onClick={() => { if (armed === s.id) { onDelete(s.id); setArmed(null); } else setArmed(s.id); }}>
                        <Trash2 size={13} />{armed === s.id ? "Confirm delete" : ""}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={S.foot}>Click a run to reopen it · sessions are saved to your account, no LLM needed to restore</div>
      </div>
    </div>,
    document.body
  );
}

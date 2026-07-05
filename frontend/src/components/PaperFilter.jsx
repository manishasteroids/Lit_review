import React from "react";
import { Filter, Check, X, ChevronRight, RotateCw } from "./icons.jsx";

export default function PaperFilter({ papers, approved, scope, busy, onToggle, onApprove, onRestart }) {
  const approvedCount = Object.values(approved).filter(Boolean).length;

  return (
    <div className="card">
      <div className="card-h">
        <div className="ic"><Filter size={16} /></div>
        <h3>Filter sources</h3>
        <span className="tag">human in the loop · {approvedCount}/{papers.length}</span>
      </div>
      {scope && <div className="muted tiny" style={{ marginBottom: 12 }}>Scope: {scope}</div>}

      {papers.map((p) => (
        <div key={p.idx} className={"paper" + (approved[p.idx] ? "" : " off")}>
          <div className="paper-top">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="paper-title">{p.title}</div>
              <div className="paper-meta">
                {p.authors || "—"} · {p.year || "—"} · {p.venue || "preprint"}
                {p.url ? " · " : ""}
                {p.url && <a href={p.url} target="_blank" rel="noreferrer">link</a>}
              </div>
              {p.abstract && <div className="paper-abs">{p.abstract}</div>}
            </div>
            <div className={"toggle" + (approved[p.idx] ? " on" : "")} onClick={() => onToggle(p.idx)}>
              {approved[p.idx] ? <Check size={15} /> : <X size={15} />}
            </div>
          </div>
        </div>
      ))}

      <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" disabled={busy || approvedCount < 2} onClick={onApprove}>
          <ChevronRight size={15} /> Approve {approvedCount} & build review
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={onRestart}>
          <RotateCw size={13} /> Restart
        </button>
      </div>
    </div>
  );
}

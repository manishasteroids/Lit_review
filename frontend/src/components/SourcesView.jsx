import React, { useState } from "react";
import PaperChatPanel from "./PaperChatPanel.jsx";

const COLUMNS = [
  { key: "paper", label: "Paper", always: true, width: 300 },
  { key: "excerpt", label: "Excerpt", always: true, width: 340 },
  { key: "contribution", label: "Contribution", width: 240 },
  { key: "method", label: "Method", width: 200 },
  { key: "metrics", label: "Metrics", width: 200 },
  { key: "finding", label: "Key finding", width: 220 },
  { key: "limitation", label: "Limitation", width: 220 },
  { key: "relevance", label: "Relevance", width: 240 },
];
const DEFAULT_ON = ["paper", "excerpt", "contribution", "metrics", "method"];

export default function SourcesView({ citeOrder, extractions, runId, apiKey, model }) {
  const extByIdx = {};
  (extractions || []).forEach((e) => (extByIdx[e.idx] = e));

  const [visible, setVisible] = useState(new Set(DEFAULT_ON));
  const [chatPaper, setChatPaper] = useState(null);
  const citeNumOf = (idx) => citeOrder.findIndex((p) => p.idx === idx) + 1;

  const toggleCol = (key) =>
    setVisible((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const shownCols = COLUMNS.filter((c) => c.always || visible.has(c.key));

  return (
    <div>
      <div className="col-picker">
        <span className="eyebrow" style={{ marginRight: 4 }}>Columns</span>
        {COLUMNS.map((c) => (
          <button key={c.key} disabled={c.always}
            className={"col-chip" + (c.always || visible.has(c.key) ? " on" : "")}
            onClick={() => !c.always && toggleCol(c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="ptable-wrap">
        <table className="ptable">
          <thead>
            <tr>
              <th style={{ width: 38 }}>#</th>
              {shownCols.map((c) => <th key={c.key} style={{ minWidth: c.width }}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {citeOrder.map((p, i) => {
              const e = extByIdx[p.idx] || {};
              return (
                <tr key={p.idx}>
                  <td className="pt-num"><span className="cite">[{i + 1}]</span></td>
                  {shownCols.map((c) => {
                    if (c.key === "paper") {
                      return (
                        <td key={c.key}>
                          <div className="pt-title">{p.title}</div>
                          <div className="pt-meta">{p.authors || "—"} · {p.year || "—"} · {p.venue || "preprint"}</div>
                          <div className="pt-actions">
                            {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="pt-link">link</a>}
                            <button className="pt-chat-btn" onClick={() => setChatPaper(p)}>chat</button>
                          </div>
                          {e.concepts?.length > 0 && (
                            <div className="pt-tags">
                              {e.concepts.map((t) => <span key={t} className="pill theme">{t}</span>)}
                            </div>
                          )}
                        </td>
                      );
                    }
                    return (
                      <td key={c.key} className={c.key === "excerpt" ? "pt-excerpt" : ""}>
                        {e[c.key] || <span className="pt-na">n/a</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="muted tiny" style={{ marginTop: 10 }}>
        {citeOrder.length} sources · scroll horizontally for more columns · toggle columns above
      </div>

      {chatPaper && (
        <PaperChatPanel runId={runId} paper={chatPaper} cite={citeNumOf(chatPaper.idx)}
          apiKey={apiKey} model={model} onClose={() => setChatPaper(null)} />
      )}
    </div>
  );
}

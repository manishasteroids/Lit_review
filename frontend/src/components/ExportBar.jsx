import React, { useState } from "react";
import { api } from "../api/client.js";

/**
 * Download the finished review as a slide deck, PDF report, or a manuscript in
 * an IEEE / arXiv template. All generated server-side from existing content —
 * no model calls, so exporting is free.
 */
export default function ExportBar({ runId, onError }) {
  const [busy, setBusy] = useState(null);

  async function go(fmt, template) {
    if (busy) return;
    setBusy(template ? `${fmt}:${template}` : fmt);
    try {
      await api.downloadExport(runId, fmt, template);
    } catch (e) {
      onError?.(e.message || "Export failed");
    } finally {
      setBusy(null);
    }
  }

  const label = (k, text) => (busy === k ? "Preparing…" : text);

  return (
    <div style={S.bar}>
      <span className="eyebrow" style={{ marginRight: 2 }}>Export</span>

      <button className="btn sm" disabled={!!busy} onClick={() => go("pptx")}
        title="Slide deck (.pptx) — title, sections, themes, gaps and references">
        {label("pptx", "◼ Slide deck (.pptx)")}
      </button>

      <button className="btn ghost sm" disabled={!!busy} onClick={() => go("pdf")}
        title="Formatted report (.pdf)">
        {label("pdf", "▤ Report (.pdf)")}
      </button>

      <span style={S.div} />
      <span className="muted tiny" style={{ marginRight: 2 }}>Manuscript template:</span>

      <button className="btn ghost sm" disabled={!!busy} onClick={() => go("docx", "ieee")}
        title="IEEE two-column manuscript (.docx) — Abstract, Index Terms, numbered sections, references">
        {label("docx:ieee", "IEEE (.docx)")}
      </button>

      <button className="btn ghost sm" disabled={!!busy} onClick={() => go("docx", "arxiv")}
        title="arXiv/preprint single-column manuscript (.docx)">
        {label("docx:arxiv", "arXiv (.docx)")}
      </button>
    </div>
  );
}

const S = {
  bar: {
    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
    paddingBottom: 14, marginBottom: 16, borderBottom: "1px solid var(--line)",
  },
  div: { width: 1, height: 18, background: "var(--line)", margin: "0 4px" },
};

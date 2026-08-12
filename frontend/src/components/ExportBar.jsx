import React, { useState } from "react";
import { api } from "../api/client.js";
import { useConfirm } from "./ConfirmModal.jsx";

// Rough client-side estimate only (for the cost-disclosure dialog) — the
// real price is computed server-side per core/pricing.py IMAGE_PRICE_USD and
// only the sections that actually generate successfully get charged.
const IMAGE_PRICE_ESTIMATE = 0.039;
const MAX_ILLUSTRATED_SECTIONS = 5;

/**
 * Download the finished review as a slide deck, PDF report, or a manuscript in
 * an IEEE / arXiv template. All generated server-side from existing content —
 * no model calls, so exporting is free. The slide deck always includes a
 * small free vector diagram per section (no AI, no cost) plus Gemini-written
 * slide-native bullets. The separate "+ AI illustrations" option swaps those
 * vector diagrams for real generated images and costs real money (disclosed
 * before triggering).
 */
export default function ExportBar({ runId, onError }) {
  const [busy, setBusy] = useState(null);
  const [confirmAsync, confirmModal] = useConfirm();

  async function go(fmt, template, illustrate) {
    if (busy) return;
    setBusy(illustrate ? `${fmt}:illustrate` : (template ? `${fmt}:${template}` : fmt));
    try {
      await api.downloadExport(runId, fmt, template, illustrate);
    } catch (e) {
      onError?.(e.message || "Export failed");
    } finally {
      setBusy(null);
    }
  }

  async function goIllustrated() {
    const ok = await confirmAsync(
      `Generates up to ${MAX_ILLUSTRATED_SECTIONS} AI illustrations (one per section), ` +
      `roughly $${(IMAGE_PRICE_ESTIMATE * MAX_ILLUSTRATED_SECTIONS).toFixed(2)} total. ` +
      "Images are cached, so re-downloading this run's deck won't generate or charge again.",
      { title: "Add AI illustrations to the slide deck?", confirmLabel: "Generate & download" }
    );
    if (ok) go("pptx", null, true);
  }

  const label = (k, text) => (busy === k ? "Preparing…" : text);

  return (
    <div style={S.bar}>
      {confirmModal}
      <span className="eyebrow" style={{ marginRight: 2 }}>Export</span>

      <button className="btn sm" disabled={!!busy} onClick={() => go("pptx")}
        title="Slide deck (.pptx) — sections with free vector diagrams, themes, gaps, data and references. Free, no model calls.">
        {label("pptx", "◼ Slide deck (.pptx)")}
      </button>

      <button className="btn ghost sm" disabled={!!busy} onClick={goIllustrated}
        title="Same slide deck, but swaps the free vector diagrams for real AI-generated illustrations — costs real money, confirmed before generating">
        {label("pptx:illustrate", "🖼 Slide deck + AI illustrations")}
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

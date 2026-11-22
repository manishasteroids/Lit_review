import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client.js";
import { X, RotateCw } from "./icons.jsx";

/**
 * Opens the generated paper inside the app. The backend builds the same
 * Word file the download gives (in the uploaded Word template when there is
 * one, otherwise the standard layout) and docx-preview lays it out as pages
 * in the browser -- no download, no Word needed. The library is loaded only
 * when the viewer is opened, so it adds nothing to the normal page load.
 *
 * Props: msId, note (one line shown under the title, e.g. why a LaTeX
 *        paper is shown in the standard layout), onClose
 */
export default function PaperPreview({ msId, title, note, onClose }) {
  const host = useRef(null);
  const [state, setState] = useState("loading");   // loading | ready | error
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const [bytes, lib] = await Promise.all([api.getManuscriptPreview(msId), import("docx-preview")]);
        if (off || !host.current) return;
        host.current.innerHTML = "";
        await lib.renderAsync(bytes, host.current, undefined, {
          className: "paper", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true,
          experimental: true, useBase64URL: true,
        });
        if (!off) setState("ready");
      } catch (e) {
        if (!off) { setMsg(e.message || "The preview could not be built."); setState("error"); }
      }
    })();
    return () => { off = true; };
  }, [msId]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Paper preview"
      style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(17,17,27,.6)", display: "flex", flexDirection: "column",
        fontFamily: "'Space Grotesk',system-ui,sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", background: "var(--card,#fff)",
        borderBottom: "1px solid var(--line)", color: "var(--txt)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title || "Paper preview"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            {note || "A reading view of the whole paper. The downloaded file has the same text, figures and references."}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close preview"
          style={{ marginLeft: "auto", background: "none", border: "1px solid var(--line)", borderRadius: 8, padding: 7,
            cursor: "pointer", color: "var(--muted)", display: "flex", flexShrink: 0 }}>
          <X size={16} />
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", background: "#5b5e6b" }} onClick={(e) => e.target === e.currentTarget && onClose()}>
        {state === "loading" && (
          <div style={{ color: "#fff", padding: 40, textAlign: "center", fontSize: 14 }}>
            <RotateCw size={15} className="spin" /> &nbsp;Building the preview…
          </div>
        )}
        {state === "error" && (
          <div role="alert" style={{ color: "#fff", padding: 40, textAlign: "center", fontSize: 14 }}>{msg}</div>
        )}
        {/* Templates such as IEEE's change column count mid-page with "continuous"
            section breaks. The viewer would start a new page at each one, so the
            sections are joined back into a single sheet. */}
        <style>{`
          .paper-wrapper{background:transparent!important;padding:24px 12px 40px!important;gap:0!important;}
          .paper-wrapper>section.paper{min-height:0!important;margin-bottom:0!important;box-shadow:none!important;border-radius:0!important;}
          .paper-wrapper>section.paper:not(:first-of-type){padding-top:0!important;}
          .paper-wrapper>section.paper:not(:last-of-type){padding-bottom:0!important;}
        `}</style>
        <div ref={host} style={{ display: state === "ready" ? "block" : "none" }} />
      </div>
    </div>,
    document.body
  );
}

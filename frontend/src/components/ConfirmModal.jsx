import React, { useCallback, useState } from "react";

// A styled in-app replacement for window.confirm(). Native confirm() dialogs
// are prefixed by the browser with the page's actual hosting origin (e.g.
// "samhita-503314.web.app says") — that's the browser's own chrome, shown
// for phishing protection, and no amount of copy editing in the app can
// change it. This component never shows any browser chrome at all, so it's
// unaffected by whatever domain the app happens to be deployed under.

const ACCENT = "#6d5ef6";
const DANGER = "#d64545";

const overlayStyle = {
  position: "fixed", inset: 0, background: "rgba(20,20,30,.45)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 1000,
};
const boxStyle = {
  background: "var(--panel, #fff)", borderRadius: 12, padding: "20px 22px",
  width: "min(420px, 90vw)", boxShadow: "0 20px 60px rgba(0,0,0,.25)",
};
const titleStyle = { fontWeight: 700, fontSize: 15, marginBottom: 8, color: "var(--text, #1a1a2e)" };
const msgStyle = { fontSize: 13.5, lineHeight: 1.55, color: "var(--muted, #555)", whiteSpace: "pre-line" };
const btnRowStyle = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 };

export function ConfirmModal({ open, title, message, confirmLabel = "OK", cancelLabel = "Cancel",
                                danger = false, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div style={overlayStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={boxStyle}>
        {title && <div style={titleStyle}>{title}</div>}
        <div style={msgStyle}>{message}</div>
        <div style={btnRowStyle}>
          <button className="btn ghost sm" onClick={onCancel}>{cancelLabel}</button>
          <button
            className="btn sm"
            style={{ background: danger ? DANGER : ACCENT, color: "#fff", borderColor: "transparent" }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Drop-in async replacement for window.confirm(message):
//   const [confirmAsync, confirmModal] = useConfirm();
//   const ok = await confirmAsync("Delete this?", { danger: true });
//   ...render {confirmModal} once, anywhere in the tree...
export function useConfirm() {
  const [state, setState] = useState(null);

  const confirmAsync = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setState({ message, title: opts.title, danger: opts.danger, confirmLabel: opts.confirmLabel, resolve });
    });
  }, []);

  const handleConfirm = () => { state?.resolve(true); setState(null); };
  const handleCancel = () => { state?.resolve(false); setState(null); };

  const modal = (
    <ConfirmModal
      open={!!state}
      title={state?.title}
      message={state?.message}
      danger={state?.danger}
      confirmLabel={state?.confirmLabel}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return [confirmAsync, modal];
}

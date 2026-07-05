import React from "react";
import { AlertTriangle } from "./icons.jsx";

export default function CritiqueView({ synth }) {
  if (!synth) return <div className="muted tiny">No critique yet.</div>;
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Themes</div>
      <div style={{ marginBottom: 16 }}>
        {(synth.themes || []).map((t) => <span key={t} className="pill theme">{t}</span>)}
      </div>

      <div className="kv" style={{ marginBottom: 14 }}><span className="k">Consensus</span><span className="v">{synth.consensus}</span></div>
      <div className="kv" style={{ marginBottom: 18 }}><span className="k">Tensions</span><span className="v">{synth.tensions}</span></div>

      <div className="eyebrow" style={{ marginBottom: 8 }}>Research gaps</div>
      <div style={{ marginBottom: 16 }}>
        {(synth.gaps || []).map((g, i) => (
          <div key={i} style={{ display: "flex", gap: 9, marginBottom: 7, fontSize: 13.5 }}>
            <span className="pill gap" style={{ margin: 0 }}>gap</span><span>{g}</span>
          </div>
        ))}
      </div>

      <div className="eyebrow" style={{ marginBottom: 8 }}>Detected biases</div>
      <div>
        {(synth.biases || []).map((b, i) => (
          <div key={i} style={{ display: "flex", gap: 9, marginBottom: 7, fontSize: 13.5 }}>
            <AlertTriangle size={15} color="var(--amber)" style={{ flex: "0 0 15px", marginTop: 2 }} /><span>{b}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

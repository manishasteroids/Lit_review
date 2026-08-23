import React, { useState } from "react";
import { api } from "../api/client.js";

/**
 * Public read-only project viewer — reached at /share/:token, no Sift login
 * required. The visitor confirms an email that's on the link's allowlist,
 * then sees the project's papers, notes, and filed runs read-only.
 *
 * Rendered directly by main.jsx (no router in this app) whenever the URL
 * path starts with /share/.
 */
export default function ShareViewer({ token }) {
  const [email, setEmail] = useState("");
  const [verified, setVerified] = useState(null); // null | {project_name}
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [proj, setProj] = useState(null);
  const [openRun, setOpenRun] = useState(null);

  async function verify(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setErr(null);
    try {
      const v = await api.shareVerify(token, email.trim());
      setVerified(v);
      const p = await api.shareGetProject(token, email.trim());
      setProj(p);
    } catch (e2) {
      setErr(e2.message || "This link doesn't grant access to that email.");
    } finally {
      setBusy(false);
    }
  }

  async function openRunDetail(runId) {
    setOpenRun({ loading: true });
    try {
      const r = await api.shareGetRun(token, runId, email.trim());
      setOpenRun(r);
    } catch (e2) {
      setOpenRun({ error: e2.message || "Could not load this review." });
    }
  }

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <div style={S.brand}>Sift</div>

        {!verified ? (
          <div style={S.card}>
            <h1 style={S.h1}>You've been sent a Sift project</h1>
            <p style={S.p}>
              Enter the email address this link was shared with to view it read-only.
              No account needed.
            </p>
            <form onSubmit={verify} style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <input style={S.input} type="email" autoFocus placeholder="you@example.com"
                value={email} onChange={(e) => setEmail(e.target.value)} />
              <button type="submit" disabled={busy} style={S.btn}>{busy ? "Checking…" : "View"}</button>
            </form>
            {err && <div style={S.err}>{err}</div>}
          </div>
        ) : openRun ? (
          <RunDetail run={openRun} onBack={() => setOpenRun(null)} />
        ) : (
          <ProjectView proj={proj} onOpenRun={openRunDetail} />
        )}
      </div>
    </div>
  );
}

function ProjectView({ proj, onOpenRun }) {
  if (!proj) return <div style={S.card}><div style={S.p}>Loading…</div></div>;
  return (
    <div>
      <div style={S.card}>
        <div style={S.tag}>Read-only shared project</div>
        <h1 style={S.h1}>{proj.name}</h1>
        {proj.description && <p style={S.p}>{proj.description}</p>}
      </div>

      <Section title={`Runs (${proj.runs.length})`}>
        {proj.runs.length === 0 ? (
          <div style={S.muted}>No reviews filed under this project yet.</div>
        ) : proj.runs.map((r) => (
          <button key={r.id} style={S.row} onClick={() => onOpenRun(r.id)}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={S.rowTitle}>{r.topic || "Untitled review"}</div>
              <div style={S.rowMeta}>{r.stage === "done" ? "Completed" : "In progress"} · {r.paper_count} papers</div>
            </div>
            <span style={S.chev}>→</span>
          </button>
        ))}
      </Section>

      <Section title={`Papers (${proj.papers.length})`}>
        {proj.papers.length === 0 ? (
          <div style={S.muted}>No saved papers.</div>
        ) : proj.papers.map((row) => (
          <div key={row.id} style={S.row}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={S.rowTitle}>
                {row.paper.url
                  ? <a href={row.paper.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{row.paper.title}</a>
                  : row.paper.title}
              </div>
              <div style={S.rowMeta}>{[row.paper.authors, row.paper.year].filter(Boolean).join(" · ")}</div>
            </div>
          </div>
        ))}
      </Section>

      <Section title={`Notes (${proj.notes.length})`}>
        {proj.notes.length === 0 ? (
          <div style={S.muted}>No notes.</div>
        ) : proj.notes.map((n) => (
          <div key={n.id} style={S.noteCard}>
            {n.title && <div style={S.rowTitle}>{n.title}</div>}
            <div style={S.noteBody}>{n.body}</div>
          </div>
        ))}
      </Section>
    </div>
  );
}

function RunDetail({ run, onBack }) {
  return (
    <div>
      <button style={S.back} onClick={onBack}>← Back to project</button>
      {run.loading ? (
        <div style={S.card}><div style={S.p}>Loading…</div></div>
      ) : run.error ? (
        <div style={S.card}><div style={S.err}>{run.error}</div></div>
      ) : (
        <>
          <div style={S.card}>
            <h1 style={S.h1}>{run.topic || "Untitled review"}</h1>
            <div style={S.rowMeta}>{(run.papers || []).length} papers found</div>
          </div>

          {run.sections && Object.keys(run.sections).length > 0 && (
            <Section title="Written review">
              {["title", "abstract", "intro", "synthesis", "gaps", "future"].map((k) => (
                run.sections[k] ? (
                  <div key={k} style={{ marginBottom: 14 }}>
                    <div style={S.sectionLbl}>{k}</div>
                    <div style={S.prose}>{run.sections[k]}</div>
                  </div>
                ) : null
              ))}
            </Section>
          )}

          {run.synthesis && (
            <Section title="Synthesis">
              {run.synthesis.themes?.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={S.sectionLbl}>Themes</div>
                  <div style={S.prose}>{run.synthesis.themes.join(" · ")}</div>
                </div>
              )}
              {run.synthesis.gaps?.length > 0 && (
                <div>
                  <div style={S.sectionLbl}>Gaps</div>
                  <div style={S.prose}>{run.synthesis.gaps.join(" · ")}</div>
                </div>
              )}
            </Section>
          )}

          <Section title={`Papers (${(run.papers || []).length})`}>
            {(run.papers || []).map((p) => (
              <div key={p.idx} style={S.row}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={S.rowTitle}>
                    {p.url
                      ? <a href={p.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{p.title}</a>
                      : p.title}
                  </div>
                  <div style={S.rowMeta}>{[p.authors, p.year].filter(Boolean).join(" · ")}</div>
                </div>
              </div>
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={S.card}>
      <div style={S.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

const S = {
  page: { minHeight: "100vh", background: "#fafafe", fontFamily: "'Space Grotesk',sans-serif" },
  wrap: { maxWidth: 640, margin: "0 auto", padding: "40px 20px 80px" },
  brand: { fontSize: 15, fontWeight: 700, color: "#5b4ff0", marginBottom: 18 },
  card: { background: "#fff", border: "1px solid #eeeef4", borderRadius: 14, padding: "22px 24px", marginBottom: 16 },
  tag: {
    display: "inline-block", fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase",
    color: "#5b4ff0", background: "#efedfe", borderRadius: 5, padding: "3px 8px", marginBottom: 10,
  },
  h1: { fontSize: 21, fontWeight: 700, margin: "0 0 6px", color: "#111" },
  p: { fontSize: 13.5, color: "#5c5c6e", lineHeight: 1.6, margin: 0 },
  input: {
    flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #e3e3ec",
    fontFamily: "inherit", fontSize: 13.5, outline: "none",
  },
  btn: {
    padding: "10px 16px", borderRadius: 8, border: "none", background: "#5b4ff0",
    color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  err: { color: "#c0392b", fontSize: 12.5, marginTop: 10 },
  muted: { color: "#8a8a9a", fontSize: 13 },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 10 },
  sectionLbl: { fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#8a8a9a", marginBottom: 4 },
  prose: { fontSize: 13.5, color: "#3a3a4a", lineHeight: 1.6, whiteSpace: "pre-wrap" },
  row: {
    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
    background: "none", border: "1px solid #f1f1f6", borderRadius: 9, padding: "10px 12px",
    marginBottom: 6, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
  },
  rowTitle: { fontSize: 13, fontWeight: 600, color: "#111", lineHeight: 1.4 },
  rowMeta: { fontSize: 11.5, color: "#8a8a9a", marginTop: 2 },
  chev: { color: "#c3c3d2", fontSize: 14, flexShrink: 0, marginLeft: 8 },
  noteCard: { border: "1px solid #f1f1f6", borderRadius: 9, padding: "10px 12px", marginBottom: 8 },
  noteBody: { fontSize: 12.5, color: "#3a3a4a", marginTop: 4, whiteSpace: "pre-wrap", lineHeight: 1.5 },
  back: { background: "none", border: "none", color: "#5b4ff0", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: 0, marginBottom: 14, fontFamily: "inherit" },
};

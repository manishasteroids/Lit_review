import React, { useState } from "react";
import { api } from "../api/client.js";
import { Lightbulb, ArrowLeft } from "./icons.jsx";

/**
 * Flow B from pipeline-wiring-architecture.md: the sidebar's "Hypothesis
 * Generation" entry, reached with no run already open. A dropdown picks
 * which project (only those with a completed Literature Review are
 * offered), and "Open" fetches that project's full run list (api.getProject)
 * to find the most recently completed run, then hands off to the exact same
 * restore-and-land-on-tab path Flow A already uses (App.jsx's openProject
 * with landOnTab="hypothesis").
 */
export default function HypothesisPicker({ projects, onSelect, onGoToLitReview, onBack }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // list_projects() only returns counts, not each project's runs -- a
  // project is only OFFERED here once we know (after fetching, on Open) it
  // has a completed run, so `run_count > 0` is just a cheap first-pass
  // filter to avoid listing empty projects at all.
  const candidates = (projects || []).filter((p) => (p.run_count || 0) > 0);
  const [projectId, setProjectId] = useState(candidates[0]?.id || "");

  async function open() {
    const proj = candidates.find((p) => p.id === projectId);
    if (!proj) return;
    setErr(null);
    setLoading(true);
    try {
      const full = await api.getProject(proj.id);
      const done = (full.runs || []).filter((r) => r.stage === "done");
      if (done.length === 0) {
        setErr(`"${proj.name}" doesn't have a completed Literature Review yet.`);
        return;
      }
      const latest = [...done].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))[0];
      onSelect(full, latest.id);
    } catch (e) {
      setErr(e.message || "Couldn't load that project.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "28px 32px" }}>
      {onBack && (
        <button
          type="button" onClick={onBack}
          style={{
            display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
            color: "var(--muted, #5b6472)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
            padding: 0, marginBottom: 16, fontFamily: "inherit",
          }}
        >
          <ArrowLeft size={13} /> Home
        </button>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
        <Lightbulb size={20} /> Hypothesis Generation
      </div>
      <div style={{ color: "var(--muted, #5b6472)", fontSize: 13.5, marginBottom: 20 }}>
        Reads the structured findings from a completed Literature Review project — pick which one.
      </div>

      {err && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 14 }}>{err}</div>}

      {candidates.length === 0 ? (
        <div style={{ fontSize: 13.5, color: "var(--muted, #5b6472)" }}>
          No projects with a completed Literature Review yet.{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); onGoToLitReview(); }} style={{ color: "var(--indigo, #6d5df6)", fontWeight: 600 }}>
            Start one →
          </a>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10 }}>
          <select
            value={projectId}
            onChange={(e) => { setProjectId(e.target.value); setErr(null); }}
            disabled={loading}
            style={{
              flex: 1, border: "1px solid var(--line, #e4e7ef)", borderRadius: 9, padding: "11px 14px",
              fontSize: 14, outline: "none", fontFamily: "inherit", background: "var(--panel, #fff)",
              color: "var(--txt, #1c2128)",
            }}
          >
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.run_count} run{p.run_count === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <button
            type="button" onClick={open} disabled={loading || !projectId}
            style={{
              background: "var(--indigo, #6d5df6)", color: "#fff", border: "none", borderRadius: 9,
              padding: "0 20px", fontSize: 14, fontWeight: 600, cursor: loading ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {loading ? "Opening…" : "Open →"}
          </button>
        </div>
      )}
    </div>
  );
}

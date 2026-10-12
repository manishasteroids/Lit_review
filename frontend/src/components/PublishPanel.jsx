import React, { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import PaperPreview from "./PaperPreview.jsx";
import { Check, AlertTriangle, Download, Trash2, Plus, RotateCw, ChevronUp, ChevronDown, FileText } from "./icons.jsx";

/**
 * Publish — the step after the Infinity report. Turns the Sift review and
 * (when there is one) the recommended hypothesis into a manuscript in the
 * format of the venue's own Word or LaTeX template.
 *
 * Server side: backend/api/manuscript_routes.py. This panel holds one
 * manuscript per Sift run (found or created by /open) and saves every edit
 * as it is made, so leaving and coming back loses nothing.
 *
 * Props: runId (the Sift run), hypRunId (the Infinity run, or null),
 *        apiKey, model.
 */

const S = {
  wrap: { display: "flex", flexDirection: "column", gap: 18 },
  h: { margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-.01em" },
  lead: { margin: "6px 0 0", color: "var(--muted)", fontSize: 14, lineHeight: 1.6, maxWidth: 720 },
  step: { border: "1px solid var(--line)", borderRadius: 16, padding: "26px 28px", background: "var(--card,#fff)" },
  group: { fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, fontWeight: 600, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted2)", margin: "0 0 8px" },
  stepHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 },
  num: {
    width: 24, height: 24, borderRadius: 12, background: "var(--indigo-soft)", color: "var(--indigo)",
    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0,
  },
  stepTitle: { margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" },
  hint: { color: "var(--muted)", fontSize: 13, lineHeight: 1.55, margin: "0 0 12px" },
  label: { display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", margin: "0 0 5px" },
  input: {
    width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 9, border: "1px solid var(--line)",
    background: "var(--card,#fff)", color: "var(--txt)", fontFamily: "inherit", fontSize: 14, outline: "none",
  },
  grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12 },
  choice: {
    textAlign: "left", padding: "13px 14px", borderRadius: 12, border: "1px solid var(--line)", cursor: "pointer",
    background: "var(--card,#fff)", color: "var(--txt)", fontFamily: "inherit",
  },
  choiceOn: { borderColor: "var(--indigo)", background: "var(--indigo-soft)" },
  chip: {
    display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5,
    padding: "3px 8px", borderRadius: 6, background: "var(--indigo-soft)", color: "var(--indigo)",
  },
  row: { display: "flex", alignItems: "center", gap: 8 },
  iconBtn: {
    background: "none", border: "1px solid var(--line)", borderRadius: 7, padding: 5, cursor: "pointer",
    color: "var(--muted)", display: "inline-flex",
  },
  err: { color: "#c0392b", fontSize: 13, margin: "8px 0 0" },
  fileRow: { border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 },
  check: { display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 13.5 },
  secHead: { margin: "18px 0 6px", fontSize: 14, fontWeight: 600 },
};

const TYPES = [
  ["review", "Review article", "The literature review as a paper. The recommended hypothesis appears as an open question for future work."],
  ["research", "Research paper", "Introduction, methods, results and discussion, built around the recommended hypothesis and the results you supply."],
];

const STEP_OF = { template: "format", spec: "format", guide: "format", guidefile: "format", reset: "top", file: "results", generate: "write", download: "download", approve: "download" };

const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

// One step is shown at a time (see the stepper in PublishPanel). The step's
// place in the flow is shown by the stepper, so the card carries no number.
function Step({ id, cur, title, sub, children }) {
  if (id !== cur) return null;
  return (
    <section style={S.step}>
      <div style={{ marginBottom: 18 }}>
        <h3 style={S.stepTitle}>{title}</h3>
        {sub && <p style={{ ...S.hint, margin: "5px 0 0" }}>{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function Stepper({ steps, cur, onPick }) {
  const at = steps.findIndex((x) => x.id === cur);
  return (
    <nav aria-label="Publish steps" style={{ display: "flex", alignItems: "flex-start", overflowX: "auto", padding: "4px 2px 2px" }}>
      {steps.map((st, i) => {
        const on = st.id === cur;
        const dotBg = on ? "var(--indigo)" : st.done ? "var(--green-soft)" : "var(--card,#fff)";
        const dotFg = on ? "#fff" : st.done ? "var(--green)" : "var(--muted)";
        return (
          <React.Fragment key={st.id}>
            {i > 0 && (
              <span aria-hidden="true" style={{ flex: "1 1 18px", minWidth: 14, height: 2, marginTop: 15, borderRadius: 2,
                background: i <= at ? "var(--indigo)" : "var(--line)", opacity: i <= at ? 0.55 : 1 }} />
            )}
            <button onClick={() => onPick(st.id)} aria-current={on ? "step" : undefined}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, background: "none", border: "none",
                cursor: "pointer", padding: "0 6px", fontFamily: "inherit", color: on ? "var(--txt)" : "var(--muted)", flexShrink: 0 }}>
              <span style={{ width: 32, height: 32, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center",
                background: dotBg, color: dotFg, fontSize: 13, fontWeight: 700,
                border: on ? "1px solid var(--indigo)" : st.done ? "1px solid transparent" : "1px solid var(--line)",
                boxShadow: on ? "0 0 0 4px var(--indigo-soft)" : "none", transition: "box-shadow .15s ease" }}>
                {st.done && !on ? <Check size={15} /> : i + 1}
              </span>
              <span style={{ fontSize: 12.5, fontWeight: on ? 600 : 500, whiteSpace: "nowrap" }}>{st.label}</span>
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

// A text field that keeps its own draft and saves once, when focus leaves.
function Field({ label, value, onSave, rows, placeholder, type = "text", style }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => { setV(value ?? ""); }, [value]);
  const commit = () => { if ((v ?? "") !== (value ?? "")) onSave(v); };
  const common = { style: { ...S.input, ...(rows ? { resize: "vertical", lineHeight: 1.5 } : {}), ...style }, value: v, placeholder,
    onChange: (e) => setV(e.target.value), onBlur: commit };
  return (
    <label style={{ display: "block" }}>
      {label && <span style={S.label}>{label}</span>}
      {rows ? <textarea rows={rows} {...common} /> : <input type={type} {...common} />}
    </label>
  );
}

// One drawn concept diagram: the picture, where it goes, and its caption.
function DiagramCard({ msId, d, sectionName, onCaption, onRemove }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let made = null, off = false;
    api.getManuscriptImageUrl(msId, d.id).then((u) => { made = u; if (!off) setUrl(u); else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { off = true; if (made) URL.revokeObjectURL(made); };
  }, [msId, d.id]);
  return (
    <div style={{ ...S.fileRow, flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
      <div style={{ flex: "0 1 260px", minWidth: 180, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}>
        {url ? <img src={url} alt={d.description || "Concept diagram"} style={{ display: "block", width: "100%", height: "auto" }} />
          : <div className="muted tiny" style={{ padding: 20, textAlign: "center" }}>Loading…</div>}
      </div>
      <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={S.row}>
          <span style={S.chip}>{d.kind}</span>
          <span className="muted tiny">in “{sectionName}”</span>
          <button style={{ ...S.iconBtn, marginLeft: "auto" }} aria-label="Remove this diagram" onClick={onRemove}><Trash2 size={14} /></button>
        </div>
        <Field label="Caption" rows={2} value={d.description} onSave={onCaption} />
        {d.mention && <p className="muted tiny" style={{ margin: 0, lineHeight: 1.5 }}>Added to the text: “{d.mention.replace("{fig}", "Fig. N")}”</p>}
      </div>
    </div>
  );
}

export default function PublishPanel({ runId, hypRunId, apiKey, model, topic }) {
  const [ms, setMs] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [busy, setBusy] = useState(null);       // "template" | "spec" | "file" | "generate" | "download" | null
  const [err, setErr] = useState(null);         // { at: step the action belongs to, msg }
  const [guideUrl, setGuideUrl] = useState("");
  const [fileNote, setFileNote] = useState("");
  const [openSec, setOpenSec] = useState(null);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [step, setStep] = useState("type");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const tplInput = useRef(null);
  const guideInput = useRef(null);
  const resInput = useRef(null);

  useEffect(() => {
    let off = false;
    setMs(null); setLoadErr(null); setErr(null);
    if (!runId) return;
    api.openManuscript(runId, hypRunId || undefined)
      .then((m) => {
        if (off) return;
        setMs(m); setGuideUrl(m.guidelines?.url || "");
        setStep(m.manuscript ? (m.approved ? "download" : "write") : "type");   // pick up where they left off
      })
      .catch((e) => { if (!off) setLoadErr(e.message); });
    return () => { off = true; };
  }, [runId, hypRunId]);

  // Every server call returns the whole manuscript, so one helper covers them.
  async function run(kind, fn) {
    setBusy(kind); setErr(null);
    try { const m = await fn(); if (m) setMs(m); }
    catch (e) { setErr({ at: STEP_OF[kind] || "top", msg: e.message }); }
    finally { setBusy(null); }
  }
  // Errors show inside the step whose button was pressed, not at the bottom.
  const errAt = (at) => (err?.at === at ? <p style={S.err} role="alert">{err.msg}</p> : null);
  const save = (body) => run(null, () => api.patchManuscript(ms.id, body));

  if (loadErr) {
    return (
      <div style={{ textAlign: "center", padding: "28px 16px" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Publish isn't available for this run yet</h3>
        <div className="muted tiny" style={{ maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>{loadErr}</div>
      </div>
    );
  }
  if (!ms) return <div className="muted" style={{ padding: 24 }}>Loading…</div>;

  const spec = ms.spec || { sections: [] };
  const details = ms.details || {};
  const research = ms.paper_type === "research";
  const tinfo = ms.template?.info || {};
  const setSpec = (patch) => save({ spec: { ...spec, ...patch } });
  const setSections = (sections) => setSpec({ sections });
  const move = (i, d) => {
    const next = [...spec.sections];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setSections(next);
  };
  const noWord = (spec.accepted_formats || []).length > 0 && !spec.accepted_formats.includes("word");
  const warn = (ms.checks || []).filter((c) => c.status !== "ok").length;
  const hasAuthors = !!(details.authors_text || "").trim();
  const steps = [
    { id: "type", label: "Paper type", done: true },
    { id: "format", label: "Format", done: !!(ms.template || ms.guidelines || ms.guidelines_file) },
    { id: "details", label: "Authors", done: hasAuthors },
    research && { id: "results", label: "Results", done: (ms.files || []).length > 0 },
    { id: "write", label: "Write", done: !!ms.manuscript },
    { id: "download", label: "Approve & download", done: !!ms.approved },
  ].filter(Boolean);
  const cur = steps.some((x) => x.id === step) ? step : "write";
  const idx = steps.findIndex((x) => x.id === cur);
  const go = (id) => { setErr(null); setStep(id); };

  return (
    <div style={S.wrap}>
      <div>
        <div style={{ ...S.row, alignItems: "flex-start" }}>
          <h2 style={S.h}>Publish</h2>
          <button className="btn ghost sm" disabled={!!busy} onMouseLeave={() => setResetArmed(false)}
            style={{ marginLeft: "auto", ...(resetArmed ? { color: "#c0392b", borderColor: "#f0b4ac" } : {}) }}
            title="Clear the template, guidelines, author details, results files and written text for this paper"
            onClick={() => {
              if (!resetArmed) { setResetArmed(true); return; }
              setResetArmed(false);
              run("reset", async () => { const m = await api.resetManuscript(ms.id); setGuideUrl(""); setStep("type"); return m; });
            }}>
            {busy === "reset" ? "Clearing…" : resetArmed ? "Click again to clear everything" : "Start over"}
          </button>
        </div>
        <p style={S.lead}>
          Write this work up as a paper in your target journal or conference's own format. Upload their Word or
          LaTeX template and the paper is written into it, with a checklist of what still needs your attention.
        </p>
        {topic && (
          <div style={{ ...S.fileRow, flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <span style={{ ...S.group, margin: 0 }}>Written from</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{topic}</span>
            <span className="muted tiny">
              the literature review this paper is built on{ms.hyp_run_id ? ", with its Infinity hypotheses" : ""}. Not the right one? Open a different review first.
            </span>
          </div>
        )}
        {errAt("top")}
      </div>

      <Stepper steps={steps} cur={cur} onPick={go} />

      <Step id="type" cur={cur} title="What kind of paper is this?" sub="This decides the outline and what the writer draws on.">
        <div style={S.grid2}>
          {TYPES.map(([k, name, blurb]) => (
            <button key={k} style={{ ...S.choice, ...(ms.paper_type === k ? S.choiceOn : {}) }}
              aria-pressed={ms.paper_type === k} onClick={() => ms.paper_type !== k && save({ paper_type: k })}>
              <b style={{ display: "block", fontSize: 14, marginBottom: 4 }}>{name}</b>
              <span style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>{blurb}</span>
            </button>
          ))}
        </div>
        {!ms.hyp_run_id && (
          <p style={{ ...S.hint, margin: "12px 0 0" }}>
            No Infinity run is linked to this review, so the paper is written from the literature review alone.
          </p>
        )}
      </Step>

      <Step id="format" cur={cur} title="Where is it going?"
        sub="Give the venue's template, its guidelines, or both. Their rules are read into the format and outline below, which you can edit.">
        <div style={S.group}>Template</div>
        <p style={S.hint}>
          Word (.docx, .dotx) or LaTeX (.zip of the template folder, or a single .tex or .cls). The paper is written
          into this file, in its own styles.
        </p>
        <input ref={tplInput} type="file" hidden accept=".docx,.dotx,.dotm,.zip,.tex,.cls"
          onChange={(e) => {
            const f = e.target.files?.[0]; e.target.value = "";
            if (f) run("template", () => api.uploadManuscriptTemplate(ms.id, f, apiKey || undefined, model));
          }} />
        <div style={{ ...S.row, flexWrap: "wrap" }}>
          <button className="btn sm" disabled={!!busy} onClick={() => tplInput.current?.click()}>
            {busy === "template" ? <><RotateCw size={13} className="spin" /> Reading template…</>
              : ms.template ? "Replace template" : "Upload template"}
          </button>
          {!ms.template && busy !== "template" && <span className="muted tiny">No template uploaded yet.</span>}
          {ms.template && (
            <>
              <span style={{ ...S.chip, background: "var(--green-soft)", color: "var(--green)" }}>
                <Check size={12} /> {ms.template.filename}
              </span>
              <span className="muted tiny">
                {ms.template.kind === "docx"
                  ? `Word · ${tinfo.columns > 1 ? tinfo.columns + " columns" : "single column"}`
                  : `LaTeX · ${tinfo.documentclass || "class not found"}${tinfo.bibstyle ? " · " + tinfo.bibstyle : ""}`}
              </span>
              <button className="btn ghost sm" disabled={!!busy} title="Read the template again for the current paper type and instructions"
                onClick={() => run("spec", () => api.rebuildManuscriptSpec(ms.id, apiKey || undefined, model))}>
                {busy === "spec" ? "Re-reading…" : "Re-read template"}
              </button>
            </>
          )}
        </div>
        {errAt("format")}

        <div style={{ marginTop: 16 }}>
          <div style={{ ...S.group, marginTop: 22 }}>Submission guidelines <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></div>
          <div style={{ ...S.row, flexWrap: "wrap" }}>
            <input style={{ ...S.input, flex: "1 1 320px", width: "auto" }} type="url" value={guideUrl}
              placeholder="https://info.arxiv.org/help/submit/index.html" aria-label="Submission guidelines link"
              onChange={(e) => setGuideUrl(e.target.value)} />
            <button className="btn ghost sm" disabled={!!busy || (!guideUrl.trim() && !ms.guidelines)}
              onClick={() => run("guide", () => api.setManuscriptGuidelines(ms.id, guideUrl.trim(), apiKey || undefined, model))}>
              {busy === "guide" ? <><RotateCw size={13} className="spin" /> Reading page…</>
                : !guideUrl.trim() && ms.guidelines ? "Remove link" : ms.guidelines ? "Read again" : "Read guidelines"}
            </button>
          </div>
          <p style={{ ...S.hint, margin: "6px 0 0" }}>
            {ms.guidelines
              ? <><Check size={12} style={{ color: "var(--green)", verticalAlign: "-1px" }} /> Guidelines read from {ms.guidelines.url} — limits and required statements below were updated from it.</>
              : "The venue's author instructions page. Its limits, required statements and citation style are read into the outline below."}
          </p>

          <input ref={guideInput} type="file" hidden accept=".pdf,.docx,.txt,.md"
            onChange={(e) => {
              const f = e.target.files?.[0]; e.target.value = "";
              if (f) run("guidefile", () => api.uploadManuscriptGuidelinesFile(ms.id, f, apiKey || undefined, model));
            }} />
          <div style={{ ...S.row, flexWrap: "wrap", marginTop: 10 }}>
            <button className="btn ghost sm" disabled={!!busy} onClick={() => guideInput.current?.click()}>
              {busy === "guidefile" ? <><RotateCw size={13} className="spin" /> Reading document…</>
                : ms.guidelines_file ? "Replace document" : "Upload guidelines PDF"}
            </button>
            {ms.guidelines_file ? (
              <>
                <span style={{ ...S.chip, background: "var(--green-soft)", color: "var(--green)" }}>
                  <Check size={12} /> {ms.guidelines_file.filename}
                </span>
                <button style={S.iconBtn} aria-label="Remove guidelines document" disabled={!!busy}
                  onClick={() => run("guidefile", () => api.removeManuscriptGuidelinesFile(ms.id))}><Trash2 size={14} /></button>
              </>
            ) : (
              <span className="muted tiny">
                PDF, DOCX or TXT: the author instructions, or a sample paper from the venue to copy its structure.
              </span>
            )}
          </div>
        </div>

        {(spec.summary || []).length > 0 && (
          <div style={{ ...S.fileRow, marginTop: 14, background: "var(--indigo-soft)", borderColor: "transparent" }}>
            <button onClick={() => setSummaryOpen((o) => !o)} aria-expanded={summaryOpen}
              style={{ ...S.row, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--txt)", fontFamily: "inherit", textAlign: "left", width: "100%" }}>
              <FileText size={14} style={{ color: "var(--indigo)" }} />
              <b style={{ fontSize: 13.5 }}>What was read</b>
              <span className="muted tiny">summary of the {[ms.template && "template", (ms.guidelines || ms.guidelines_file) && "guidelines"].filter(Boolean).join(" and ") || "sources"}</span>
              <span style={{ marginLeft: "auto", color: "var(--muted2)", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                {summaryOpen ? "Hide" : "Show"} {summaryOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </span>
            </button>
            {summaryOpen && (
              <>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: 13.5, lineHeight: 1.6 }}>
                  {spec.summary.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
                {(tinfo.learned?.conventions || []).length > 0 && (
                  <>
                    <div style={{ ...S.group, margin: "10px 0 2px" }}>Format learned from the template</div>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.6 }}>
                      {tinfo.learned.conventions.map((line, i) => <li key={i}>{line}</li>)}
                    </ul>
                  </>
                )}
                {(tinfo.learned?.by_hand || []).length > 0 && (
                  <>
                    <div style={{ ...S.group, margin: "10px 0 2px" }}>For you to finish by hand</div>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.6 }}>
                      {tinfo.learned.by_hand.map((x, i) => (
                        <li key={i}><b>{x.item}</b>{x.where ? ` (${x.where})` : ""}{x.how ? ` — ${x.how}` : ""}</li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="muted tiny" style={{ margin: "4px 0 0" }}>
                  Written by the agent from your template and guidelines, for your information. Check anything
                  that matters against the original.
                </p>
              </>
            )}
          </div>
        )}

        {ms.template && ms.spec_source === "default" && (
          <p style={{ ...S.hint, margin: "10px 0 0" }}>
            The template's own instructions could not be read automatically, so a standard outline is shown. The
            file is still written in the template's styles.
          </p>
        )}

        <div style={{ ...S.group, marginTop: 24 }}>Format rules</div>
        <p style={S.hint}>
          {ms.spec_source === "default"
            ? "Standard values. Upload a template or guidelines above to have these read for you."
            : `Read from your ${ms.spec_source === "template" ? "template" : "guidelines"}${ms.spec_source === "template" && (ms.guidelines || ms.guidelines_file) ? " and guidelines" : ""}. Where the two disagree on citation style or headings, the template wins, because the file is written in its styles. Change anything that is wrong.`}
        </p>
        <div style={S.grid2}>
          <Field label="Venue" value={spec.venue} placeholder="e.g. IEEE Transactions on Robotics" onSave={(v) => setSpec({ venue: v })} />
          <label style={{ display: "block" }}>
            <span style={S.label}>Citation style</span>
            <select style={S.input} value={spec.citation_style} onChange={(e) => setSpec({ citation_style: e.target.value })}>
              <option value="numeric">Numbered [1]</option>
              <option value="author-year">Author–year (Smith et al., 2024)</option>
            </select>
          </label>
          <label style={{ display: "block" }}>
            <span style={S.label}>Reference list format</span>
            <select style={S.input} value={spec.reference_style || "ieee"} onChange={(e) => setSpec({ reference_style: e.target.value })}>
              <option value="ieee">IEEE — J. Smith, "Title," Venue, 2024.</option>
              <option value="apa">APA — Smith, J. (2024). Title. Venue.</option>
              <option value="harvard">Harvard — Smith, J. (2024). Title. Venue.</option>
              <option value="vancouver">Vancouver — Smith J. Title. Venue. 2024.</option>
              <option value="acm">ACM — Jane Smith. 2024. Title. Venue.</option>
            </select>
          </label>
          <Field label="Abstract word limit" type="number" value={spec.abstract_word_limit ?? ""} onSave={(v) => setSpec({ abstract_word_limit: v })} />
          <Field label="Body word limit (optional)" type="number" value={spec.word_limit ?? ""} onSave={(v) => setSpec({ word_limit: v || null })} />
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Statements the venue requires (comma-separated)" value={(spec.required_statements || []).join(", ")}
            placeholder="e.g. Data availability, Conflict of interest"
            onSave={(v) => setSpec({ required_statements: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
        </div>

        <button onClick={() => setSectionsOpen((o) => !o)} aria-expanded={sectionsOpen}
          style={{ ...S.row, ...S.group, marginTop: 24, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
          Outline <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· {spec.sections.length} sections</span>
          <span style={{ marginLeft: "auto", color: "var(--muted2)", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: 12.5 }}>
            {sectionsOpen ? "Hide" : "Edit outline"} {sectionsOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </button>
        {!sectionsOpen && (
          <p style={{ ...S.hint, margin: 0 }}>
            {spec.sections.map((x) => `${x.heading} (${x.words})`).join("  →  ")}
          </p>
        )}
        {sectionsOpen && <>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {spec.sections.map((s, i) => (
            <div key={s.key} style={{ ...S.fileRow, gap: 6 }}>
              <div style={S.row}>
                <Field value={s.heading} style={{ fontWeight: 600 }}
                  onSave={(v) => v.trim() && setSections(spec.sections.map((x, j) => (j === i ? { ...x, heading: v } : x)))} />
                <div style={{ width: 92, flexShrink: 0 }}>
                  <Field type="number" value={s.words} placeholder="words"
                    onSave={(v) => setSections(spec.sections.map((x, j) => (j === i ? { ...x, words: v } : x)))} />
                </div>
                <button style={S.iconBtn} aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp size={14} /></button>
                <button style={S.iconBtn} aria-label="Move down" disabled={i === spec.sections.length - 1} onClick={() => move(i, 1)}><ChevronDown size={14} /></button>
                <button style={S.iconBtn} aria-label="Remove section" disabled={spec.sections.length <= 1}
                  onClick={() => setSections(spec.sections.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
              </div>
              <Field value={s.guidance} placeholder="What belongs in this section"
                style={{ fontSize: 13, color: "var(--muted)" }}
                onSave={(v) => setSections(spec.sections.map((x, j) => (j === i ? { ...x, guidance: v } : x)))} />
            </div>
          ))}
        </div>
        <button className="btn ghost sm" style={{ marginTop: 10 }}
          onClick={() => setSections([...spec.sections, { heading: "New section", guidance: "", words: 300 }])}>
          <Plus size={13} /> Add section
        </button>
        </>}
      </Step>

      <Step id="details" cur={cur} title="Who wrote it?" sub="Authors and the statements that go at the front and back of the paper.">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Title (leave empty to have one written)" value={details.title} onSave={(v) => save({ details: { title: v } })} />
          <Field label="Authors — one per line: Name; Affiliation; Email" rows={3} value={details.authors_text}
            placeholder={"Ada Lovelace; University of London; ada@example.org"} onSave={(v) => save({ details: { authors_text: v } })} />
          <Field label="Keywords (leave empty to have them written)" value={details.keywords} onSave={(v) => save({ details: { keywords: v } })} />
          <div style={S.grid2}>
            <Field label="Funding" rows={2} value={details.funding} onSave={(v) => save({ details: { funding: v } })} />
            <Field label="Conflict of interest" rows={2} value={details.conflicts} onSave={(v) => save({ details: { conflicts: v } })} />
            <Field label="Data availability" rows={2} value={details.data_availability} onSave={(v) => save({ details: { data_availability: v } })} />
            <Field label="Acknowledgements" rows={2} value={details.acknowledgements} onSave={(v) => save({ details: { acknowledgements: v } })} />
          </div>
          <Field label="Instructions for the writer (optional)" rows={3} value={ms.instructions}
            placeholder="e.g. British spelling, emphasise clinical relevance, keep the introduction under 500 words"
            onSave={(v) => save({ instructions: v })} />
          <label style={{ ...S.row, fontSize: 13.5, cursor: "pointer" }}>
            <input type="checkbox" checked={details.ai_disclosure !== false}
              onChange={(e) => save({ details: { ai_disclosure: e.target.checked } })} />
            Include a statement declaring the use of AI tools (most publishers require one)
          </label>
        </div>
      </Step>

      {research && (
        <Step id="results" cur={cur} title="What did you find?">
          <p style={S.hint}>
            Upload what you found: documents (PDF, DOCX, TXT), data files (CSV, XLSX) and figures (PNG, JPG). Say
            what to use from each. Results are reported only from what you supply here; anything missing is
            marked [TO ADD] in the paper rather than filled in.
          </p>
          <Field label="What to use overall" rows={2} value={ms.results_notes}
            placeholder="e.g. Report the accuracy and F1 columns for the three models; trial 4 was a calibration run, leave it out"
            onSave={(v) => save({ results_notes: v })} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
            {(ms.files || []).map((f) => (
              <div key={f.id} style={S.fileRow}>
                <div style={S.row}>
                  <span style={S.chip}>{f.kind === "image" ? "figure" : f.kind}</span>
                  <b style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.filename}</b>
                  <span className="muted tiny" style={{ whiteSpace: "nowrap" }}>
                    {kb(f.size)}{f.kind === "data" ? ` · ${f.rows} rows × ${f.cols} columns` : ""}
                  </span>
                  <button style={{ ...S.iconBtn, marginLeft: "auto" }} aria-label={`Remove ${f.filename}`}
                    onClick={() => run("file", () => api.deleteManuscriptFile(ms.id, f.id))}><Trash2 size={14} /></button>
                </div>
                <Field value={f.description}
                  placeholder={f.kind === "image" ? "Caption for this figure" : "What to use from this file"}
                  onSave={(v) => run("file", () => api.patchManuscriptFile(ms.id, f.id, { description: v }))} />
                {f.kind === "data" && (
                  <label style={{ ...S.row, fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={!!f.include}
                      onChange={(e) => run("file", () => api.patchManuscriptFile(ms.id, f.id, { include: e.target.checked }))} />
                    Also print this file as a table in the paper (first 15 rows, 8 columns)
                  </label>
                )}
              </div>
            ))}
          </div>
          <input ref={resInput} type="file" hidden multiple accept=".pdf,.docx,.txt,.md,.csv,.tsv,.xlsx,.xls,.png,.jpg,.jpeg"
            onChange={async (e) => {
              const list = Array.from(e.target.files || []); e.target.value = "";
              for (const f of list) await run("file", () => api.uploadManuscriptFile(ms.id, f, list.length === 1 ? fileNote : ""));
              setFileNote("");
            }} />
          <div style={{ ...S.row, flexWrap: "wrap" }}>
            <input style={{ ...S.input, flex: "1 1 260px", width: "auto" }} value={fileNote} onChange={(e) => setFileNote(e.target.value)}
              placeholder="Description for the next file (optional)" aria-label="Description for the next file" />
            <button className="btn ghost sm" disabled={!!busy} onClick={() => resInput.current?.click()}>
              {busy === "file" ? "Working…" : <><Plus size={13} /> Add files</>}
            </button>
          </div>
          {errAt("results")}
        </Step>
      )}

      <Step id="write" cur={cur} title="Write the paper" sub="Every section is written against your outline. You can edit the text afterwards.">
        <div style={{ ...S.row, flexWrap: "wrap" }}>
          <button className="btn" disabled={!!busy}
            onClick={() => run("generate", () => api.generateManuscript(ms.id, apiKey || undefined, model))}>
            {busy === "generate" ? <><RotateCw size={14} className="spin" /> Writing — this takes a minute or two…</>
              : ms.manuscript ? "Write again" : "Write the paper"}
          </button>
          {ms.manuscript && (
            <button className="btn ghost" disabled={!!busy} onClick={() => setPreviewOpen(true)}>
              <FileText size={14} /> Open the paper
            </button>
          )}
        </div>
        <label style={{ ...S.row, fontSize: 13.5, cursor: "pointer", marginTop: 12 }}>
          <input type="checkbox" checked={details.diagrams !== false}
            onChange={(e) => save({ details: { diagrams: e.target.checked } })} />
          Draw concept diagrams where they help (introduction, background, methods — never results)
        </label>
        {errAt("write")}

        {ms.manuscript && (
          <>
            <div style={S.secHead}>
              Checklist {warn > 0 ? <span className="muted" style={{ fontWeight: 400 }}>· {warn} to look at</span> : null}
            </div>
            <div>
              {(ms.checks || []).map((c) => (
                <div key={c.label} style={S.check}>
                  <span style={{ color: c.status === "ok" ? "var(--green)" : "var(--amber)", marginTop: 2, flexShrink: 0 }}>
                    {c.status === "ok" ? <Check size={15} /> : <AlertTriangle size={15} />}
                  </span>
                  <span><b>{c.label}</b> <span className="muted">— {c.detail}</span></span>
                </div>
              ))}
            </div>

            {Array.isArray(ms.format_review) && (
              <>
                <div style={S.secHead}>
                  Format review <span className="muted" style={{ fontWeight: 400 }}>
                    · {ms.format_review.length === 0 ? "matches the template" : `${ms.format_review.length} difference${ms.format_review.length === 1 ? "" : "s"} from the template`}
                  </span>
                </div>
                <p style={S.hint}>
                  After writing, the agent builds the file and compares it with your template, part by part.
                  {ms.format_review.length === 0 ? " It found nothing that differs." : " These are the places it found that still differ."}
                </p>
                {ms.format_review.map((x, i) => (
                  <div key={i} style={S.check}>
                    <span style={{ color: "var(--amber)", marginTop: 2, flexShrink: 0 }}><AlertTriangle size={15} /></span>
                    <span>
                      {x.element && <b>{x.element} </b>}<span className="muted">— {x.issue}</span>
                      {x.fix && <span style={{ display: "block", marginTop: 2 }}>Fix: {x.fix}</span>}
                    </span>
                  </div>
                ))}
              </>
            )}

            {(ms.diagrams || []).length > 0 && (
              <>
                <div style={S.secHead}>Diagrams <span className="muted" style={{ fontWeight: 400 }}>· {ms.diagrams.length} drawn from the text</span></div>
                <p style={S.hint}>
                  Conceptual figures drawn from what each section says. They show ideas and structure, not data.
                  Check each one, fix its caption, or remove it.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {ms.diagrams.map((d) => (
                    <DiagramCard key={d.id} msId={ms.id} d={d}
                      sectionName={spec.sections.find((x) => x.key === d.section_key)?.heading || d.section || "the paper"}
                      onCaption={(v) => run("file", () => api.patchManuscriptFile(ms.id, d.id, { description: v }))}
                      onRemove={() => run("file", () => api.deleteManuscriptFile(ms.id, d.id))} />
                  ))}
                </div>
              </>
            )}

            <div style={S.secHead}>Text</div>
            <p style={S.hint}>Edit anything here before downloading; changes are saved when you click away.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="Title" value={ms.manuscript.title} onSave={(v) => save({ manuscript: { title: v } })} />
              <Field label="Abstract" rows={6} value={ms.manuscript.abstract} onSave={(v) => save({ manuscript: { abstract: v } })} />
              <Field label="Keywords" value={(ms.manuscript.keywords || []).join(", ")}
                onSave={(v) => save({ manuscript: { keywords: v.split(",").map((x) => x.trim()).filter(Boolean) } })} />
              {spec.sections.map((s) => {
                const text = ms.manuscript.sections?.[s.key] || "";
                const open = openSec === s.key;
                return (
                  <div key={s.key} style={S.fileRow}>
                    <button onClick={() => setOpenSec(open ? null : s.key)} aria-expanded={open}
                      style={{ ...S.row, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--txt)", fontFamily: "inherit", textAlign: "left" }}>
                      <b style={{ fontSize: 14 }}>{s.heading}</b>
                      <span className="muted tiny">{text ? text.trim().split(/\s+/).length + " words" : "not written yet"}</span>
                      <span style={{ marginLeft: "auto", color: "var(--muted2)" }}>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
                    </button>
                    {open && (
                      <Field rows={14} value={text} onSave={(v) => save({ manuscript: { sections: { [s.key]: v } } })} />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Step>

      {!ms.manuscript && cur === "download" && (
        <section style={S.step}><p style={{ ...S.hint, margin: 0 }}>Nothing to approve yet. Write the paper first.</p></section>
      )}
      {ms.manuscript && (
        <Step id="download" cur={cur} title="Approve and download">
          {!ms.approved ? (
            <>
              <p style={S.hint}>
                Read the text in the Write step and edit anything you want changed. The Word or LaTeX file is only
                built from text you have approved.
              </p>
              <div style={{ ...S.row, flexWrap: "wrap" }}>
                <button className="btn ghost" disabled={!!busy} onClick={() => setPreviewOpen(true)}>
                  <FileText size={14} /> Open the paper
                </button>
                <button className="btn" disabled={!!busy} onClick={() => run("approve", () => api.patchManuscript(ms.id, { approved: true }))}>
                  <Check size={14} /> {busy === "approve" ? "Saving…" : "Approve text"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ ...S.hint, color: "var(--green)" }}>
                <Check size={13} style={{ verticalAlign: "-2px" }} /> Text approved. Editing the text or writing again
                will ask for approval again.
              </p>
              <div style={{ ...S.row, flexWrap: "wrap" }}>
          {ms.template && (
            <button className="btn ghost" disabled={!!busy}
              onClick={() => run("download", async () => { await api.downloadManuscript(ms.id); })}>
              <Download size={14} /> {busy === "download" ? "Preparing…" : ms.template.kind === "latex" ? "Download LaTeX (.zip)" : "Download Word (.docx)"}
            </button>
          )}
          {!ms.template && (noWord ? ["latex", "docx"] : ["docx", "latex"]).map((fmt) => (
            <button key={fmt} className={"btn" + (noWord && fmt === "latex" ? "" : " ghost")} disabled={!!busy}
              onClick={() => run("download", async () => { await api.downloadManuscript(ms.id, fmt); })}>
              <Download size={14} /> {fmt === "latex" ? "Download LaTeX (.zip)" : "Download Word (.docx)"}
            </button>
          ))}
              </div>
        {noWord && (
          <p style={{ ...S.hint, margin: "8px 0 0", color: "var(--amber)" }}>
            {spec.venue || "This venue"} does not accept Word files. Use the LaTeX download for submission; the Word
            file is for reading and sharing drafts.
          </p>
        )}
        {!ms.template && (
          <p style={{ ...S.hint, margin: "8px 0 0" }}>
            No template uploaded, so these use a standard single-column layout. Upload the venue's template in
            the Format step to get its exact format.
          </p>
        )}
            </>
          )}
          {errAt("download")}
        </Step>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {idx > 0 && <button className="btn ghost" onClick={() => go(steps[idx - 1].id)}>Back</button>}
        <span className="muted tiny" style={{ marginLeft: "auto" }}>Saved automatically</span>
        {idx < steps.length - 1 && (
          <button className="btn" disabled={cur === "write" && !ms.manuscript}
            title={cur === "write" && !ms.manuscript ? "Write the paper first" : ""}
            onClick={() => go(steps[idx + 1].id)}>
            Continue to {steps[idx + 1].label.toLowerCase()} →
          </button>
        )}
      </div>
      {previewOpen && ms.manuscript && (
        <PaperPreview msId={ms.id} title={ms.manuscript.title} onClose={() => setPreviewOpen(false)}
          note={ms.template
            ? "A reading view in a plain layout: same text, figures and references as your download, which uses your template's own layout."
            : undefined} />
      )}
    </div>
  );
}

import React, { useState, useRef, useEffect } from "react";

/**
 * Methods / Experiment Designer panel (controlled).
 * Plan + design handler live in App.jsx so results survive tab switches.
 *
 * Each hypothesis renders as a scannable card:
 *   - the hypothesis + rationale
 *   - critic scores as small status-colored bars (novelty/grounding/
 *     testability/consistency) instead of a plain number — see ScoreBars
 *   - an "Evidence trail" table: which cited paper actually backs which
 *     claim, so "what is this grounded in" is answered in the UI itself,
 *     not just in a citation number you have to go look up
 *   - an Edit toggle: every field is user-editable, and edits save with no
 *     LLM call — the agent's output is a draft to argue with, not a verdict
 *   - a "Challenge" box: type an objection, the designer either revises the
 *     hypothesis or defends it with a specific counter-reason (never a bare
 *     concession) — see agents/experiment_designer.py: respond_to_challenge
 *
 * Props: plan, critique, iterations, debate, busy, onDesign, onRefine,
 *        onUpdate(index, edits), onDispute(index, argument),
 *        onAcceptRevision(index, proposedHypothesis), onExport(fmt),
 *        papers=[{idx,title}], extractions=[{idx,finding,...}]
 */
export default function MethodsPanel({
  plan, critique, iterations = 0, debate = {}, kgBridges = [], busy,
  onDesign, onRefine, onUpdate, onDispute, onAcceptRevision, onExport,
  papers = [], extractions = [],
}) {
  const muted = { color: "var(--muted, #667)" };
  const critiqueByIndex = Object.fromEntries(
    (critique?.critiques || []).map((c) => [c.index, c])
  );

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
          Methods &amp; Experiments
          <HelpTip label="What this panel does">
            Turns the synthesis and detected gaps into testable experiment plans, in
            the language of the paper's domain — grounded in your cited sources.
            Nothing here is final: edit any field, or challenge a hypothesis
            directly and the agent will revise it or defend it. Saved automatically —
            it'll still be here if you leave and come back.
          </HelpTip>
        </h3>
        <button onClick={onDesign} disabled={busy} type="button">
          {busy ? "Working…" : plan ? "Regenerate" : "Design experiments"}
        </button>
        <button
          onClick={onRefine}
          disabled={busy}
          type="button"
          title="Critique each hypothesis and revise the weak ones — repeats a couple of rounds automatically"
        >
          {busy ? "Working…" : "Refine (recursive self-improve)"}
        </button>
        {iterations > 0 && <span style={{ ...muted, fontSize: 12 }}>Refined ×{iterations}</span>}
        {plan && onExport && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button type="button" onClick={() => onExport("docx")} disabled={busy}>Export .docx</button>
            <button type="button" onClick={() => onExport("pdf")} disabled={busy}>Export .pdf</button>
          </span>
        )}
      </div>
      {plan?.domain && (
        <div style={{ fontSize: 13, margin: "8px 0 4px" }}>
          <span style={muted}>Domain detected:</span> <b>{plan.domain}</b>
        </div>
      )}
      {plan?.note && (
        <CitedText text={plan.note} papers={papers} style={{ ...muted, fontSize: 13, margin: "4px 0 8px", display: "block" }} />
      )}
      {critique?.note && (
        <div style={{ ...muted, fontSize: 13, margin: "4px 0 8px", fontStyle: "italic" }}>
          Critic: <CitedText text={critique.note} papers={papers} />
        </div>
      )}
      {plan && kgBridges.length > 0 && <KgBridgePanel bridges={kgBridges} papers={papers} />}

      {(plan?.hypotheses || []).some((_, i) => critiqueByIndex[i]) && <ScoreLegend />}

      {(plan?.hypotheses || []).map((h, i) => (
        <HypothesisCard
          key={i}
          h={h}
          i={i}
          papers={papers}
          extractions={extractions}
          critique={critiqueByIndex[i]}
          debate={debate[i] || []}
          busy={busy}
          onUpdate={onUpdate ? (edits) => onUpdate(i, edits) : null}
          onDispute={onDispute ? (argument) => onDispute(i, argument) : null}
          onAcceptRevision={onAcceptRevision ? (proposed) => onAcceptRevision(i, proposed) : null}
        />
      ))}

      {plan && (plan.hypotheses || []).length === 0 && !busy && (
        <div style={muted}>No experiment plan for this run yet.</div>
      )}
    </div>
  );
}

// ---- help tip: what used to be an always-visible intro paragraph, now a --
// "?" icon next to the title — hover (mouse) or click/tap (touch) to reveal.
// Click also pins it open so it doesn't vanish while reading; clicking
// anywhere else, or pressing Escape, closes it.
function HelpTip({ label, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className="help-tip" ref={ref}>
      <button
        type="button"
        className="help-tip-btn"
        aria-label={label || "More info"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      <span className={"help-tip-pop" + (open ? " open" : "")} role="tooltip">
        {children}
      </span>
    </span>
  );
}

// ---- citation links: "[1,3,9]" / "paper 38" -> clickable paper links -----
// The designer/critic write free-text prose with inline citations like
// "papers [1,13,27,49] identify..." or "(paper 38)". Both forms reference a
// paper's `idx` — the same numbering used everywhere else in this panel
// (Evidence trail, Candidate approaches) — so both are turned into links
// that open that paper's URL in a new tab. A number with no matching paper,
// or a matching paper with no URL, degrades to plain text (or a title-only
// hover) rather than a dead link.
//
// `idx` is the paper's raw internal index (0-based — the first paper added
// to a run is idx 0), which is what every citation in this file has always
// looked up a paper BY. Left as the raw number, that reads as "paper 0" to
// a human, which is confusing (nothing else a person reads is 0-indexed) —
// so `citeNum`, an optional {idx: displayNumber} map, lets a caller show a
// friendlier number without touching how the citation is looked up. Pass
// one built the same way App.jsx's own `citeNum` already is for the Review
// tab (1-based, by position: `citeNum[p.idx] = i + 1`) to get "paper 1" for
// the first paper instead of "paper 0". Omitting it keeps every existing
// call site's exact current behavior — this is purely additive.
export function CiteLink({ idx, papers, label, citeNum }) {
  const p = papers.find((pp) => pp.idx === idx);
  const shown = citeNum && citeNum[idx] != null ? citeNum[idx] : label;
  if (!p) return <>{shown}</>;
  if (!p.url) return <span title={p.title}>{shown}</span>;
  return (
    <a
      href={p.url}
      target="_blank"
      rel="noreferrer"
      title={p.title}
      style={{ color: "var(--accent,#6c5ce7)" }}
    >
      {shown}
    </a>
  );
}

// Matches "[1,13,27]", "(paper 38)"/"paper 38", and now also the plural,
// non-bracket phrasing a model sometimes writes instead of a clean bracket
// list — "papers 0 and 1", "papers 0, 1", "papers 0/1" — which used to fall
// through this regex entirely and render as bare, unlinked digits with no
// visual distinction from ordinary prose (worse than the bracket case,
// since at least "[0]" LOOKS like a citation even when it's confusingly
// 0-indexed).
const CITATION_RE = /\[(\d+(?:\s*,\s*\d+)*)\]|\b([Pp]apers?)\s+(\d+(?:\s*(?:,|\/|and)\s*\d+)*)\b/g;

function splitNums(raw) {
  return raw.split(/\s*(?:,|\/|and)\s*/i).map((s) => s.trim()).filter(Boolean);
}

export function CitedText({ text, papers = [], style, citeNum }) {
  if (!text) return null;
  const nodes = [];
  let last = 0, m, key = 0;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] != null) {
      nodes.push("[");
      splitNums(m[1]).forEach((num, j) => {
        if (j > 0) nodes.push(",");
        nodes.push(<CiteLink key={`c${key++}`} idx={Number(num)} papers={papers} label={num} citeNum={citeNum} />);
      });
      nodes.push("]");
    } else {
      nodes.push(`${m[2]} `);
      splitNums(m[3]).forEach((num, j) => {
        if (j > 0) nodes.push(", ");
        nodes.push(<CiteLink key={`c${key++}`} idx={Number(num)} papers={papers} label={num} citeNum={citeNum} />);
      });
    }
    last = CITATION_RE.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <span style={style}>{nodes}</span>;
}

// ---- knowledge-graph bridge candidates: the "why" behind grounded novelty --
// See backend pipeline/knowledge_graph.find_bridge_candidates: concept pairs
// that never co-occur in any paper in THIS corpus, but each connects to a
// shared concept through different papers — a structural gap the literature
// itself never states, distinct from a gap the synthesizer wrote in prose.
// Shown collapsed by default (it's the "how did it think of this" layer, not
// the headline), and only when the designer actually had bridges to work
// with — an empty corpus produces none, and that's not worth a callout.
export function KgBridgePanel({ bridges, papers }) {
  const [open, setOpen] = useState(false);
  const muted = { color: "var(--muted, #667)" };

  return (
    <div style={{
      margin: "0 0 14px", padding: "10px 12px", borderRadius: 10,
      border: "1px solid var(--border,#e5e7eb)", background: "var(--chip,#f1f0fb)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
          }}
        >
          <span aria-hidden="true">🔗</span>
          Knowledge-graph angle: {bridges.length} unconnected concept pair{bridges.length === 1 ? "" : "s"} found
          <span aria-hidden="true" style={{ fontSize: 11 }}>{open ? "▲" : "▼"}</span>
        </button>
        <HelpTip label="What this is">
          These concept pairs never appear together in any single paper among your
          sources, but each one separately connects to a shared concept through
          different papers — a gap in the literature's actual structure, not just a
          sentence the synthesizer wrote. When a pair genuinely fits the topic, the
          designer builds a hypothesis around it and names the bridging concept in
          that hypothesis's rationale, instead of relying only on a text-derived gap.
        </HelpTip>
      </div>
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {bridges.map((b, i) => (
            <div key={i} style={{ fontSize: 13 }}>
              <b>{b.a}</b>{" "}
              <span style={muted}>
                [{b.a_papers.map((p, j) => (
                  <React.Fragment key={p}>
                    {j > 0 && ","}
                    <CiteLink idx={p} papers={papers} label={p} />
                  </React.Fragment>
                ))}]
              </span>
              {" ↔ "}
              <b>{b.c}</b>{" "}
              <span style={muted}>
                [{b.c_papers.map((p, j) => (
                  <React.Fragment key={p}>
                    {j > 0 && ","}
                    <CiteLink idx={p} papers={papers} label={p} />
                  </React.Fragment>
                ))}]
              </span>
              <div style={muted}>bridged via {b.bridges.join(", ")}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- score visualization -------------------------------------------------
// Status is a quality GATE (pass/needs-work/fail), not an arbitrary category,
// so it uses the reserved status palette rather than a categorical hue — and
// per that palette's contrast rules, color never carries the meaning alone:
// every bar pairs an icon + text label with the fill.
const STATUS = {
  good: { color: "#0ca30c", icon: "●", label: "good" },
  warning: { color: "#fab219", icon: "▲", label: "needs work" },
  critical: { color: "#d03b3b", icon: "✕", label: "weak" },
};
function statusFor(score) {
  if (score == null) return null;
  if (score >= 75) return STATUS.good;
  if (score >= 50) return STATUS.warning;
  return STATUS.critical;
}

export function ScoreLegend() {
  const muted = { color: "var(--muted, #667)" };
  return (
    <div style={{ ...muted, fontSize: 12, margin: "0 0 12px" }}>
      Critic scores:
      {Object.values(STATUS).map((s) => (
        <span key={s.label} style={{ marginLeft: 10 }}>
          <span aria-hidden="true" style={{ color: s.color, marginRight: 3 }}>{s.icon}</span>
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function ScoreBars({ critique, papers = [] }) {
  const muted = { color: "var(--muted, #667)" };
  if (!critique) return null;
  const rows = [
    ["novelty", critique.scores?.novelty],
    ["grounding", critique.scores?.grounding],
    ["testability", critique.scores?.testability],
    ["consistency", critique.scores?.consistency],
  ].filter(([, v]) => v != null);
  if (rows.length === 0) return null;

  return (
    <div style={{ margin: "8px 0 12px", maxWidth: 420 }}>
      {rows.map(([label, value]) => {
        const s = statusFor(value);
        return (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ ...muted, fontSize: 12, width: 82, flexShrink: 0 }}>
              <span aria-hidden="true" style={{ color: s.color, marginRight: 4 }}>{s.icon}</span>
              {label}
            </span>
            {/* bar: ≤24px thick (here 8px), 4px rounded ends, single baseline */}
            <div style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--border,#e5e7eb)", overflow: "hidden" }}>
              <div style={{ width: `${value}%`, height: "100%", borderRadius: 4, background: s.color }} />
            </div>
            <span style={{ fontSize: 12, width: 22, textAlign: "right", fontWeight: 600 }}>{value}</span>
          </div>
        );
      })}
      {critique.overall != null && (
        <div style={{ fontSize: 12, marginTop: 2 }}>
          <b>Overall {critique.overall}</b>
          {statusFor(critique.overall) && <> — {statusFor(critique.overall).label}</>}
        </div>
      )}
      {(critique.issues || []).length > 0 && (
        <div style={{ ...muted, fontSize: 13, marginTop: 6 }}>
          {critique.issues.map((issue, j) => (
            <React.Fragment key={j}>
              {j > 0 && " · "}
              <CitedText text={issue} papers={papers} />
            </React.Fragment>
          ))}
        </div>
      )}
      {critique.revise && (
        <div style={{ fontSize: 13, marginTop: 2, fontStyle: "italic" }}>
          Next revision: <CitedText text={critique.revise} papers={papers} />
        </div>
      )}
    </div>
  );
}

// ---- evidence trail: which cited paper backs which claim ------------------
function EvidenceTrail({ h, papers, extractions }) {
  const muted = { color: "var(--muted, #667)" };
  const titleFor = (idx) => papers.find((p) => p.idx === idx)?.title;
  const findingFor = (idx) => extractions.find((e) => e.idx === idx)?.finding;

  const items = [
    ...(h.approaches || []).map((a) => ({ ...a, role: "approach" })),
    ...(h.baselines || []).map((b) => ({ ...b, role: "baseline" })),
  ].filter((it) => it.from_idx != null);
  const proposed = (h.approaches || []).filter((a) => a.from_idx == null || a.evidenced === false);

  if (items.length === 0 && proposed.length === 0) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
        Evidence trail — what this is grounded in
      </div>
      {items.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, marginBottom: proposed.length ? 8 : 0 }}>
          <thead>
            <tr style={{ ...muted, textAlign: "left" }}>
              <th style={th}>{h.approaches?.length ? "Approach / baseline" : "Baseline"}</th>
              <th style={th}>Source paper</th>
              <th style={th}>What it found</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, j) => (
              <tr key={j}>
                <td style={td}>
                  {it.name} [<CiteLink idx={it.from_idx} papers={papers} label={it.from_idx} />]
                </td>
                <td style={{ ...td, maxWidth: 240 }}>{titleFor(it.from_idx) || "—"}</td>
                <td style={{ ...td, ...muted }}>{findingFor(it.from_idx) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {proposed.length > 0 && (
        <div style={{ ...muted, fontSize: 13, fontStyle: "italic" }}>
          Not traced to a source (the agent's own proposal): {proposed.map((a) => a.name).join(", ")}
        </div>
      )}
    </div>
  );
}

// ---- variables diagram: independent -> setup -> dependent, controlled aside --
// Replaces a plain "independent: X · dependent: Y · controlled: Z" text line
// with the actual causal shape of the experiment — worth a diagram because
// this is the one thing in the card that IS a flow (an intervention between
// two variables), not just a list of facts a table already handles fine.
function VariablesDiagram({ variables, setup }) {
  const muted = { color: "var(--muted, #667)" };
  const boxLabel = { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--muted,#667)", marginBottom: 3 };
  const box = (bg) => ({
    flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 10,
    border: "1px solid var(--border,#e5e7eb)", background: bg, fontSize: 13, lineHeight: 1.4,
  });
  const arrow = { flexShrink: 0, fontSize: 18, color: "var(--muted,#667)", alignSelf: "center" };

  return (
    <div style={{ margin: "4px 0 14px" }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 8, flexWrap: "wrap" }}>
        <div style={box("var(--chip,#f1f0fb)")}>
          <div style={boxLabel}>Independent</div>
          {variables.independent || "—"}
        </div>
        <span aria-hidden="true" style={arrow}>→</span>
        <div style={box("var(--surface-2,#fff)")}>
          <div style={boxLabel}>Intervention / setup</div>
          {setup || "—"}
        </div>
        <span aria-hidden="true" style={arrow}>→</span>
        <div style={box("var(--chip,#f1f0fb)")}>
          <div style={boxLabel}>Dependent</div>
          {variables.dependent || "—"}
        </div>
      </div>
      {variables.controlled && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <span style={muted}>held constant:</span> {variables.controlled}
        </div>
      )}
    </div>
  );
}

// ---- the card itself: view, edit, and dispute ------------------------------
function HypothesisCard({ h, i, papers, extractions, critique, debate, busy, onUpdate, onDispute, onAcceptRevision }) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [argument, setArgument] = useState("");
  const muted = { color: "var(--muted, #667)" };

  const titleFor = (idx) => (idx == null ? null : (papers.find((p) => p.idx === idx)?.title || `[${idx}]`));
  const cite = (idx, evidenced) => {
    if (idx == null) return <span style={{ ...muted, fontStyle: "italic" }}>proposed</span>;
    const p = papers.find((pp) => pp.idx === idx);
    const color = evidenced === false ? "var(--muted,#667)" : "var(--accent,#6c5ce7)";
    if (!p?.url) return <span title={titleFor(idx)} style={{ color }}>[{idx}]</span>;
    return (
      <a href={p.url} target="_blank" rel="noreferrer" title={p.title} style={{ color }}>
        [{idx}]
      </a>
    );
  };

  const pill = {
    display: "inline-block", fontSize: 13, padding: "3px 10px", marginRight: 6,
    marginBottom: 6, borderRadius: 999, background: "var(--chip,#f1f0fb)",
    border: "1px solid var(--border,#e5e7eb)",
  };
  const inputStyle = {
    width: "100%", fontSize: 13, padding: "4px 6px", marginBottom: 6,
    border: "1px solid var(--border,#e5e7eb)", borderRadius: 6, boxSizing: "border-box",
  };

  function startEdit() {
    setDraft({
      hypothesis: h.hypothesis || "", rationale: h.rationale || "", setup: h.setup || "",
      variables: { ...(h.variables || {}) }, risks: h.risks || "",
      metrics: (h.metrics || []).map((m) => ({ ...m })),
    });
    setEditing(true);
  }
  function saveEdit() {
    onUpdate?.(draft);
    setEditing(false);
  }

  async function submitDispute() {
    if (!argument.trim()) return;
    const text = argument;
    setArgument("");
    await onDispute?.(text);
  }

  return (
    <div style={{ border: "1px solid var(--border,#e5e7eb)", borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        {editing ? (
          <textarea
            style={{ ...inputStyle, fontWeight: 700 }}
            rows={2}
            value={draft.hypothesis}
            onChange={(e) => setDraft({ ...draft, hypothesis: e.target.value })}
          />
        ) : (
          <div style={{ fontWeight: 700, marginBottom: 2 }}>
            H{i + 1}. <CitedText text={h.hypothesis} papers={papers} />
          </div>
        )}
        {onUpdate && !editing && (
          <button type="button" onClick={startEdit} style={{ fontSize: 12, flexShrink: 0 }}>Edit</button>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            style={inputStyle} rows={2} placeholder="Rationale"
            value={draft.rationale} onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
          />
          <textarea
            style={inputStyle} rows={2} placeholder="Setup"
            value={draft.setup} onChange={(e) => setDraft({ ...draft, setup: e.target.value })}
          />
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {["independent", "dependent", "controlled"].map((k) => (
              <input
                key={k} style={inputStyle} placeholder={k} value={draft.variables[k] || ""}
                onChange={(e) => setDraft({ ...draft, variables: { ...draft.variables, [k]: e.target.value } })}
              />
            ))}
          </div>
          {draft.metrics.map((m, j) => (
            <div key={j} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <span style={{ ...muted, fontSize: 13, minWidth: 100 }}>{m.name}</span>
              <input
                style={{ ...inputStyle, marginBottom: 0 }} placeholder="target" value={m.target || ""}
                onChange={(e) => {
                  const metrics = [...draft.metrics];
                  metrics[j] = { ...m, target: e.target.value };
                  setDraft({ ...draft, metrics });
                }}
              />
            </div>
          ))}
          <textarea
            style={inputStyle} rows={2} placeholder="Risks"
            value={draft.risks} onChange={(e) => setDraft({ ...draft, risks: e.target.value })}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={saveEdit}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          {h.rationale && (
            <CitedText text={h.rationale} papers={papers} style={{ ...muted, fontSize: 13, marginBottom: 4, display: "block" }} />
          )}
          <ScoreBars critique={critique} papers={papers} />

          {(h.approaches || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Candidate approaches</div>
              {h.approaches.map((a, j) => (
                <span key={j} style={pill}>{a.name} {cite(a.from_idx, a.evidenced)}</span>
              ))}
            </div>
          )}

          {(h.metrics || []).length > 0 && (
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14, marginBottom: 6 }}>
              <thead>
                <tr style={{ ...muted, textAlign: "left" }}>
                  <th style={th}>Metric</th><th style={th}>Unit / scale</th><th style={th}>Target</th>
                </tr>
              </thead>
              <tbody>
                {h.metrics.map((m, j) => (
                  <tr key={j}>
                    <td style={td}>{m.name}</td>
                    <td style={{ ...td, ...muted }}>{m.unit || "—"}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{m.target || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <button
            type="button" onClick={() => setOpen((o) => !o)}
            style={{ background: "none", border: "none", color: "var(--accent,#6c5ce7)", cursor: "pointer", padding: 0, fontSize: 13, marginTop: 4 }}
          >
            {open ? "Hide evidence, variables & validation ▲" : "Show evidence, variables & validation ▼"}
          </button>

          {open && (
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border,#e5e7eb)", paddingTop: 12 }}>
              <EvidenceTrail h={h} papers={papers} extractions={extractions} />
              {h.variables ? (
                <VariablesDiagram variables={h.variables} setup={h.setup} />
              ) : (
                h.setup && <Field label="Setup">{h.setup}</Field>
              )}
              {(h.baselines || []).length > 0 && (
                <Field label="Baselines">
                  {h.baselines.map((b, j) => (
                    <span key={j} style={{ marginRight: 10 }}>{b.name} {cite(b.from_idx, true)}</span>
                  ))}
                </Field>
              )}
              {(h.failure_modes || []).length > 0 && (
                <Field label="What could invalidate it">
                  {h.failure_modes.map((fm, j) => (
                    <React.Fragment key={j}>
                      {j > 0 && "; "}
                      <CitedText text={fm} papers={papers} />
                    </React.Fragment>
                  ))}
                </Field>
              )}
              {h.validation && (
                <Field label="Validation"><CitedText text={h.validation} papers={papers} /></Field>
              )}
              {h.risks && (
                <Field label="Risks / ethics"><CitedText text={h.risks} papers={papers} /></Field>
              )}
            </div>
          )}

          {onDispute && (
            <div style={{ marginTop: 12, borderTop: "1px solid var(--border,#e5e7eb)", paddingTop: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Argue with this hypothesis</div>
              {debate.map((d, j) => {
                const applied = d.proposed && d.proposed.hypothesis === h.hypothesis;
                return (
                  <div key={j} style={{ fontSize: 13, marginBottom: 8 }}>
                    <div style={muted}>You: <CitedText text={d.argument} papers={papers} /></div>
                    <div>
                      <span style={{
                        display: "inline-block", fontSize: 11, padding: "1px 6px", borderRadius: 999,
                        marginRight: 6, border: "1px solid var(--border,#e5e7eb)",
                        color: d.stance === "revised" ? "var(--accent,#6c5ce7)" : "var(--muted,#667)",
                      }}>
                        {d.stance === "revised" ? "revised" : "defended"}
                      </span>
                      <CitedText text={d.response} papers={papers} />
                    </div>
                    {d.proposed && !applied && (
                      <div style={{ marginTop: 4, padding: 8, background: "var(--chip,#f1f0fb)", borderRadius: 8 }}>
                        <div style={muted}>Proposed: <CitedText text={d.proposed.hypothesis} papers={papers} /></div>
                        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                          <button type="button" onClick={() => onAcceptRevision?.(d.proposed)} disabled={busy}>
                            Agree — apply this
                          </button>
                          <span style={muted}>or keep the current wording above</span>
                        </div>
                      </div>
                    )}
                    {applied && <div style={{ ...muted, fontStyle: "italic", marginTop: 2 }}>Applied ✓</div>}
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
                  placeholder={'e.g. "the metric target seems arbitrary — where does 15% come from?"'}
                  value={argument}
                  onChange={(e) => setArgument(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitDispute()}
                  disabled={busy}
                />
                <button type="button" onClick={submitDispute} disabled={busy || !argument.trim()}>
                  {busy ? "Working…" : "Challenge"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const th = { padding: "6px 10px", borderBottom: "1px solid var(--border,#e5e7eb)", fontWeight: 600 };
const td = { padding: "6px 10px", borderBottom: "1px solid var(--border,#f0f0f4)", verticalAlign: "top" };

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 8, fontSize: 14, lineHeight: 1.5 }}>
      <span style={{ fontWeight: 600, marginRight: 6 }}>{label}:</span>
      {children}
    </div>
  );
}

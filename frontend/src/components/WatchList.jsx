import React, { useState, useEffect, useRef } from "react";
import { api } from "../api/client.js";

/**
 * "Scholars to watch / Laboratories to watch" on Home: researchers and labs
 * the user follows, with their newest papers (backend core/watch.py, from
 * OpenAlex). Papers that appeared since the user last marked them seen carry
 * a "New" tag; the Home banner counts them.
 */
export const shortOpenAlexId = (v) => ((v || "").match(/([AI]\d{4,})\s*$/i)?.[1] || "").toUpperCase();

// Settings and Home are separate screens: tell Home to reload when follows change.
export const WATCH_CHANGED = "sift-watch-changed";
const announce = () => window.dispatchEvent(new Event(WATCH_CHANGED));

const fmtDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

export function FollowButton({ watch, kind, openalex, name, subtitle, keywords, scope, onChanged }) {
  const oid = shortOpenAlexId(openalex);
  const [busy, setBusy] = useState(false);
  if (!oid) return null;
  const existing = (watch?.follows || []).find((f) => f.kind === kind && f.openalex_id === oid);
  return (
    <button
      type="button"
      className={"wl-follow" + (existing ? " on" : "")}
      disabled={busy}
      title={existing ? "Stop watching" : kind === "lab"
        ? `Watch this laboratory's new papers${scope ? ` in ${scope}` : ""}` : "Watch this researcher's new papers"}
      onClick={async () => {
        setBusy(true);
        try {
          if (existing) await api.unfollow(existing.id);
          else await api.follow({ kind, openalex_id: oid, name, subtitle: subtitle || "", keywords: keywords || [], scope: scope || "" });
          announce();
          await onChanged?.();
        } catch (e) {
          alert(e.message);
        } finally { setBusy(false); }
      }}
    >
      {busy ? "…" : existing ? "Following ✓" : "+ Follow"}
    </button>
  );
}

function FollowSearch({ watch, onChanged, onClose, onBuildLab }) {
  const [kind, setKind] = useState("scholar");
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, [kind]);

  const isUrl = (t) => /^https?:\/\//i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t);

  async function run(e) {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    if (kind === "lab" && onBuildLab && isUrl(q.trim())) {
      setBusy(true); setErr(null); setResults(null);
      try {
        const found = await api.labFromUrl(q.trim());
        onBuildLab(found.name || "", found);
      } catch (e2) { setErr(e2.message); }
      finally { setBusy(false); }
      return;
    }
    setBusy(true); setErr(null);
    try { setResults((await api.watchSearch(kind, q.trim())).results || []); }
    catch (e2) { setErr(e2.message); setResults(null); }
    finally { setBusy(false); }
  }

  return (
    <div className="wl-search">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div className="hp-seg" role="tablist" aria-label="What to follow">
          {[["scholar", "Researcher"], ["lab", "Laboratory / institute"]].map(([k, lab]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""}
              onClick={() => { setKind(k); setResults(null); }}>{lab}</button>
          ))}
        </div>
        {onClose && <button type="button" className="hp-ghost" style={{ marginLeft: "auto" }} onClick={onClose}>Close</button>}
      </div>
      <form onSubmit={run} className="wl-search-row">
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={kind === "scholar" ? "Researcher's name, e.g. Fei-Fei Li" : "Institute name, or paste a lab's website (e.g. labs.utdallas.edu/revt)"} />
        <button type="submit" disabled={busy || q.trim().length < 2}>
          {busy ? (kind === "lab" && isUrl(q.trim()) ? "Reading the site…" : "Searching…") : (kind === "lab" && isUrl(q.trim()) ? "Read website" : "Search")}
        </button>
      </form>
      {err && <div className="wl-err">{err}</div>}
      {results && results.length === 0 && <div className="hp-muted" style={{ marginTop: 8 }}>No matches in OpenAlex — check the spelling, or try the name as it appears on their papers.</div>}
      {results && results.length > 1 && kind === "scholar" && (
        <div className="hp-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          Several people can share a name — check the institution and topics. The most-cited match is listed first.
        </div>
      )}
      {results && results.length > 0 && (
        <div className="wl-results">
          {results.map((r) => (
            <div key={r.openalex_id} className="wl-result">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="hp-who-name">{r.name}</div>
                <div className="hp-person-inst">
                  {[r.subtitle, `${(r.works_count || 0).toLocaleString()} works`,
                    `${(r.cited_by_count || 0).toLocaleString()} citations`].filter(Boolean).join(" · ")}
                </div>
              </div>
              <FollowButton watch={watch} kind={kind} openalex={r.openalex_id} name={r.name} subtitle={r.subtitle}
                onChanged={onChanged} />
            </div>
          ))}
        </div>
      )}
      {kind === "lab" && onBuildLab && (
        <div className="wl-build-cta">
          <div style={{ minWidth: 0, flex: 1 }}>
            <b>Can't find the lab?</b> Most research groups (e.g. a university lab like REVT at UT Dallas) aren't
            listed as institutions. Paste the lab's website above and Sift reads its name, university and team, or set it
            up by hand: a lab's papers are its members' papers.
          </div>
          <button type="button" className="wl-follow" onClick={() => onBuildLab(q.trim())}>Set up a lab →</button>
        </div>
      )}
      {kind === "lab" && (
        <div className="hp-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          Search results here are OpenAlex institutions (universities and large institutes). Following a whole
          university brings in all of its papers.
        </div>
      )}
    </div>
  );
}

function FollowCard({ f, onChanged }) {
  const [open, setOpen] = useState(false);
  const works = f.works || [];
  const shown = open ? works : works.slice(0, 3);
  return (
    <div className="wl-card">
      <div className="wl-card-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="wl-name">
            {f.name}
            {f.new_count > 0 && <span className="wl-new-pill">{f.new_count} new</span>}
          </div>
          <div className="hp-person-inst">
            {[f.subtitle, f.kind === "lab" && f.scope ? `in ${f.scope}` : ""].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="wl-card-actions">
          {f.new_count > 0 && (
            <button type="button" className="wl-link" onClick={async () => { await api.watchSeen(f.id); onChanged(); }}>
              Mark seen
            </button>
          )}
          {f.kind === "group"
            ? (f.website && <a className="wl-link" href={f.website} target="_blank" rel="noopener noreferrer">Website</a>)
            : <a className="wl-link" href={`https://openalex.org/${f.openalex_id}`} target="_blank" rel="noopener noreferrer">Profile</a>}
        </div>
      </div>
      {f.error && works.length === 0 && <div className="hp-muted" style={{ fontSize: 12 }}>{f.error}</div>}
      {!f.error && works.length === 0 && <div className="hp-muted" style={{ fontSize: 12 }}>No papers in the last six months.</div>}
      {shown.map((w) => (
        <a key={w.id} className={"hp-paper wl-paper" + (w.new ? " is-new" : "")} href={w.url} target="_blank" rel="noopener noreferrer">
          <span className="hp-paper-title">{w.new && <span className="wl-new">New</span>}{w.title}</span>
          <span className="hp-paper-meta">
            {[(w.authors || []).join(", ") + (w.more_authors ? ` +${w.more_authors}` : ""), w.venue, fmtDate(w.date)].filter(Boolean).join(" · ")}
          </span>
        </a>
      ))}
      {works.length > 3 && (
        <button type="button" className="wl-link" style={{ marginTop: 6 }} onClick={() => setOpen((v) => !v)}>
          {open ? "Show fewer" : `Show all ${works.length}`}
        </button>
      )}
    </div>
  );
}

export default function WatchList({ watch, onChanged, sectionRef, onManage }) {
  const follows = watch?.follows || [];
  if (watch && follows.length === 0) {
    return (
      <section className="hp-frontier" ref={sectionRef} aria-label="Scholars and laboratories you watch">
        <style>{WL_CSS}</style>
        <div className="hp-frontier-head">
          <div>
            <div className="hp-label" style={{ marginBottom: 6 }}>Watching</div>
            <h2 className="hp-h2">Follow researchers and labs to see their new papers here</h2>
          </div>
          {onManage && <button type="button" className="hp-ghost" onClick={onManage}>Choose who to follow</button>}
        </div>
        <div className="hp-muted" style={{ fontSize: 12.5 }}>
          Add them in Settings → Following. Their new papers appear here, and Home tells you when something new comes out.
        </div>
      </section>
    );
  }
  const scholars = follows.filter((f) => f.kind === "scholar");
  const labs = follows.filter((f) => f.kind === "lab" || f.kind === "group");
  const column = (title, list, empty) => (
    <div className="wl-col">
      <div className="hp-area-name" style={{ color: "var(--txt,#1c2128)" }}>{title}{list.length ? ` · ${list.length}` : ""}</div>
      {list.length === 0 ? <div className="hp-muted" style={{ fontSize: 12.5, padding: "10px 0" }}>{empty}</div>
        : list.map((f) => <FollowCard key={f.id} f={f} onChanged={onChanged} />)}
    </div>
  );
  return (
    <section className="hp-frontier" ref={sectionRef} aria-label="Scholars and laboratories you watch">
      <style>{WL_CSS}</style>
      <div className="hp-frontier-head">
        <div>
          <div className="hp-label" style={{ marginBottom: 6 }}>
            Watching{watch?.new_total > 0 && <span className="wl-new-pill" style={{ marginLeft: 8 }}>{watch.new_total} new</span>}
          </div>
          <h2 className="hp-h2">New papers from the people and labs you follow</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {watch?.new_total > 0 && (
            <button type="button" className="hp-ghost" onClick={async () => { await api.watchSeen(); onChanged(); }}>Mark all seen</button>
          )}
          {onManage && <button type="button" className="hp-ghost" onClick={onManage}>Manage</button>}
        </div>
      </div>
      {!watch ? <div className="hp-muted">Loading…</div> : (
        <div className="hp-areas" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
          {column("Scholars to watch", scholars, "No researchers yet — add them in Settings → Following.")}
          {column("Laboratories to watch", labs, "No laboratories yet — add them in Settings → Following.")}
        </div>
      )}
      <div className="hp-muted" style={{ fontSize: 11.5, marginTop: 14, lineHeight: 1.6, maxWidth: 860 }}>
        Papers from the last six months, from OpenAlex, checked every few hours. <b>New</b> marks a paper that
        appeared after you followed or last marked them seen.
      </div>
    </section>
  );
}

/**
 * Set up (or edit) a lab that isn't an OpenAlex institution, from its members.
 * Pick the host university, then either let Sift suggest people there who
 * publish on the lab's topic, or add members by name.
 */
function LabBuilder({ initial, onSaved, onCancel }) {
  const editing = !!initial?.id;
  const [name, setName] = useState(initial?.name || "");
  const [website, setWebsite] = useState(initial?.website || "");
  const [inst, setInst] = useState(initial?.institution?.openalex_id ? initial.institution : null);
  const [instQ, setInstQ] = useState("");
  const [instRes, setInstRes] = useState(null);
  const [members, setMembers] = useState(initial?.members || []);
  const [sugg, setSugg] = useState(null);
  const [personQ, setPersonQ] = useState("");
  const [personRes, setPersonRes] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState(null);

  const has = (id) => members.some((m) => m.openalex_id === id);
  const toggle = (p) => setMembers((ms) => (ms.some((m) => m.openalex_id === p.openalex_id)
    ? ms.filter((m) => m.openalex_id !== p.openalex_id) : [...ms, { openalex_id: p.openalex_id, name: p.name }]));
  const go = async (what, fn) => {
    setBusy(what); setErr(null);
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };

  return (
    <div className="wl-builder">
      <div className="wl-set-h" style={{ marginBottom: 10 }}>{editing ? "Edit lab" : "Set up a lab from its members"}</div>
      {initial?.fromSite && (
        <div className="wl-site-note">
          Read from <a href={initial.website} target="_blank" rel="noopener noreferrer">{initial.website.replace(/^https?:\/\//, "")}</a>
          {initial.team_page && <> and its <a href={initial.team_page} target="_blank" rel="noopener noreferrer">team page</a></>}.{" "}
          {!initial.institution && "Couldn't confirm the university — choose it below. "}
          {initial.names_found > 0
            ? <>Found {initial.names_found} name{initial.names_found === 1 ? "" : "s"}; {initial.members.length} matched a researcher in OpenAlex
                {initial.institution ? ` at ${initial.institution.name}` : ""} and {initial.members.length === 1 ? "is" : "are"} added below — check them.</>
            : "No member names could be read from the site (some sites load them with scripts) — use Suggest people, or add them by name."}
          {initial.unmatched?.length > 0 && (
            <div style={{ marginTop: 4 }}>Not found in OpenAlex (often students without papers yet): {initial.unmatched.join(", ")}.</div>
          )}
        </div>
      )}
      <div className="wl-grid2">
        <label><span>Lab name</span>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Renewable Energy and Vehicular Technology Lab" /></label>
        <label><span>Website (optional)</span>
          <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="labs.utdallas.edu/revt" /></label>
      </div>

      <div className="wl-step">
        <span className="wl-step-n">1</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wl-step-t">University or institute it belongs to</div>
          {inst ? (
            <div className="wl-chosen">{inst.name}
              <button type="button" className="wl-x" title="Change" onClick={() => { setInst(null); setSugg(null); }}>×</button>
            </div>
          ) : (
            <>
              <form className="wl-search-row" style={{ marginTop: 6 }}
                onSubmit={(e) => { e.preventDefault(); if (instQ.trim().length >= 2) go("inst", async () => setInstRes((await api.watchSearch("lab", instQ.trim())).results || [])); }}>
                <input value={instQ} onChange={(e) => setInstQ(e.target.value)} placeholder="e.g. University of Texas at Dallas" />
                <button type="submit" disabled={busy === "inst" || instQ.trim().length < 2}>{busy === "inst" ? "…" : "Find"}</button>
              </form>
              {instRes && instRes.length === 0 && <div className="hp-muted" style={{ fontSize: 12, marginTop: 6 }}>No match — try the full name (not the acronym).</div>}
              {(instRes || []).map((r) => (
                <div key={r.openalex_id} className="wl-result">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="hp-who-name">{r.name}</div>
                    <div className="hp-person-inst">{r.subtitle}</div>
                  </div>
                  <button type="button" className="wl-follow" onClick={() => { setInst({ openalex_id: r.openalex_id, name: r.name }); setInstRes(null); }}>Choose</button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="wl-step">
        <span className="wl-step-n">2</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wl-step-t">Members{members.length ? ` · ${members.length} chosen` : ""}</div>
          {members.length > 0 && (
            <div className="wl-chips">
              {members.map((m) => (
                <span key={m.openalex_id} className="wl-chip">{m.name}
                  <button type="button" onClick={() => toggle(m)} aria-label={`Remove ${m.name}`}>×</button></span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <button type="button" className="hp-ghost" disabled={!inst || !name.trim() || busy === "sugg"}
              title={!inst ? "Choose the university first" : ""}
              onClick={() => go("sugg", async () => setSugg((await api.suggestLabMembers(inst.openalex_id, name)).results || []))}>
              {busy === "sugg" ? "Looking…" : `Suggest people${inst ? ` at ${inst.name}` : ""} publishing on this`}
            </button>
          </div>
          {sugg && sugg.length === 0 && (
            <div className="hp-muted" style={{ fontSize: 12, marginTop: 6 }}>
              No one found for that name — spell out the lab's full name, or add members by name below.
            </div>
          )}
          {sugg && sugg.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="hp-muted" style={{ fontSize: 11.5 }}>Tick the people who are in the lab (check its Team page).</div>
              {sugg.map((p) => (
                <label key={p.openalex_id} className="wl-result" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={has(p.openalex_id)} onChange={() => toggle(p)} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="hp-who-name">{p.name}</div>
                    <div className="hp-person-inst">{p.papers} matching paper{p.papers === 1 ? "" : "s"}{p.example ? ` · e.g. ${p.example}` : ""}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
          <form className="wl-search-row" style={{ marginTop: 8 }}
            onSubmit={(e) => { e.preventDefault(); if (personQ.trim().length >= 2) go("person", async () => setPersonRes((await api.watchSearch("scholar", personQ.trim(), inst?.openalex_id)).results || [])); }}>
            <input value={personQ} onChange={(e) => setPersonQ(e.target.value)}
              placeholder={inst ? `Add a member by name (at ${inst.name})` : "Add a member by name"} />
            <button type="submit" disabled={busy === "person" || personQ.trim().length < 2}>{busy === "person" ? "…" : "Find"}</button>
          </form>
          {personRes && personRes.length === 0 && <div className="hp-muted" style={{ fontSize: 12, marginTop: 6 }}>No match{inst ? ` at ${inst.name}` : ""}.</div>}
          {(personRes || []).map((r) => (
            <div key={r.openalex_id} className="wl-result">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="hp-who-name">{r.name}</div>
                <div className="hp-person-inst">{[r.subtitle, `${(r.works_count || 0).toLocaleString()} works`].filter(Boolean).join(" · ")}</div>
              </div>
              <button type="button" className={"wl-follow" + (has(r.openalex_id) ? " on" : "")} onClick={() => toggle(r)}>
                {has(r.openalex_id) ? "Added ✓" : "+ Add"}
              </button>
            </div>
          ))}
        </div>
      </div>

      {err && <div className="wl-err">{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button type="button" className="wl-primary" disabled={busy === "save" || !name.trim() || members.length === 0}
          onClick={() => go("save", async () => {
            const body = { name: name.trim(), website, institution: inst, members };
            if (editing) await api.updateLab(initial.id, body); else await api.createLab(body);
            onSaved();
          })}>
          {busy === "save" ? "Saving…" : editing ? "Save lab" : "Follow this lab"}
        </button>
        <button type="button" className="hp-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Settings → Following: where researchers and laboratories are added and
 * removed. Search OpenAlex by name, or pick from the people and institutions
 * active in your own research areas (the "From the frontier" data).
 */
export function FollowingSettings() {
  const [watch, setWatch] = useState(null);
  const [building, setBuilding] = useState(null);   // null | {name} (new) | follow (edit)
  const [frontier, setFrontier] = useState(null);
  const load = () => api.getWatchlist(false).then(setWatch).catch(() => setWatch({ follows: [], new_total: 0 }));
  useEffect(() => {
    load();
    api.getFrontier(false).then(setFrontier).catch(() => setFrontier({ areas: [] }));
  }, []);
  const follows = watch?.follows || [];
  const group = (kind, title) => {
    const list = follows.filter((f) => f.kind === kind || (kind === "lab" && f.kind === "group"));
    return (
      <div style={{ marginTop: 18 }}>
        <div className="wl-set-h">{title}{list.length ? ` · ${list.length}` : ""}</div>
        {list.length === 0 && <div className="hp-muted" style={{ fontSize: 12.5, padding: "6px 0" }}>None yet.</div>}
        {list.map((f) => (
          <div key={f.id} className="wl-result">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="hp-who-name">{f.name}</div>
              <div className="hp-person-inst">
                {[f.subtitle, kind === "lab" && f.scope ? `only papers in ${f.scope}` : ""].filter(Boolean).join(" · ")}
              </div>
            </div>
            {f.kind === "group" ? (
              <>
                {f.website && <a className="wl-link" href={f.website} target="_blank" rel="noopener noreferrer">Website</a>}
                <button type="button" className="wl-link" onClick={() => setBuilding(f)}>Edit members</button>
              </>
            ) : <a className="wl-link" href={`https://openalex.org/${f.openalex_id}`} target="_blank" rel="noopener noreferrer">Profile</a>}
            <button type="button" className="wl-follow on" onClick={async () => { await api.unfollow(f.id); announce(); load(); }}>
              Unfollow
            </button>
          </div>
        ))}
      </div>
    );
  };
  const suggestions = (frontier?.areas || []).filter((a) => (a.people || []).length || (a.labs || []).length);
  return (
    <div className="wl-settings">
      <style>{WL_CSS}</style>
      <div className="hp-muted" style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
        Follow researchers and laboratories to see their new papers on your Home page, with a notice when
        something new comes out.
      </div>
      {building ? (
        <LabBuilder initial={building} onCancel={() => setBuilding(null)}
          onSaved={() => { setBuilding(null); announce(); load(); }} />
      ) : (
        <FollowSearch watch={watch} onChanged={load} onBuildLab={(name, found) => setBuilding(found ? { ...found, fromSite: true } : { name })} />
      )}
      {!watch ? <div className="hp-muted">Loading…</div> : (
        <>
          {group("scholar", "Scholars you follow")}
          {group("lab", "Laboratories you follow")}
        </>
      )}
      {suggestions.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div className="wl-set-h">Suggested from your research areas</div>
          <div className="hp-muted" style={{ fontSize: 11.5, margin: "2px 0 6px" }}>
            Researchers and institutions that recur as authors in recent papers on your own topics.
            Following an institution from here keeps only its papers in that area.
          </div>
          {suggestions.map((a) => (
            <div key={a.label} style={{ marginTop: 10 }}>
              <div className="hp-area-name">{a.label}</div>
              {(a.people || []).filter((p) => p.openalex).map((p) => (
                <div key={p.openalex} className="wl-result">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="hp-who-name">{p.name}</div>
                    <div className="hp-person-inst">{["Researcher", p.institution].filter(Boolean).join(" · ")}</div>
                  </div>
                  <FollowButton watch={watch} kind="scholar" openalex={p.openalex} name={p.name}
                    subtitle={p.institution || ""} onChanged={load} />
                </div>
              ))}
              {(a.labs || []).filter((l) => l.openalex).map((l) => (
                <div key={l.openalex} className="wl-result">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="hp-who-name">{l.name}</div>
                    <div className="hp-person-inst">{["Institution", l.country].filter(Boolean).join(" · ")}</div>
                  </div>
                  <FollowButton watch={watch} kind="lab" openalex={l.openalex} name={l.name}
                    subtitle={l.country || ""} keywords={a.keywords} scope={a.label} onChanged={load} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const WL_CSS = `
.wl-follow{flex-shrink:0;background:none;border:1px solid var(--indigo,#6d5df6);color:var(--indigo,#6d5df6);border-radius:999px;padding:2px 10px;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;}
.wl-follow:hover{background:var(--indigo-soft,#efedff);}
.wl-follow.on{border-color:var(--line,#e4e7ef);color:var(--muted,#5b6472);font-weight:500;}
.wl-follow:disabled{opacity:.6;cursor:default;}
.wl-search{border:1px solid var(--line,#e4e7ef);border-radius:12px;padding:14px;margin-bottom:22px;background:var(--card,#fff);}
.wl-search-row{display:flex;gap:8px;margin-top:12px;}
.wl-search-row input{flex:1;min-width:0;border:1px solid var(--line,#e4e7ef);border-radius:9px;padding:9px 12px;font-size:14px;background:transparent;color:var(--txt,#1c2128);}
.wl-search-row button{border:none;border-radius:9px;padding:9px 16px;background:var(--indigo,#6d5df6);color:#fff;font-weight:600;font-size:13px;cursor:pointer;}
.wl-search-row button:disabled{opacity:.55;cursor:default;}
.wl-results{margin-top:10px;display:flex;flex-direction:column;}
.wl-result{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--line-soft,#eef0f6);}
.wl-result:last-child{border-bottom:none;}
.wl-err{color:#c0392b;font-size:12.5px;margin-top:8px;}
.wl-col{min-width:0;}
.wl-settings{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--txt,#1c2128);}
.wl-settings .hp-muted{color:var(--muted,#5b6472);font-size:13px;}
.wl-settings .hp-seg{display:inline-flex;flex-wrap:wrap;max-width:100%;background:var(--panel2,#f1f3f9);border-radius:10px;padding:3px;}
.wl-settings .hp-seg button{border:none;background:none;padding:7px 13px;border-radius:8px;font-size:13px;font-weight:500;color:var(--muted,#5b6472);cursor:pointer;font-family:inherit;}
.wl-settings .hp-seg button.on{background:var(--panel,#fff);color:var(--txt,#1c2128);font-weight:600;box-shadow:0 1px 2px rgba(20,28,50,.1);}
.wl-settings .hp-who-name{font-size:13.5px;font-weight:500;color:var(--txt,#1c2128);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wl-settings .hp-person-inst{font-size:12px;color:var(--muted,#5b6472);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wl-settings .hp-area-name{font-size:12.5px;font-weight:600;color:var(--indigo,#6d5df6);padding:4px 0;}
.wl-settings .wl-search{border:none;padding:0;background:none;}
.wl-settings .wl-search-row input{font-family:inherit;}
.wl-settings .wl-search{margin-bottom:6px;}
.wl-site-note{font-size:12px;line-height:1.55;color:var(--muted,#5b6472);background:var(--panel2,#f1f3f9);border-radius:9px;padding:9px 11px;margin-bottom:12px;}
.wl-site-note a{color:var(--indigo,#6d5df6);}
.wl-build-cta{display:flex;align-items:center;gap:12px;margin-top:10px;padding:10px 12px;border:1px dashed var(--indigo,#6d5df6);border-radius:10px;font-size:12.5px;line-height:1.5;color:var(--muted,#5b6472);}
.wl-build-cta b{color:var(--txt,#1c2128);}
.wl-builder{border:1px solid var(--line,#e4e7ef);border-radius:12px;padding:14px;}
.wl-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
@media (max-width:640px){.wl-grid2{grid-template-columns:1fr;}}
.wl-grid2 label span{display:block;font-size:12px;font-weight:600;color:var(--muted,#5b6472);margin-bottom:4px;}
.wl-grid2 input{width:100%;box-sizing:border-box;border:1px solid var(--line,#e4e7ef);border-radius:9px;padding:9px 11px;font-size:13.5px;font-family:inherit;color:var(--txt,#1c2128);background:transparent;}
.wl-step{display:flex;gap:10px;margin-top:16px;}
.wl-step-n{width:20px;height:20px;border-radius:50%;background:var(--indigo,#6d5df6);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
.wl-step-t{font-size:13px;font-weight:600;}
.wl-chosen{display:inline-flex;align-items:center;gap:8px;margin-top:6px;padding:5px 10px;border-radius:8px;background:var(--indigo-soft,#efedff);font-size:13px;font-weight:500;}
.wl-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}
.wl-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 4px 3px 10px;border-radius:999px;background:var(--indigo-soft,#efedff);font-size:12px;font-weight:500;}
.wl-chip button{background:none;border:none;cursor:pointer;color:var(--muted,#5b6472);font-size:14px;line-height:1;padding:0 4px;}
.wl-primary{border:none;border-radius:9px;padding:9px 16px;background:var(--indigo,#6d5df6);color:#fff;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;}
.wl-primary:disabled{opacity:.5;cursor:default;}
.wl-settings .hp-ghost{display:inline-flex;align-items:center;gap:5px;background:none;border:1px solid var(--line,#e4e7ef);border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:500;color:var(--muted,#5b6472);cursor:pointer;font-family:inherit;}
.wl-settings .hp-ghost:disabled{opacity:.55;cursor:default;}
.wl-set-h{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted,#5b6472);padding-bottom:6px;border-bottom:1px solid var(--line,#e4e7ef);}
.wl-card{padding:12px 0 10px;border-bottom:1px solid var(--line,#e4e7ef);}
.wl-card:last-child{border-bottom:none;}
.wl-card-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:2px;}
.wl-name{font-size:14.5px;font-weight:600;color:var(--txt,#1c2128);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.wl-card-actions{display:flex;align-items:center;gap:10px;flex-shrink:0;}
.wl-link{background:none;border:none;padding:0;font-size:12px;font-weight:500;color:var(--indigo,#6d5df6);cursor:pointer;text-decoration:none;}
.wl-link:hover{text-decoration:underline;text-underline-offset:3px;}
.wl-x{background:none;border:none;font-size:17px;line-height:1;color:var(--muted2,#98a0af);cursor:pointer;padding:0 2px;}
.wl-x:hover{color:#c0392b;}
.wl-paper{padding:8px 0;}
.wl-paper .hp-paper-title{font-size:15px;}
.wl-new{display:inline-block;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:var(--indigo,#6d5df6);border-radius:4px;padding:2px 5px;margin-right:7px;vertical-align:2px;}
.wl-new-pill{display:inline-block;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:.06em;text-transform:none;color:var(--indigo,#6d5df6);background:var(--indigo-soft,#efedff);border-radius:999px;padding:2px 8px;font-weight:600;}
.wl-banner{display:flex;align-items:center;gap:10px;width:100%;text-align:left;margin:0 0 22px;padding:11px 14px;border:1px solid var(--indigo,#6d5df6);border-radius:12px;background:var(--indigo-soft,#efedff);color:var(--txt,#1c2128);font-size:13.5px;cursor:pointer;}
.wl-banner i{width:8px;height:8px;border-radius:50%;background:var(--indigo,#6d5df6);flex-shrink:0;}
.wl-banner b{font-weight:600;}
.wl-banner span:last-child{margin-left:auto;color:var(--indigo,#6d5df6);font-weight:600;white-space:nowrap;}
`;

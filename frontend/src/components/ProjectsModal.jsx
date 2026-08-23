import React, { useState, useEffect, useCallback } from "react";
import { api } from "../api/client.js";

/**
 * Projects — a folder for a line of research: runs filed under it, a saved
 * paper library (manual or Zotero-imported), and free-form notes.
 *
 * `onOpenRun(runId, project)` restores that run in the main app AND enters
 * the project workspace (see App.jsx's `openProject`), then closes the modal.
 * `onOpenProject(project)` enters the workspace without picking a specific
 * run — App.jsx jumps to the most recently updated one, or a blank slate.
 */
export default function ProjectsModal({ onClose, onOpenRun, onOpenProject }) {
  const [projects, setProjects] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    api.listProjects().then((d) => setProjects(d.projects || [])).catch(() => setProjects([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && (openId ? setOpenId(null) : onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, openId]);

  async function createProject(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setErr(null);
    try {
      const p = await api.createProject(newName.trim(), newDesc.trim());
      setNewName(""); setNewDesc(""); setCreating(false);
      load();
      setOpenId(p.id);
    } catch (e2) {
      setErr(e2.message || "Could not create project.");
    }
  }

  return (
    <div style={S.scrim} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={S.close} aria-label="Close">×</button>

        {openId ? (
          <ProjectDetail
            projectId={openId}
            onBack={() => { setOpenId(null); load(); }}
            onOpenRun={onOpenRun}
            onOpenProject={onOpenProject}
            onDeleted={() => { setOpenId(null); load(); }}
          />
        ) : (
          <>
            <div style={S.head}>
              <h3 style={S.h3}>Projects</h3>
              <button style={S.newBtn} onClick={() => setCreating((c) => !c)}>
                {creating ? "Cancel" : "+ New project"}
              </button>
            </div>
            <div style={S.sub}>
              Group reviews under a project — saved papers, notes and search history stay
              together until you remove them.
            </div>

            {creating && (
              <form onSubmit={createProject} style={S.card}>
                <input autoFocus style={S.input} placeholder="Project name (e.g. “CRISPR delivery methods”)"
                  value={newName} onChange={(e) => setNewName(e.target.value)} />
                <textarea style={{ ...S.input, marginTop: 8, minHeight: 54, resize: "vertical" }}
                  placeholder="Description (optional)" value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)} />
                {err && <div style={S.err}>{err}</div>}
                <button type="submit" style={{ ...S.save, marginTop: 10 }}>Create</button>
              </form>
            )}

            {projects == null ? (
              <div style={S.muted}>Loading…</div>
            ) : projects.length === 0 ? (
              <div style={S.muted}>No projects yet. Create one to start organizing your research.</div>
            ) : (
              <div style={{ marginTop: 6 }}>
                {projects.map((p) => (
                  <button key={p.id} style={S.projRow} onClick={() => setOpenId(p.id)}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={S.projName}>
                        {p.name}
                        {p.role === "collaborator" && <span style={S.roleTag}>Shared with you</span>}
                      </div>
                      {p.description && <div style={S.projDesc}>{p.description}</div>}
                    </div>
                    <div style={S.counts}>
                      <span>{p.run_count} run{p.run_count === 1 ? "" : "s"}</span>
                      <span>{p.paper_count} paper{p.paper_count === 1 ? "" : "s"}</span>
                      <span>{p.note_count} note{p.note_count === 1 ? "" : "s"}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ProjectDetail({ projectId, onBack, onOpenRun, onOpenProject, onDeleted }) {
  const [proj, setProj] = useState(null);
  const [tab, setTab] = useState("runs");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => {
    api.getProject(projectId).then((p) => { setProj(p); setName(p.name || ""); });
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  async function rename() {
    if (!name.trim() || name === proj.name) { setRenaming(false); return; }
    const p = await api.updateProject(projectId, { name: name.trim() });
    setProj(p); setRenaming(false);
  }

  async function del() {
    await api.deleteProject(projectId, true);
    onDeleted();
  }

  if (!proj) return <div style={S.muted}>Loading…</div>;
  const isOwner = proj.role !== "collaborator";

  return (
    <div>
      <button style={S.back} onClick={onBack}>← All projects</button>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, marginBottom: 2 }}>
        {renaming ? (
          <input autoFocus style={{ ...S.input, fontSize: 18, fontWeight: 700, padding: "4px 8px" }}
            value={name} onChange={(e) => setName(e.target.value)}
            onBlur={rename} onKeyDown={(e) => e.key === "Enter" && rename()} />
        ) : (
          <h3 style={S.h3} onClick={() => setRenaming(true)} title="Click to rename">{proj.name}</h3>
        )}
        {!isOwner && <span style={S.roleTag}>Shared with you</span>}
      </div>
      {proj.description && <div style={S.sub}>{proj.description}</div>}
      {onOpenProject && (
        <button style={S.smallBtn} onClick={() => onOpenProject(proj)}>Open project workspace →</button>
      )}

      <div style={S.tabs}>
        {[["runs", `Runs (${proj.runs.length})`], ["papers", `Papers (${proj.papers.length})`],
          ["notes", `Notes (${proj.notes.length})`], ["zotero", "Zotero import"],
          ["share", "Share"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ ...S.tab, ...(tab === id ? S.tabOn : null) }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "runs" && (
        <RunsTab runs={proj.runs} onOpenRun={onOpenRun && ((runId) => onOpenRun(runId, proj))} />
      )}
      {tab === "papers" && <PapersTab projectId={projectId} papers={proj.papers} onChange={load} />}
      {tab === "notes" && <NotesTab projectId={projectId} notes={proj.notes} onChange={load} />}
      {tab === "zotero" && <ZoteroTab projectId={projectId} onImported={load} />}
      {tab === "share" && <ShareTab projectId={projectId} isOwner={isOwner} />}

      {isOwner && (
        <div style={{ marginTop: 22, paddingTop: 14, borderTop: "1px solid #f1f1f6" }}>
          {confirmDelete ? (
            <span style={{ fontSize: 12.5 }}>
              Delete this project? Runs stay in your history, unfiled. &nbsp;
              <button style={S.dangerBtn} onClick={del}>Yes, delete</button>{" "}
              <button style={S.linkBtn} onClick={() => setConfirmDelete(false)}>Cancel</button>
            </span>
          ) : (
            <button style={S.dangerLink} onClick={() => setConfirmDelete(true)}>Delete project</button>
          )}
        </div>
      )}
    </div>
  );
}

function ShareTab({ projectId, isOwner }) {
  const [collabs, setCollabs] = useState(null);
  const [links, setLinks] = useState(null);
  const [email, setEmail] = useState("");
  const [addErr, setAddErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [linkEmails, setLinkEmails] = useState("");
  const [linkErr, setLinkErr] = useState(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  const load = useCallback(() => {
    api.listCollaborators(projectId).then((d) => setCollabs(d.collaborators || [])).catch(() => setCollabs([]));
    if (isOwner) {
      api.listShareLinks(projectId).then((d) => setLinks(d.links || [])).catch(() => setLinks([]));
    }
  }, [projectId, isOwner]);
  useEffect(() => { load(); }, [load]);

  async function addCollaborator(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setAddErr(null);
    try {
      await api.addCollaborator(projectId, email.trim());
      setEmail("");
      load();
    } catch (e2) {
      setAddErr(e2.message || "Could not add collaborator.");
    } finally {
      setBusy(false);
    }
  }

  async function removeCollaborator(userId) {
    await api.removeCollaborator(projectId, userId);
    load();
  }

  async function createLink(e) {
    e.preventDefault();
    const emails = linkEmails.split(",").map((s) => s.trim()).filter(Boolean);
    if (emails.length === 0) return;
    setLinkBusy(true); setLinkErr(null);
    try {
      await api.createShareLink(projectId, emails);
      setLinkEmails("");
      load();
    } catch (e2) {
      setLinkErr(e2.message || "Could not create share link.");
    } finally {
      setLinkBusy(false);
    }
  }

  async function revokeLink(id) {
    await api.revokeShareLink(projectId, id);
    load();
  }

  function copyLink(link) {
    const url = `${window.location.origin}/share/${link.token}`;
    navigator.clipboard?.writeText(url);
    setCopiedId(link.id);
    setTimeout(() => setCopiedId((c) => (c === link.id ? null : c)), 1600);
  }

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={S.shareHead}>Collaborators</div>
        <div style={S.sub}>
          Full access — anyone added here can view and edit everything in this project, the same
          as you. They need a Sift account and must have signed in at least once.
        </div>
        {isOwner && (
          <form onSubmit={addCollaborator} style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input style={S.input} type="email" placeholder="teammate@lab.edu" value={email}
              onChange={(e) => setEmail(e.target.value)} />
            <button type="submit" disabled={busy} style={S.smallBtn}>{busy ? "Adding…" : "Add"}</button>
          </form>
        )}
        {addErr && <div style={S.err}>{addErr}</div>}
        {collabs == null ? (
          <div style={S.muted}>Loading…</div>
        ) : collabs.length === 0 ? (
          <div style={S.muted}>No collaborators yet.</div>
        ) : (
          <div style={{ marginTop: 10 }}>
            {collabs.map((c) => (
              <div key={c.id} style={S.listRow}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={S.rowTitle}>{c.email}</div>
                  <div style={S.rowMeta}>Full access</div>
                </div>
                {isOwner && (
                  <button style={S.iconBtn} onClick={() => removeCollaborator(c.user_id)} title="Remove">×</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {isOwner && (
        <div>
          <div style={S.shareHead}>Read-only share links</div>
          <div style={S.sub}>
            Generate a link restricted to specific emails — for people without a Sift account.
            They confirm their email once, then see the project read-only. Copy and send the link
            yourself; Sift doesn't email it for you.
          </div>
          <form onSubmit={createLink} style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input style={S.input} placeholder="one@ex.com, two@ex.com" value={linkEmails}
              onChange={(e) => setLinkEmails(e.target.value)} />
            <button type="submit" disabled={linkBusy} style={S.smallBtn}>
              {linkBusy ? "Creating…" : "Create link"}
            </button>
          </form>
          {linkErr && <div style={S.err}>{linkErr}</div>}
          {links == null ? (
            <div style={S.muted}>Loading…</div>
          ) : links.length === 0 ? (
            <div style={S.muted}>No share links yet.</div>
          ) : (
            <div style={{ marginTop: 10 }}>
              {links.map((l) => (
                <div key={l.id} style={S.noteCard}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={S.rowMeta}>{l.allowed_emails.join(", ")}</div>
                      {l.revoked_at && <div style={{ ...S.rowMeta, color: "#c0392b" }}>Revoked</div>}
                    </div>
                    {!l.revoked_at && (
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button style={S.smallBtn} onClick={() => copyLink(l)}>
                          {copiedId === l.id ? "Copied!" : "Copy link"}
                        </button>
                        <button style={S.iconBtn} onClick={() => revokeLink(l.id)} title="Revoke">×</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunsTab({ runs, onOpenRun }) {
  if (runs.length === 0) {
    return <div style={S.muted}>No reviews filed under this project yet. Start a search and choose this project, or file an existing run from its History entry.</div>;
  }
  return (
    <div>
      {runs.map((r) => (
        <button key={r.id} style={S.listRow} onClick={() => onOpenRun(r.id)}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={S.rowTitle}>{r.topic || "Untitled review"}</div>
            <div style={S.rowMeta}>{r.stage === "done" ? "Completed" : "In progress"} · {r.paper_count} papers</div>
          </div>
          <span style={S.chev}>→</span>
        </button>
      ))}
    </div>
  );
}

function PapersTab({ projectId, papers, onChange }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ title: "", authors: "", year: "", url: "" });

  async function add(e) {
    e.preventDefault();
    if (!f.title.trim()) return;
    await api.addProjectPaper(projectId, {
      title: f.title.trim(), authors: f.authors.trim(), year: f.year ? Number(f.year) : null,
      url: f.url.trim(), abstract: "",
    }, "manual");
    setF({ title: "", authors: "", year: "", url: "" });
    setAdding(false);
    onChange();
  }

  async function remove(id) {
    await api.removeProjectPaper(projectId, id);
    onChange();
  }

  return (
    <div>
      <button style={S.smallBtn} onClick={() => setAdding((a) => !a)}>
        {adding ? "Cancel" : "+ Add paper"}
      </button>
      {adding && (
        <form onSubmit={add} style={{ ...S.card, marginTop: 8 }}>
          <input style={S.input} placeholder="Title" value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input style={S.input} placeholder="Authors" value={f.authors}
              onChange={(e) => setF({ ...f, authors: e.target.value })} />
            <input style={{ ...S.input, maxWidth: 90 }} placeholder="Year" value={f.year}
              onChange={(e) => setF({ ...f, year: e.target.value })} />
          </div>
          <input style={{ ...S.input, marginTop: 8 }} placeholder="URL / DOI" value={f.url}
            onChange={(e) => setF({ ...f, url: e.target.value })} />
          <button type="submit" style={{ ...S.save, marginTop: 10 }}>Save paper</button>
        </form>
      )}
      {papers.length === 0 ? (
        <div style={S.muted}>No saved papers yet.</div>
      ) : (
        <div style={{ marginTop: 10 }}>
          {papers.map((row) => (
            <div key={row.id} style={S.listRow}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={S.rowTitle}>
                  {row.paper.url
                    ? <a href={row.paper.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{row.paper.title}</a>
                    : row.paper.title}
                </div>
                <div style={S.rowMeta}>
                  {[row.paper.authors, row.paper.year, row.source === "zotero" ? "via Zotero" : null]
                    .filter(Boolean).join(" · ")}
                </div>
              </div>
              <button style={S.iconBtn} onClick={() => remove(row.id)} title="Remove">×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotesTab({ projectId, notes, onChange }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ title: "", body: "" });

  async function add(e) {
    e.preventDefault();
    if (!f.body.trim() && !f.title.trim()) return;
    await api.addProjectNote(projectId, f.title.trim(), f.body.trim());
    setF({ title: "", body: "" });
    setAdding(false);
    onChange();
  }

  async function remove(id) {
    await api.removeProjectNote(projectId, id);
    onChange();
  }

  return (
    <div>
      <button style={S.smallBtn} onClick={() => setAdding((a) => !a)}>
        {adding ? "Cancel" : "+ Add note"}
      </button>
      {adding && (
        <form onSubmit={add} style={{ ...S.card, marginTop: 8 }}>
          <input style={S.input} placeholder="Title (optional)" value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })} />
          <textarea style={{ ...S.input, marginTop: 8, minHeight: 80, resize: "vertical" }}
            placeholder="Note" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
          <button type="submit" style={{ ...S.save, marginTop: 10 }}>Save note</button>
        </form>
      )}
      {notes.length === 0 ? (
        <div style={S.muted}>No notes yet.</div>
      ) : (
        <div style={{ marginTop: 10 }}>
          {notes.map((n) => (
            <div key={n.id} style={S.noteCard}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                {n.title && <div style={S.rowTitle}>{n.title}</div>}
                <button style={S.iconBtn} onClick={() => remove(n.id)} title="Delete">×</button>
              </div>
              <div style={S.noteBody}>{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ZoteroTab({ projectId, onImported }) {
  const [apiKey, setApiKey] = useState("");
  const [libraryId, setLibraryId] = useState("");
  const [libraryType, setLibraryType] = useState("user");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function doImport(e) {
    e.preventDefault();
    if (!apiKey.trim() || !libraryId.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.zoteroImport(projectId, apiKey.trim(), libraryId.trim(), libraryType);
      setMsg({ ok: true, text: `Imported ${r.imported} item${r.imported === 1 ? "" : "s"} into Papers.` });
      onImported();
    } catch (err) {
      setMsg({ ok: false, text: err.message || "Import failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={doImport}>
      <div style={S.sub}>
        Connect a Zotero library to pull its items into this project's paper list. This is a
        one-time, read-only import — we never store your Zotero key. Get a read-only API key and
        your library id at{" "}
        <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noreferrer" style={{ color: "#5b4ff0" }}>
          zotero.org/settings/keys
        </a>.
      </div>
      <label style={S.lbl}>API key</label>
      <input style={S.input} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
        placeholder="Read-only Zotero API key" />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={S.lbl}>Library id</label>
          <input style={S.input} value={libraryId} onChange={(e) => setLibraryId(e.target.value)}
            placeholder="Your numeric userID" />
        </div>
        <div>
          <label style={S.lbl}>Type</label>
          <select style={S.input} value={libraryType} onChange={(e) => setLibraryType(e.target.value)}>
            <option value="user">My library</option>
            <option value="group">Group library</option>
          </select>
        </div>
      </div>
      <button type="submit" disabled={busy} style={{ ...S.save, marginTop: 12 }}>
        {busy ? "Importing…" : "Import from Zotero"}
      </button>
      {msg && <div style={{ marginTop: 10, fontSize: 13, color: msg.ok ? "#2e9e5b" : "#c0392b" }}>{msg.text}</div>}
    </form>
  );
}

const S = {
  scrim: {
    position: "fixed", inset: 0, background: "rgba(17,17,27,.45)", backdropFilter: "blur(2px)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 20,
  },
  modal: {
    width: "100%", maxWidth: 620, maxHeight: "86vh", overflowY: "auto",
    background: "#fff", borderRadius: 16, padding: "26px 28px 28px",
    boxShadow: "0 20px 60px rgba(0,0,0,.25)", fontFamily: "'Space Grotesk',sans-serif",
    color: "#111", position: "relative",
  },
  close: {
    position: "absolute", top: 12, right: 15, background: "none", border: "none",
    fontSize: 22, color: "#9a9aab", cursor: "pointer", lineHeight: 1,
  },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  h3: { margin: 0, fontSize: 19, fontWeight: 700, cursor: "default" },
  sub: { fontSize: 13, color: "#6b6b7b", lineHeight: 1.5, margin: "6px 0 14px" },
  newBtn: {
    background: "#5b4ff0", color: "#fff", border: "none", borderRadius: 8, padding: "7px 12px",
    fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  smallBtn: {
    background: "none", border: "1px solid #e3e3ec", borderRadius: 8, padding: "6px 11px",
    fontSize: 12.5, fontWeight: 600, cursor: "pointer", color: "#5b4ff0", fontFamily: "inherit",
  },
  card: { border: "1px solid #eeeef4", borderRadius: 10, padding: 12, marginBottom: 14, background: "#fafafe" },
  input: {
    width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid #e3e3ec",
    fontFamily: "inherit", fontSize: 13.5, color: "#111", outline: "none", boxSizing: "border-box",
  },
  lbl: { display: "block", fontSize: 12, fontWeight: 600, color: "#4a4a5a", margin: "8px 0 5px" },
  save: {
    padding: "9px 16px", borderRadius: 8, border: "none", background: "#5b4ff0",
    color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  err: { color: "#c0392b", fontSize: 12.5, marginTop: 8 },
  muted: { color: "#6b6b7b", fontSize: 13.5, padding: "10px 0" },
  projRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
    background: "none", border: "1px solid #eeeef4", borderRadius: 10, padding: "12px 14px",
    marginBottom: 8, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
  },
  projName: { fontSize: 14.5, fontWeight: 700, color: "#111" },
  roleTag: {
    display: "inline-block", marginLeft: 8, fontSize: 10, fontWeight: 700, letterSpacing: ".02em",
    color: "#5b4ff0", background: "#efedfe", borderRadius: 5, padding: "2px 7px", verticalAlign: "middle",
  },
  shareHead: { fontSize: 13.5, fontWeight: 700, color: "#111", marginBottom: 2 },
  projDesc: { fontSize: 12.5, color: "#6b6b7b", marginTop: 2 },
  counts: { display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "#8a8a9a", textAlign: "right", flexShrink: 0, marginLeft: 12 },
  back: { background: "none", border: "none", color: "#5b4ff0", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" },
  tabs: { display: "flex", gap: 4, borderBottom: "1px solid #eeeef4", margin: "14px 0 16px", flexWrap: "wrap" },
  tab: {
    background: "none", border: "none", borderBottom: "2px solid transparent", cursor: "pointer",
    fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: "#6b6b7b", padding: "7px 10px 9px",
  },
  tabOn: { color: "#5b4ff0", borderBottomColor: "#5b4ff0" },
  listRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
    background: "none", border: "1px solid #f1f1f6", borderRadius: 9, padding: "10px 12px",
    marginBottom: 6, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
  },
  rowTitle: { fontSize: 13, fontWeight: 600, color: "#111", lineHeight: 1.4 },
  rowMeta: { fontSize: 11.5, color: "#8a8a9a", marginTop: 2 },
  chev: { color: "#c3c3d2", fontSize: 14, flexShrink: 0, marginLeft: 8 },
  iconBtn: {
    background: "none", border: "none", color: "#b5b5c5", fontSize: 17, cursor: "pointer",
    padding: "0 4px", lineHeight: 1, flexShrink: 0,
  },
  noteCard: { border: "1px solid #f1f1f6", borderRadius: 9, padding: "10px 12px", marginBottom: 8 },
  noteBody: { fontSize: 12.5, color: "#3a3a4a", marginTop: 4, whiteSpace: "pre-wrap", lineHeight: 1.5 },
  linkBtn: { background: "none", border: "none", color: "#6b6b7b", fontSize: 12.5, cursor: "pointer", padding: 0, fontFamily: "inherit" },
  dangerLink: { background: "none", border: "none", color: "#c0392b", fontSize: 12.5, cursor: "pointer", padding: 0, fontFamily: "inherit" },
  dangerBtn: {
    background: "#c0392b", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px",
    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
};

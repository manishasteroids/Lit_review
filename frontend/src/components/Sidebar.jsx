import React, { useState, useRef, useEffect } from "react";
import { useSession, signOut, displayName, Avatar } from "../Auth.jsx";
import { AuthButtons } from "../Auth.jsx";
import { BookOpen, Lightbulb, Cpu, BarChart3, Coins, Plus } from "./icons.jsx";

/**
 * The dashboard-shell left nav (architecture doc: claude/architecture-dashboard-upgrade.md).
 * Purely presentational + its own tiny bits of local UI state (Data Analysis
 * dropdown open/closed, the account dropdown open/closed) — every actual
 * navigation decision is a callback into App.jsx, which owns `view` and all
 * the underlying app state.
 *
 * `activeView` — one of "home" | "workspace" | "hypothesis-picker" |
 * "hypothesis-workspace" | "physical-ai" | "data-analysis" | "billing" —
 * used only to highlight the matching nav row; App.jsx is still the source
 * of truth for what's actually showing.
 */
export default function Sidebar({
  activeView, onNewProject, onGoHome, onLiteratureReview, onHypothesisGeneration,
  onPhysicalAI, onDataAnalysis, onOpenBilling, onOpenProfile, onOpenSettings, onDeleteAllData,
}) {
  const session = useSession();

  return (
    <div style={S.sidebar}>
      <button type="button" style={S.brand} onClick={onGoHome} title="Home">
        Orcus Intelligence Lab
      </button>
      <button type="button" style={S.newBtn} onClick={onNewProject}>
        <Plus size={14} /> Create new project
      </button>

      <div style={S.sectionLabel}>Workspace</div>
      <nav style={{ flex: 1, overflowY: "auto" }}>
        <NavItem icon={<BookOpen size={15} />} label="Literature Review"
          active={activeView === "workspace"} onClick={onLiteratureReview} />
        <NavItem icon={<Lightbulb size={15} />} label="Hypothesis Generation"
          active={activeView === "hypothesis-picker" || activeView === "hypothesis-workspace"}
          onClick={onHypothesisGeneration} />
        <NavItem icon={<Cpu size={15} />} label="Physical AI"
          active={activeView === "physical-ai"} onClick={onPhysicalAI} />

        <NavItem icon={<BarChart3 size={15} />} label="Data Analysis"
          active={activeView === "data-analysis"} onClick={() => onDataAnalysis("dataviz")} />
      </nav>

      <div style={S.footer}>
        <NavItem icon={<Coins size={15} />} label="Account and Billing"
          active={activeView === "billing"} onClick={onOpenBilling} />
        <div style={{ padding: "8px 10px 2px" }}>
          {session ? (
            <AccountRow
              session={session}
              onOpenProfile={onOpenProfile}
              onOpenSettings={onOpenSettings}
              onDeleteAllData={onDeleteAllData}
            />
          ) : (
            <AuthButtons />
          )}
        </div>
      </div>
    </div>
  );
}

// Clicking the avatar/name goes straight to the profile page (skips the
// extra "View Profile" click a dropdown would need); the small chevron
// button opens a short menu for the less-common actions (Settings, wiping
// all data, signing out) instead of crowding those onto the main row.
function AccountRow({ session, onOpenProfile, onOpenSettings, onDeleteAllData }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const user = session.user;
  const name = displayName(user);
  const avatarUrl = user?.user_metadata?.avatar_url;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <div style={S.acctRow}>
        <button type="button" style={S.acctMain} onClick={onOpenProfile} title="View profile">
          <Avatar name={name} url={avatarUrl} size={26} />
          <span style={S.acctName}>{name}</span>
        </button>
        <button
          type="button"
          style={{ ...S.acctChevron, background: open ? "var(--line, #e4e7ef)" : "none" }}
          onClick={() => setOpen((o) => !o)}
          aria-label="Account menu"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {open && (
        <div style={S.acctMenu}>
          <MenuItem onClick={() => { setOpen(false); onOpenSettings?.(); }}>Settings</MenuItem>
          <MenuItem danger onClick={() => { setOpen(false); onDeleteAllData?.(); }}>Delete all my data</MenuItem>
          <MenuItem danger onClick={() => { setOpen(false); signOut(); }}>Log out</MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
        padding: "9px 10px", borderRadius: 8, border: "none", cursor: "pointer",
        background: hover ? (danger ? "#fdecec" : "#f3f3f8") : "transparent",
        color: danger ? "#c0392b" : "#111", fontSize: 13, fontWeight: 500, fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

function NavItem({ icon, label, active, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ ...S.navItem, ...(active ? S.navItemActive : null) }}>
      {icon} {label}
    </button>
  );
}


const S = {
  sidebar: {
    width: 226, flexShrink: 0, display: "flex", flexDirection: "column",
    background: "var(--panel2, #f1f3f9)", borderRight: "1px solid var(--line, #e4e7ef)",
    height: "100vh", position: "sticky", top: 0, fontFamily: "inherit",
  },
  brand: {
    textAlign: "left", background: "none", border: "none", cursor: "pointer",
    fontFamily: "inherit", fontSize: 13.5, fontWeight: 800, letterSpacing: "-.01em",
    lineHeight: 1.25, color: "var(--txt, #1c2128)", padding: "16px 16px 0",
  },
  newBtn: {
    margin: 14, padding: "9px 12px", background: "var(--indigo, #6d5df6)", color: "#fff",
    border: "none", borderRadius: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer",
    display: "flex", alignItems: "center", gap: 7, fontFamily: "inherit",
  },
  sectionLabel: {
    fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em",
    color: "var(--muted2, #98a0af)", padding: "10px 16px 6px",
  },
  navItem: {
    width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
    fontSize: 13.5, color: "var(--txt, #1c2128)", background: "none", border: "none",
    cursor: "pointer", textAlign: "left", fontFamily: "inherit",
  },
  navItemActive: { background: "#e8e5fd", color: "var(--indigo, #6d5df6)", fontWeight: 600 },
  subNavItem: {
    width: "100%", display: "block", padding: "8px 16px 8px 41px", fontSize: 12.5,
    color: "var(--muted, #5b6472)", background: "none", border: "none", cursor: "pointer",
    textAlign: "left", fontFamily: "inherit",
  },
  footer: { borderTop: "1px solid var(--line, #e4e7ef)", padding: "6px 0" },
  acctRow: {
    display: "flex", alignItems: "center", gap: 4, borderRadius: 8,
  },
  acctMain: {
    flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, padding: "6px 4px",
    background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
    borderRadius: 8,
  },
  acctName: {
    fontSize: 13, fontWeight: 500, color: "var(--txt, #1c2128)", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  acctChevron: {
    flexShrink: 0, background: "none", border: "none", cursor: "pointer", padding: 6,
    borderRadius: 8, color: "var(--muted, #5b6472)", display: "flex", alignItems: "center",
  },
  acctMenu: {
    position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, minWidth: 200,
    background: "#fff", border: "1px solid #e3e3ec", borderRadius: 12,
    boxShadow: "0 14px 40px rgba(0,0,0,0.16)", padding: 6, zIndex: 1000,
  },
};

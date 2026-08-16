import React, { useState, useEffect, useRef } from "react";
import { ensureAuth } from "../Auth.jsx";
import { api } from "../api/client.js";

/**
 * Public marketing site — shown to signed-out visitors, before the tools app.
 * Always light/white themed, independent of the app's dark UI.
 *
 * Pages: "home" (hero + features), "pricing", "careers", "about".
 */
export default function LandingPage() {
  const [page, setPage] = useState("home");
  // Every call site below is an acquisition CTA ("Try for free", "Sign up",
  // pricing buttons, etc.) except the one explicit "Sign in" link, so this
  // defaults to opening the modal on the signup tab rather than making
  // people find the "Create an account" toggle themselves.
  const login = (mode = "signup") => ensureAuth({ mode });

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  const PAGES = {
    pricing: <Pricing login={login} />,
    careers: <CareersPage />,
    about: <AboutPage />,
  };

  return (
    <div className="lp-root">
      <LandingStyles />
      <TopBar page={page} setPage={setPage} login={login} />
      {PAGES[page] || <Home login={login} setPage={setPage} />}
      <SiteFooter setPage={setPage} />
    </div>
  );
}

/* Fades + slides a section in the first time it scrolls into view, instead
   of everything below the fold just being present at full opacity from
   load — the flat, static feel the "pipeline and page below is still
   static" feedback was pointing at. Cheap: one IntersectionObserver per
   instance, disconnects itself after the first reveal. */
function Reveal({ children, className = "", delay = 0 }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setShown(true); io.disconnect(); } },
      { threshold: 0.15 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`lp-reveal${shown ? " lp-reveal-in" : ""} ${className}`}
      style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
    >
      {children}
    </div>
  );
}

/* ── Top bar ──────────────────────────────────────────────────────────── */

const FEATURE_ITEMS = [
  ["Literature Review", "Search, filter and synthesise papers into a cited review", "doc"],
  ["Research Paper Analysis", "Read any paper in full and chat with it", "search"],
  ["Research Methods Generation", "Turn findings into testable methods and hypotheses", "flask"],
  ["Data Analysis", "Trends, comparisons and evidence tables across your corpus", "chart"],
];

// One dropdown, reused for both "Product" and "Resources" — the six flat
// links (Features / News / FAQ / Pricing / Careers / About) were crowding
// the bar at anything less than a very wide screen; grouping related links
// under two menus (plus two standalone pages) mirrors how most product
// sites structure this once they have more than three or four sections.
function NavDropdown({ label, items, onSelect, closeSignal }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffect(() => { setOpen(false); }, [closeSignal]);

  return (
    <div className="lp-dd" ref={ref}>
      <button className="lp-dd-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
        <svg className={"lp-caret" + (open ? " up" : "")} viewBox="0 0 12 8" width="10" height="7" aria-hidden="true">
          <path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="lp-dd-menu">
          {items.map(([itemLabel, desc, icon], i) => (
            <button key={itemLabel} className="lp-dd-item"
              onClick={() => { setOpen(false); onSelect(i); }}>
              <span className="lp-dd-ic"><FeatureIcon i={i} name={icon} /></span>
              <span>
                <div className="lp-dd-label">{itemLabel}</div>
                <div className="lp-dd-desc">{desc}</div>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TopBar({ page, setPage, login }) {
  // Scroll to a home-page section (switching back to home first if needed).
  const jump = (id) => {
    if (page !== "home") setPage("home");
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }), 60);
  };

  const RESOURCE_ITEMS = [
    ["News", "What's moving across AI-driven research", "news"],
    ["FAQ", "Answers to the questions researchers ask most", "faq"],
    ["Publications", "Papers & white papers coming out of this project", "pub"],
  ];
  const resourceActions = [() => jump("lp-news"), () => jump("lp-faq"), () => jump("lp-papers")];

  return (
    <header className="lp-bar">
      <div className="lp-bar-in">
        <div className="lp-logo" onClick={() => setPage("home")}>
          <LogoMark />
          <span>Sift</span>
        </div>

        <nav className="lp-nav">
          <NavDropdown label="Product" items={FEATURE_ITEMS} closeSignal={page} onSelect={() => login()} />
          <NavDropdown label="Resources" items={RESOURCE_ITEMS} closeSignal={page}
            onSelect={(i) => resourceActions[i]()} />
          <button className="lp-link" onClick={() => setPage("careers")}>Careers</button>
          <button className="lp-link" onClick={() => setPage("about")}>About</button>
        </nav>

        <div className="lp-bar-cta">
          <button className="lp-ghost" onClick={() => login("signin")}>Sign in</button>
          <button className="lp-solid" onClick={() => login("signup")}>Sign up</button>
        </div>
      </div>
    </header>
  );
}

// Logomark: a diyo (the clay oil lamp lit for Tihar/Diwali — light over
// darkness) with its flame, on the indigo badge. See BrandMark below for
// the fuller version of the idea — the same lamp burning at the center of
// a mind, i.e. the spark of insight found inside a pile of literature.
// A single idea bulb, split between a human fold (left) and an AI chip
// (right) — the balance-of-intelligence concept, condensed to fit a 30px
// badge. See BrandMark below for the fuller two-bulb version of the idea.
function LogoMark() {
  return (
    <span className="lp-logomark" aria-hidden="true">
      <svg viewBox="0 0 30 30" width="20" height="20">
        <path d="M15 5.2c-3.4 0-5.9 2.6-5.9 5.7 0 2.1 1.1 3.5 2.1 4.6.7.8 1.1 1.4 1.2 2.1h5.2
          c.1-.7.5-1.3 1.2-2.1 1-1.1 2.1-2.5 2.1-4.6 0-3.1-2.5-5.7-5.9-5.7z"
          fill="none" stroke="#fff" strokeWidth="1.3" />
        <path d="M12.6 9.4c-.6.3-.9 1-.6 1.6.2.4 0 .9-.4 1.1-.5.3-.6 1-.2 1.4"
          fill="none" stroke="#ffe08a" strokeWidth="0.9" strokeLinecap="round" />
        <circle cx="17.3" cy="10.3" r="0.9" fill="#ffe08a" />
        <path d="M17.3 11.2v1.1h1.3M17.3 11.2h-1.1" fill="none" stroke="#ffe08a" strokeWidth="0.8" strokeLinecap="round" />
        <rect x="12.6" y="18.6" width="4.8" height="1.1" rx="0.3" fill="#fff" />
        <rect x="12.9" y="20.1" width="4.2" height="1.1" rx="0.3" fill="#fff" />
        <rect x="13.3" y="21.6" width="3.4" height="1.6" rx="0.6" fill="#fff" />
        <g stroke="#ffe08a" strokeWidth="1.1" strokeLinecap="round">
          <line x1="15" y1="2.6" x2="15" y2="1" />
          <line x1="10.6" y1="3.9" x2="9.6" y2="2.7" />
          <line x1="19.4" y1="3.9" x2="20.4" y2="2.7" />
        </g>
      </svg>
    </span>
  );
}

// The full idea, larger: two bulbs — one lit with a human/brain fold, one
// with an AI chip — balanced on a bar. Used as a standalone brand
// illustration (About page) where there's room for both sides of the idea.
function BrandMark({ width = 160 }) {
  const bulb = (cx, ai) => (
    <g transform={`translate(${cx},49)`}>
      <path d="M28 6C13 6 3 16.6 3 29c0 8.4 4.6 14 8.6 18.4C14.4 50.6 16 53 16.2 55.8h23.6
        C40 53 41.6 50.6 44.4 47.4 48.4 43 53 37.4 53 29 53 16.6 43 6 28 6z"
        fill="var(--lp-soft)" stroke="var(--lp-indigo)" strokeWidth="2.2" />
      {ai ? (
        <>
          <rect x="19" y="20" width="18" height="18" rx="2.5" fill="none" stroke="var(--lp-indigo)" strokeWidth="2" />
          <text x="28" y="32.5" textAnchor="middle" fontFamily="'JetBrains Mono',monospace"
            fontSize="9" fontWeight="700" fill="var(--lp-indigo)">AI</text>
          <g stroke="var(--lp-indigo)" strokeWidth="1.6" strokeLinecap="round">
            <line x1="28" y1="20" x2="28" y2="15" /><line x1="28" y1="38" x2="28" y2="43" />
            <line x1="19" y1="29" x2="14" y2="29" /><line x1="37" y1="29" x2="42" y2="29" />
          </g>
        </>
      ) : (
        <>
          <path d="M18 22c-2.4 1.2-3.6 4-2.4 6.4.8 1.6 0 3.6-1.6 4.4-2 1.2-2.4 4-.8 5.6"
            fill="none" stroke="var(--lp-indigo)" strokeWidth="2" strokeLinecap="round" />
          <path d="M32 20c2.6.8 4.2 3.4 3.4 6-.6 1.8.4 3.6 2.2 4.2 2.2.8 3 3.4 1.8 5.2"
            fill="none" stroke="var(--lp-indigo)" strokeWidth="2" strokeLinecap="round" />
        </>
      )}
      <rect x="16.5" y="58" width="23" height="5" rx="1.5" fill="var(--lp-indigo)" />
      <rect x="18" y="65" width="20" height="5" rx="1.5" fill="var(--lp-indigo)" />
      <rect x="20" y="72" width="16" height="7" rx="2.5" fill="var(--lp-indigo)" />
      <g stroke="#ffb238" strokeWidth="2.4" strokeLinecap="round">
        <line x1="28" y1="-2" x2="28" y2="-10" />
        <line x1="10" y1="4" x2="4" y2="-2" /><line x1="46" y1="4" x2="52" y2="-2" />
        <line x1="2" y1="20" x2="-6" y2="18" /><line x1="54" y1="20" x2="62" y2="18" />
      </g>
    </g>
  );
  return (
    <svg viewBox="0 0 320 220" width={width} height={width * (220 / 320)} aria-hidden="true">
      <defs>
        <radialGradient id="lp-bm-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--lp-indigo)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--lp-indigo)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="160" cy="110" r="72" fill="url(#lp-bm-glow)" />
      <rect x="55" y="128" width="210" height="10" rx="3" fill="var(--lp-ink)" />
      <path d="M160 138 L182 168 L138 168 Z" fill="var(--lp-ink)" />
      <rect x="130" y="168" width="60" height="8" rx="2" fill="var(--lp-ink)" />
      {bulb(60, false)}
      {bulb(232, true)}
    </svg>
  );
}

// Small per-item glyphs for the Features dropdown — literature review
// (document stack), paper analysis (magnifier), methods (flask), data
// analysis (bars). Purely decorative but breaks up four otherwise
// identical text rows.
const ICON_PATHS = {
  doc: "M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M16 16l5 5",
  flask: "M9 3h6 M10 3v5l-5 10a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-10V3",
  chart: "M4 20V10 M11 20V4 M18 20v-7",
  news: "M4 4h13a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V4z M20 8v9a2 2 0 0 1-2 2 M8 8h7 M8 12h7 M8 16h4",
  faq: "M12 17.5h.01 M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1.5 1-1.5 2.2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  pub: "M6 3h12v18l-6-3.5L6 21z",
  ask: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z M12 8.3a1.8 1.8 0 1 1 2.3 1.7c-.7.3-1.3.8-1.3 1.6 M12.3 14.2h.01",
  filter: "M3 4h18l-7 8v6l-4 2v-8z",
  extract: "M12 2v4 M12 18v4 M2 12h4 M18 12h4 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  critique: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  write: "M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
};

// icon shown per pipeline step, in STEPS order.
const STEP_ICONS = ["ask", "search", "filter", "extract", "critique", "write"];

function FeatureIcon({ i, name }) {
  const common = { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none",
    stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
  const order = ["doc", "search", "flask", "chart"];
  const d = ICON_PATHS[name || order[i % order.length]];
  return <svg {...common}><path d={d} /></svg>;
}

/* ── Home ─────────────────────────────────────────────────────────────── */

function Home({ login, setPage }) {
  return (
    <>
      <section className="lp-hero">
        <h1 className="lp-h1">Interactive Scientific AI Research Assistant</h1>
        <p className="lp-sub">Accelerates innovation, and boosts scientific discovery.</p>
        <div className="lp-cta-row">
          <button className="lp-cta" onClick={() => login("signup")}>Try for free</button>
          <button className="lp-cta-2"
            onClick={() => document.getElementById("lp-features")?.scrollIntoView({ behavior: "smooth" })}>
            See how it works
          </button>
        </div>
        <div className="lp-note">Sign in with Google, GitHub, or email — no credit card required.</div>
        <button className="lp-pricing-link" onClick={() => setPage("pricing")}>See pricing →</button>
        <HeroVisual />
      </section>

      <div id="lp-features" className="lp-section">
        <div className="lp-ads-label">What it does</div>
        <h2 className="lp-cat">Literature Review</h2>
        <p className="lp-cat-sub">From a research question to a cited review — automatically.</p>

        {/* Pipeline steps overview — clickable, scrolls to the matching
            detail section below so the strip feels like a live map of the
            pipeline rather than a flat row of labels. */}
        <div className="lp-steps">
          {STEPS.map((s, i) => (
            <React.Fragment key={s.k}>
              <a href={`#feat-${STEP_FEATURE_MAP[i]}`} className="lp-step">
                <div className="lp-step-ic">
                  <span className="lp-step-ic-ring" />
                  <FeatureIcon name={STEP_ICONS[i]} />
                </div>
                <div className="lp-step-n">{i + 1}</div>
                <div className="lp-step-t">{s.k}</div>
                <div className="lp-step-d">{s.d}</div>
              </a>
              {i < STEPS.length - 1 && (
                <div className="lp-step-arrow" aria-hidden="true">
                  <svg viewBox="0 0 28 16" className="lp-step-arrow-svg">
                    <path d="M1 8h22M17 2l6 6-6 6" />
                    <circle r="2" className="lp-step-flow">
                      <animateMotion dur="2.4s" repeatCount="indefinite"
                        begin={`${i * 0.3}s`} path="M1 8h22" />
                    </circle>
                  </svg>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Step-by-step feature detail */}
        {FEATURES.map((f, i) => (
          <Reveal key={f.title}>
            <div className={"lp-feature" + (i % 2 ? " rev" : "")} id={`feat-${i}`}>
              <div>
                <div className="lp-step-tag">Step {i + 1}</div>
                <h3 className="lp-feat-title">{f.title}</h3>
                <p className="lp-feat-body">{f.body}</p>
                <ul className="lp-feat-list">
                  {f.points.map((p) => <li key={p}><span className="lp-check">✓</span>{p}</li>)}
                </ul>
                <button className="lp-learn" onClick={() => login("signup")}>Try it free →</button>
              </div>
              <div className="lp-visual">{f.visual}</div>
            </div>
          </Reveal>
        ))}

        {/* ── Research Collaborations ─────────────────────────── */}
        <Reveal>
          <div className="lp-band">
            <h2 className="lp-cat">Research Collaborations</h2>
            <p className="lp-cat-sub">Work together on the questions that matter.</p>
            <div className="lp-tri">
              {COLLAB.map((c, i) => (
                <Reveal key={c.t} delay={i * 90} className="lp-tile-wrap">
                  <div className="lp-tile">
                    <div className="lp-tile-ic">{c.ic}</div>
                    <div className="lp-tile-t">{c.t}</div>
                    <div className="lp-tile-d">{c.d}</div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </Reveal>

        {/* ── Hypothesis Generation ───────────────────────────── */}
        <Reveal><HypothesisSection login={login} /></Reveal>

        {/* ── Publications ────────────────────────────────────── */}
        <div className="lp-band" id="lp-papers">
          <h2 className="lp-cat">Publications &amp; white papers</h2>
          <p className="lp-cat-sub">Research coming out of this project. Links go live on release.</p>
          <div className="lp-pubs">
            {PUBS.map((p) => (
              <article className="lp-pub" key={p.title}>
                <div className="lp-pub-top">
                  <span className={"lp-status " + p.state}>{p.status}</span>
                  <span className="lp-pub-kind">{p.kind}</span>
                </div>
                <h3 className="lp-pub-t">{p.title}</h3>
                <p className="lp-pub-d">{p.desc}</p>
                {p.href
                  ? <a className="lp-learn" href={p.href} target="_blank" rel="noreferrer">Read →</a>
                  : <span className="lp-pub-soon">Coming soon</span>}
              </article>
            ))}
          </div>
        </div>

        {/* ── News ────────────────────────────────────────────── */}
        <NewsSection />

        {/* ── FAQ ─────────────────────────────────────────────── */}
        <div className="lp-band" id="lp-faq">
          <h2 className="lp-cat">Frequently asked questions</h2>
          <p className="lp-cat-sub">The things researchers ask us most.</p>
          <div className="lp-faq">
            {FAQ.map((f, i) => <FaqItem key={i} {...f} />)}
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Hero illustration: papers -> pipeline -> cited review ─────────────── */
// A hand-built vector piece rather than a generated image — stays crisp at
// any size, costs nothing to render, and can't produce the stray embedded
// text/labels a generative image model tends to add.

function PaperGlyph({ x, y, rot = 0, tone = "#e7e4fd", floatDelay = 0 }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      {/* Floating animation lives on this INNER <g> — a CSS transform on
          the same element as the SVG transform attribute above would
          override the positioning/rotation outright in most browsers, so
          the animated wobble is kept on a nested group instead. */}
      <g className="lp-hv-paper" style={{ animationDelay: `${floatDelay}s` }}>
        <rect x="0" y="0" width="66" height="86" rx="8" fill="#fff" stroke="#d9d6f7" strokeWidth="1.5" />
        <rect x="0" y="0" width="66" height="86" rx="8" fill={tone} opacity="0.35" />
        <rect x="12" y="16" width="42" height="5" rx="2.5" fill="#c9c4f4" />
        <rect x="12" y="28" width="34" height="4" rx="2" fill="#ded9f8" />
        <rect x="12" y="38" width="38" height="4" rx="2" fill="#ded9f8" />
        <rect x="12" y="48" width="26" height="4" rx="2" fill="#ded9f8" />
      </g>
    </g>
  );
}

function HeroVisual() {
  const hub = { cx: 430, cy: 156 };
  const nodeR = 84;
  const nodes = STEPS.map((s, i) => {
    const angle = (Math.PI * 2 * i) / STEPS.length - Math.PI / 2;
    return { ...s, x: hub.cx + Math.cos(angle) * nodeR, y: hub.cy + Math.sin(angle) * nodeR };
  });
  const outD = `M${hub.cx + 46},${hub.cy} Q${hub.cx + 90},${hub.cy} 616,${hub.cy}`;
  return (
    <div className="lp-hero-visual" aria-hidden="true">
      <svg viewBox="0 0 860 320" className="lp-hero-svg">
        {/* incoming papers — gently float, staggered so they don't move in sync */}
        <PaperGlyph x={14} y={30} rot={-7} tone="#e7e4fd" floatDelay={0} />
        <PaperGlyph x={2} y={128} rot={4} tone="#dcd7fb" floatDelay={0.7} />
        <PaperGlyph x={22} y={218} rot={-3} tone="#e7e4fd" floatDelay={1.4} />

        {/* converging lines: papers -> hub, each with a small dot on a
            continuous loop so papers visibly keep "flowing" into the
            pipeline instead of the scene going still after the intro. */}
        {[[80, 73], [68, 171], [88, 261]].map(([x, y], i) => {
          const d = `M${x},${y} Q${(x + hub.cx) / 2 + 30},${hub.cy} ${hub.cx - 46},${hub.cy}`;
          return (
            <g key={i}>
              <path className="lp-hv-line" style={{ animationDelay: `${i * 0.15}s` }} d={d} />
              <circle r="3.4" className="lp-hv-dot">
                <animateMotion dur="2.8s" repeatCount="indefinite" begin={`${1.2 + i * 0.7}s`} path={d} />
              </circle>
            </g>
          );
        })}

        {/* pipeline hub */}
        <circle cx={hub.cx} cy={hub.cy} r="46" fill="#fff" stroke="#5b4ff0" strokeWidth="1.6" />
        <circle className="lp-hv-pulse" cx={hub.cx} cy={hub.cy} r="46" fill="#5b4ff0" />
        <text x={hub.cx} y={hub.cy - 4} textAnchor="middle" className="lp-hv-hub-t">Sift</text>
        <text x={hub.cx} y={hub.cy + 13} textAnchor="middle" className="lp-hv-hub-s">agent pipeline</text>

        {/* six pipeline-stage nodes orbiting the hub, each breathing gently
            on its own offset so the ring reads as "actively working" */}
        {nodes.map((n, i) => (
          <g key={n.k}>
            <line x1={hub.cx} y1={hub.cy} x2={n.x} y2={n.y} className="lp-hv-spoke" />
            <circle cx={n.x} cy={n.y} r="15" fill="#f2f1fe" stroke="#c9c4f4" strokeWidth="1.3"
              className="lp-hv-node" style={{ animationDelay: `${0.5 + i * 0.1}s, ${1.2 + i * 0.3}s` }} />
            <text x={n.x} y={n.y + 4} textAnchor="middle" className="lp-hv-node-n">{i + 1}</text>
          </g>
        ))}

        {/* output line: hub -> cited review, with a brighter dot repeatedly
            carrying the "answer" out to the document */}
        <path className="lp-hv-line lp-hv-out" style={{ animationDelay: "0.9s" }} d={outD} />
        <circle r="4" className="lp-hv-dot lp-hv-dot-out">
          <animateMotion dur="1.7s" repeatCount="indefinite" begin="2.1s" path={outD} />
        </circle>

        {/* output document: the cited review */}
        <g transform="translate(618, 76)">
          <rect x="0" y="0" width="150" height="160" rx="10" fill="#fff" stroke="#5b4ff0" strokeWidth="1.6" />
          <path d="M0,10 a10,10 0 0 1 10,-10 h130 a10,10 0 0 1 10,10 v20 h-150 z" fill="#5b4ff0" />
          <text x="16" y="20" className="lp-hv-doc-t">Literature review</text>
          <rect x="16" y="46" width="118" height="5" rx="2.5" fill="#ded9f8" />
          <rect x="16" y="58" width="100" height="5" rx="2.5" fill="#ded9f8" />
          <rect x="16" y="70" width="112" height="5" rx="2.5" fill="#ded9f8" />
          <rect x="16" y="82" width="80" height="5" rx="2.5" fill="#ded9f8" />
          <g className="lp-hv-cite" style={{ animationDelay: "1.3s" }}>
            <rect x="16" y="104" width="26" height="16" rx="4" fill="#f2f1fe" stroke="#c9c4f4" strokeWidth="1" />
            <text x="29" y="115" textAnchor="middle" className="lp-hv-cite-t">[1]</text>
            <rect x="48" y="104" width="26" height="16" rx="4" fill="#f2f1fe" stroke="#c9c4f4" strokeWidth="1" />
            <text x="61" y="115" textAnchor="middle" className="lp-hv-cite-t">[2]</text>
            <rect x="80" y="104" width="26" height="16" rx="4" fill="#f2f1fe" stroke="#c9c4f4" strokeWidth="1" />
            <text x="93" y="115" textAnchor="middle" className="lp-hv-cite-t">[3]</text>
          </g>
          <text x="16" y="140" className="lp-hv-doc-check">✓ every claim cited</text>
        </g>
      </svg>
    </div>
  );
}

/* ── News with domain filters ─────────────────────────────────────────── */

function NewsSection() {
  const [domain, setDomain] = useState("All");
  const [items, setItems] = useState(NEWS);   // curated fallback until live loads
  const [live, setLive] = useState(false);
  const track = useRef(null);

  useEffect(() => {
    let alive = true;
    api.getNews().then((r) => {
      if (alive && r?.items?.length) { setItems(r.items); setLive(true); }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const domains = ["All", ...Array.from(new Set(items.map((n) => n.domain)))];
  const shown = domain === "All" ? items : items.filter((n) => n.domain === domain);

  // Scroll roughly one card's width at a time (measured from the first
  // card + its gap) rather than a fixed pixel guess, so it stays correct
  // whatever the viewport width does to card sizing.
  const scrollBy = (dir) => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector(".lp-news-card");
    const step = card ? card.getBoundingClientRect().width + 18 : el.clientWidth * 0.8;
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  return (
    <div className="lp-band" id="lp-news">
      <div className="lp-news-head">
        <div>
          <h2 className="lp-cat">News in AI-driven discovery</h2>
          <p className="lp-cat-sub" style={{ marginBottom: 0 }}>
            What's moving across biomedical, pharmaceutical and engineering research.
            {live && <span className="lp-live"> · updated daily</span>}
          </p>
        </div>
        <div className="lp-news-nav">
          <button className="lp-news-arrow" aria-label="Scroll left" onClick={() => scrollBy(-1)}>
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M15 4l-8 8 8 8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button className="lp-news-arrow" aria-label="Scroll right" onClick={() => scrollBy(1)}>
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
      <div className="lp-filters">
        {domains.map((d) => (
          <button key={d} className={"lp-filter" + (d === domain ? " on" : "")}
            onClick={() => setDomain(d)}>{d}</button>
        ))}
      </div>
      <div className="lp-news" ref={track}>
        {shown.map((n) => (
          <a className="lp-news-card" key={n.title} href={n.href} target="_blank" rel="noreferrer">
            <span className="lp-news-domain">{n.domain}</span>
            <div className="lp-news-t">{n.title}</div>
            <div className="lp-news-d">{n.desc}</div>
            <div className="lp-news-src">{n.source} ↗</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"lp-faq-item" + (open ? " on" : "")}>
      <button className="lp-faq-q" onClick={() => setOpen((v) => !v)}>
        <span>{q}</span><span className="lp-faq-x">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="lp-faq-a">{a}</div>}
    </div>
  );
}

/* ── Footer ───────────────────────────────────────────────────────────── */

// Set these in frontend/.env to point at your real pages:
//   VITE_TWITTER_URL=https://x.com/your-handle
//   VITE_LINKEDIN_URL=https://www.linkedin.com/company/your-page
const TWITTER_URL = import.meta.env.VITE_TWITTER_URL || "";
const LINKEDIN_URL = import.meta.env.VITE_LINKEDIN_URL || "";
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || "";

function SiteFooter({ setPage }) {
  return (
    <footer className="lp-footer">
      <div className="lp-footer-in">
        <div>
          <div className="lp-logo" style={{ cursor: setPage ? "pointer" : "default" }}
            onClick={() => setPage?.("home")}>
            <LogoMark /><span>Sift</span>
          </div>
          <div className="lp-foot-tag">Interactive Scientific AI Research Assistant</div>
          {setPage && (
            <div className="lp-foot-links">
              <button onClick={() => setPage("careers")}>Careers</button>
              <button onClick={() => setPage("about")}>About</button>
              <button onClick={() => setPage("pricing")}>Pricing</button>
            </div>
          )}
        </div>
        <div className="lp-socials">
          <a className={"lp-social" + (LINKEDIN_URL ? "" : " off")}
            href={LINKEDIN_URL || undefined} target="_blank" rel="noreferrer"
            title={LINKEDIN_URL || "Set VITE_LINKEDIN_URL in frontend/.env"} aria-label="LinkedIn">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4.98 3.5a2.5 2.5 0 11-.02 5 2.5 2.5 0 01.02-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-.95 1.83-1.95 3.76-1.95C20.5 8.75 21 11.1 21 14.2V21h-4v-6c0-1.43-.03-3.27-2-3.27-2 0-2.3 1.56-2.3 3.17V21H9z" />
            </svg>
            <span>LinkedIn</span>
          </a>
          <a className={"lp-social" + (TWITTER_URL ? "" : " off")}
            href={TWITTER_URL || undefined} target="_blank" rel="noreferrer"
            title={TWITTER_URL || "Set VITE_TWITTER_URL in frontend/.env"} aria-label="X / Twitter">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.22-6.82-5.96 6.82H1.68l7.73-8.84L1.25 2.25h6.82l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.11z" />
            </svg>
            <span>X / Twitter</span>
          </a>
          {CONTACT_EMAIL && (
            <a className="lp-social" href={`mailto:${CONTACT_EMAIL}`}><span>{CONTACT_EMAIL}</span></a>
          )}
        </div>
      </div>
      <div className="lp-foot-legal">
        © {new Date().getFullYear()} Sift · Built for researchers
      </div>
    </footer>
  );
}

/* ── Hypothesis Generation — auto-advancing closed-loop carousel ───────── */

function HypothesisSection({ login }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setI((n) => (n + 1) % LOOP.length), 5000);
    return () => clearInterval(t);
  }, [paused]);

  const stage = LOOP[i];
  return (
    <div className="lp-band" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <h2 className="lp-cat">Hypothesis Generation</h2>
      <p className="lp-cat-sub">
        Beyond reading the literature — close the loop between AI reasoning and the bench.
      </p>

      {/* loop navigator */}
      <div className="lp-loop">
        {LOOP.map((s, n) => (
          <React.Fragment key={s.key}>
            <button className={"lp-loop-node" + (n === i ? " on" : "")} onClick={() => setI(n)}>
              <span className="lp-loop-ic">{s.ic}</span>
              <span className="lp-loop-t">{s.key}</span>
              <span className="lp-loop-s">{s.sub}</span>
            </button>
            <span className="lp-loop-arrow" aria-hidden="true">{n === LOOP.length - 1 ? "↺" : "→"}</span>
          </React.Fragment>
        ))}
      </div>

      {/* slide */}
      <div className="lp-slide" key={stage.key}>
        <div className="lp-slide-copy">
          <div className="lp-step-tag">Stage {i + 1} of {LOOP.length}</div>
          <h3 className="lp-feat-title">{stage.title}</h3>
          <p className="lp-feat-body">{stage.body}</p>
          <ul className="lp-feat-list">
            {stage.points.map((p) => <li key={p}><span className="lp-check">✓</span>{p}</li>)}
          </ul>
          <button className="lp-learn" onClick={() => login("signup")}>Join the early access →</button>
        </div>
        <div className="lp-visual">{stage.visual}</div>
      </div>

      <div className="lp-dots">
        {LOOP.map((s, n) => (
          <button key={s.key} aria-label={s.key}
            className={"lp-dot" + (n === i ? " on" : "")} onClick={() => setI(n)} />
        ))}
      </div>
    </div>
  );
}

/* ── Feature visuals (lightweight mock UI) ────────────────────────────── */
// NOTE: these visuals are module-level JSX evaluated at import time, so every
// constant they reference (MOCK_PAPERS) must be declared ABOVE them.

// Deliberately spans a few different fields (structural biology, ML
// systems, multi-agent LLMs, climate) rather than five near-identical
// "LLM efficiency" papers — the point of this mock is to read as a live,
// current search, not a repeated fixture that goes stale in screenshots.
const MOCK_PAPERS = [
  { title: "AlphaFold3: Accurate Structure Prediction of Biomolecular Interactions", meta: "Abramson et al. · 2024 · Nature" },
  { title: "Mixture-of-Experts Routing at Trillion-Parameter Scale", meta: "2025 · arXiv" },
  { title: "Multi-Agent Debate Improves Factual Accuracy in LLMs", meta: "2025 · NeurIPS" },
  { title: "Foundation Models for Sub-Seasonal Climate Forecasting", meta: "2025 · Nature Geoscience" },
  { title: "Scaling Laws for Long-Context Retrieval-Augmented Generation", meta: "2025 · ACL" },
];

const GatherVisual = (
  <div className="lp-papers" aria-hidden="true">
    <div className="lp-mock-head">
      <span className="lp-dot-ok">✓</span> Found 50 papers
      <span className="lp-mock-sub"> ranked by relevance to your topic</span>
    </div>
    <div className="lp-track">
      {[...MOCK_PAPERS, ...MOCK_PAPERS].map((p, i) => (
        <div className="lp-paper" key={i}>
          <span className="num">[{(i % MOCK_PAPERS.length) + 1}]</span>
          <div>
            <div className="t">{p.title}</div>
            <div className="m">{p.meta}</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const FilterVisual = (
  <div className="lp-card" aria-hidden="true">
    <div className="lp-mock-head">Filter sources <span className="lp-pill">human in the loop · 42/50</span></div>
    {[["AlphaFold3: Structure Prediction", true], ["Multi-Agent Debate Improves Accuracy", true],
      ["Unrelated Retracted Preprint", false], ["Sub-Seasonal Climate Forecasting", true]].map(([t, on]) => (
      <div className={"lp-row" + (on ? "" : " off")} key={t}>
        <span className={"lp-tick" + (on ? " on" : "")}>{on ? "✓" : "×"}</span>
        <span className="t">{t}</span>
      </div>
    ))}
  </div>
);

const ExtractVisual = (
  <div className="lp-card" aria-hidden="true">
    <div className="lp-mock-head">Extracted fields</div>
    <table className="lp-tbl">
      <thead><tr><th>#</th><th>Method</th><th>Key finding</th></tr></thead>
      <tbody>
        <tr><td>[1]</td><td>Diffusion + MSA</td><td>Predicts protein–ligand complexes</td></tr>
        <tr><td>[2]</td><td>Sparse MoE routing</td><td>4× throughput at same accuracy</td></tr>
        <tr><td>[3]</td><td>Multi-agent debate</td><td>+11pt factual accuracy</td></tr>
      </tbody>
    </table>
  </div>
);

const WriteVisual = (
  <div className="lp-card" aria-hidden="true">
    <div className="lp-mock-head">Literature review · draft</div>
    <div className="lp-prose">
      <p>Structure-prediction models have converged on diffusion-based architectures
      that jointly model proteins, ligands and nucleic acids <em>[1]</em>. In parallel,
      sparse routing has become the default path to scaling inference efficiently
      <em>[2]</em>, while multi-agent debate improves factual reliability without
      retraining the base model <em>[3]</em>.</p>
      <div className="lp-skel" /><div className="lp-skel" style={{ width: "82%" }} />
      <div className="lp-skel" style={{ width: "91%" }} />
    </div>
    <div className="lp-exports">
      <span className="lp-chip">Word</span><span className="lp-chip">PDF</span>
      <span className="lp-chip">LaTeX</span><span className="lp-chip">BibTeX</span>
    </div>
  </div>
);

const ChatVisual = (
  <div className="lp-card" aria-hidden="true">
    <div className="lp-mock-head">Chat · source [1]</div>
    <div className="lp-bubble user">How does it handle ligand binding?</div>
    <div className="lp-bubble bot">
      It jointly diffuses atom positions for the protein <b>and</b> ligand, letting the
      model learn binding geometry directly instead of docking afterward (Fig. 2).
    </div>
    <div className="lp-chips">
      <span className="lp-chip on">Quick · free</span><span className="lp-chip">Deep</span>
    </div>
  </div>
);

/* Hypothesis-generation stage visuals */

const HypoVisual = (
  <div className="lp-card lp-lab" aria-hidden="true">
    <div className="lp-mock-head">Research Assistant · protocol design</div>
    <div className="lp-hyp-title">mRNA optimization during protein translation</div>
    <div className="lp-hyp-lbl">Optimization protocol</div>
    {["Codon Adaptability Index (CAI)", "GC content balance", "Secondary structure stability"].map((t) => (
      <div className="lp-hyp-row" key={t}><span className="lp-hyp-b" />{t}</div>
    ))}
    <div className="lp-hyp-out">Detailed experimental protocol →</div>
  </div>
);

const RoboVisual = (
  <div className="lp-card lp-lab" aria-hidden="true">
    <div className="lp-mock-head">Execution unit · lab robot at the bench</div>
    <svg viewBox="0 0 260 190" className="lp-robo">
      {/* bench */}
      <rect x="6" y="150" width="248" height="20" rx="6" fill="var(--lp-soft)" stroke="var(--lp-line)" strokeWidth="1.5" />

      {/* beakers with liquid, right side of the bench */}
      <path d="M196 118h20l4 32a4 4 0 0 1-4 5h-20a4 4 0 0 1-4-5z" fill="none" stroke="#c9cdfb" strokeWidth="2" />
      <path d="M194 138h24v13a4 4 0 0 1-4 4h-16a4 4 0 0 1-4-4z" fill="#e0a33e" opacity=".85" />
      <path d="M224 122h16l3 28a3.5 3.5 0 0 1-3.5 4.4h-15a3.5 3.5 0 0 1-3.5-4.4z" fill="none" stroke="#c9cdfb" strokeWidth="2" />
      <path d="M222.5 138h19v9a3.5 3.5 0 0 1-3.5 3.5h-12a3.5 3.5 0 0 1-3.5-3.5z" fill="#5eb37c" opacity=".85" />

      {/* well plate, left/center of the bench */}
      <rect x="14" y="152" width="150" height="16" rx="5" fill="var(--lp-soft)" stroke="var(--lp-line)" strokeWidth="1.2" />
      <g fill="var(--lp-indigo)" opacity="0.32">
        {Array.from({ length: 11 }).map((_, n) => (
          <circle key={n} cx={24 + n * 13} cy={160} r="3" className="lp-robo-well" style={{ animationDelay: `${n * 0.15}s` }} />
        ))}
      </g>

      {/* humanoid, leaning over the bench to run the plate */}
      <g className="lp-robo-figure">
        <path d="M56 150c-2-34 6-58 24-58s26 24 24 58z" fill="var(--lp-ink)" />
        <rect x="68" y="108" width="24" height="16" rx="4" fill="var(--lp-indigo)" opacity=".9" />
        <rect x="70" y="66" width="20" height="30" rx="6" fill="var(--lp-ink)" />
        <g className="lp-robo-head">
          <circle cx="80" cy="58" r="19" fill="var(--lp-ink)" />
          <rect x="67" y="52" width="26" height="10" rx="5" fill="#8de1ff" />
        </g>
        <path d="M58 118c-10 4-16 14-16 28" fill="none" stroke="var(--lp-ink)" strokeWidth="11" strokeLinecap="round" />
        <g className="lp-robo-arm">
          <path d="M100 118c14 6 20 20 16 40" fill="none" stroke="var(--lp-ink)" strokeWidth="11" strokeLinecap="round" />
          <g className="lp-robo-hand">
            <circle cx="116" cy="158" r="6" fill="var(--lp-indigo)" />
            <rect x="113.5" y="158" width="5" height="16" rx="2.5" fill="#9fa4ff" />
          </g>
        </g>
      </g>

      {/* pulse marking the well currently being sampled */}
      <circle cx="99" cy="160" r="4" fill="none" stroke="var(--lp-indigo)" strokeWidth="1.6" className="lp-robo-pulse" />
    </svg>
    <div className="lp-hyp-out">Compiler-verified · zero ambiguity</div>
  </div>
);

const FeedbackVisual = (
  <div className="lp-card lp-lab" aria-hidden="true">
    <div className="lp-mock-head">Data feedback · iteration 3</div>
    <svg viewBox="0 0 260 110" className="lp-chart">
      <polyline className="lp-line" points="6,92 44,80 82,60 120,52 158,34 196,26 234,14" />
      {[[6, 92], [44, 80], [82, 60], [120, 52], [158, 34], [196, 26], [234, 14]].map(([x, y], n) => (
        <circle key={n} cx={x} cy={y} r="3.4" className="lp-pt" style={{ animationDelay: `${n * 0.18}s` }} />
      ))}
    </svg>
    <div className="lp-hyp-row"><span className="lp-hyp-b" />Yield improving each cycle</div>
    <div className="lp-hyp-out">Model updated → next hypothesis</div>
  </div>
);

const LOOP = [
  {
    key: "AI Hypothesis", sub: "Literature & predictive AI", ic: "◇",
    title: "AI hypothesis & method design",
    body: "The same agent that read your literature proposes what to test next. It scans prior assay databases alongside the papers, then formulates optimal reaction conditions as a structured, executable protocol.",
    points: [
      "Combinatorial design search across cofactors, buffers and concentrations",
      "Schema validation against biological constraints — no non-viable designs",
      "Bayesian optimization: maximum information per experiment",
    ],
    visual: HypoVisual,
  },
  {
    key: "Execution", sub: "Protocol & robotics", ic: "⬡",
    title: "Compiler-verified experimental validation",
    body: "Natural-language procedures are compiled into deterministic, physical-unit specifications and checked before anything moves — then executed on standard benchtop equipment.",
    points: [
      "Protocol compiler verifies units and safety pre-execution",
      "High-precision multi-well pipetting with liquid verification",
      "Replaces ambiguous SOPs with checked execution paths",
    ],
    visual: RoboVisual,
  },
  {
    key: "Data Feedback", sub: "Closed-loop optimization", ic: "◎",
    title: "Real-time data analysis & model feedback",
    body: "Results stream straight back into the model. Each cycle sharpens the next hypothesis, compressing design-test-analyze iterations that used to take weeks.",
    points: [
      "Multimodal streaming: titers, pH shifts, standard curves, lot numbers",
      "Anomaly detection for bubbles, drift and handling errors",
      "Iterations in under an hour — the loop never waits on a human",
    ],
    visual: FeedbackVisual,
  },
];

/* Publications from this project. Add `href` once a paper is public. */
const PUBS = [
  {
    kind: "White paper", status: "In preparation", state: "wip",
    title: "Sift: a multi-agent architecture for automated literature review",
    desc: "System design across query reformulation, multi-source retrieval, relevance ranking, structured extraction, critique and cited writing — with cost and latency benchmarks per stage.",
    href: null,
  },
  {
    kind: "Technical report", status: "In progress", state: "wip",
    title: "Token-efficient multi-agent pipelines: routing, caching and retrieval",
    desc: "How per-purpose model routing, prompt caching and passage retrieval reduced cost per review by an order of magnitude without measurable quality loss.",
    href: null,
  },
  {
    kind: "Concept paper", status: "Draft", state: "draft",
    title: "Closed-loop autonomous laboratories: from hypothesis to assay and back",
    desc: "Coupling generative reasoning with compiler-verified protocols and robotic execution to compress design–test–analyze cycles.",
    href: null,
  },
];

/* Curated external news. Sources verified July 2026. */
const NEWS = [
  {
    domain: "Pharmaceutical",
    title: "First generative-AI-discovered drug posts Phase IIa results",
    desc: "Insilico Medicine's rentosertib — target and compound both AI-identified — improved lung function by 98.4 mL vs a 20.3 mL decline on placebo in a 71-patient IPF trial, published in Nature Medicine.",
    source: "Nature Medicine / Insilico",
    href: "https://aimmediahouse.com/ai-lifesciences/2026-is-the-year-ai-drug-discovery-meets-clinical-reality",
  },
  {
    domain: "Pharmaceutical",
    title: "200+ AI-discovered drugs now in clinical development",
    desc: "94 in Phase 1, 56 in Phase 2 and 15 in Phase 3 as of early 2026, with 15–20 programs expected to enter pivotal Phase III trials this year — the real test of AI-led discovery.",
    source: "Axis Intelligence",
    href: "https://axis-intelligence.com/ai-drug-discovery-2026-complete-analysis/",
  },
  {
    domain: "Materials",
    title: "Argonne's Polybot brings autonomous discovery to materials science",
    desc: "An AI-driven robotic lab at the Center for Nanoscale Materials plans, runs and analyses its own experiments — a working self-driving laboratory for materials research.",
    source: "Argonne National Laboratory",
    href: "https://www.anl.gov/article/selfdriving-lab-transforms-materials-discovery",
  },
  {
    domain: "Chemistry",
    title: "Self-driving labs are changing how chemists work",
    desc: "Autonomous platforms have reached maturity on the lab floor in 2026, as cloud computing, robotics and chemistry-specific AI converge — some completing in a day what took weeks.",
    source: "C&EN",
    href: "https://cen.acs.org/physical-chemistry/computational-chemistry/Self-driving-labs-changing-chemists/104/web/2026/06",
  },
  {
    domain: "Engineering",
    title: "AI and robotics accelerate thin-film and catalyst research",
    desc: "Linked laboratory tasks are being automated to raise the speed, precision and throughput of materials research, including thin-film semiconductors and catalytic nanomaterials.",
    source: "National Laboratory of the Rockies",
    href: "https://www.nlr.gov/news/detail/program/2026/ai-and-robotics-are-speeding-up-discovery-at-national-laboratory-of-the-rockies",
  },
  {
    domain: "Methods",
    title: "Toward self-driving laboratory 2.0 for chemistry and materials",
    desc: "A review of where autonomous experimentation goes next: tighter model–instrument coupling, shared protocol standards and multi-agent orchestration.",
    source: "PubMed",
    href: "https://pubmed.ncbi.nlm.nih.gov/41804871/",
  },
];

const FAQ = [
  {
    q: "Where do the papers come from?",
    a: "Every result is a real record pulled live from Semantic Scholar, arXiv, OpenAlex and PubMed — never generated from a model's memory. Results are then ranked by relevance to your question rather than by citation count alone.",
  },
  {
    q: "Can it invent citations?",
    a: "No. The writer only cites papers that came back from those databases and that you approved, and every extracted claim is grounded in the paper's own text. If something isn't in the source, the assistant says so instead of guessing.",
  },
  {
    q: "Do I stay in control of which papers are used?",
    a: "Yes. After the search you review every candidate with its abstract and approve or remove it. You can also add a specific paper by DOI, arXiv ID or title, and regenerate the review at any point.",
  },
  {
    q: "Does it read the full paper or just the abstract?",
    a: "Both, depending on mode. Lite and Medium work from abstracts for speed and cost; Deep fetches the full open-access PDF and reads it end to end, including figures and tables.",
  },
  {
    q: "What does it cost to run?",
    a: "The free tier covers small reviews. Beyond that, cost scales with depth — the app shows exact token usage and dollar cost per run, broken down by pipeline stage and model, so there are no surprises.",
  },
  {
    q: "Who owns my data?",
    a: "You do. Your searches, notes and reviews are stored against your account, and you can permanently delete everything from the account menu at any time.",
  },
];

const ProjectsIcon = (
  <svg viewBox="0 0 20 20" width="22" height="22" fill="none">
    <circle cx="7.4" cy="10" r="5.4" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="12.6" cy="10" r="5.4" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const ScholarIcon = (
  <svg viewBox="0 0 20 20" width="22" height="22" fill="none">
    <path d="M8.2 11.8l3.6-3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9.6 6.4l1-1a3.1 3.1 0 014.4 4.4l-1 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M10.4 13.6l-1 1a3.1 3.1 0 01-4.4-4.4l1-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const AuditIcon = (
  <svg viewBox="0 0 20 20" width="22" height="22" fill="none">
    <path d="M10 2.6l6 2.2v4.5c0 3.9-2.6 6.8-6 8.1-3.4-1.3-6-4.2-6-8.1V4.8z"
      stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M7.2 10.1l2 2 3.6-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const COLLAB = [
  { ic: ProjectsIcon, t: "Shared research projects", d: "Create a project for a specific question and bring your collaborators into the same sources, notes and review." },
  { ic: ScholarIcon, t: "Connected scholar profiles", d: "Link Google Scholar and ORCID so contributions and citations map to real researcher identities." },
  { ic: AuditIcon, t: "Reproducible by default", d: "Every claim traces to a numbered source, so a colleague can audit exactly how a conclusion was reached." },
];

const STEPS = [
  { k: "Ask", d: "Your research question" },
  { k: "Search", d: "Ranked by relevance" },
  { k: "Filter", d: "You approve sources" },
  { k: "Extract", d: "Structured findings" },
  { k: "Critique", d: "Themes & gaps" },
  { k: "Write", d: "Cited review" },
];

// Which FEATURES[] detail section each pipeline step scrolls to when
// clicked. Ask/Search both live under "Gather papers"; Critique/Write both
// live under "Write the review" — the two arrays don't have a 1:1 length,
// so this maps step index -> feature index explicitly instead of assuming.
const STEP_FEATURE_MAP = [0, 0, 1, 2, 3, 3];

const FEATURES = [
  {
    title: "Gather papers",
    body: "Ask a question in plain language. Sift reformulates it into precise search queries, then searches Semantic Scholar, arXiv, OpenAlex and PubMed at once — ranking results by relevance to your topic, not just citation count.",
    points: ["Four databases in one search", "Relevance-first ranking", "Up to 100 papers per review"],
    visual: GatherVisual,
  },
  {
    title: "Filter papers",
    body: "You stay in the loop. Review every candidate with its abstract, keep what's relevant, drop what isn't — and let AI triage each paper against your review scope when you want a second opinion.",
    points: ["Human-in-the-loop approval", "AI relevance triage per paper", "Add papers by DOI, arXiv ID or title"],
    visual: FilterVisual,
  },
  {
    title: "Extract findings",
    body: "Every kept paper is read and distilled into a structured row — method, key finding, metrics, limitations and contribution — so you can compare an entire corpus at a glance instead of reading linearly.",
    points: ["Full-text PDF reading in Deep mode", "Side-by-side comparison table", "Cached — never pay to read twice"],
    visual: ExtractVisual,
  },
  {
    title: "Write the review",
    body: "The writer agent drafts a structured, IEEE-cited literature review from your approved sources — introduction, thematic synthesis, gaps and future directions — with every claim traceable to a numbered paper.",
    points: ["Inline [n] citations", "Themes, consensus and gaps detected first", "Export to Word, PDF, LaTeX and BibTeX"],
    visual: WriteVisual,
  },
  {
    title: "Chat with any paper",
    body: "Ask a specific paper anything. Quick mode answers instantly from cached extractions at no cost; Deep mode re-reads the full PDF for thorough, reasoned answers — and you can attach a figure to discuss it.",
    points: ["Quick (free) and Deep (thorough) modes", "Grounded in the paper — no invented facts", "Chat history saved per paper"],
    visual: ChatVisual,
  },
];

/* ── Pricing ──────────────────────────────────────────────────────────── */

const PLANS = [
  {
    name: "Free", price: "$0", per: "forever",
    blurb: "Explore the full pipeline on small reviews.",
    features: ["Up to 20 papers per review", "Lite search mode", "Abstract-level extraction",
               "Paper chat (Quick mode)", "Export Markdown & BibTeX"],
    cta: "Start free", highlight: false,
  },
  {
    name: "Pro", price: "$10", per: "per month",
    blurb: "For active researchers running regular reviews.",
    features: ["Up to 100 papers per review", "Medium & Deep search modes", "Full-text PDF reading",
               "Paper chat (Quick + Deep)", "Saved history & usage analytics", "Word, PDF & LaTeX export"],
    cta: "Get Pro", highlight: true,
  },
  {
    name: "Max", price: "$16", per: "per month",
    blurb: "Maximum depth, for labs and heavy users.",
    features: ["Everything in Pro", "Highest-tier writing models", "Priority processing",
               "Research methods generation", "Data analysis & hypothesis tools", "Priority support"],
    cta: "Get Max", highlight: false,
  },
];

function Pricing({ login }) {
  return (
    <section className="lp-pricing">
      <h1 className="lp-p-title">Pricing</h1>
      <p className="lp-p-sub">Start free. Upgrade when your reviews get bigger.</p>

      <div className="lp-plans">
        {PLANS.map((p) => (
          <div key={p.name} className={"lp-plan" + (p.highlight ? " hot" : "")}>
            {p.highlight && <div className="lp-badge">Most popular</div>}
            <div className="lp-plan-name">{p.name}</div>
            <div className="lp-price">
              {p.price}<span className="lp-per"> / {p.per}</span>
            </div>
            <div className="lp-plan-blurb">{p.blurb}</div>
            <button className={p.highlight ? "lp-cta full" : "lp-cta-2 full"} onClick={() => login("signup")}>{p.cta}</button>
            <ul className="lp-plan-list">
              {p.features.map((f) => (
                <li key={f}><span className="lp-check">✓</span>{f}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="lp-p-foot">All plans include unlimited searches. Cancel anytime.</p>
    </section>
  );
}

/* ── Careers ──────────────────────────────────────────────────────────── */

const WHY_SIFT = [
  { t: "Small team, real ownership", d: "Every hire shapes the product roadmap directly — no layers between you and what ships." },
  { t: "Build for working scientists", d: "You're designing for people running actual literature reviews, not a hypothetical user persona." },
  { t: "Move at research speed", d: "We ship weekly. Ideas go from a conversation to something a researcher can use in days." },
];

function CareersPage() {
  return (
    <section className="lp-pricing">
      <h1 className="lp-p-title">Careers at Sift</h1>
      <p className="lp-p-sub">
        We're building the tools we wish existed when we were doing research ourselves —
        and we're just getting started.
      </p>

      <div className="lp-tri" style={{ textAlign: "left", marginBottom: 56 }}>
        {WHY_SIFT.map((w) => (
          <div className="lp-tile" key={w.t}>
            <div className="lp-tile-t">{w.t}</div>
            <div className="lp-tile-d">{w.d}</div>
          </div>
        ))}
      </div>

      <div className="lp-openroles">
        <h2 className="lp-cat" style={{ textAlign: "left" }}>Open roles</h2>
        <div className="lp-empty-card">
          <p>
            No open roles posted right now — Sift is a small team and we hire deliberately.
            If you're a researcher or engineer who cares about making science move faster,
            we'd still like to hear from you.
          </p>
          {CONTACT_EMAIL
            ? <a className="lp-cta" href={`mailto:${CONTACT_EMAIL}?subject=Interested in Sift`}>Say hello →</a>
            : <span className="lp-pub-soon">Set VITE_CONTACT_EMAIL to enable this link</span>}
        </div>
      </div>
    </section>
  );
}

/* ── About ────────────────────────────────────────────────────────────── */

const ABOUT_TABS = [
  { id: "about-team", label: "Team" },
  { id: "about-contact", label: "Contact us" },
  { id: "about-blog", label: "Blog" },
];

function AboutPage() {
  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <section className="lp-pricing" style={{ paddingBottom: 0 }}>
      <BrandMark width={148} />
      <h1 className="lp-p-title" style={{ marginTop: 18 }}>About Orcus Intelligence Labs</h1>
      <p className="lp-p-sub">
        Orcus Intelligence Labs builds Sift — a multi-agent research assistant for people who
        read papers for a living. We're small, independent, and focused on one problem.
      </p>
      <p className="lp-mark-caption">
        Our mark: two ideas in balance — human judgment on one side, AI on the other. Sift
        doesn't replace the researcher's read of the literature; it holds up its end of the
        scale so you can do yours faster.
      </p>

      <div className="lp-filters" style={{ justifyContent: "center", margin: "0 0 40px" }}>
        {ABOUT_TABS.map((t) => (
          <button key={t.id} className="lp-filter" onClick={() => jump(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="lp-band" id="about-team" style={{ textAlign: "left" }}>
        <h2 className="lp-cat">Team</h2>
        <p className="lp-cat-sub">
          Sift is built by a small, hands-on team of researchers and engineers — everyone here
          also uses the product to do their own literature reviews. Full team profiles are coming
          soon; in the meantime, the fastest way to meet us is to say hello.
        </p>
        <a className="lp-learn" onClick={() => jump("about-contact")}>Get in touch →</a>
      </div>

      <div className="lp-band" id="about-contact" style={{ textAlign: "left" }}>
        <h2 className="lp-cat">Contact us</h2>
        <p className="lp-cat-sub">
          Questions, feedback, partnership ideas, or just want to talk about the product —
          reach out any time.
        </p>
        <div className="lp-contact-row">
          {CONTACT_EMAIL && (
            <a className="lp-cta" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          )}
          {LINKEDIN_URL && (
            <a className="lp-cta-2" href={LINKEDIN_URL} target="_blank" rel="noreferrer">LinkedIn ↗</a>
          )}
        </div>
      </div>

      <div className="lp-band" id="about-blog" style={{ textAlign: "left" }}>
        <h2 className="lp-cat">Blog</h2>
        <p className="lp-cat-sub">Notes on building Sift and what we're learning from researchers who use it.</p>
        <div className="lp-empty-card">
          <p>No posts yet — check back soon, or follow along on LinkedIn.</p>
        </div>
      </div>
    </section>
  );
}

/* ── Styles (scoped, always light) ────────────────────────────────────── */

function LandingStyles() {
  return (
    <style>{`
      html { scroll-behavior: smooth; }
      .lp-root {
        --lp-ink: #14161c; --lp-muted: #5c6373; --lp-muted2: #8b91a2;
        --lp-line: #e5e7ec; --lp-indigo: #5b4ff0; --lp-soft: #f2f1fe; --lp-bg2: #fafbfc;
        background: #fff; color: var(--lp-ink); min-height: 100vh;
        font-family: 'Space Grotesk', system-ui, sans-serif;
        scroll-behavior: smooth;
      }
      .lp-root button { font-family: inherit; }

      .lp-bar { position: sticky; top: 0; z-index: 30; background: rgba(255,255,255,.86);
        backdrop-filter: blur(10px); border-bottom: 1px solid var(--lp-line); }
      .lp-bar-in { max-width: 1140px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 26px; }
      .lp-logo { font-weight: 700; font-size: 19px; letter-spacing: -.01em; cursor: pointer;
        display: flex; align-items: center; gap: 9px; }
      .lp-logomark { position: relative; width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0;
        background: linear-gradient(135deg, var(--lp-indigo), #8f83f7);
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 3px 10px rgba(91,79,240,.32); }
      .lp-logomark-spark { position: absolute; top: -4px; right: -4px;
        animation: lp-hv-pulse 2.6s ease-in-out infinite; }
      .lp-nav { display: flex; align-items: center; gap: 2px; }
      .lp-link, .lp-dd-btn { background: none; border: none; cursor: pointer; font-size: 14px;
        font-weight: 500; color: var(--lp-muted); padding: 9px 12px; border-radius: 8px;
        transition: color .15s ease, background .15s ease; }
      .lp-dd-btn { display: inline-flex; align-items: center; gap: 6px; }
      .lp-link:hover, .lp-dd-btn:hover, .lp-dd-btn[aria-expanded="true"] { color: var(--lp-ink); background: var(--lp-bg2); }
      .lp-dd { position: relative; }
      .lp-caret { color: var(--lp-muted2); transition: transform .18s ease; }
      .lp-caret.up { transform: rotate(180deg); }
      .lp-dd-menu { position: absolute; top: calc(100% + 10px); left: 0; width: 340px; background: #fff;
        border: 1px solid var(--lp-line); border-radius: 14px; padding: 7px;
        box-shadow: 0 16px 40px rgba(20,22,28,.12); animation: lp-dd-in .16s ease; }
      @keyframes lp-dd-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
      .lp-dd-item { display: flex; align-items: flex-start; gap: 11px; width: 100%; text-align: left;
        background: none; border: none; cursor: pointer; padding: 10px 11px; border-radius: 10px; }
      .lp-dd-item:hover { background: var(--lp-soft); }
      .lp-dd-item:hover .lp-dd-ic { background: var(--lp-indigo); color: #fff; }
      .lp-dd-ic { flex-shrink: 0; width: 30px; height: 30px; border-radius: 8px; background: var(--lp-soft);
        color: var(--lp-indigo); display: flex; align-items: center; justify-content: center;
        transition: background .15s ease, color .15s ease; }
      .lp-dd-label { font-size: 14px; font-weight: 600; color: var(--lp-ink); }
      .lp-dd-desc { font-size: 12.5px; color: var(--lp-muted); margin-top: 2px; line-height: 1.4; }
      .lp-bar-cta { margin-left: auto; display: flex; align-items: center; gap: 10px; }
      .lp-ghost { font-size: 13.5px; font-weight: 600; color: var(--lp-ink); background: transparent;
        border: 1px solid var(--lp-line); border-radius: 9px; padding: 8px 14px; cursor: pointer;
        transition: background .15s ease, border-color .15s ease; }
      .lp-ghost:hover { background: var(--lp-bg2); border-color: #d4d6dd; }
      .lp-solid { font-size: 13.5px; font-weight: 600; color: #fff; background: var(--lp-indigo);
        border: 1px solid var(--lp-indigo); border-radius: 9px; padding: 8px 16px; cursor: pointer;
        box-shadow: 0 2px 8px rgba(91,79,240,.22); transition: filter .15s ease, transform .15s ease; }
      .lp-solid:hover { filter: brightness(1.07); transform: translateY(-1px); }

      .lp-hero { max-width: 980px; margin: 0 auto; padding: 92px 24px 70px; text-align: center; }
      .lp-h1 { font-weight: 700; letter-spacing: -.025em; color: var(--lp-ink);
        font-size: clamp(38px, 6.4vw, 72px); line-height: 1.05; margin: 0 0 20px; }
      .lp-sub { font-size: clamp(16px, 2.1vw, 21px); color: var(--lp-muted);
        max-width: 640px; margin: 0 auto 34px; line-height: 1.5; }
      .lp-cta-row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
      .lp-cta { font-size: 15px; font-weight: 600; color: #fff; background: var(--lp-indigo);
        border: 1px solid var(--lp-indigo); border-radius: 11px; padding: 13px 26px; cursor: pointer; }
      .lp-cta:hover { filter: brightness(1.07); }
      .lp-cta-2 { font-size: 15px; font-weight: 600; color: var(--lp-ink); background: #fff;
        border: 1px solid var(--lp-line); border-radius: 11px; padding: 13px 24px; cursor: pointer; }
      .lp-cta-2:hover { background: var(--lp-bg2); }
      .lp-cta.full, .lp-cta-2.full { display: block; width: 100%; margin: 16px 0 0; }
      .lp-note { margin-top: 16px; font-size: 12.5px; color: var(--lp-muted2); }
      .lp-pricing-link { display: block; margin: 10px auto 0; background: none; border: none;
        cursor: pointer; font-size: 13px; font-weight: 600; color: var(--lp-indigo);
        padding: 2px 0; }
      .lp-pricing-link:hover { text-decoration: underline; }

      /* hero illustration: papers -> pipeline -> cited review */
      .lp-hero-visual { max-width: 860px; margin: 56px auto 0; }
      .lp-hero-svg { width: 100%; height: auto; display: block; overflow: visible; }
      @media (max-width: 640px) { .lp-hero-visual { display: none; } }
      .lp-hv-line { fill: none; stroke: #c9c4f4; stroke-width: 2; stroke-linecap: round;
        stroke-dasharray: 420; stroke-dashoffset: 420; animation: lp-hv-draw 1.1s ease forwards; }
      .lp-hv-line.lp-hv-out { stroke: var(--lp-indigo); stroke-width: 2.4; }
      @keyframes lp-hv-draw { to { stroke-dashoffset: 0; } }
      .lp-hv-pulse { fill: var(--lp-indigo); opacity: .16; transform-box: fill-box; transform-origin: 50% 50%;
        animation: lp-hv-pulse 2.6s ease-in-out infinite; }
      @keyframes lp-hv-pulse { 0%, 100% { transform: scale(1); opacity: .16; } 50% { transform: scale(1.12); opacity: .05; } }
      .lp-hv-hub-t { font-weight: 700; font-size: 16px; fill: var(--lp-indigo); font-family: 'Space Grotesk', sans-serif; }
      .lp-hv-hub-s { font-size: 8px; fill: var(--lp-muted2); font-family: 'JetBrains Mono', monospace;
        letter-spacing: .04em; text-transform: uppercase; }
      .lp-hv-spoke { stroke: #ece9fb; stroke-width: 1.3; }
      /* two animations: the one-time pop-in (opacity, plays once) and an
         infinite gentle breathing pulse (transform, never stops) — kept on
         separate properties so they don't fight each other. */
      .lp-hv-node { opacity: 0; transform-box: fill-box; transform-origin: 50% 50%;
        animation: lp-hv-pop .4s ease forwards, lp-hv-node-breathe 3.4s ease-in-out infinite; }
      @keyframes lp-hv-pop { to { opacity: 1; } }
      @keyframes lp-hv-node-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.16); } }
      .lp-hv-node-n { font-size: 10px; font-weight: 700; fill: var(--lp-indigo); font-family: 'JetBrains Mono', monospace; }
      /* traveling dots along the connecting lines — the continuous "papers
         flowing in, answer flowing out" motion that was missing before */
      .lp-hv-dot { fill: var(--lp-indigo); opacity: 0; animation: lp-hv-dot-fade 2.8s ease-in-out infinite; }
      .lp-hv-dot-out { fill: #7c6ef0; animation-duration: 1.7s; }
      @keyframes lp-hv-dot-fade { 0%, 6% { opacity: 0; } 14%, 78% { opacity: 1; } 92%, 100% { opacity: 0; } }
      /* gentle continuous float on each incoming paper, staggered per glyph
         via inline animation-delay so the three don't move in lockstep */
      .lp-hv-paper { animation: lp-hv-float 3.6s ease-in-out infinite;
        transform-box: fill-box; transform-origin: 50% 50%; }
      @keyframes lp-hv-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
      .lp-hv-doc-t { font-size: 11.5px; font-weight: 700; fill: #fff; font-family: 'Space Grotesk', sans-serif; }
      .lp-hv-cite { opacity: 0; animation: lp-hv-pop .4s ease forwards; }
      .lp-hv-cite-t { font-size: 9px; font-weight: 600; fill: var(--lp-indigo); font-family: 'JetBrains Mono', monospace; }
      .lp-hv-doc-check { font-size: 10.5px; fill: #2e9e5b; font-weight: 600; font-family: 'Space Grotesk', sans-serif; }

      .lp-reveal { opacity: 0; transform: translateY(22px);
        transition: opacity .6s ease, transform .6s ease; }
      .lp-reveal-in { opacity: 1; transform: translateY(0); }
      @media (prefers-reduced-motion: reduce) {
        .lp-reveal { opacity: 1; transform: none; transition: none; }
      }

      .lp-section { max-width: 1140px; margin: 0 auto; padding: 40px 24px 60px; }
      .lp-ads-label { text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 11.5px;
        letter-spacing: .14em; text-transform: uppercase; color: var(--lp-muted2); margin-bottom: 30px; }
      .lp-cat { font-weight: 700; font-size: 27px; margin: 0 0 6px; }
      .lp-cat-sub { color: var(--lp-muted); font-size: 15px; margin: 0 0 28px; }
      /* pipeline steps — clickable, hover-lifts, jumps to its detail
         section below (see STEP_FEATURE_MAP). */
      .lp-steps { display: flex; align-items: stretch; gap: 6px; flex-wrap: wrap;
        justify-content: center; margin: 0 0 64px; }
      .lp-step { position: relative; flex: 1 1 140px; min-width: 132px; border: 1px solid var(--lp-line);
        border-radius: 12px; padding: 14px 14px 16px; background: #fff; text-align: center;
        text-decoration: none; color: inherit; display: block; cursor: pointer;
        transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
      .lp-step:hover, .lp-step:focus-visible { transform: translateY(-4px);
        border-color: var(--lp-indigo); box-shadow: 0 10px 24px rgba(84,70,224,.14); }
      .lp-step:hover .lp-step-n { background: var(--lp-indigo); color: #fff; }
      .lp-step:hover .lp-step-ic { color: #fff; background: var(--lp-indigo); }
      .lp-step-ic { position: absolute; top: 10px; right: 10px; width: 26px; height: 26px;
        border-radius: 50%; background: var(--lp-soft); color: var(--lp-indigo);
        display: flex; align-items: center; justify-content: center;
        transition: background .18s ease, color .18s ease; }
      .lp-step-ic svg { width: 13px; height: 13px; }
      .lp-step-ic-ring { position: absolute; inset: -4px; border-radius: 50%;
        border: 1.4px solid var(--lp-indigo); opacity: 0;
        animation: lp-step-ic-pulse 3.2s ease-out infinite; }
      @keyframes lp-step-ic-pulse { 0% { opacity: .55; transform: scale(.8); }
        100% { opacity: 0; transform: scale(1.55); } }
      .lp-step-n { width: 24px; height: 24px; line-height: 24px; border-radius: 50%;
        background: var(--lp-soft); color: var(--lp-indigo); font-size: 12px; font-weight: 700;
        margin: 0 auto 8px; font-family: 'JetBrains Mono', monospace;
        transition: background .18s ease, color .18s ease; }
      .lp-step-t { font-weight: 700; font-size: 15px; margin-bottom: 3px; }
      .lp-step-d { font-size: 12.5px; color: var(--lp-muted); line-height: 1.4; }
      .lp-step-arrow { align-self: center; color: var(--lp-muted2); width: 24px; }
      .lp-step-arrow-svg { width: 100%; height: 16px; overflow: visible; }
      .lp-step-arrow-svg path { fill: none; stroke: var(--lp-muted2); stroke-width: 1.6;
        stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 40; stroke-dashoffset: 40;
        animation: lp-step-arrow-draw 1s ease forwards; animation-delay: .3s; }
      @keyframes lp-step-arrow-draw { to { stroke-dashoffset: 0; } }
      .lp-step-flow { fill: var(--lp-indigo); }
      @media (max-width: 720px) { .lp-step-arrow { display: none; } }

      .lp-feature { display: grid; grid-template-columns: 1fr 1fr; gap: 52px; align-items: center;
        padding: 46px 0; border-top: 1px solid var(--lp-line); scroll-margin-top: 24px;
        border-radius: 14px; transition: background-color .6s ease; }
      .lp-feature:target { animation: lp-feature-flash 1.6s ease; }
      @keyframes lp-feature-flash {
        0% { background-color: var(--lp-soft); }
        100% { background-color: transparent; }
      }
      .lp-feature.rev > *:first-child { order: 2; }
      @media (max-width: 860px) {
        .lp-feature { grid-template-columns: 1fr; gap: 28px; }
        .lp-feature.rev > *:first-child { order: 0; }
      }
      .lp-step-tag { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: .12em;
        text-transform: uppercase; color: var(--lp-indigo); margin-bottom: 8px; }
      .lp-feat-title { font-weight: 700; font-size: 26px; margin: 0 0 10px; letter-spacing: -.01em; }
      .lp-feat-body { color: var(--lp-muted); font-size: 15.5px; line-height: 1.65; margin: 0; }
      .lp-feat-list { list-style: none; padding: 0; margin: 18px 0 0; }
      .lp-feat-list li { display: flex; gap: 9px; font-size: 14.5px; padding: 5px 0; line-height: 1.5; }
      .lp-learn { margin-top: 20px; background: none; border: none; color: var(--lp-indigo);
        font-size: 14.5px; font-weight: 600; cursor: pointer; padding: 0; }
      .lp-learn:hover { text-decoration: underline; }

      /* mock visuals */
      .lp-visual { min-width: 0; }
      .lp-card { border: 1px solid var(--lp-line); border-radius: 14px; background: #fff;
        padding: 14px; box-shadow: 0 8px 26px rgba(20,22,28,.05); }
      .lp-mock-head { font-size: 12.5px; font-weight: 600; color: var(--lp-ink);
        padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid var(--lp-line); }
      .lp-mock-sub { font-weight: 400; color: var(--lp-muted); }
      .lp-dot-ok { color: #2e9e5b; margin-right: 5px; }
      .lp-pill { float: right; font-family: 'JetBrains Mono', monospace; font-size: 10px;
        font-weight: 500; color: var(--lp-muted); }
      .lp-row { display: flex; gap: 9px; align-items: center; padding: 9px 4px;
        font-size: 13px; border-bottom: 1px solid var(--lp-line); }
      .lp-row:last-child { border-bottom: none; }
      .lp-row.off { opacity: .42; text-decoration: line-through; }
      .lp-tick { width: 17px; height: 17px; line-height: 16px; text-align: center; border-radius: 5px;
        font-size: 11px; background: #f1f2f5; color: var(--lp-muted2); flex-shrink: 0; }
      .lp-tick.on { background: #e7f6ee; color: #2e9e5b; }
      .lp-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .lp-tbl th { text-align: left; font-family: 'JetBrains Mono', monospace; font-size: 10px;
        text-transform: uppercase; letter-spacing: .06em; color: var(--lp-muted2);
        padding: 6px 8px; border-bottom: 1px solid var(--lp-line); }
      .lp-tbl td { padding: 9px 8px; border-bottom: 1px solid var(--lp-line); }
      .lp-tbl tr:last-child td { border-bottom: none; }
      .lp-prose { font-size: 13px; line-height: 1.6; color: var(--lp-ink); }
      .lp-prose p { margin: 0 0 12px; }
      .lp-prose em { color: var(--lp-indigo); font-style: normal; font-weight: 600; }
      .lp-skel { height: 9px; border-radius: 5px; background: #eef0f4; margin: 7px 0; }
      .lp-exports { margin-top: 14px; display: flex; gap: 6px; flex-wrap: wrap; }
      .lp-chip { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; padding: 3px 9px;
        border: 1px solid var(--lp-line); border-radius: 20px; color: var(--lp-muted); }
      .lp-chip.on { background: var(--lp-indigo); border-color: var(--lp-indigo); color: #fff; }
      .lp-chips { margin-top: 12px; display: flex; gap: 6px; }
      .lp-bubble { font-size: 13px; line-height: 1.55; padding: 9px 12px; border-radius: 11px;
        margin-bottom: 8px; max-width: 90%; }
      .lp-bubble.user { background: var(--lp-soft); margin-left: auto; }
      .lp-bubble.bot { background: var(--lp-bg2); border: 1px solid var(--lp-line); }

      /* bands: Research Collaborations + Hypothesis Generation */
      .lp-band { border-top: 1px solid var(--lp-line); padding: 56px 0 10px; }
      .lp-tri { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 26px; }
      @media (max-width: 860px) { .lp-tri { grid-template-columns: 1fr; } }
      .lp-tile { border: 1px solid var(--lp-line); border-radius: 14px; padding: 22px; background: #fff; }
      .lp-tile-ic { color: var(--lp-indigo); margin-bottom: 12px; display: inline-flex; }
      .lp-tile-t { font-weight: 700; font-size: 16.5px; margin-bottom: 6px; }
      .lp-tile-d { color: var(--lp-muted); font-size: 14px; line-height: 1.6; }

      /* closed-loop navigator */
      .lp-loop { display: flex; align-items: stretch; justify-content: center; gap: 6px;
        flex-wrap: wrap; margin: 30px 0 34px; }
      .lp-loop-node { flex: 1 1 190px; max-width: 260px; text-align: left; cursor: pointer;
        border: 1px solid var(--lp-line); border-radius: 13px; background: #fff; padding: 14px 16px;
        display: flex; flex-direction: column; gap: 2px; transition: all .2s; }
      .lp-loop-node:hover { border-color: var(--lp-indigo); }
      .lp-loop-node.on { border-color: var(--lp-indigo); background: var(--lp-soft);
        box-shadow: 0 6px 20px rgba(91,79,240,.12); }
      .lp-loop-ic { font-size: 17px; color: var(--lp-indigo); }
      .lp-loop-t { font-weight: 700; font-size: 14.5px; }
      .lp-loop-s { font-size: 12px; color: var(--lp-muted); }
      .lp-loop-arrow { align-self: center; color: var(--lp-muted2); font-size: 16px; }
      .lp-loop-arrow:last-child { color: var(--lp-indigo); }
      @media (max-width: 780px) { .lp-loop-arrow { display: none; } }

      .lp-slide { display: grid; grid-template-columns: 1fr 1fr; gap: 52px; align-items: center;
        animation: lp-fade .5s ease; }
      @media (max-width: 860px) { .lp-slide { grid-template-columns: 1fr; gap: 28px; } }
      @keyframes lp-fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      .lp-dots { display: flex; gap: 7px; justify-content: center; margin-top: 34px; }
      .lp-dot { width: 8px; height: 8px; border-radius: 50%; border: none; cursor: pointer;
        background: #d8dae2; padding: 0; }
      .lp-dot.on { background: var(--lp-indigo); width: 22px; border-radius: 5px; }

      /* lab-stage visuals */
      .lp-lab { min-height: 260px; }
      .lp-hyp-title { font-size: 14.5px; font-weight: 700; color: var(--lp-indigo); margin-bottom: 12px; line-height: 1.35; }
      .lp-hyp-lbl { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .1em;
        text-transform: uppercase; color: var(--lp-muted2); margin-bottom: 8px; }
      .lp-hyp-row { display: flex; align-items: center; gap: 9px; font-size: 13px; padding: 5px 0; }
      .lp-hyp-b { width: 6px; height: 6px; border-radius: 50%; background: var(--lp-indigo); flex-shrink: 0; }
      .lp-hyp-out { margin-top: 14px; border: 1px dashed var(--lp-line); border-radius: 9px;
        padding: 9px 12px; font-size: 12.5px; font-weight: 600; color: var(--lp-muted); text-align: center; }
      .lp-robo { width: 100%; height: auto; overflow: visible; }
      .lp-robo-well { animation: lp-robo-fill 3.2s ease-in-out infinite; }
      @keyframes lp-robo-fill { 0%,100% { opacity: 0.32; } 45% { opacity: 1; } }
      /* whole figure sways gently at the hip */
      .lp-robo-figure { transform-box: fill-box; transform-origin: 80px 150px;
        animation: lp-robo-sway 4.5s ease-in-out infinite; }
      @keyframes lp-robo-sway { 0%,100% { transform: rotate(-2deg); } 50% { transform: rotate(1deg); } }
      /* head tilts, independent of the body sway */
      .lp-robo-head { transform-box: fill-box; transform-origin: 80px 58px;
        animation: lp-robo-head 4.5s ease-in-out infinite; }
      @keyframes lp-robo-head { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(-6deg); }
        75% { transform: rotate(4deg); } }
      /* right arm reaches down to the plate */
      .lp-robo-arm { transform-box: fill-box; transform-origin: 100px 118px;
        animation: lp-robo-arm 4.5s ease-in-out infinite; }
      @keyframes lp-robo-arm { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(18deg); }
        75% { transform: rotate(-6deg); } }
      /* hand/pipette dips into the well */
      .lp-robo-hand { transform-box: fill-box; animation: lp-robo-hand 4.5s ease-in-out infinite; }
      @keyframes lp-robo-hand { 0%,100% { transform: translateY(0); } 25%,75% { transform: translateY(8px); } }
      .lp-robo-pulse { animation: lp-robo-pulse 2.5s ease-out infinite; }
      @keyframes lp-robo-pulse { 0% { r: 4; opacity: .9; } 100% { r: 13; opacity: 0; } }
      .lp-chart { width: 100%; height: 110px; }
      .lp-line { fill: none; stroke: var(--lp-indigo); stroke-width: 2.2; stroke-linejoin: round;
        stroke-dasharray: 400; stroke-dashoffset: 400; animation: lp-draw 2.2s ease forwards; }
      @keyframes lp-draw { to { stroke-dashoffset: 0; } }
      .lp-pt { fill: var(--lp-indigo); opacity: 0; animation: lp-pop .4s ease forwards; }
      @keyframes lp-pop { to { opacity: 1; } }

      /* publications */
      .lp-pubs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 26px; }
      @media (max-width: 900px) { .lp-pubs { grid-template-columns: 1fr; } }
      .lp-pub { border: 1px solid var(--lp-line); border-radius: 14px; padding: 20px; background: #fff;
        display: flex; flex-direction: column; }
      .lp-pub-top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      .lp-status { font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 600;
        padding: 2px 8px; border-radius: 20px; }
      .lp-status.wip { background: rgba(224,163,62,.14); color: #b8862f; }
      .lp-status.draft { background: #eef0f4; color: var(--lp-muted); }
      .lp-status.out { background: #e7f6ee; color: #2e9e5b; }
      .lp-pub-kind { font-size: 11.5px; color: var(--lp-muted2); }
      .lp-pub-t { font-size: 16px; font-weight: 700; line-height: 1.35; margin: 0 0 8px; }
      .lp-pub-d { font-size: 13.5px; color: var(--lp-muted); line-height: 1.6; margin: 0 0 14px; flex: 1; }
      .lp-pub-soon { font-size: 12.5px; color: var(--lp-muted2); font-style: italic; }

      /* news — horizontal, snap-scrolled row instead of a tall multi-row
         grid, so a handful of stories don't push the whole page down. */
      .lp-news-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
      .lp-news-nav { display: flex; gap: 6px; flex-shrink: 0; }
      .lp-news-arrow { width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--lp-line);
        background: #fff; color: var(--lp-muted); cursor: pointer; display: flex; align-items: center;
        justify-content: center; transition: border-color .15s ease, color .15s ease, background .15s ease; }
      .lp-news-arrow:hover { border-color: var(--lp-indigo); color: var(--lp-indigo); background: var(--lp-soft); }
      .lp-filters { display: flex; gap: 7px; flex-wrap: wrap; margin: 24px 0 20px; }
      .lp-filter { font-size: 13px; font-weight: 500; padding: 6px 14px; border-radius: 20px;
        border: 1px solid var(--lp-line); background: #fff; color: var(--lp-muted); cursor: pointer; }
      .lp-filter:hover { color: var(--lp-ink); }
      .lp-filter.on { background: var(--lp-indigo); border-color: var(--lp-indigo); color: #fff; }
      .lp-news { display: flex; gap: 18px; overflow-x: auto; scroll-snap-type: x proximity;
        padding-bottom: 6px; margin: 0 -2px; scrollbar-width: thin; }
      .lp-news::-webkit-scrollbar { height: 6px; }
      .lp-news::-webkit-scrollbar-thumb { background: var(--lp-line); border-radius: 6px; }
      .lp-news-card { flex: 0 0 300px; scroll-snap-align: start; border: 1px solid var(--lp-line);
        border-radius: 14px; padding: 18px 20px;
        background: #fff; text-decoration: none; color: inherit; display: flex; flex-direction: column;
        transition: all .18s; }
      @media (max-width: 640px) { .lp-news-card { flex-basis: 84vw; } }
      .lp-news-card:hover { border-color: var(--lp-indigo); transform: translateY(-2px);
        box-shadow: 0 10px 26px rgba(20,22,28,.07); }
      .lp-news-domain { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .1em;
        text-transform: uppercase; color: var(--lp-indigo); margin-bottom: 9px; }
      .lp-news-t { font-size: 15.5px; font-weight: 700; line-height: 1.35; margin-bottom: 8px; }
      .lp-news-d { font-size: 13px; color: var(--lp-muted); line-height: 1.6; flex: 1; }
      .lp-news-src { font-size: 12px; color: var(--lp-muted2); margin-top: 14px; }
      .lp-live { color: #2e9e5b; font-weight: 600; }

      /* faq */
      .lp-faq { margin-top: 24px; border-top: 1px solid var(--lp-line); }
      .lp-faq-item { border-bottom: 1px solid var(--lp-line); }
      .lp-faq-q { width: 100%; display: flex; align-items: center; justify-content: space-between;
        gap: 16px; background: none; border: none; cursor: pointer; text-align: left;
        padding: 18px 2px; font-size: 15.5px; font-weight: 600; color: var(--lp-ink); }
      .lp-faq-q:hover { color: var(--lp-indigo); }
      .lp-faq-x { font-size: 20px; color: var(--lp-indigo); flex-shrink: 0; line-height: 1; }
      .lp-faq-a { padding: 0 40px 20px 2px; font-size: 14.5px; color: var(--lp-muted); line-height: 1.7; }

      /* footer */
      .lp-footer { border-top: 1px solid var(--lp-line); background: var(--lp-bg2); margin-top: 60px; }
      .lp-footer-in { max-width: 1140px; margin: 0 auto; padding: 40px 24px 26px; display: flex;
        align-items: flex-start; justify-content: space-between; gap: 28px; flex-wrap: wrap; }
      .lp-foot-tag { font-size: 13.5px; color: var(--lp-muted); margin-top: 6px; }
      .lp-foot-links { display: flex; gap: 16px; margin-top: 14px; }
      .lp-foot-links button { background: none; border: none; cursor: pointer; padding: 0;
        font-size: 13px; font-weight: 500; color: var(--lp-muted); font-family: inherit; }
      .lp-foot-links button:hover { color: var(--lp-indigo); }
      .lp-socials { display: flex; gap: 10px; flex-wrap: wrap; }
      .lp-social { display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
        border: 1px solid var(--lp-line); background: #fff; border-radius: 9px; padding: 9px 14px;
        font-size: 13.5px; font-weight: 500; color: var(--lp-ink); }
      .lp-social:hover { border-color: var(--lp-indigo); color: var(--lp-indigo); }
      .lp-social.off { opacity: .45; cursor: default; pointer-events: none; }
      .lp-foot-legal { max-width: 1140px; margin: 0 auto; padding: 0 24px 34px;
        font-size: 12.5px; color: var(--lp-muted2); }

      .lp-papers { border: 1px solid var(--lp-line); border-radius: 14px; padding: 14px;
        background: #fff; height: 262px; overflow: hidden; position: relative; }
      .lp-papers::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 64px;
        background: linear-gradient(transparent, #fff); }
      .lp-track { display: flex; flex-direction: column; gap: 10px; animation: lp-scroll 18s linear infinite; }
      @keyframes lp-scroll { from { transform: translateY(0); } to { transform: translateY(-50%); } }
      .lp-paper { border: 1px solid var(--lp-line); border-radius: 10px; padding: 10px 12px;
        display: flex; gap: 10px; align-items: flex-start; background: var(--lp-bg2); }
      .lp-paper .num { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--lp-indigo);
        border: 1px solid var(--lp-line); background: #fff; border-radius: 6px; padding: 1px 6px; flex-shrink: 0; }
      .lp-paper .t { font-size: 13px; font-weight: 600; line-height: 1.3; }
      .lp-paper .m { font-size: 11px; color: var(--lp-muted2); margin-top: 2px; font-family: 'JetBrains Mono', monospace; }

      .lp-pricing { max-width: 1140px; margin: 0 auto; padding: 72px 24px 80px; text-align: center; }
      .lp-p-title { font-weight: 700; font-size: clamp(34px, 5vw, 52px); margin: 0 0 12px; letter-spacing: -.02em; }
      .lp-p-sub { color: var(--lp-muted); font-size: 17px; margin: 0 0 48px; }
      .lp-plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; text-align: left; }
      @media (max-width: 880px) { .lp-plans { grid-template-columns: 1fr; max-width: 420px; margin: 0 auto; } }
      .lp-plan { position: relative; border: 1px solid var(--lp-line); border-radius: 16px;
        padding: 26px 24px 28px; background: #fff; }
      .lp-plan.hot { border-color: var(--lp-indigo); box-shadow: 0 10px 34px rgba(91,79,240,.12); }
      .lp-badge { position: absolute; top: -11px; left: 24px; background: var(--lp-indigo); color: #fff;
        font-size: 11px; font-weight: 600; letter-spacing: .04em; padding: 3px 10px; border-radius: 20px; }
      .lp-plan-name { font-size: 15px; font-weight: 700; color: var(--lp-indigo); letter-spacing: .02em; }
      .lp-price { font-size: 40px; font-weight: 700; margin: 8px 0 2px; letter-spacing: -.02em; }
      .lp-per { font-size: 14px; font-weight: 500; color: var(--lp-muted2); }
      .lp-plan-blurb { color: var(--lp-muted); font-size: 14px; line-height: 1.5; min-height: 42px; }
      .lp-plan-list { list-style: none; padding: 0; margin: 22px 0 0; }
      .lp-plan-list li { display: flex; gap: 9px; font-size: 14px; color: var(--lp-ink);
        padding: 7px 0; line-height: 1.45; }
      .lp-check { color: var(--lp-indigo); font-weight: 700; flex-shrink: 0; }
      .lp-p-foot { color: var(--lp-muted2); font-size: 13.5px; margin-top: 40px; }

      /* careers / about */
      .lp-mark-caption { max-width: 460px; margin: -20px auto 48px; color: var(--lp-muted2);
        font-size: 13px; line-height: 1.6; font-style: italic; }
      .lp-openroles { max-width: 780px; margin: 0 auto 60px; }
      .lp-empty-card { border: 1px dashed var(--lp-line); border-radius: 14px; padding: 30px 28px;
        text-align: left; background: var(--lp-bg2); }
      .lp-empty-card p { color: var(--lp-muted); font-size: 14.5px; line-height: 1.65; margin: 0 0 18px; }
      .lp-contact-row { display: flex; gap: 12px; flex-wrap: wrap; }
    `}</style>
  );
}

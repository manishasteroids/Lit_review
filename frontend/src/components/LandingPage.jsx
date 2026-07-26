import React, { useState, useEffect, useRef } from "react";
import { ensureAuth } from "../Auth.jsx";

/**
 * Public marketing site — shown to signed-out visitors, before the tools app.
 * Always light/white themed, independent of the app's dark UI.
 *
 * Pages: "home" (hero + features) and "pricing".
 */
export default function LandingPage() {
  const [page, setPage] = useState("home");
  const login = () => ensureAuth();

  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  return (
    <div className="lp-root">
      <LandingStyles />
      <TopBar page={page} setPage={setPage} login={login} />
      {page === "pricing"
        ? <Pricing login={login} />
        : <Home login={login} setPage={setPage} />}
    </div>
  );
}

/* ── Top bar ──────────────────────────────────────────────────────────── */

const FEATURE_ITEMS = [
  ["Literature Review", "Search, filter and synthesise papers into a cited review"],
  ["Research Paper Analysis", "Read any paper in full and chat with it"],
  ["Research Methods Generation", "Turn findings into testable methods and hypotheses"],
  ["Data Analysis", "Trends, comparisons and evidence tables across your corpus"],
];

function TopBar({ page, setPage, login }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Every feature in the menu is behind the product → prompt sign-in / sign-up.
  const goFeature = () => { setOpen(false); login(); };

  // Scroll to a home-page section (switching back to home first if needed).
  const jump = (id) => {
    if (page !== "home") setPage("home");
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }), 60);
  };

  return (
    <header className="lp-bar">
      <div className="lp-bar-in">
        <div className="lp-logo" onClick={() => setPage("home")}>
          Saṃhitā<span className="dot">.</span>
        </div>

        <nav className="lp-nav">
          <div className="lp-dd" ref={ref}>
            <button className="lp-dd-btn" onClick={() => setOpen((v) => !v)}>
              Features <span className={"lp-caret" + (open ? " up" : "")}>▾</span>
            </button>
            {open && (
              <div className="lp-dd-menu">
                {FEATURE_ITEMS.map(([label, desc]) => (
                  <button key={label} className="lp-dd-item" onClick={goFeature}>
                    <div className="lp-dd-label">{label}</div>
                    <div className="lp-dd-desc">{desc}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="lp-link" onClick={() => jump("lp-news")}>News</button>
          <button className="lp-link" onClick={() => jump("lp-faq")}>FAQ</button>
          <button className="lp-link" onClick={() => setPage("pricing")}>Pricing</button>
        </nav>

        <div className="lp-bar-cta">
          <button className="lp-ghost" onClick={login}>Sign in</button>
          <button className="lp-solid" onClick={login}>Sign up</button>
        </div>
      </div>
    </header>
  );
}

/* ── Home ─────────────────────────────────────────────────────────────── */

function Home({ login, setPage }) {
  return (
    <>
      <section className="lp-hero">
        <h1 className="lp-h1">Interactive Scientific AI Research Assistant</h1>
        <p className="lp-sub">Accelerates innovation, and boosts scientific discovery.</p>
        <div className="lp-cta-row">
          <button className="lp-cta" onClick={login}>Try for free</button>
          <button className="lp-cta-2"
            onClick={() => document.getElementById("lp-features")?.scrollIntoView({ behavior: "smooth" })}>
            See how it works
          </button>
        </div>
        <div className="lp-note">Sign in with Google, GitHub, or email — no credit card required.</div>
      </section>

      <div id="lp-features" className="lp-section">
        <div className="lp-ads-label">What it does</div>
        <h2 className="lp-cat">Literature Review</h2>
        <p className="lp-cat-sub">From a research question to a cited review — automatically.</p>

        {/* Pipeline steps overview */}
        <div className="lp-steps">
          {STEPS.map((s, i) => (
            <React.Fragment key={s.k}>
              <div className="lp-step">
                <div className="lp-step-n">{i + 1}</div>
                <div className="lp-step-t">{s.k}</div>
                <div className="lp-step-d">{s.d}</div>
              </div>
              {i < STEPS.length - 1 && <div className="lp-step-arrow" aria-hidden="true">→</div>}
            </React.Fragment>
          ))}
        </div>

        {/* Step-by-step feature detail */}
        {FEATURES.map((f, i) => (
          <div className={"lp-feature" + (i % 2 ? " rev" : "")} key={f.title}>
            <div>
              <div className="lp-step-tag">Step {i + 1}</div>
              <h3 className="lp-feat-title">{f.title}</h3>
              <p className="lp-feat-body">{f.body}</p>
              <ul className="lp-feat-list">
                {f.points.map((p) => <li key={p}><span className="lp-check">✓</span>{p}</li>)}
              </ul>
              <button className="lp-learn" onClick={login}>Try it free →</button>
            </div>
            <div className="lp-visual">{f.visual}</div>
          </div>
        ))}

        {/* ── Research Collaborations ─────────────────────────── */}
        <div className="lp-band">
          <h2 className="lp-cat">Research Collaborations</h2>
          <p className="lp-cat-sub">Work together on the questions that matter.</p>
          <div className="lp-tri">
            {COLLAB.map((c) => (
              <div className="lp-tile" key={c.t}>
                <div className="lp-tile-ic">{c.ic}</div>
                <div className="lp-tile-t">{c.t}</div>
                <div className="lp-tile-d">{c.d}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Hypothesis Generation ───────────────────────────── */}
        <HypothesisSection login={login} />

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

      <SiteFooter />
    </>
  );
}

/* ── News with domain filters ─────────────────────────────────────────── */

function NewsSection() {
  const [domain, setDomain] = useState("All");
  const domains = ["All", ...Array.from(new Set(NEWS.map((n) => n.domain)))];
  const shown = domain === "All" ? NEWS : NEWS.filter((n) => n.domain === domain);
  return (
    <div className="lp-band" id="lp-news">
      <h2 className="lp-cat">News in AI-driven discovery</h2>
      <p className="lp-cat-sub">What's moving across biomedical, pharmaceutical and engineering research.</p>
      <div className="lp-filters">
        {domains.map((d) => (
          <button key={d} className={"lp-filter" + (d === domain ? " on" : "")}
            onClick={() => setDomain(d)}>{d}</button>
        ))}
      </div>
      <div className="lp-news">
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

function SiteFooter() {
  return (
    <footer className="lp-footer">
      <div className="lp-footer-in">
        <div>
          <div className="lp-logo">Saṃhitā<span className="dot">.</span></div>
          <div className="lp-foot-tag">Interactive Scientific AI Research Assistant</div>
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
        © {new Date().getFullYear()} Saṃhitā · Built for researchers
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
          <button className="lp-learn" onClick={login}>Join the early access →</button>
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

const MOCK_PAPERS = [
  { title: "Attention Is All You Need", meta: "Vaswani et al. · 2017 · NeurIPS" },
  { title: "Token-Efficient Inference for Large Language Models", meta: "2024 · arXiv" },
  { title: "Retrieval-Augmented Generation for Knowledge Tasks", meta: "Lewis et al. · 2020" },
  { title: "A Survey of LLM-based Autonomous Agents", meta: "2023 · arXiv" },
  { title: "Prompt Compression and Context Pruning", meta: "2025 · ACL" },
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
    {[["Token-Efficient Inference for LLMs", true], ["A Survey of LLM-based Agents", true],
      ["Unrelated Clinical Trial Report", false], ["Prompt Compression and Pruning", true]].map(([t, on]) => (
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
        <tr><td>[1]</td><td>Transformer</td><td>Self-attention beats RNNs</td></tr>
        <tr><td>[2]</td><td>KV-cache pruning</td><td>−58% tokens, same accuracy</td></tr>
        <tr><td>[3]</td><td>RAG</td><td>Grounds output in sources</td></tr>
      </tbody>
    </table>
  </div>
);

const WriteVisual = (
  <div className="lp-card" aria-hidden="true">
    <div className="lp-mock-head">Literature review · draft</div>
    <div className="lp-prose">
      <p>Recent work on efficient inference has converged on three strategies <em>[1], [2]</em>.
      Prompt compression reduces context length without measurable loss <em>[2]</em>, while
      retrieval-based grounding improves factuality <em>[3]</em>.</p>
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
    <div className="lp-mock-head">Chat · source [2]</div>
    <div className="lp-bubble user">What was the measured token reduction?</div>
    <div className="lp-bubble bot">
      The authors report a <b>58% reduction</b> in prompt tokens with no significant
      drop in downstream accuracy (Table 3).
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
    <div className="lp-mock-head">Execution unit · 384-well plate</div>
    <div className="lp-plate">
      {Array.from({ length: 96 }).map((_, n) => (
        <span className="lp-well" key={n} style={{ animationDelay: `${(n % 24) * 0.08}s` }} />
      ))}
    </div>
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
    title: "Saṃhitā: a multi-agent architecture for automated literature review",
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

const COLLAB = [
  { ic: "◉", t: "Shared research projects", d: "Create a project for a specific question and bring your collaborators into the same sources, notes and review." },
  { ic: "◈", t: "Connected scholar profiles", d: "Link Google Scholar and ORCID so contributions and citations map to real researcher identities." },
  { ic: "◒", t: "Reproducible by default", d: "Every claim traces to a numbered source, so a colleague can audit exactly how a conclusion was reached." },
];

const STEPS = [
  { k: "Ask", d: "Your research question" },
  { k: "Search", d: "4 academic databases" },
  { k: "Filter", d: "You approve sources" },
  { k: "Extract", d: "Structured findings" },
  { k: "Critique", d: "Themes & gaps" },
  { k: "Write", d: "Cited review" },
];

const FEATURES = [
  {
    title: "Gather papers",
    body: "Ask a question in plain language. Saṃhitā reformulates it into precise search queries, then searches Semantic Scholar, arXiv, OpenAlex and PubMed at once — ranking results by relevance to your topic, not just citation count.",
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
            <button className={p.highlight ? "lp-cta full" : "lp-cta-2 full"} onClick={login}>{p.cta}</button>
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

/* ── Styles (scoped, always light) ────────────────────────────────────── */

function LandingStyles() {
  return (
    <style>{`
      .lp-root {
        --lp-ink: #14161c; --lp-muted: #5c6373; --lp-muted2: #8b91a2;
        --lp-line: #e5e7ec; --lp-indigo: #5b4ff0; --lp-soft: #f2f1fe; --lp-bg2: #fafbfc;
        background: #fff; color: var(--lp-ink); min-height: 100vh;
        font-family: 'Space Grotesk', system-ui, sans-serif;
      }
      .lp-root button { font-family: inherit; }

      .lp-bar { position: sticky; top: 0; z-index: 30; background: rgba(255,255,255,.86);
        backdrop-filter: blur(10px); border-bottom: 1px solid var(--lp-line); }
      .lp-bar-in { max-width: 1140px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; gap: 26px; }
      .lp-logo { font-weight: 700; font-size: 20px; cursor: pointer; }
      .lp-logo .dot { color: var(--lp-indigo); }
      .lp-nav { display: flex; align-items: center; gap: 8px; }
      .lp-link, .lp-dd-btn { background: none; border: none; cursor: pointer; font-size: 14.5px;
        color: var(--lp-muted); padding: 8px 10px; border-radius: 8px; }
      .lp-link:hover, .lp-dd-btn:hover { color: var(--lp-ink); background: var(--lp-bg2); }
      .lp-dd { position: relative; }
      .lp-caret { font-size: 10px; display: inline-block; transition: transform .15s; }
      .lp-caret.up { transform: rotate(180deg); }
      .lp-dd-menu { position: absolute; top: calc(100% + 8px); left: 0; width: 320px; background: #fff;
        border: 1px solid var(--lp-line); border-radius: 12px; padding: 6px;
        box-shadow: 0 12px 32px rgba(20,22,28,.10); }
      .lp-dd-item { display: block; width: 100%; text-align: left; background: none; border: none;
        cursor: pointer; padding: 10px 12px; border-radius: 9px; }
      .lp-dd-item:hover { background: var(--lp-soft); }
      .lp-dd-label { font-size: 14px; font-weight: 600; color: var(--lp-ink); }
      .lp-dd-desc { font-size: 12.5px; color: var(--lp-muted); margin-top: 2px; line-height: 1.4; }
      .lp-bar-cta { margin-left: auto; display: flex; align-items: center; gap: 10px; }
      .lp-ghost { font-size: 13.5px; font-weight: 600; color: var(--lp-ink); background: transparent;
        border: 1px solid var(--lp-line); border-radius: 9px; padding: 8px 14px; cursor: pointer; }
      .lp-ghost:hover { background: var(--lp-bg2); }
      .lp-solid { font-size: 13.5px; font-weight: 600; color: #fff; background: var(--lp-indigo);
        border: 1px solid var(--lp-indigo); border-radius: 9px; padding: 8px 16px; cursor: pointer; }
      .lp-solid:hover { filter: brightness(1.07); }

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

      .lp-section { max-width: 1140px; margin: 0 auto; padding: 40px 24px 60px; }
      .lp-ads-label { text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 11.5px;
        letter-spacing: .14em; text-transform: uppercase; color: var(--lp-muted2); margin-bottom: 30px; }
      .lp-cat { font-weight: 700; font-size: 27px; margin: 0 0 6px; }
      .lp-cat-sub { color: var(--lp-muted); font-size: 15px; margin: 0 0 28px; }
      /* pipeline steps */
      .lp-steps { display: flex; align-items: stretch; gap: 6px; flex-wrap: wrap;
        justify-content: center; margin: 0 0 64px; }
      .lp-step { flex: 1 1 140px; min-width: 132px; border: 1px solid var(--lp-line);
        border-radius: 12px; padding: 14px 14px 16px; background: #fff; text-align: center; }
      .lp-step-n { width: 24px; height: 24px; line-height: 24px; border-radius: 50%;
        background: var(--lp-soft); color: var(--lp-indigo); font-size: 12px; font-weight: 700;
        margin: 0 auto 8px; font-family: 'JetBrains Mono', monospace; }
      .lp-step-t { font-weight: 700; font-size: 15px; margin-bottom: 3px; }
      .lp-step-d { font-size: 12.5px; color: var(--lp-muted); line-height: 1.4; }
      .lp-step-arrow { align-self: center; color: var(--lp-muted2); font-size: 15px; }
      @media (max-width: 720px) { .lp-step-arrow { display: none; } }

      .lp-feature { display: grid; grid-template-columns: 1fr 1fr; gap: 52px; align-items: center;
        padding: 46px 0; border-top: 1px solid var(--lp-line); }
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
      .lp-tile-ic { font-size: 20px; color: var(--lp-indigo); margin-bottom: 10px; }
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
      .lp-plate { display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px; margin: 6px 0 4px; }
      .lp-well { display: block; width: 100%; aspect-ratio: 1; border-radius: 50%;
        background: #e4e7ee; animation: lp-fill 3.2s ease-in-out infinite; }
      @keyframes lp-fill { 0%,100% { background: #e4e7ee; } 45% { background: var(--lp-indigo); } }
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

      /* news */
      .lp-filters { display: flex; gap: 7px; flex-wrap: wrap; margin: 24px 0 20px; }
      .lp-filter { font-size: 13px; font-weight: 500; padding: 6px 14px; border-radius: 20px;
        border: 1px solid var(--lp-line); background: #fff; color: var(--lp-muted); cursor: pointer; }
      .lp-filter:hover { color: var(--lp-ink); }
      .lp-filter.on { background: var(--lp-indigo); border-color: var(--lp-indigo); color: #fff; }
      .lp-news { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
      @media (max-width: 900px) { .lp-news { grid-template-columns: 1fr; } }
      .lp-news-card { border: 1px solid var(--lp-line); border-radius: 14px; padding: 18px 20px;
        background: #fff; text-decoration: none; color: inherit; display: flex; flex-direction: column;
        transition: all .18s; }
      .lp-news-card:hover { border-color: var(--lp-indigo); transform: translateY(-2px);
        box-shadow: 0 10px 26px rgba(20,22,28,.07); }
      .lp-news-domain { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .1em;
        text-transform: uppercase; color: var(--lp-indigo); margin-bottom: 9px; }
      .lp-news-t { font-size: 15.5px; font-weight: 700; line-height: 1.35; margin-bottom: 8px; }
      .lp-news-d { font-size: 13px; color: var(--lp-muted); line-height: 1.6; flex: 1; }
      .lp-news-src { font-size: 12px; color: var(--lp-muted2); margin-top: 14px; }

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
    `}</style>
  );
}

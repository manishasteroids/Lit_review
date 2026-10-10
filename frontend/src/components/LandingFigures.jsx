import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";

/**
 * Live 3D figures for the public landing page (three.js).
 *
 *   <CitationFigure />  hero: a corpus as a rotating citation map
 *   <PipelineFigure />  Sift: one review moving through the six agents, driven by scroll
 *   <HypothesisFigure /> Infinity: generate, critique, rank, recommend as a rotating 3D bracket
 *   <LoopFigure />      Infinity: design space / 96-well plate / model feedback
 *
 * This file is loaded lazily from LandingPage.jsx so three.js stays out of the
 * main bundle. All data shown in the figures is illustrative. Styles live in
 * LandingStyles() under the `lp3-` prefix.
 */

const HEX = {
  surface: "#ffffff", stage: "#f3f3fa", ink: "#14161c", muted: "#5c6373", line: "#dcddea",
  accent: "#5b4ff0", d1: "#5b4ff0", d2: "#0b9a9a", d3: "#d9701f", d4: "#c23b8a", d5: "#3a8a4c", d6: "#2f74d0",
};
const PAL = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, new THREE.Color(v)]));
const RM = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
// Small seeded generators so every visitor sees the same layout.
function rng(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussOf = (r) => () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(6.2831853 * r());

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.beginPath(); g.arc(32, 32, 28, 0, 6.3); g.fill();
  return new THREE.CanvasTexture(c);
}

/* Creates renderer + scene + camera on the <canvas> inside `el`, runs one
   render loop while the stage is on screen, and returns a cleanup function. */
function mountStage(el, fov, build) {
  const canvas = el.querySelector("canvas");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    el.classList.add("no-gl");
    return () => {};
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0, 0);
  const st = {
    el, canvas, renderer, scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(fov, 1, 0.1, 500), w: 1, h: 1, cleanups: [],
  };
  st.on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    st.cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  const size = () => {
    st.w = Math.max(1, el.clientWidth); st.h = Math.max(1, el.clientHeight);
    renderer.setSize(st.w, st.h, false);
    st.camera.aspect = st.w / st.h; st.camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(size); ro.observe(el); size();
  let visible = true;
  const io = new IntersectionObserver((e) => { visible = e[0].isIntersecting; }, { rootMargin: "120px" });
  io.observe(el);

  const update = build(st);
  let raf = 0, last = performance.now(), now = 0;
  const frame = (ms) => {
    const dt = Math.min(0.05, (ms - last) / 1000); last = ms; now += dt;
    if (visible) { update(now, dt); renderer.render(st.scene, st.camera); }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
    st.cleanups.forEach((f) => f());
    st.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { if (x.map) x.map.dispose(); x.dispose(); });
    });
    renderer.dispose();
  };
}

/* Drag-to-rotate camera with a slow idle spin. */
function orbit(st, o) {
  let drag = false, lx = 0, ly = 0;
  o.target = o.target || new THREE.Vector3();
  st.on(st.canvas, "pointerdown", (e) => {
    drag = true; lx = e.clientX; ly = e.clientY;
    try { st.canvas.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
  });
  st.on(st.canvas, "pointermove", (e) => {
    if (!drag) return;
    o.az -= (e.clientX - lx) * 0.006; o.el = clamp(o.el + (e.clientY - ly) * 0.004, o.lo, o.hi);
    lx = e.clientX; ly = e.clientY;
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((n) => st.on(st.canvas, n, () => { drag = false; }));
  o.apply = (dt) => {
    if (!drag && !RM) o.az += o.auto * dt;
    const d = o.dist * Math.max(1, o.ref / st.camera.aspect), c = Math.cos(o.el);
    st.camera.position.set(o.target.x + d * c * Math.sin(o.az), o.target.y + d * Math.sin(o.el), o.target.z + d * c * Math.cos(o.az));
    st.camera.lookAt(o.target);
  };
  return o;
}

const V = new THREE.Vector3();
/* Pins an HTML label to a 3D point. Leaves the projected point in V. */
function place(st, el, x, y, z, show) {
  if (!el) return;
  V.set(x, y, z).project(st.camera);
  el.style.transform = `translate(${((V.x * 0.5 + 0.5) * st.w).toFixed(1)}px,${((-V.y * 0.5 + 0.5) * st.h).toFixed(1)}px)`;
  el.classList.toggle("on", !!show && V.z < 1);
}
const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
const NoGL = () => <div className="lp3-nogl">The 3D view needs WebGL, which this browser has turned off.</div>;

/* ── Fig. 1: citation space ───────────────────────────────────────────── */

const THEMES = [
  ["structure prediction", "d1", "AlphaFold3: Accurate Structure Prediction"],
  ["model scaling", "d6", "Mixture-of-Experts Routing at Scale"],
  ["multi-agent reasoning", "d4", "Multi-Agent Debate Improves Accuracy"],
  ["climate forecasting", "d2", "Sub-Seasonal Climate Forecasting"],
  ["retrieval & RAG", "d3", "Long-Context Retrieval-Augmented Generation"],
  ["lab automation", "d5", "Closed-loop autonomous laboratories"],
];

function buildCitation(st, ctl, autoPick) {
  const r = rng(11), g = gaussOf(r), PER = 70, N = PER * 6;
  const pos = new Float32Array(N * 3), colr = new Float32Array(N * 3), cl = new Uint8Array(N), dc = new Float32Array(N);
  const ctr = [], top = [];
  for (let c = 0; c < 6; c++) {
    const a = (c / 6) * 6.2832 + 0.4, cx = Math.cos(a) * 7.6, cz = Math.sin(a) * 7.6, cy = (c % 2 ? 2.6 : -2.2) + g() * 0.5;
    ctr.push([cx, cy, cz]);
    const sx = 1.5 + r() * 1.1, sy = 1.1 + r() * 0.8, sz = 1.5 + r() * 1.1, list = [];
    for (let i = 0; i < PER; i++) {
      const k = c * PER + i, x = g() * sx, y = g() * sy, z = g() * sz;
      pos[k * 3] = cx + x; pos[k * 3 + 1] = cy + y; pos[k * 3 + 2] = cz + z;
      cl[k] = c; dc[k] = Math.sqrt(x * x + y * y + z * z); list.push(k);
    }
    list.sort((p, q) => dc[p] - dc[q]);
    top.push([list[0], list[16], list[34]]);
  }
  // Citation edges: each paper links to its nearest neighbours in the same theme, plus a few cross-theme links.
  const ed = [];
  for (let i = 0; i < N; i++) {
    const best = [-1, -1], bd = [1e9, 1e9], b0 = cl[i] * PER;
    for (let j = b0; j < b0 + PER; j++) {
      if (j === i) continue;
      const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2], d = dx * dx + dy * dy + dz * dz;
      if (d < bd[0]) { bd[1] = bd[0]; best[1] = best[0]; bd[0] = d; best[0] = j; } else if (d < bd[1]) { bd[1] = d; best[1] = j; }
    }
    ed.push(i, best[0]); if (r() < 0.5) ed.push(i, best[1]);
  }
  for (let e = 0; e < 18; e++) ed.push(Math.floor(r() * N), Math.floor(r() * N));
  const ep = new Float32Array(ed.length * 3);
  ed.forEach((n, q) => { ep[q * 3] = pos[n * 3]; ep[q * 3 + 1] = pos[n * 3 + 1]; ep[q * 3 + 2] = pos[n * 3 + 2]; });
  const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(ep, 3));
  st.scene.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: PAL.muted, transparent: true, opacity: 0.2 })));
  const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const ca = new THREE.BufferAttribute(colr, 3); pg.setAttribute("color", ca);
  st.scene.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.62, map: dotTexture(), vertexColors: true, transparent: true, alphaTest: 0.5, sizeAttenuation: true })));
  const wave = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0 }));
  st.scene.add(wave);

  const ob = orbit(st, { az: 0.5, el: 0.3, dist: 31, auto: 0.09, lo: -0.6, hi: 1.1, ref: 1.15 });
  const labels = [0, 1, 2].map((i) => st.el.querySelector(`[data-r="lab${i}"]`));
  const azEl = st.el.querySelector('[data-r="az"]');
  const A = new THREE.Color(), B = new THREE.Color();

  return (t, dt) => {
    ctl.now = t;
    if (!RM && t - ctl.manual > 18 && t - ctl.t0 > 7) autoPick((ctl.sel + 1) % 6);
    ob.apply(dt);
    const sel = ctl.sel, R = RM ? 99 : (t - ctl.t0) * 6.5, sc = ctr[sel];
    for (let i = 0; i < N; i++) {
      const mine = cl[i] === sel, dx = pos[i * 3] - sc[0], dy = pos[i * 3 + 1] - sc[1], dz = pos[i * 3 + 2] - sc[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const lit = mine ? smooth((R - d) / 1.2) : 0, glow = Math.exp(-Math.pow((d - R) / 1.3, 2)) * (mine ? 0.7 : 0.35);
      A.copy(PAL[THEMES[cl[i]][1]]); B.copy(A).lerp(PAL.stage, 0.34); B.lerp(A, lit).lerp(PAL.ink, glow);
      colr[i * 3] = B.r; colr[i * 3 + 1] = B.g; colr[i * 3 + 2] = B.b;
    }
    ca.needsUpdate = true;
    wave.position.set(sc[0], sc[1], sc[2]); wave.scale.setScalar(Math.max(0.01, R));
    wave.material.color.copy(PAL[THEMES[sel][1]]); wave.material.opacity = RM ? 0 : clamp(0.28 - R * 0.02, 0, 0.28);
    for (let q = 0; q < 3; q++) {
      const n = top[sel][q];
      place(st, labels[q], pos[n * 3], pos[n * 3 + 1], pos[n * 3 + 2], R > dc[n] + 1.5);
      if (labels[q]) labels[q].classList.toggle("flip", V.x * 0.5 + 0.5 > 0.55);
    }
    setText(azEl, ((((ob.az * 57.2958) % 360) + 360) % 360).toFixed(0) + "°");
  };
}

export function CitationFigure() {
  const ref = useRef(null);
  const ctl = useRef({ sel: 0, t0: 0, manual: -1e9, now: 0 });
  const [sel, setSel] = useState(0);
  const pick = (i, manual) => {
    const c = ctl.current; c.sel = i; c.t0 = c.now; if (manual) c.manual = c.now; setSel(i);
  };
  const pickRef = useRef(pick); pickRef.current = pick;
  useEffect(() => mountStage(ref.current, 38, (st) => buildCitation(st, ctl.current, (i) => pickRef.current(i, false))), []);

  return (
    <figure className="lp3-fig">
      <div className="lp3-stage" ref={ref}>
        <canvas role="img" aria-label="Rotating 3D map of 420 papers grouped into six research themes and linked by citations. A search pulse lights up the papers that match the selected theme." />
        <div className="lp3-hud tl"><b>Citation space</b><br />n = 420 papers · 6 themes</div>
        <div className="lp3-hud tr">query: <b>{THEMES[sel][0]}</b><br />θ = <b data-r="az">0°</b></div>
        <div className="lp3-tag" data-r="lab0"><span>[1] {THEMES[sel][2]}</span></div>
        <div className="lp3-tag" data-r="lab1"><span>[2]</span></div>
        <div className="lp3-tag" data-r="lab2"><span>[3]</span></div>
        <NoGL />
      </div>
      <div className="lp3-chips" role="group" aria-label="Search the map by theme">
        {THEMES.map((t, i) => (
          <button key={t[0]} className="lp3-chip" style={{ "--c": HEX[t[1]] }} aria-pressed={i === sel} onClick={() => pick(i, true)}>
            <i />{t[0]}
          </button>
        ))}
      </div>
      <figcaption><b>Fig. 1</b> A corpus as Sift sees it. Each point is a paper, each line a citation. Pick a theme to send a query through the map, or drag to rotate. Illustrative data.</figcaption>
    </figure>
  );
}

/* ── Fig. 2: review pipeline ──────────────────────────────────────────── */

const STAGE_NAMES = ["Ask", "Search", "Filter", "Extract", "Critique", "Write"];
const STAGE_INFO = [
  "1 question → search queries",
  "50 papers · ranked by relevance",
  "42 / 50 kept · you approve each source",
  "42 rows · method, finding, metrics, limits",
  "4 themes · 1 gap found",
  "42 sources → 1 review · IEEE [n]",
];
const SOURCE_LEGEND = [["d1", "Semantic Scholar"], ["d2", "arXiv"], ["d3", "OpenAlex"], ["d4", "PubMed"]];
const THEME_LEGEND = [["d2", "theme A"], ["d3", "theme B"], ["d4", "theme C"], ["d6", "theme D"]];
const STAGE_LEGEND = [null, SOURCE_LEGEND, SOURCE_LEGEND, null, THEME_LEGEND, null];

function buildPipeline(st, getSteps, onStage) {
  const N = 50, r = rng(7), g = gaussOf(r), rej = {};
  let cnt = 0;
  while (cnt < 8) { const q = 14 + Math.floor(r() * 36); if (!rej[q]) { rej[q] = 1; cnt++; } }
  const SRC = ["d1", "d2", "d3", "d4"], THM = ["d2", "d3", "d4", "d6"];
  // L[stage][paper] = [x, y, z, scale, rx, ry, rz, colourKey]
  const L = [[], [], [], [], [], []], anchors = [];
  const cs = [[-15, 8, -8], [15, 8, -8], [-15, -8, -8], [15, -8, -8]];
  const ct = [[-6, 3.2, 0], [5.5, 3.6, -2], [-4.8, -3.8, 2], [6, -3.4, 1]];
  let k = 0;
  for (let i = 0; i < N; i++) {
    const s = Math.floor(r() * 4), a = i * 2.39996, rad = 2.3 + Math.sqrt(i) * 1.08;
    const rx = (r() - 0.5) * 0.7, ry = (r() - 0.5) * 0.7, rz = (r() - 0.5) * 0.5;
    L[0].push([cs[s][0] + g() * 1.5, cs[s][1] + g() * 1.5, cs[s][2] + g() * 1.5, 0, rx, ry, rz, SRC[s]]);
    const p1 = [Math.cos(a) * rad, Math.sin(a) * rad * 0.82, g() * 0.6, 1, rx, ry, rz, SRC[s]];
    L[1].push(p1);
    if (rej[i]) {
      const gone = [p1[0], p1[1] - 16, p1[2], 0, rx, ry, rz + 1.2, "line"];
      for (let m = 2; m < 6; m++) L[m].push(gone);
      continue;
    }
    const r2 = 2.3 + Math.sqrt(k) * 1.12;
    L[2].push([Math.cos(k * 2.39996) * r2, Math.sin(k * 2.39996) * r2 * 0.82, g() * 0.5, 1, rx, ry, rz, SRC[s]]);
    L[3].push([((k % 7) - 3) * 2.0, (2.5 - Math.floor(k / 7)) * 1.72, 0, 1, 0, 0, 0, "d1"]);
    const th = Math.floor(r() * 4);
    L[4].push([ct[th][0] + g() * 1.5, ct[th][1] + g() * 1.25, ct[th][2] + g() * 1.3, 0.9, rx, ry, rz, THM[th]]);
    const px = -10.2 + (k % 3) * 1.15, py = 6.2 - Math.floor(k / 3) * 0.95;
    L[5].push([px, py, 0, 0.6, 0, 0.35, 0, "muted"]);
    anchors.push([px + 0.35, py, 0, 1.5, 3.7 - (k % 14) * 0.57, 0.1]);
    k++;
  }

  const grp = new THREE.Group(); st.scene.add(grp);
  st.scene.add(new THREE.AmbientLight(0xffffff, 0.82));
  const dl = new THREE.DirectionalLight(0xffffff, 0.45); dl.position.set(6, 10, 14); st.scene.add(dl);
  const sheets = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 1.2, 0.06), new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  grp.add(sheets);
  const qWire = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 1), new THREE.MeshBasicMaterial({ color: PAL.accent, wireframe: true }));
  const qCore = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 14), new THREE.MeshBasicMaterial({ color: PAL.accent }));
  const qg = new THREE.Group(); qg.add(qWire); qg.add(qCore); grp.add(qg);
  const gap = new THREE.Mesh(new THREE.IcosahedronGeometry(2.1, 1), new THREE.MeshBasicMaterial({ color: PAL.muted, wireframe: true, transparent: true, opacity: 0 }));
  gap.position.set(0.4, -0.2, 0); grp.add(gap);
  const doc = new THREE.Group(); doc.position.set(4.6, 0, 0);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(7.2, 9, 0.12), new THREE.MeshLambertMaterial({ color: PAL.surface }));
  doc.add(slab);
  doc.add(new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), new THREE.LineBasicMaterial({ color: PAL.accent })));
  const txtM = new THREE.MeshBasicMaterial({ color: PAL.line });
  for (let j = 0; j < 14; j++) {
    const w = 3.4 + r() * 2.4, ln = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, 0.04), txtM);
    ln.position.set(-3.0 + w / 2, 3.7 - j * 0.57, 0.1); doc.add(ln);
  }
  grp.add(doc);
  const cp = new Float32Array(anchors.length * 6); anchors.forEach((a, i) => cp.set(a, i * 6));
  const cg = new THREE.BufferGeometry(); cg.setAttribute("position", new THREE.BufferAttribute(cp, 3));
  const cm = new THREE.LineBasicMaterial({ color: PAL.accent, transparent: true, opacity: 0 });
  grp.add(new THREE.LineSegments(cg, cm));

  // Scroll position -> stage 0..5, measured from the copy blocks beside the figure.
  let p = 0, pt = 0, mx = 0, shown = -1;
  const measure = () => {
    const steps = getSteps();
    if (steps.length < 6) return 0;
    const probe = window.innerHeight * (window.innerWidth <= 860 ? 0.72 : 0.5);
    const c = steps.map((s) => { const b = s.getBoundingClientRect(); return b.top + b.height / 2; });
    if (probe <= c[0]) return 0;
    for (let i = 0; i < 5; i++) if (probe < c[i + 1]) return i + (probe - c[i]) / (c[i + 1] - c[i]);
    return 5;
  };
  const onScroll = () => { pt = measure(); };
  st.on(window, "scroll", onScroll, { passive: true }); st.on(window, "resize", onScroll);
  onScroll(); p = pt;
  st.on(st.el, "pointermove", (e) => { const b = st.el.getBoundingClientRect(); mx = ((e.clientX - b.left) / b.width - 0.5) * 2; });

  const gapEl = st.el.querySelector('[data-r="gap"]');
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color();

  return (t, dt) => {
    p += (pt - p) * (RM ? 1 : Math.min(1, dt * 6));
    const a = Math.min(4, Math.floor(p)), f = p - a, cur = Math.round(p);
    if (cur !== shown) { shown = cur; onStage(cur); }
    for (let i = 0; i < N; i++) {
      const A = L[a][i], B = L[a + 1][i], u = smooth(f * 1.5 - (i / N) * 0.5);
      P.set(A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, A[2] + (B[2] - A[2]) * u);
      const sc = Math.max(0.0001, A[3] + (B[3] - A[3]) * u); S.set(sc, sc, sc);
      E.set(A[4] + (B[4] - A[4]) * u, A[5] + (B[5] - A[5]) * u, A[6] + (B[6] - A[6]) * u); Q.setFromEuler(E);
      M.compose(P, Q, S); sheets.setMatrixAt(i, M);
      C.copy(PAL[A[7]]).lerp(PAL[B[7]], u); sheets.setColorAt(i, C);
    }
    sheets.instanceMatrix.needsUpdate = true; if (sheets.instanceColor) sheets.instanceColor.needsUpdate = true;
    const w3 = Math.max(0, 1 - Math.abs(p - 3)), w4 = Math.max(0, 1 - Math.abs(p - 4)), w5 = clamp(p - 4, 0, 1);
    const qs = p <= 2 ? 1 - p * 0.14 : Math.max(0, 1 - (p - 2) * 1.6) * 0.72;
    qg.scale.setScalar(Math.max(0.0001, qs)); qg.visible = qs > 0.01;
    if (!RM) { qWire.rotation.y = t * 0.4; qWire.rotation.x = t * 0.23; gap.rotation.y = t * 0.2; }
    gap.material.opacity = w4 * 0.5; gap.visible = w4 > 0.02;
    doc.scale.setScalar(Math.max(0.0001, smooth(w5))); doc.visible = w5 > 0.01; cm.opacity = smooth(w5 * 1.4 - 0.4) * 0.4;
    const sway = (RM ? 0 : Math.sin(t * 0.3) * 0.1) + mx * 0.14, flat = 1 - Math.max(w3, w5) * 0.85;
    grp.rotation.y = sway * flat; grp.rotation.x = 0.06 * flat;
    st.camera.position.set(0, 0, 31 * Math.max(1, 1.3 / st.camera.aspect)); st.camera.lookAt(0, 0, 0);
    grp.updateMatrixWorld(); P.set(0.4, 2.2, 0).applyMatrix4(grp.matrixWorld);
    place(st, gapEl, P.x, P.y, P.z, w4 > 0.6);
  };
}

/**
 * stepsRef: ref to the element whose six children are the stage copy blocks.
 * onStage:  called with 0..5 whenever the stage nearest the viewport centre changes.
 */
export function PipelineFigure({ stepsRef, onStage }) {
  const ref = useRef(null);
  const [cur, setCur] = useState(0);
  const cb = useRef(onStage); cb.current = onStage;
  useEffect(() => mountStage(ref.current, 40, (st) => buildPipeline(
    st,
    () => (stepsRef.current ? Array.from(stepsRef.current.children) : []),
    (c) => { setCur(c); if (cb.current) cb.current(c); },
  )), [stepsRef]);
  const legend = STAGE_LEGEND[cur];

  return (
    <figure className="lp3-fig">
      <div className="lp3-stage fixed" ref={ref}>
        <canvas role="img" aria-label="3D view of fifty papers moving through the review pipeline: retrieved around the question, filtered to forty-two, laid out as a table, clustered into themes, then cited by the finished review." />
        <div className="lp3-hud tl"><b>Stage {cur + 1}/6 · {STAGE_NAMES[cur]}</b><br />{STAGE_INFO[cur]}</div>
        {legend && (
          <div className="lp3-hud bl">
            {legend.map(([c, n]) => <span key={n}><i className="lp3-sw" style={{ background: HEX[c] }} />{n}</span>)}
          </div>
        )}
        <div className="lp3-tag" data-r="gap"><span>gap: no papers here</span></div>
        <NoGL />
      </div>
      <figcaption><b>Fig. 2</b> One example run: 50 papers found, 42 kept. Each sheet is a paper and keeps its identity from retrieval to citation.</figcaption>
    </figure>
  );
}

/* ── Fig. 3: hypothesis tournament ────────────────────────────────────────
   A 3D bracket. The corpus circles the floor, eight hypotheses stand on a
   ring as score pillars, and each round of head-to-head matches lifts the
   winners inward and upward until one sits at the top. The whole structure
   turns slowly so the depth reads; drag to look around. */

export const HYPO_STAGES = [
  ["Generate", "42 papers → 8 candidate hypotheses"],
  ["Critique", "each one scored · 2 flagged as prior art"],
  ["Rank", "single elimination · 7 head-to-head matches"],
  ["Recommend", "H3 · target within the reported range"],
];

function buildHypo(st, ctl) {
  const r = rng(41), g = gaussOf(r);
  const SCORE = [0.62, 0.81, 0.9, 0.55, 0.74, 0.47, 0.86, 0.68], FLAG = [0, 0, 0, 1, 0, 1, 0, 0];
  const R0 = 7, PH = 2.6, TIER = [[4.7, 3.7], [2.5, 5.3], [0, 6.9]]; // [radius, height] of each round's winners
  const angOf = (i) => (i / 8) * 6.2832 + 0.39;
  const polar = (rad, a, y) => new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad);
  const top = (i) => polar(R0, angOf(i), 0.35 + SCORE[i] * PH);

  const grp = new THREE.Group(); st.scene.add(grp);
  st.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dl = new THREE.DirectionalLight(0xffffff, 0.5); dl.position.set(6, 14, 10); st.scene.add(dl);

  // floor rings, one per tier of the bracket
  [R0, TIER[0][0], TIER[1][0]].forEach((rad) => {
    const pts = []; for (let k = 0; k <= 96; k++) pts.push(polar(rad, (k / 96) * 6.2832, 0));
    grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: PAL.line })));
  });

  // the corpus: papers drifting around the outside
  const NP = 240, pp = new Float32Array(NP * 3);
  for (let i = 0; i < NP; i++) { const a = r() * 6.2832, rad = 9.6 + r() * 2.2; pp[i * 3] = Math.cos(a) * rad; pp[i * 3 + 1] = g() * 0.35; pp[i * 3 + 2] = Math.sin(a) * rad; }
  const pgeo = new THREE.BufferGeometry(); pgeo.setAttribute("position", new THREE.BufferAttribute(pp, 3));
  const pmat = new THREE.PointsMaterial({ size: 0.42, map: dotTexture(), transparent: true, alphaTest: 0.5, sizeAttenuation: true });
  const corpus = new THREE.Points(pgeo, pmat); grp.add(corpus);

  // curved path helper: a quadratic arc from a to b that bows upward
  const arc = (a, b, lift) => new THREE.QuadraticBezierCurve3(a, a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, lift, 0)), b);
  const lineOf = (curves, color) => {
    const pts = []; curves.forEach((c) => { const p = c.getPoints(20); for (let k = 0; k < 20; k++) pts.push(p[k], p[k + 1]); });
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0 });
    grp.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat)); return mat;
  };

  // eight hypotheses: an orb on the ring, and a pillar whose height is its critic score
  const orbs = [], pillars = [], rings = [];
  const ringGeo = new THREE.TorusGeometry(0.62, 0.04, 8, 40); ringGeo.rotateX(Math.PI / 2);
  const feed = [];
  for (let i = 0; i < 8; i++) {
    const a = angOf(i), base = polar(R0, a, 0);
    const o = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 14), new THREE.MeshLambertMaterial()); grp.add(o); orbs.push(o);
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1, 20), new THREE.MeshLambertMaterial()); p.position.copy(base); grp.add(p); pillars.push(p);
    const q = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })); q.position.copy(base); grp.add(q); rings.push(q);
    feed.push(arc(polar(10.4, a - 0.5, 0), polar(R0, a, 0.35), 1.6));
  }
  const feedMat = lineOf(feed, PAL.muted);

  // the bracket: each match sends its winner one tier up and in
  let ent = SCORE.map((s, i) => ({ i, a: angOf(i), pos: top(i) }));
  const rounds = [], pulses = [];
  for (let rd = 0; rd < 3; rd++) {
    const win = [], lose = [], next = [], dots = [];
    for (let m = 0; m < ent.length; m += 2) {
      const A = ent[m], B = ent[m + 1], a = rd === 2 ? 0 : (A.a + B.a) / 2, node = polar(TIER[rd][0], a, TIER[rd][1]);
      const w = SCORE[A.i] >= SCORE[B.i] ? A : B;
      [A, B].forEach((e) => { const c = arc(e.pos, node, 1.1); if (e === w) { win.push(c); pulses.push({ c, rd, ph: r() }); } else lose.push(c); });
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 12), new THREE.MeshLambertMaterial({ color: PAL.accent })); d.position.copy(node); grp.add(d); dots.push(d);
      next.push({ i: w.i, a, pos: node });
    }
    rounds.push({ mWin: lineOf(win, PAL.accent), mLose: lineOf(lose, PAL.muted), dots }); ent = next;
  }
  feed.forEach((c) => pulses.push({ c, rd: -1, ph: r() }));
  const pulseMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), pulses.length);
  grp.add(pulseMesh);

  const champ = rounds[2].dots[0], CY = TIER[2][1];
  const halo = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 1), new THREE.MeshBasicMaterial({ color: PAL.accent, wireframe: true, transparent: true, opacity: 0 }));
  halo.position.copy(champ.position); grp.add(halo);

  // plausibility: the range the literature reports (band) and the champion's target (ring) on one axis
  const axMat = new THREE.LineBasicMaterial({ color: PAL.muted, transparent: true, opacity: 0 });
  grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, CY, 0)]), axMat));
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.2, 28, 1, true), new THREE.MeshBasicMaterial({ color: PAL.d2, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  band.position.y = 2.5; grp.add(band);
  const tgtGeo = new THREE.TorusGeometry(0.95, 0.07, 8, 48); tgtGeo.rotateX(Math.PI / 2);
  const target = new THREE.Mesh(tgtGeo, new THREE.MeshBasicMaterial({ color: PAL.d3, transparent: true, opacity: 0 })); target.position.y = 3.0; grp.add(target);

  const ob = orbit(st, { az: 0.6, el: 0.42, dist: 28, auto: 0.1, lo: 0.1, hi: 1.2, ref: 1.25, target: new THREE.Vector3(0, 2.7, 0) });
  const tags = orbs.map((_, i) => st.el.querySelector(`[data-r="h${i}"]`));
  const champEl = st.el.querySelector('[data-r="champ"]'), rangeEl = st.el.querySelector('[data-r="range"]'), targEl = st.el.querySelector('[data-r="target"]');
  const v = { hyp: 0, bar: 0, flag: 0, r: [0, 0, 0], champ: 0, plaus: 0 }; // eased, so stages animate in both directions
  const C = new THREE.Color(), P = new THREE.Vector3(), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3();

  return (t, dt) => {
    ctl.now = t;
    const s = ctl.stage, lt = RM ? 99 : t - ctl.t0, k = RM ? 1 : Math.min(1, dt * 4);
    const ease = (key, on) => { v[key] += ((on ? 1 : 0) - v[key]) * k; return v[key]; };
    ease("hyp", s > 0 || lt > 0.5); ease("bar", s >= 1); ease("flag", s > 1 || (s === 1 && lt > 1.6));
    ease("champ", s >= 3); ease("plaus", s === 3 && lt > 1.4);
    for (let rd = 0; rd < 3; rd++) v.r[rd] += ((s > 2 || (s === 2 && lt > rd * 1.3) ? 1 : 0) - v.r[rd]) * k;
    ob.apply(dt);
    if (!RM) corpus.rotation.y = t * 0.05;

    pmat.color.copy(PAL.muted).lerp(PAL.accent, s === 0 ? 0.9 : 0.15);
    feedMat.opacity = s === 0 ? 0.45 * v.hyp : 0.1 * v.hyp;
    for (let i = 0; i < 8; i++) {
      const dim = FLAG[i] * v.flag, h = 0.02 + v.bar * SCORE[i] * PH, a = angOf(i);
      C.copy(PAL.accent).lerp(PAL.line, dim * 0.85);
      orbs[i].position.copy(polar(R0, a, 0.35 + h)); orbs[i].scale.setScalar(Math.max(0.0001, v.hyp)); orbs[i].material.color.copy(C);
      pillars[i].scale.set(1, h, 1); pillars[i].position.y = h / 2; pillars[i].visible = v.bar > 0.01;
      pillars[i].material.color.copy(PAL.d6).lerp(PAL.accent, SCORE[i]).lerp(PAL.line, dim * 0.85);
      // critique: a ring scans up each pillar; a flagged hypothesis keeps an amber ring at its base
      const scan = RM ? 1 : (lt * 0.55 + i * 0.11) % 1;
      rings[i].visible = s === 1 || dim > 0.02;
      rings[i].position.y = FLAG[i] && v.flag > 0.5 ? 0.06 : scan * (0.35 + h);
      rings[i].material.color.copy(FLAG[i] && v.flag > 0.5 ? PAL.d3 : PAL.accent);
      rings[i].material.opacity = FLAG[i] ? Math.max(dim * 0.9, s === 1 ? 0.7 * v.bar : 0) : (s === 1 ? 0.7 * v.bar * (1 - v.flag * 0.6) : 0);
      P.copy(polar(R0 + 1.25, a, 0.2)).applyMatrix4(grp.matrixWorld); place(st, tags[i], P.x, P.y, P.z, v.hyp > 0.5);
    }
    rounds.forEach((R, rd) => {
      R.mWin.opacity = v.r[rd]; R.mLose.opacity = v.r[rd] * 0.3;
      R.dots.forEach((d) => { d.scale.setScalar(Math.max(0.0001, v.r[rd])); d.visible = v.r[rd] > 0.01; });
    });
    // pulses: papers flowing into the hypotheses, then winners flowing up the bracket
    pulses.forEach((p, n) => {
      const on = p.rd < 0 ? (s === 0 ? v.hyp : 0) : v.r[p.rd] * (s >= 2 ? 1 : 0);
      p.c.getPoint(RM ? 0.5 : (t * (p.rd < 0 ? 0.45 : 0.4) + p.ph) % 1, P);
      S.setScalar(Math.max(0.0001, on)); M.compose(P, Q, S); pulseMesh.setMatrixAt(n, M);
      pulseMesh.setColorAt(n, p.rd < 0 ? PAL.muted : PAL.accent);
    });
    pulseMesh.instanceMatrix.needsUpdate = true; if (pulseMesh.instanceColor) pulseMesh.instanceColor.needsUpdate = true;

    champ.scale.setScalar(Math.max(0.0001, v.r[2] * (1 + v.champ * 1.2)));
    halo.material.opacity = v.champ * 0.55; halo.visible = v.champ > 0.02;
    if (!RM) { halo.rotation.y = t * 0.6; halo.rotation.x = t * 0.35; halo.scale.setScalar(1 + Math.sin(t * 2) * 0.05); }
    axMat.opacity = v.plaus * 0.7; band.material.opacity = v.plaus * 0.3; band.visible = v.plaus > 0.02;
    target.material.opacity = v.plaus; target.visible = v.plaus > 0.02;
    target.position.y = 3.0 + (RM ? 0 : Math.sin(t * 1.6) * 0.12 * v.plaus) + (1 - v.plaus) * 2.5;
    place(st, champEl, 0, CY + 1.9, 0, v.champ > 0.5);
    place(st, rangeEl, 0, 1.0, 0, v.plaus > 0.5); place(st, targEl, 1.9, 3.0, 0, v.plaus > 0.5);
  };
}

/** stage: 0..3, an index into HYPO_STAGES. */
export function HypothesisFigure({ stage = 0 }) {
  const ref = useRef(null);
  const ctl = useRef({ stage, t0: 0, now: 0 });
  useEffect(() => { ctl.current.stage = stage; ctl.current.t0 = ctl.current.now; }, [stage]);
  useEffect(() => mountStage(ref.current, 38, (st) => buildHypo(st, ctl.current)), []);

  return (
    <figure className="lp3-fig">
      <div className="lp3-stage" ref={ref}>
        <canvas role="img" aria-label="Rotating 3D bracket. Papers circle the floor and feed eight hypotheses standing on a ring. Each grows a pillar as tall as its score, two are flagged as prior art, and rounds of head-to-head matches lift the winners inward and upward until one hypothesis sits at the top." />
        <div className="lp3-hud tl"><b>Stage {stage + 1}/{HYPO_STAGES.length} · {HYPO_STAGES[stage][0]}</b><br />{HYPO_STAGES[stage][1]}</div>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="lp3-tag axis" data-r={"h" + i}><span>H{i + 1}</span></div>)}
        <div className="lp3-tag axis strong" data-r="champ"><span>Recommendation: H3</span></div>
        <div className="lp3-tag axis" data-r="range"><span>reported range</span></div>
        <div className="lp3-tag axis" data-r="target"><span>H3 target</span></div>
        <NoGL />
      </div>
      <figcaption><b>Fig. 3</b> Eight candidate hypotheses are scored, checked for prior art and ranked head to head until one is recommended. Drag to rotate. Scores and outcome are illustrative.</figcaption>
    </figure>
  );
}

/* ── Fig. 4: hypothesis loop ──────────────────────────────────────────── */

const LOOP_TITLE = ["Design space", "Execution · 96-well plate", "Model feedback"];
const LOOP_CAPTION = [
  "Predicted yield over two reaction conditions. Each amber point is one proposed experiment; the search closes in on the peak. Toy model.",
  "A 96-well plate filled column by column by an 8-channel pipette. Colour marks the concentration series. Illustrative.",
  "Measurements land in three batches and the model surface bends to fit them. RMSE is computed live from this toy model.",
];

function buildLoop(st, ctl) {
  const G = 30, H = 4.6, PRIOR = 0.3, r = rng(23), g = gaussOf(r);
  const ft = (x, y) => 0.95 * Math.exp(-((x - 0.35) * (x - 0.35) + (y - 0.3) * (y - 0.3)) / 0.18)
    + 0.5 * Math.exp(-((x + 0.5) * (x + 0.5) + (y + 0.45) * (y + 0.45)) / 0.12) + 0.04 * (x + 1);
  const nv = (G + 1) * (G + 1), sp = new Float32Array(nv * 3), sc = new Float32Array(nv * 3), tr = new Float32Array(nv), idx = [];
  let sq = 0;
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
    const n = j * (G + 1) + i, x = (i / G) * 2 - 1, y = (j / G) * 2 - 1;
    sp[n * 3] = x * 6; sp[n * 3 + 2] = y * 6; tr[n] = ft(x, y); sq += (tr[n] - PRIOR) * (tr[n] - PRIOR);
    if (i < G) idx.push(n, n + 1); if (j < G) idx.push(n, n + G + 1);
  }
  const RMSE0 = Math.sqrt(sq / nv);
  const sg = new THREE.BufferGeometry(), spA = new THREE.BufferAttribute(sp, 3), scA = new THREE.BufferAttribute(sc, 3);
  sg.setAttribute("position", spA); sg.setAttribute("color", scA); sg.setIndex(idx);
  const surf = new THREE.Group();
  surf.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ vertexColors: true })));
  const ax = [-6, 0, 6, 6, 0, 6, -6, 0, 6, -6, 0, -6, -6, 0, -6, -6, H * 1.08, -6, 6, 0, 6, 6, 0, -6, 6, 0, -6, -6, 0, -6];
  for (let q = 0; q <= 4; q++) {
    const v = -6 + q * 3;
    ax.push(v, 0, 6, v, 0, 6.35, -6, 0, v, -6.35, 0, v, -6, (H * 1.08 * q) / 4, -6, -6.3, (H * 1.08 * q) / 4, -6);
  }
  const ag = new THREE.BufferGeometry(); ag.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ax), 3));
  surf.add(new THREE.LineSegments(ag, new THREE.LineBasicMaterial({ color: PAL.muted })));
  const MAXP = 24, pts = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAXP);
  surf.add(pts);
  const stemP = new Float32Array(MAXP * 6), stemG = new THREE.BufferGeometry(), stemA = new THREE.BufferAttribute(stemP, 3);
  stemG.setAttribute("position", stemA);
  surf.add(new THREE.LineSegments(stemG, new THREE.LineBasicMaterial({ color: PAL.d3, transparent: true, opacity: 0.6 })));
  st.scene.add(surf);
  // Bayesian-optimisation style sequence: scattered first, then closing in on the peak.
  const BO = [[-0.8, 0.7], [0.75, -0.7], [-0.5, -0.45], [0, 0.85], [0.8, 0.6], [-0.1, 0], [0.55, 0.05], [0.2, 0.5], [0.45, 0.4], [0.3, 0.22], [0.38, 0.33], [0.35, 0.3]];
  const MS = []; for (let b = 0; b < 24; b++) MS.push([r() * 1.8 - 0.9, r() * 1.8 - 0.9, g() * 0.03]);

  const plate = new THREE.Group(), M = new THREE.Matrix4();
  const body = new THREE.Mesh(new THREE.BoxGeometry(13.6, 0.5, 9.4), new THREE.MeshLambertMaterial({ color: PAL.surface }));
  plate.add(body);
  plate.add(new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: PAL.muted })));
  const wells = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.38, 0.38, 0.14, 20), new THREE.MeshLambertMaterial({ color: 0xffffff }), 96);
  for (let c = 0; c < 12; c++) for (let w = 0; w < 8; w++) { M.makeTranslation((c - 5.5) * 1.05, 0.3, (w - 3.5) * 1.05); wells.setMatrixAt(c * 8 + w, M); }
  plate.add(wells);
  const pip = new THREE.Group(), pipM = new THREE.MeshLambertMaterial({ color: PAL.muted });
  for (let w = 0; w < 8; w++) { const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.04, 2.4, 10), pipM); tip.position.set(0, 1.2, (w - 3.5) * 1.05); pip.add(tip); }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 8.6), pipM); bar.position.y = 2.7; pip.add(bar);
  plate.add(pip); st.scene.add(plate);
  st.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dl = new THREE.DirectionalLight(0xffffff, 0.5); dl.position.set(8, 14, 10); st.scene.add(dl);

  const ob = orbit(st, { az: 0.7, el: 0.5, dist: 24, auto: 0.12, lo: 0.12, hi: 1.3, ref: 1.2, target: new THREE.Vector3(0, 1.4, 0) });
  const C = new THREE.Color(), LO = new THREE.Color().copy(PAL.muted).lerp(PAL.stage, 0.45);
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  let lastBlend = -1;
  const setSurface = (bl) => {
    if (bl === lastBlend) return; lastBlend = bl;
    for (let n = 0; n < nv; n++) {
      const h = PRIOR + (tr[n] - PRIOR) * bl; sp[n * 3 + 1] = h * H;
      C.copy(LO).lerp(PAL.accent, clamp(h * 1.05, 0, 1)); sc[n * 3] = C.r; sc[n * 3 + 1] = C.g; sc[n * 3 + 2] = C.b;
    }
    spA.needsUpdate = true; scA.needsUpdate = true;
  };
  const putPoint = (i, x, y, h, drop, color, big) => {
    const X = x * 6, Z = y * 6, Y = h * H + drop;
    P.set(X, Y, Z); S.setScalar(big ? 1.7 : 1); M.compose(P, Q, S); pts.setMatrixAt(i, M); pts.setColorAt(i, color);
    stemP[i * 6] = X; stemP[i * 6 + 1] = 0; stemP[i * 6 + 2] = Z; stemP[i * 6 + 3] = X; stemP[i * 6 + 4] = drop > 0 ? 0 : Y; stemP[i * 6 + 5] = Z;
  };
  const hidePoint = (i) => { S.setScalar(0.0001); P.set(0, -50, 0); M.compose(P, Q, S); pts.setMatrixAt(i, M); stemP.fill(0, i * 6, i * 6 + 6); };
  const infoEl = st.el.querySelector('[data-r="info"]');
  const axEl = ["ax", "ay", "az"].map((k) => st.el.querySelector(`[data-r="${k}"]`));

  return (t, dt) => {
    ctl.now = t;
    const mode = ctl.mode, lt = t - ctl.t0;
    surf.visible = mode !== 1; plate.visible = mode === 1;
    ob.target.y += ((mode === 1 ? 0.4 : 1.5) - ob.target.y) * Math.min(1, dt * 4); ob.apply(dt);
    let info = "";
    if (mode === 0) {
      setSurface(1);
      const per = 12 * 0.75 + 3.5, s = RM ? 99 : lt % per, k = clamp(Math.floor(s / 0.75) + 1, 1, 12);
      for (let i = 0; i < MAXP; i++) {
        if (i < k) { const b = BO[i]; putPoint(i, b[0], b[1], ft(b[0], b[1]), 0, i === k - 1 ? PAL.ink : PAL.d3, i === k - 1); } else hidePoint(i);
      }
      const bb = BO[k - 1]; info = `experiment ${k}/12 · predicted yield ${ft(bb[0], bb[1]).toFixed(2)}`;
    } else if (mode === 2) {
      const per = 3 * 2.6 + 3.5, s = RM ? 99 : lt % per, TG = [0, 0.4, 0.75, 1];
      let bl = 0, it = 0;
      for (let b = 0; b < 3; b++) { const land = b * 2.6 + 0.6; if (s >= land) { it = b + 1; bl = TG[b] + (TG[b + 1] - TG[b]) * smooth((s - land) / 1.2); } }
      setSurface(bl);
      for (let i = 0; i < MAXP; i++) {
        const bt = Math.floor(i / 8) * 2.6, m = MS[i], u = clamp((s - bt) / 0.6, 0, 1);
        if (s < bt) hidePoint(i); else putPoint(i, m[0], m[1], ft(m[0], m[1]) + m[2], (1 - u) * (1 - u) * 5, PAL.d3, false);
      }
      info = `iteration ${Math.max(1, it)}/3 · surface RMSE ${(RMSE0 * (1 - bl)).toFixed(3)}`;
    } else {
      const per = 12 * 0.7 + 2.5, s = RM ? 99 : lt % per, col = clamp(Math.floor(s / 0.7), 0, 12), ph = (s / 0.7) % 1;
      for (let c = 0; c < 12; c++) {
        const done = c < col || (c === col && ph > 0.5); C.copy(PAL.d2).lerp(PAL.d1, c / 11);
        for (let w = 0; w < 8; w++) wells.setColorAt(c * 8 + w, done ? C : PAL.line);
      }
      if (wells.instanceColor) wells.instanceColor.needsUpdate = true;
      pip.position.x = (Math.min(col, 11) - 5.5) * 1.05; pip.position.y = col >= 12 ? 1.6 : 0.35 + Math.abs(Math.cos(ph * 3.14159)) * 1.3;
      const filled = Math.min(96, (col < 12 && ph > 0.5 ? col + 1 : col) * 8);
      info = `column ${Math.min(12, col + (col < 12 ? 1 : 0))}/12 · ${filled} of 96 wells dispensed`;
    }
    pts.instanceMatrix.needsUpdate = true; if (pts.instanceColor) pts.instanceColor.needsUpdate = true; stemA.needsUpdate = true;
    setText(infoEl, info);
    const s = mode !== 1;
    place(st, axEl[0], 0, 0, 8, s); place(st, axEl[1], -8.2, 0, 0, s); place(st, axEl[2], -6, H * 1.08 + 0.6, -6, s);
  };
}

/** mode: 0 = design space, 1 = 96-well plate, 2 = model feedback. */
export function LoopFigure({ mode = 0 }) {
  const ref = useRef(null);
  const ctl = useRef({ mode, t0: 0, now: 0 });
  useEffect(() => { ctl.current.mode = mode; ctl.current.t0 = ctl.current.now; }, [mode]);
  useEffect(() => mountStage(ref.current, 38, (st) => buildLoop(st, ctl.current)), []);

  return (
    <figure className="lp3-fig">
      <div className="lp3-stage" ref={ref}>
        <canvas role="img" aria-label="3D view that changes with the selected stage: a yield surface sampled by Bayesian optimization, a 96-well plate being filled by an eight-channel pipette, or the model surface bending to fit new measurements." />
        <div className="lp3-hud tl"><b>{LOOP_TITLE[mode]}</b><br /><span data-r="info" /></div>
        <div className="lp3-tag axis" data-r="ax"><span>cofactor (mM)</span></div>
        <div className="lp3-tag axis" data-r="ay"><span>buffer pH</span></div>
        <div className="lp3-tag axis" data-r="az"><span>yield</span></div>
        <NoGL />
      </div>
      <figcaption><b>Fig. 4</b> {LOOP_CAPTION[mode]}</figcaption>
    </figure>
  );
}

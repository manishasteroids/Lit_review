// Click-to-zoom for chat-rendered diagrams (mermaid architecture/flow
// diagrams shown in Studio chat and single-paper chat). Both chat surfaces
// insert `.chat-diagram` divs via raw DOM (see renderMermaid() in
// StudioView.jsx / PaperChatPanel.jsx, not React), so this listens at the
// document level with one delegated click handler instead of duplicating
// zoom/lightbox state in every chat component.
//
// The lightbox itself supports zooming in/out (buttons, scroll wheel,
// Ctrl/Cmd + +/-) and panning by dragging once zoomed in.
//
// Imported once for its side effect (see main.jsx).

let overlay = null;
let scale = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let dragStart = null;

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "dz-overlay";
  overlay.innerHTML = `
    <div class="dz-toolbar">
      <button class="dz-btn" data-act="out" aria-label="Zoom out" type="button">−</button>
      <span class="dz-pct">100%</span>
      <button class="dz-btn" data-act="in" aria-label="Zoom in" type="button">+</button>
      <button class="dz-btn" data-act="reset" aria-label="Reset zoom" type="button">Reset</button>
      <span class="dz-sep"></span>
      <button class="dz-btn dz-btn-wide" data-act="png" aria-label="Download PNG" type="button">⇩ PNG</button>
      <button class="dz-btn dz-btn-wide" data-act="svg" aria-label="Download SVG" type="button">⇩ SVG</button>
    </div>
    <button class="dz-close" aria-label="Close" type="button">×</button>
    <div class="dz-viewport">
      <div class="dz-box"></div>
    </div>
  `;
  const viewport = overlay.querySelector(".dz-viewport");
  const box = overlay.querySelector(".dz-box");

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest(".dz-close")) close();
  });

  overlay.querySelector(".dz-toolbar").addEventListener("click", (e) => {
    const act = e.target.closest(".dz-btn")?.dataset.act;
    if (act === "in") setScale(scale + 0.25);
    else if (act === "out") setScale(scale - 0.25);
    else if (act === "reset") { panX = 0; panY = 0; setScale(1); }
    else if (act === "svg") downloadSvg();
    else if (act === "png") downloadPng();
  });

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    setScale(scale + (e.deltaY < 0 ? 0.15 : -0.15));
  }, { passive: false });

  viewport.addEventListener("mousedown", (e) => {
    if (scale <= 1) return;
    dragging = true;
    dragStart = { x: e.clientX - panX, y: e.clientY - panY };
    viewport.classList.add("dragging");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panX = e.clientX - dragStart.x;
    panY = e.clientY - dragStart.y;
    applyTransform();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    viewport.classList.remove("dragging");
  });

  function applyTransform() {
    box.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    overlay.querySelector(".dz-pct").textContent = `${Math.round(scale * 100)}%`;
  }
  overlay._applyTransform = applyTransform;

  document.body.appendChild(overlay);
  return overlay;
}

function setScale(next) {
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  if (scale <= 1) { panX = 0; panY = 0; }
  overlay._applyTransform();
}

function open(svgHtml) {
  const el = ensureOverlay();
  el.querySelector(".dz-box").innerHTML = svgHtml;
  scale = 1; panX = 0; panY = 0;
  el._applyTransform();
  el.classList.add("on");
  document.addEventListener("keydown", onKey);
}

function close() {
  if (!overlay) return;
  overlay.classList.remove("on");
  document.removeEventListener("keydown", onKey);
}

// Diagrams render at whatever intrinsic size mermaid chose, which is often
// small — reading pixel dimensions straight off the SVG produces a blurry
// download. Fall back to the viewBox (mermaid always sets one) and render at
// a fixed multiplier for a crisp PNG regardless of on-screen zoom level.
function svgDimensions(svg) {
  const vb = svg.getAttribute("viewBox");
  if (vb) {
    const parts = vb.trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { w: parts[2], h: parts[3] };
  }
  const w = parseFloat(svg.getAttribute("width")) || svg.getBoundingClientRect().width || 800;
  const h = parseFloat(svg.getAttribute("height")) || svg.getBoundingClientRect().height || 600;
  return { w, h };
}

function currentSvg() {
  return overlay?.querySelector(".dz-box svg") || null;
}

function timestampedName(ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `sift-diagram-${ts}.${ext}`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadSvg() {
  const svg = currentSvg();
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  triggerDownload(blob, timestampedName("svg"));
}

function downloadPng() {
  const svg = currentSvg();
  if (!svg) return;
  const { w, h } = svgDimensions(svg);
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", w);
  clone.setAttribute("height", h);
  const source = new XMLSerializer().serializeToString(clone);

  // A blob: URL as the <img> src worked in some browsers but silently failed
  // to fire either onload or onerror in others (Safari in particular has
  // been inconsistent about rasterizing SVG blob URLs) — the click did
  // nothing with no error surfaced anywhere. A base64 data: URI is the more
  // broadly-supported way to get an SVG into a canvas via <img>. Diagram
  // labels routinely contain non-ASCII characters (→, en dashes, etc.), so
  // btoa() needs the UTF-8-safe escape/encodeURIComponent dance — passing
  // the raw string to btoa() throws on those characters.
  let dataUrl;
  try {
    dataUrl = "data:image/svg+xml;charset=utf-8;base64," +
      btoa(unescape(encodeURIComponent(source)));
  } catch (err) {
    console.error("diagramZoom: failed to encode SVG for PNG export", err);
    downloadSvg();
    return;
  }

  const SCALE = 2; // crisp on high-DPI screens without producing a huge file
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w * SCALE;
      canvas.height = h * SCALE;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";  // mermaid diagrams assume a white page background
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(SCALE, SCALE);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (blob) triggerDownload(blob, timestampedName("png"));
        else { console.error("diagramZoom: canvas.toBlob() returned null"); downloadSvg(); }
      }, "image/png");
    } catch (err) {
      // Most likely a tainted-canvas SecurityError — fall back to SVG rather
      // than leave the click looking like it did nothing.
      console.error("diagramZoom: PNG export failed, falling back to SVG download", err);
      downloadSvg();
    }
  };
  img.onerror = (err) => {
    console.error("diagramZoom: SVG failed to load as an Image for PNG export", err);
    downloadSvg();
  };
  img.src = dataUrl;
}

function onKey(e) {
  if (e.key === "Escape") close();
  else if ((e.key === "+" || e.key === "=") ) setScale(scale + 0.25);
  else if (e.key === "-") setScale(scale - 0.25);
}

document.addEventListener("click", (e) => {
  const diagram = e.target.closest(".chat-diagram");
  if (!diagram) return;
  open(diagram.innerHTML);
});

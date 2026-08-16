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

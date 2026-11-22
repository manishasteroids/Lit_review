"""
Concept diagrams for the Publish step.

The DiagramAgent (agents/manuscript.py) reads the written paper and returns
small structured specs -- never image data, never drawing code. This module
turns each spec into a figure with matplotlib, so what is drawn is exactly
what the spec says and nothing else:

  flow      a process or pipeline: boxes top to bottom, joined by arrows
  layers    an architecture or framework: stacked bands, each holding items
  taxonomy  a classification: a root, its branches, and each branch's members

Figures are drawn 3.4 inches wide so they sit in one column of a two-column
template and scale up cleanly in a single-column one. Monochrome with one
light tint, so they survive greyscale printing.
"""
from __future__ import annotations

import io
import textwrap

KINDS = ("flow", "layers", "taxonomy")
W = 3.4                                   # inches
INK, RULE, TINT, CHIP = "#1B1E2B", "#3A3F58", "#EEF0FB", "#FFFFFF"
PT = 1 / 72.0


def clean_spec(d: dict) -> dict | None:
    """Validate and trim one diagram spec from the agent. None = unusable."""
    if not isinstance(d, dict) or d.get("kind") not in KINDS:
        return None
    out = {"kind": d["kind"], "title": str(d.get("title") or "").strip()[:48]}
    if d["kind"] == "flow":
        steps = []
        for s in d.get("steps") or []:
            if isinstance(s, str):
                s = {"label": s}
            if isinstance(s, dict) and str(s.get("label") or "").strip():
                steps.append({"label": str(s["label"]).strip()[:44],
                              "detail": str(s.get("detail") or "").strip()[:100]})
        if len(steps) < 3:
            return None
        out["steps"] = steps[:7]
    else:
        groups = []
        for g in d.get("groups") or []:
            if not isinstance(g, dict) or not str(g.get("label") or "").strip():
                continue
            items = [str(x).strip()[:30] for x in (g.get("items") or []) if str(x).strip()][:6]
            if items:
                groups.append({"label": str(g["label"]).strip()[:40], "items": items})
        if len(groups) < 2:
            return None
        out["groups"] = groups[:5]
    return out


def _canvas(height: float):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig = plt.figure(figsize=(W, height), dpi=300)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, height)
    ax.axis("off")
    return fig, ax


def _box(ax, x, y, w, h, face=TINT, edge=RULE, lw=0.7, r=0.05):
    from matplotlib.patches import FancyBboxPatch
    ax.add_patch(FancyBboxPatch((x + r, y + r), w - 2 * r, h - 2 * r, boxstyle=f"round,pad={r}",
                                facecolor=face, edgecolor=edge, linewidth=lw))


def _png(fig) -> bytes:
    import matplotlib.pyplot as plt
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=300, facecolor="white")
    plt.close(fig)
    return buf.getvalue()


def _draw_flow(spec: dict) -> bytes:
    pad, gap, lh, dh = 0.09, 0.2, 9.5 * PT, 8.2 * PT
    rows = []
    for s in spec["steps"]:
        label = textwrap.wrap(s["label"], 38) or [""]
        detail = textwrap.wrap(s["detail"], 52) if s["detail"] else []
        rows.append((label, detail, 2 * pad + len(label) * lh + (0.03 + len(detail) * dh if detail else 0)))
    height = sum(r[2] for r in rows) + gap * (len(rows) - 1) + 0.08
    fig, ax = _canvas(height)
    y = height - 0.04
    for i, (label, detail, h) in enumerate(rows):
        _box(ax, 0.04, y - h, W - 0.08, h)
        ty = y - pad - lh * 0.5
        for line in label:
            ax.text(W / 2, ty, line, ha="center", va="center", fontsize=7.6, fontweight="bold", color=INK)
            ty -= lh
        ty -= 0.03 - (lh - dh) * 0.5 if detail else 0
        for line in detail:
            ax.text(W / 2, ty, line, ha="center", va="center", fontsize=6.4, color=RULE)
            ty -= dh
        y -= h
        if i < len(rows) - 1:
            ax.annotate("", xy=(W / 2, y - gap + 0.015), xytext=(W / 2, y - 0.015),
                        arrowprops=dict(arrowstyle="-|>", color=RULE, lw=0.8, mutation_scale=7))
            y -= gap
    return _png(fig)


def _chip_rows(items: list[str], width: float) -> list[list[tuple[str, float]]]:
    rows, cur, used = [], [], 0.0
    for it in items:
        w = min(width, 0.16 + len(it) * 0.052)
        if cur and used + w + 0.06 > width:
            rows.append(cur)
            cur, used = [], 0.0
        cur.append((it, w))
        used += w + 0.06
    if cur:
        rows.append(cur)
    return rows


def _draw_groups(spec: dict, tree: bool) -> bytes:
    indent = 0.2 if tree else 0.04
    inner = W - indent - 0.04 - 0.16
    chip_h, head_h, pad, gap = 0.21, 0.2, 0.08, 0.1 if tree else 0.14
    bands = []
    for g in spec["groups"]:
        rows = _chip_rows(g["items"], inner)
        bands.append((g, rows, head_h + len(rows) * (chip_h + 0.05) + pad + 0.03))
    root_h = 0.3 if (tree and spec.get("title")) else 0
    height = root_h + (0.14 if root_h else 0) + sum(b[2] for b in bands) + gap * (len(bands) - 1) + 0.08
    fig, ax = _canvas(height)
    y = height - 0.04
    spine_top = None
    if root_h:
        _box(ax, 0.04, y - root_h, W - 0.08, root_h, face=INK, edge=INK)
        ax.text(W / 2, y - root_h / 2, spec["title"], ha="center", va="center", fontsize=7.8,
                fontweight="bold", color="white")
        y -= root_h
        spine_top = y
        y -= 0.14
    mids = []
    for i, (g, rows, h) in enumerate(bands):
        _box(ax, indent, y - h, W - indent - 0.04, h)
        mids.append(y - h / 2)
        ax.text(indent + 0.1, y - 0.045 - head_h / 2, g["label"].upper() if not tree else g["label"],
                ha="left", va="center", fontsize=6.6 if not tree else 7.2, fontweight="bold", color=INK)
        cy = y - head_h - 0.04
        for row in rows:
            cx = indent + 0.08
            for text, w in row:
                _box(ax, cx, cy - chip_h, w, chip_h, face=CHIP, lw=0.5, r=0.035)
                ax.text(cx + w / 2, cy - chip_h / 2, text, ha="center", va="center", fontsize=6.2, color=INK)
                cx += w + 0.06
            cy -= chip_h + 0.05
        y -= h
        if i < len(bands) - 1:
            if not tree:
                ax.annotate("", xy=(W / 2, y - gap + 0.012), xytext=(W / 2, y - 0.012),
                            arrowprops=dict(arrowstyle="-|>", color=RULE, lw=0.7, mutation_scale=6))
            y -= gap
    if tree and spine_top is not None:
        ax.plot([0.1, 0.1], [spine_top, mids[-1]], color=RULE, lw=0.7)
        for m in mids:
            ax.plot([0.1, indent + 0.02], [m, m], color=RULE, lw=0.7)
    return _png(fig)


def render(spec: dict) -> bytes:
    """PNG bytes for a spec that has been through clean_spec()."""
    if spec["kind"] == "flow":
        return _draw_flow(spec)
    return _draw_groups(spec, tree=spec["kind"] == "taxonomy")

"""
One shared publication style sheet -- data_analysis_agent_architecture.md
SS4's "what publication-ready concretely means": consistent fonts/DPI/
palette across every figure this pipeline renders, colorblind- and
print-safe by default. pipeline/plot_renderer.py applies this to every
chart type; nothing else in this module renders anything itself.
"""
import matplotlib

matplotlib.use("Agg")  # headless -- this runs server-side, never opens a window
import matplotlib.pyplot as plt

# Okabe-Ito palette -- the standard colorblind-safe categorical palette,
# and it survives grayscale printing far better than matplotlib's default
# tab10 (per SS7.1's "print-safe by default" requirement).
CATEGORICAL_PALETTE = [
    "#0072B2",  # blue
    "#E69F00",  # orange
    "#009E73",  # green
    "#D55E00",  # vermillion
    "#CC79A7",  # pink
    "#56B4E9",  # sky blue
    "#F0E442",  # yellow
    "#000000",  # black
]

DPI = 300
FONT_FAMILY = "DejaVu Sans"  # ships with matplotlib -- no extra font install needed
FONT_SIZE = 11


def apply() -> None:
    """Call once before rendering a figure -- sets the shared rcParams
    every chart type in plot_renderer.py draws with."""
    plt.rcParams.update({
        "figure.dpi": DPI,
        "savefig.dpi": DPI,
        "font.family": FONT_FAMILY,
        "font.size": FONT_SIZE,
        "axes.titlesize": FONT_SIZE + 1,
        "axes.labelsize": FONT_SIZE,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.prop_cycle": plt.cycler(color=CATEGORICAL_PALETTE),
        "axes.grid": True,
        "grid.alpha": 0.25,
        "grid.linewidth": 0.5,
        "figure.facecolor": "white",
        "savefig.facecolor": "white",
        "svg.fonttype": "none",  # keep text as real text in exported SVGs, not paths
    })

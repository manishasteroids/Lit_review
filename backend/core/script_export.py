"""
Turns a saved PlotSpec back into a standalone pandas+matplotlib Python
script the researcher can run, read, and edit in their own environment --
this is the answer to "I want real matplotlib control" (custom fonts, a
second axis, tick formatting, annotations, whatever) without this app
trying to expose every matplotlib knob as a form field.

The generated script is completely self-contained: it never imports from
this codebase (core/, pipeline/) since it has to run outside it. Style
constants (palette/DPI/font) are read from plot_style at generation time
and inlined as plain values, so the script matches what was actually
rendered without importing plot_style itself.

Deterministic string-templating from a PlotSpec dict -- same "spec, never
code" principle as pipeline/plot_renderer.py, just emitting source text
instead of pixels. No LLM involvement.
"""
from typing import Optional

from core import plot_style


def _lit(v) -> str:
    """Python source literal for a value pulled out of a stored PlotSpec
    dict (already-safe JSON-ish types: str/int/float/bool/None)."""
    return repr(v)


def _style_prelude() -> list:
    return [
        "import matplotlib",
        'matplotlib.use("Agg")  # remove this line to open an interactive window instead',
        "import matplotlib.pyplot as plt",
        "import pandas as pd",
        "",
        f"PALETTE = {_lit(list(plot_style.CATEGORICAL_PALETTE))}  # Okabe-Ito, colorblind- and print-safe",
        "",
        "plt.rcParams.update({",
        f'    "figure.dpi": {plot_style.DPI}, "savefig.dpi": {plot_style.DPI},',
        f'    "font.family": {_lit(plot_style.FONT_FAMILY)}, "font.size": {plot_style.FONT_SIZE},',
        '    "axes.spines.top": False, "axes.spines.right": False,',
        '    "axes.grid": True, "grid.alpha": 0.25, "grid.linewidth": 0.5,',
        '    "figure.facecolor": "white", "savefig.facecolor": "white",',
        '    "svg.fonttype": "none",',
        "})",
    ]


def _chart_body(spec: dict) -> list:
    chart_type = spec.get("chart_type")
    x, y, group = spec.get("x"), spec.get("y"), spec.get("group")
    agg = spec.get("agg") or "mean"
    lines: list = []

    if chart_type == "scatter":
        lines += [f"x_col, y_col = {_lit(x)}, {_lit(y)}"]
        if group:
            lines += [
                f"group_col = {_lit(group)}",
                "for i, (name, g) in enumerate(df.groupby(group_col)):",
                "    ax.scatter(g[x_col], g[y_col], label=str(name),",
                "               color=PALETTE[i % len(PALETTE)], alpha=0.8, s=24)",
                "ax.legend(title=group_col, fontsize=9)",
            ]
        else:
            lines += ["ax.scatter(df[x_col], df[y_col], color=PALETTE[0], alpha=0.8, s=24)"]
        lines += ["ax.set_xlabel(x_col)", "ax.set_ylabel(y_col)"]

    elif chart_type == "line":
        lines += [f"x_col, y_col = {_lit(x)}, {_lit(y)}", "x_vals = df[x_col] if x_col else df.index"]
        if group:
            lines += [
                f"group_col = {_lit(group)}",
                "for i, (name, g) in enumerate(df.groupby(group_col)):",
                "    gx = g[x_col] if x_col else g.index",
                "    ax.plot(gx, g[y_col], label=str(name), color=PALETTE[i % len(PALETTE)], linewidth=1.2)",
                "ax.legend(title=group_col, fontsize=9)",
            ]
        else:
            lines += ["ax.plot(x_vals, df[y_col], color=PALETTE[0], linewidth=1.2)"]
        lines += ["ax.set_xlabel(x_col or 'index')", "ax.set_ylabel(y_col)"]

    elif chart_type == "bar":
        lines += [f"x_col, y_col, agg = {_lit(x)}, {_lit(y)}, {_lit(agg)}"]
        if group:
            lines += [
                f"group_col = {_lit(group)}",
                "pivot = df.groupby([x_col, group_col])[y_col].agg(agg).unstack(group_col)",
                "pivot.plot(kind='bar', ax=ax, color=PALETTE[:pivot.shape[1]])",
                "ax.legend(title=group_col, fontsize=9)",
            ]
        else:
            lines += [
                "grouped = df.groupby(x_col)[y_col].agg(agg)",
                "ax.bar(grouped.index.astype(str), grouped.values, color=PALETTE[0])",
            ]
        lines += [
            "ax.set_xlabel(x_col)", "ax.set_ylabel(f'{agg}({y_col})')",
            "plt.setp(ax.get_xticklabels(), rotation=30, ha='right')",
        ]

    elif chart_type == "box":
        lines += [f"x_col, y_col = {_lit(x)}, {_lit(y)}"]
        if x:
            lines += [
                "groups = [g[y_col].dropna().values for _, g in df.groupby(x_col)]",
                "labels = [str(k) for k in df.groupby(x_col).groups.keys()]",
                "bp = ax.boxplot(groups, labels=labels, patch_artist=True)",
                "for i, box in enumerate(bp['boxes']):",
                "    box.set_facecolor(PALETTE[i % len(PALETTE)])",
                "    box.set_alpha(0.6)",
                "ax.set_xlabel(x_col)",
                "plt.setp(ax.get_xticklabels(), rotation=30, ha='right')",
            ]
        else:
            lines += ["ax.boxplot(df[y_col].dropna().values, labels=[y_col], patch_artist=True)"]
        lines += ["ax.set_ylabel(y_col)"]

    elif chart_type == "histogram":
        col = x or y
        lines += [f"col = {_lit(col)}"]
        if group:
            lines += [
                f"group_col = {_lit(group)}",
                "for i, (name, g) in enumerate(df.groupby(group_col)):",
                "    ax.hist(g[col].dropna(), bins=30, alpha=0.5, label=str(name), color=PALETTE[i % len(PALETTE)])",
                "ax.legend(title=group_col, fontsize=9)",
            ]
        else:
            lines += ["ax.hist(df[col].dropna(), bins=30, color=PALETTE[0])"]
        lines += ["ax.set_xlabel(col)", "ax.set_ylabel('count')"]

    elif chart_type == "heatmap":
        lines += [
            "numeric = df.select_dtypes(include='number')",
            "corr = numeric.corr()",
            "im = ax.imshow(corr.values, cmap='RdBu_r', vmin=-1, vmax=1)",
            "ax.set_xticks(range(len(corr.columns)))",
            "ax.set_xticklabels(corr.columns, rotation=45, ha='right')",
            "ax.set_yticks(range(len(corr.columns)))",
            "ax.set_yticklabels(corr.columns)",
            "fig.colorbar(im, ax=ax, label='Pearson r', fraction=0.046, pad=0.04)",
            "for i in range(len(corr.columns)):",
            "    for j in range(len(corr.columns)):",
            "        val = corr.values[i, j]",
            "        ax.text(j, i, f'{val:.2f}', ha='center', va='center', fontsize=7,",
            "                color='white' if abs(val) > 0.6 else 'black')",
        ]
    else:
        lines += [f"raise ValueError({_lit(f'Unsupported chart type: {chart_type}')})"]

    return lines


def build_reproduction_script(spec: dict, dataset_filename: str) -> str:
    """spec: a PlotSpec as stored (FigureResult.spec.model_dump()).
    dataset_filename: the run's original uploaded filename -- the script
    expects a file by that name next to it (the researcher already has
    their own copy, since they uploaded it)."""
    title = spec.get("title")
    x_min, x_max = spec.get("x_min"), spec.get("x_max")
    y_min, y_max = spec.get("y_min"), spec.get("y_max")

    lines = [
        '"""',
        "Reproduces one figure exported from Samhita's Data Analysis tool.",
        "Generated deterministically from the saved chart spec -- no AI involved,",
        "and nothing here is required to match the original beyond this point:",
        "edit freely (fonts, a second axis via ax.twinx(), tick formatting,",
        "annotations, colors, ...).",
        "",
        "Requirements:  pip install pandas matplotlib openpyxl",
        f"Data file:     {dataset_filename}  (place it next to this script,",
        "               or edit DATA_PATH below)",
        '"""',
    ]
    lines += _style_prelude()
    lines += [
        "",
        f"DATA_PATH = {_lit(dataset_filename)}",
        "if DATA_PATH.lower().endswith(('.xlsx', '.xls')):",
        "    df = pd.read_excel(DATA_PATH)",
        "else:",
        "    df = pd.read_csv(DATA_PATH)",
        "",
        "fig, ax = plt.subplots(figsize=(7, 4.5))",
        "",
    ]
    lines += _chart_body(spec)
    lines += [""]
    if x_min is not None or x_max is not None:
        lines.append(f"ax.set_xlim(left={x_min!r}, right={x_max!r})")
    if y_min is not None or y_max is not None:
        lines.append(f"ax.set_ylim(bottom={y_min!r}, top={y_max!r})")
    if title:
        lines.append(f"ax.set_title({_lit(title)})")
    lines += [
        "fig.tight_layout()",
        "",
        "# ── Customize freely from here down ──",
        "# ax.set_xlabel('Custom X label')",
        "# ax.set_ylabel('Custom Y label')",
        "# ax2 = ax.twinx()  # a second Y-axis sharing this X axis",
        "# for label in ax.get_xticklabels(): label.set_fontsize(9)",
        "",
        'fig.savefig("figure.png", dpi=300)',
        'fig.savefig("figure.svg")',
        "plt.show()",
        "",
    ]
    return "\n".join(lines)

"""
Deterministic spec -> matplotlib figure renderer -- the other half of the
spec-based architecture (data_analysis_agent_architecture.md SS2). Given a
validated PlotSpec and the run's DataFrame, this always produces the same
figure for the same inputs. No LLM call, no exec()'d code -- one function
per chart_type, each just matplotlib calls against real columns.

Every render() call writes a PNG (300dpi, for on-screen/export use) and an
SVG (true vector, for a researcher who wants to drop the figure straight
into a manuscript) -- see SS4's "what publication-ready concretely means".
"""
import uuid
from datetime import datetime, timezone
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

from core import plot_style
from core.plot_models import FigureResult, PlotSpec


class RenderError(ValueError):
    """Raised for a spec that doesn't make sense against this dataframe
    (missing column, wrong dtype for the chart type, etc) -- callers turn
    this into a 4xx, not a 500."""


def _require_columns(df: pd.DataFrame, *cols: str) -> None:
    missing = [c for c in cols if c and c not in df.columns]
    if missing:
        raise RenderError(f"Column(s) not found in this dataset: {', '.join(missing)}")


def _draw_scatter(ax, df: pd.DataFrame, spec: PlotSpec) -> None:
    _require_columns(df, spec.x, spec.y)
    if not spec.x or not spec.y:
        raise RenderError("Scatter needs both an X and a Y column.")
    if spec.group and spec.group in df.columns:
        for i, (name, g) in enumerate(df.groupby(spec.group)):
            ax.scatter(g[spec.x], g[spec.y], label=str(name),
                       color=plot_style.CATEGORICAL_PALETTE[i % len(plot_style.CATEGORICAL_PALETTE)],
                       alpha=0.8, s=24)
        ax.legend(title=spec.group, fontsize=9)
    else:
        ax.scatter(df[spec.x], df[spec.y], color=plot_style.CATEGORICAL_PALETTE[0], alpha=0.8, s=24)
    ax.set_xlabel(spec.x)
    ax.set_ylabel(spec.y)


def _draw_line(ax, df: pd.DataFrame, spec: PlotSpec) -> None:
    if not spec.y:
        raise RenderError("Line needs a Y column.")
    _require_columns(df, spec.x, spec.y)
    x = df[spec.x] if spec.x else df.index
    if spec.group and spec.group in df.columns:
        for i, (name, g) in enumerate(df.groupby(spec.group)):
            gx = g[spec.x] if spec.x else g.index
            ax.plot(gx, g[spec.y], label=str(name),
                    color=plot_style.CATEGORICAL_PALETTE[i % len(plot_style.CATEGORICAL_PALETTE)],
                    linewidth=1.2)
        ax.legend(title=spec.group, fontsize=9)
    else:
        ax.plot(x, df[spec.y], color=plot_style.CATEGORICAL_PALETTE[0], linewidth=1.2)
    ax.set_xlabel(spec.x or "index")
    ax.set_ylabel(spec.y)


def _draw_bar(ax, df: pd.DataFrame, spec: PlotSpec) -> None:
    _require_columns(df, spec.x, spec.y)
    if not spec.x or not spec.y:
        raise RenderError("Bar needs both a category (X) and a value (Y) column.")
    agg = spec.agg or "mean"
    if agg not in ("mean", "sum", "count", "median"):
        raise RenderError(f"Unsupported aggregation: {agg}")
    if spec.group and spec.group in df.columns:
        pivot = df.groupby([spec.x, spec.group])[spec.y].agg(agg).unstack(spec.group)
        pivot.plot(kind="bar", ax=ax, color=plot_style.CATEGORICAL_PALETTE[: pivot.shape[1]])
        ax.legend(title=spec.group, fontsize=9)
    else:
        grouped = df.groupby(spec.x)[spec.y].agg(agg)
        ax.bar(grouped.index.astype(str), grouped.values, color=plot_style.CATEGORICAL_PALETTE[0])
    ax.set_xlabel(spec.x)
    ax.set_ylabel(f"{agg}({spec.y})")
    plt.setp(ax.get_xticklabels(), rotation=30, ha="right")


def _draw_box(ax, df: pd.DataFrame, spec: PlotSpec) -> None:
    _require_columns(df, spec.x, spec.y)
    if not spec.y:
        raise RenderError("Box needs at least a Y (value) column.")
    if spec.x and spec.x in df.columns:
        groups = [g[spec.y].dropna().values for _, g in df.groupby(spec.x)]
        labels = [str(k) for k in df.groupby(spec.x).groups.keys()]
        bp = ax.boxplot(groups, labels=labels, patch_artist=True)
        for i, box in enumerate(bp["boxes"]):
            box.set_facecolor(plot_style.CATEGORICAL_PALETTE[i % len(plot_style.CATEGORICAL_PALETTE)])
            box.set_alpha(0.6)
        ax.set_xlabel(spec.x)
        plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    else:
        ax.boxplot(df[spec.y].dropna().values, labels=[spec.y], patch_artist=True)
    ax.set_ylabel(spec.y)


def _draw_histogram(ax, df: pd.DataFrame, spec: PlotSpec) -> None:
    col = spec.x or spec.y
    _require_columns(df, col)
    if not col:
        raise RenderError("Histogram needs a column (set as X or Y).")
    if spec.group and spec.group in df.columns:
        for i, (name, g) in enumerate(df.groupby(spec.group)):
            ax.hist(g[col].dropna(), bins=30, alpha=0.5, label=str(name),
                    color=plot_style.CATEGORICAL_PALETTE[i % len(plot_style.CATEGORICAL_PALETTE)])
        ax.legend(title=spec.group, fontsize=9)
    else:
        ax.hist(df[col].dropna(), bins=30, color=plot_style.CATEGORICAL_PALETTE[0])
    ax.set_xlabel(col)
    ax.set_ylabel("count")


def _draw_heatmap(ax, df: pd.DataFrame, spec: PlotSpec) -> None:
    numeric = df.select_dtypes(include="number")
    if numeric.shape[1] < 2:
        raise RenderError("Heatmap needs at least two numeric columns to correlate.")
    corr = numeric.corr()
    im = ax.imshow(corr.values, cmap="RdBu_r", vmin=-1, vmax=1)
    ax.set_xticks(range(len(corr.columns)))
    ax.set_xticklabels(corr.columns, rotation=45, ha="right")
    ax.set_yticks(range(len(corr.columns)))
    ax.set_yticklabels(corr.columns)
    ax.figure.colorbar(im, ax=ax, label="Pearson r", fraction=0.046, pad=0.04)
    for i in range(len(corr.columns)):
        for j in range(len(corr.columns)):
            ax.text(j, i, f"{corr.values[i, j]:.2f}", ha="center", va="center", fontsize=7,
                    color="white" if abs(corr.values[i, j]) > 0.6 else "black")


_DRAWERS = {
    "scatter": _draw_scatter,
    "line": _draw_line,
    "bar": _draw_bar,
    "box": _draw_box,
    "histogram": _draw_histogram,
    "heatmap": _draw_heatmap,
}


def render(df: pd.DataFrame, spec: PlotSpec, out_dir: Path) -> FigureResult:
    drawer = _DRAWERS.get(spec.chart_type)
    if drawer is None:
        raise RenderError(f"Unsupported chart type: {spec.chart_type}")

    plot_style.apply()
    fig, ax = plt.subplots(figsize=(7, 4.5))
    try:
        drawer(ax, df, spec)
    except RenderError:
        plt.close(fig)
        raise
    except Exception as e:  # noqa: BLE001 -- a bad column/dtype combo, not a server error
        plt.close(fig)
        raise RenderError(str(e)) from e

    # Axis zoom window -- re-render at this data range instead of merely
    # magnifying pixels, so the transition/detail the researcher cares
    # about still comes out at full 300dpi rather than blown-up and blurry.
    # Best-effort: a categorical x-axis (bar/box) or a heatmap's index axes
    # can't take a numeric xlim/ylim, so a failure here is swallowed rather
    # than failing the whole render over an optional refinement.
    try:
        if spec.x_min is not None or spec.x_max is not None:
            ax.set_xlim(left=spec.x_min, right=spec.x_max)
        if spec.y_min is not None or spec.y_max is not None:
            ax.set_ylim(bottom=spec.y_min, top=spec.y_max)
    except Exception:
        pass

    if spec.title:
        ax.set_title(spec.title)
    fig.tight_layout()

    out_dir.mkdir(parents=True, exist_ok=True)
    fig_id = uuid.uuid4().hex[:10]
    png_path = out_dir / f"{fig_id}.png"
    svg_path = out_dir / f"{fig_id}.svg"
    fig.savefig(png_path, dpi=plot_style.DPI)
    fig.savefig(svg_path)
    plt.close(fig)

    return FigureResult(
        spec=spec,
        png_path=str(png_path),
        svg_path=str(svg_path),
        created_at=datetime.now(timezone.utc).isoformat(),
    )

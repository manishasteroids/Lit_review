"""
Pydantic models for the Data Analysis Agent's plot spec -- the core object
in the spec-based architecture (data_analysis_agent_architecture.md SS2):
a chart is always described as one of these, validated, and handed to
pipeline/plot_renderer.py's deterministic renderer. The model NEVER
carries code or an expression to evaluate -- only a chart type plus
column references -- which is the entire point: nothing derived from a
PlotSpec is ever executed as code.
"""
from typing import Literal, Optional

from pydantic import BaseModel, Field

# The six chart types from SS2/SS5 phase 1 -- the richer menu from SS7.1
# (raincloud, heatmap+dendrogram, PCA, forest, Kaplan-Meier, ...) is a
# later, additive phase; this is deliberately the small v1 set.
ChartType = Literal["scatter", "line", "bar", "box", "histogram", "heatmap"]


class PlotSpec(BaseModel):
    chart_type: ChartType
    x: Optional[str] = None
    y: Optional[str] = None
    group: Optional[str] = None       # color/group-by column, optional
    agg: Optional[str] = None         # "mean" | "sum" | "count" | None (no aggregation)
    title: Optional[str] = None
    rationale: Optional[str] = None   # set by the Planner (Phase 1b); blank for manual specs

    # Optional axis zoom window -- re-rendering with these set produces a
    # fresh 300dpi figure cropped to that data range, rather than
    # magnifying pixels of an already-rendered image. None on either side
    # of a pair leaves that side auto-scaled (matplotlib default).
    x_min: Optional[float] = None
    x_max: Optional[float] = None
    y_min: Optional[float] = None
    y_max: Optional[float] = None


class FigureResult(BaseModel):
    spec: PlotSpec
    png_path: str
    svg_path: str
    created_at: str
    caption: Optional[str] = None     # set by the Caption Writer (Phase 2); blank for now

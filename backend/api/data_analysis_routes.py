"""
Data Analysis Agent routes -- Phase 1a: upload a CSV/XLSX, get back a
profile, render a plot from a manually-specified PlotSpec. No LLM calls
anywhere in this router (see core/data_ingest.py and
pipeline/plot_renderer.py's own docstrings) -- Phase 1b adds a
Planner-driven /suggest endpoint on top of the same profile+renderer,
not a replacement for this one.

Standalone by design (data_analysis_agent_architecture.md SS9.1 decision
3): `project_id` is optional on upload, never required, matching how
Sift/Hypothesis Agent runs are optionally filed under a project today
(core/projects.py's `assign_session`).
"""
import math
from pathlib import Path
from typing import List, Optional

import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from core.auth import require_user
from core.config import settings
from core.data_analysis_db import (create_data_analysis_run,
                                    delete_data_analysis_run,
                                    get_data_analysis_run,
                                    list_data_analysis_runs,
                                    set_data_analysis_run_project,
                                    update_data_analysis_run_data)
from core.data_ingest import IngestError, detect_structure, load_table, profile
from core.plot_models import PlotSpec
from core.script_export import build_reproduction_script
from core.stats_analysis import compute_descriptive_stats
from pipeline.plot_renderer import RenderError, render

# Cap on points sent to the interactive client-side viewer (GET .../series)
# -- above this, rows are thinned with a uniform stride rather than a
# random sample, so a waveform's shape (rise/fall timing, transients)
# survives instead of being scrambled.
_MAX_SERIES_POINTS = 20000
_MAX_SERIES_COLUMNS = 8

router = APIRouter(prefix="/api/data-analysis")


class AssignProjectBody(BaseModel):
    project_id: Optional[str] = None  # None unfiles the run -> standalone

_STORE_DIR = Path(settings.uploads_dir) / "data_analysis"
_FIGS_DIR = Path(settings.uploads_dir) / "data_analysis_figures"


def _dataset_path(run_id: str, filename: str) -> Path:
    ext = Path(filename).suffix or ".csv"
    return _STORE_DIR / f"{run_id}{ext}"


def _load_dataset_for_run(run: dict):
    """Re-read the stored file and re-run structure detection -- cheap and
    deterministic, so there's no need to persist the parsed DataFrame
    itself (only the small `profile`/`metadata` summaries live in `data`)."""
    path = Path(run["data"]["dataset_path"])
    if not path.exists():
        raise HTTPException(404, "The original uploaded file is no longer available.")
    df = load_table(path.read_bytes(), run["filename"])
    main_df, _ = detect_structure(df)
    return main_df


@router.post("/upload")
async def upload_dataset(
    file: UploadFile = File(...),
    project_id: Optional[str] = None,
    user_id: str = Depends(require_user),
):
    raw = await file.read()
    try:
        df = load_table(raw, file.filename)
        main_df, metadata = detect_structure(df)
        prof = profile(main_df)
    except IngestError as e:
        raise HTTPException(400, str(e))

    run = create_data_analysis_run(user_id=user_id, filename=file.filename, project_id=project_id,
                                    data={"profile": prof, "metadata": metadata, "figures": [],
                                          "dataset_path": ""})
    # Save the raw file keyed by the run id we were just given, then patch
    # the path into the saved row -- two writes, but avoids guessing an id
    # before the row exists.
    _STORE_DIR.mkdir(parents=True, exist_ok=True)
    path = _dataset_path(run["id"], file.filename)
    path.write_bytes(raw)
    run["data"]["dataset_path"] = str(path)
    run = update_data_analysis_run_data(run["id"], user_id, run["data"])

    return {"run_id": run["id"], "filename": run["filename"],
            "project_id": run["project_id"], "profile": prof, "metadata": metadata}


@router.get("/runs")
def get_runs(project_id: Optional[str] = None, user_id: str = Depends(require_user)):
    return list_data_analysis_runs(user_id, project_id=project_id)


@router.get("/runs/{run_id}")
def get_run(run_id: str, user_id: str = Depends(require_user)):
    run = get_data_analysis_run(run_id, user_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return run


@router.post("/runs/{run_id}/project")
def assign_run_project(run_id: str, body: AssignProjectBody, user_id: str = Depends(require_user)):
    """File an existing (already-uploaded) run under a project, or pass
    project_id=None to unfile it back to standalone. Lets a researcher
    start standalone (the tool's default per SS9.1 decision 3) and decide
    later, rather than being locked into whatever project was open at
    upload time."""
    if body.project_id:
        from core.projects import get_project
        if not get_project(body.project_id, user_id):
            raise HTTPException(404, "Project not found.")
    run = set_data_analysis_run_project(run_id, user_id, body.project_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return {"id": run["id"], "project_id": run["project_id"]}


@router.delete("/runs/{run_id}")
def remove_run(run_id: str, user_id: str = Depends(require_user)):
    run = get_data_analysis_run(run_id, user_id)
    if run and run["data"].get("dataset_path"):
        Path(run["data"]["dataset_path"]).unlink(missing_ok=True)
    ok = delete_data_analysis_run(run_id, user_id)
    if not ok:
        raise HTTPException(404, "Run not found")
    return {"ok": True}


@router.get("/runs/{run_id}/series")
def get_series(
    run_id: str,
    x: Optional[str] = None,
    y: List[str] = Query(default=[]),
    user_id: str = Depends(require_user),
):
    """Raw column values for the interactive on-screen chart -- a
    read-only, uniformly-thinned view of the underlying data, not a
    render. Lets the frontend pan/zoom/overlay multiple columns in one
    live chart (a canvas view, drawn client-side) without hitting
    /render again for every look; pipeline/plot_renderer.py's matplotlib
    output stays the only thing that produces the downloadable
    publication PNG/SVG. No LLM or code-exec involvement, same as the
    rest of this router -- this just reshapes already-loaded columns
    into JSON arrays.
    """
    if not y:
        raise HTTPException(400, "At least one y column is required.")
    if len(y) > _MAX_SERIES_COLUMNS:
        raise HTTPException(400, f"Too many columns requested (max {_MAX_SERIES_COLUMNS}).")

    run = get_data_analysis_run(run_id, user_id)
    if not run:
        raise HTTPException(404, "Run not found")

    df = _load_dataset_for_run(run)
    wanted = ([x] if x else []) + y
    missing = [c for c in wanted if c not in df.columns]
    if missing:
        raise HTTPException(400, f"Column(s) not found in this dataset: {', '.join(missing)}")

    n = len(df)
    stride = max(1, math.ceil(n / _MAX_SERIES_POINTS))
    view = df.iloc[::stride]

    if x:
        x_numeric = pd.to_numeric(view[x], errors="coerce")
        if x_numeric.isna().all():
            raise HTTPException(400, f"Column '{x}' isn't numeric, so it can't be used as the X axis here.")
    else:
        x_numeric = pd.Series(view.index, index=view.index, dtype="float64")

    def _clean(series: "pd.Series") -> list:
        return [None if pd.isna(v) else float(v) for v in series]

    series = []
    for col in y:
        y_numeric = pd.to_numeric(view[col], errors="coerce")
        if y_numeric.isna().all():
            raise HTTPException(400, f"Column '{col}' isn't numeric, so it can't be charted here.")
        series.append({"name": col, "y": _clean(y_numeric)})

    return {
        "x_label": x or "index",
        "x": _clean(x_numeric),
        "series": series,
        "total_rows": n,
        "points_returned": len(view),
        "downsampled": stride > 1,
        "stride": stride,
    }


@router.get("/runs/{run_id}/stats")
def get_stats(
    run_id: str,
    columns: List[str] = Query(default=[]),
    user_id: str = Depends(require_user),
):
    """Descriptive statistics (mean/median/std/quartiles/skew for numeric
    columns; count/cardinality/top-values for categorical ones) for the
    run's dataset -- the Statistics panel's data source. `columns` omitted
    means every column. Same deterministic, no-LLM computation as the rest
    of this router; see core/stats_analysis.py."""
    run = get_data_analysis_run(run_id, user_id)
    if not run:
        raise HTTPException(404, "Run not found")

    df = _load_dataset_for_run(run)
    try:
        return compute_descriptive_stats(df, columns or None)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/runs/{run_id}/render")
def render_plot(run_id: str, spec: PlotSpec, user_id: str = Depends(require_user)):
    run = get_data_analysis_run(run_id, user_id)
    if not run:
        raise HTTPException(404, "Run not found")

    df = _load_dataset_for_run(run)
    try:
        result = render(df, spec, _FIGS_DIR)
    except RenderError as e:
        raise HTTPException(400, str(e))

    figures = run["data"].setdefault("figures", [])
    figures.append(result.model_dump())
    run = update_data_analysis_run_data(run_id, user_id, run["data"])

    return {
        "figure": result.model_dump(),
        "png_url": f"/api/data-analysis/runs/{run_id}/figures/{Path(result.png_path).name}",
        "svg_url": f"/api/data-analysis/runs/{run_id}/figures/{Path(result.svg_path).name}",
    }


@router.delete("/runs/{run_id}/figures/{filename}")
def remove_figure(run_id: str, filename: str, user_id: str = Depends(require_user)):
    """Remove one rendered figure from a run (the PNG or SVG filename from
    either side of that figure's pair both work) without deleting the run
    itself -- lets a researcher clear out a bad render while keeping the
    dataset and every other figure."""
    run = get_data_analysis_run(run_id, user_id)
    if not run:
        raise HTTPException(404, "Run not found")

    figures = run["data"].get("figures", [])
    match = next((f for f in figures if Path(f["png_path"]).name == filename
                  or Path(f["svg_path"]).name == filename), None)
    if not match:
        raise HTTPException(404, "Figure not found")

    Path(match["png_path"]).unlink(missing_ok=True)
    Path(match["svg_path"]).unlink(missing_ok=True)
    run["data"]["figures"] = [f for f in figures if f is not match]
    update_data_analysis_run_data(run_id, user_id, run["data"])
    return {"ok": True}


@router.get("/runs/{run_id}/figures/{filename}/script")
def get_figure_script(run_id: str, filename: str, user_id: str = Depends(require_user)):
    """Download a standalone pandas+matplotlib .py script that reproduces
    this exact figure -- the "let me use real matplotlib" escape hatch
    (custom fonts, a second axis, tick formatting, anything the render
    form doesn't expose). See core/script_export.py."""
    run = get_data_analysis_run(run_id, user_id)
    if not run:
        raise HTTPException(404, "Run not found")

    figures = run["data"].get("figures", [])
    match = next((f for f in figures if Path(f["png_path"]).name == filename
                  or Path(f["svg_path"]).name == filename), None)
    if not match:
        raise HTTPException(404, "Figure not found")

    script = build_reproduction_script(match["spec"], run["filename"])
    stem = Path(filename).stem
    return PlainTextResponse(
        script, media_type="text/x-python",
        headers={"Content-Disposition": f'attachment; filename="figure_{stem}.py"'},
    )


@router.get("/runs/{run_id}/figures/{filename}")
def get_figure(run_id: str, filename: str, user_id: str = Depends(require_user)):
    # Ownership check first -- this endpoint would otherwise let any
    # authenticated user guess another user's figure filenames.
    run = get_data_analysis_run(run_id, user_id)
    if not run:
        raise HTTPException(404, "Run not found")
    path = _FIGS_DIR / filename
    known = {Path(f["png_path"]).name for f in run["data"].get("figures", [])} | \
            {Path(f["svg_path"]).name for f in run["data"].get("figures", [])}
    if filename not in known or not path.exists():
        raise HTTPException(404, "Figure not found")
    media = "image/svg+xml" if filename.endswith(".svg") else "image/png"
    return FileResponse(path, media_type=media)

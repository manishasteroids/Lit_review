"""
Data Analysis Agent -- ingest & profiling. Plain code, no LLM calls
anywhere in this module (see data_analysis_agent_architecture.md SS1/SS3
-- the Planner and Caption Writer are the only two LLM steps in this whole
pipeline, and neither one is this file).

Three jobs:
  1. load_table   -- read an uploaded CSV/XLSX into a DataFrame, with a
                      size/row cap.
  2. detect_structure -- a real-world fix, not a hypothetical: an
                      instrument/DAQ export routinely isn't one clean
                      table. It commonly rides a sparse vertical
                      key/value metadata block along in a few trailing
                      columns of an otherwise dense measurement table
                      (see SS9.2 of the architecture doc for the actual
                      capture file that surfaced this). Split that block
                      out before profiling, so the profiler never tries
                      to compute numeric stats on a column mixing hex
                      strings, ints, and floats.
  3. profile       -- per-column dtype/stat summary the Planner (later
                      phase) and the manual column-picker (this phase)
                      both read from, plus a `kind` classification
                      (tabular vs timeseries) so callers can steer chart
                      suggestions appropriately.
"""
import io
from typing import Optional

import numpy as np
import pandas as pd

# Row cap before falling back to a random sample -- protects both the
# profiling step's cost and the eventual Planner prompt's size (SS9.1
# decision 2: "reasonable default, revisit if it bites"). Not a hard
# reject -- a huge file still gets profiled, just from a representative
# sample rather than every row.
MAX_ROWS = 100_000
SAMPLE_ROWS = 50_000

# Upload size cap -- same category of guard as main.py's MAX_BODY_BYTES
# for PDFs, sized for tabular data instead of PDFs.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50MB


class IngestError(ValueError):
    """Raised for anything wrong with the uploaded file itself (format,
    size, empty) -- callers turn this into a 4xx, not a 500."""


def load_table(file_bytes: bytes, filename: str) -> pd.DataFrame:
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise IngestError(
            f"File is {len(file_bytes) / 1e6:.1f}MB, over the "
            f"{MAX_UPLOAD_BYTES / 1e6:.0f}MB limit for this tool."
        )
    lower = (filename or "").lower()
    try:
        if lower.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(file_bytes))
        elif lower.endswith((".csv", ".tsv", ".txt")):
            sep = "\t" if lower.endswith(".tsv") else None  # None = pandas sniffs comma vs other
            df = pd.read_csv(io.BytesIO(file_bytes), sep=sep, engine="python")
        else:
            raise IngestError(
                "Unsupported file type -- upload a CSV or XLSX file (v1 "
                "input formats per data_analysis_agent_architecture.md SS9.1)."
            )
    except IngestError:
        raise
    except Exception as e:  # noqa: BLE001 -- surface as a clean ingest error, not a 500 traceback
        raise IngestError(f"Could not parse this file as a table: {e}") from e

    if df.empty or df.shape[1] == 0:
        raise IngestError("This file has no usable rows/columns.")

    if len(df) > MAX_ROWS:
        df = df.sample(n=SAMPLE_ROWS, random_state=0).sort_index()
    return df


def _looks_like_key_string(s: pd.Series) -> bool:
    """Heuristic for 'this column holds identifier-like strings' -- short,
    snake_case-ish, no whitespace, low length variance. Used only to spot
    the KEY half of a sparse key/value metadata pair, never to make any
    semantic judgement about what the keys mean."""
    vals = s.dropna().astype(str)
    if vals.empty:
        return False
    if (vals.str.contains(" ").mean()) > 0.1:
        return False
    lens = vals.str.len()
    return bool(lens.max() <= 64 and lens.std(ddof=0) < 20)


def detect_structure(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Returns (main_df, metadata) -- main_df has all-null columns
    dropped and any detected trailing key/value block removed; metadata
    is that block as a flat {key: value} dict (empty if none found).

    Detection is deliberately conservative (shape/density pattern
    matching, not semantic understanding -- SS9.3 point 1 of the
    architecture doc): only trips for the LAST two columns, only when
    the rest of the table is dense and this pair is sparse (populated for
    a small leading or trailing run of rows, not spread throughout), and
    only when one side looks like an identifier string. A normal two-
    column CSV tail (e.g. two real numeric measurement columns) won't
    match this and passes through untouched.
    """
    work = df.copy()

    # 1. Drop fully-null columns outright -- never shown as a plottable
    #    candidate (a blank separator column, e.g.).
    all_null = [c for c in work.columns if work[c].isna().all()]
    work = work.drop(columns=all_null)

    metadata: dict = {}
    if work.shape[1] >= 2:
        key_col, val_col = work.columns[-2], work.columns[-1]
        key_s, val_s = work[key_col], work[val_col]
        density = key_s.notna().mean()
        rest_density = work.drop(columns=[key_col, val_col]).notna().mean().mean() if work.shape[1] > 2 else 1.0
        sparse_relative_to_rest = density < 0.5 and density < rest_density - 0.2
        if sparse_relative_to_rest and _looks_like_key_string(key_s):
            populated = key_s.notna()
            for k, v in zip(key_s[populated].astype(str), val_s[populated]):
                metadata[k] = v.item() if hasattr(v, "item") else v
            work = work.drop(columns=[key_col, val_col])

    return work, metadata


def _classify_kind(df: pd.DataFrame) -> str:
    """'timeseries' vs 'tabular' -- steers which chart family the manual
    picker highlights and (Phase 1b) which analyses the Planner proposes.
    Deliberately a cheap heuristic, not required to be perfect (SS9.3
    point 2): an explicit datetime-looking column, or a large row count
    with no low-cardinality grouping column to split observations by,
    both tilt toward 'timeseries' -- e.g. a multi-channel oscilloscope
    capture with no time column at all, just sequential samples."""
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            return "timeseries"
        if df[col].dtype == object:
            try:
                parsed = pd.to_datetime(df[col], errors="coerce")
                if parsed.notna().mean() > 0.8:
                    return "timeseries"
            except Exception:
                pass

    numeric_cols = df.select_dtypes(include=[np.number]).columns
    categorical_cols = [c for c in df.columns if c not in numeric_cols]
    has_grouping_col = any(
        1 < df[c].nunique(dropna=True) <= max(20, len(df) * 0.05) for c in categorical_cols
    )
    if len(df) > 500 and not has_grouping_col and len(numeric_cols) >= 1:
        return "timeseries"
    return "tabular"


def profile(df: pd.DataFrame) -> dict:
    """Per-column summary + a kind classification. Never touches the full
    dataset in what gets returned -- min/max/mean/std and a handful of
    sample rows, not the raw data, which is what keeps this cheap to hand
    to a future Planner prompt (Phase 1b) as well as to the frontend's
    column pickers (this phase)."""
    columns = []
    for col in df.columns:
        s = df[col]
        is_numeric = pd.api.types.is_numeric_dtype(s)
        entry = {
            "name": str(col),
            "dtype": "numeric" if is_numeric else "categorical",
            "missing_rate": round(float(s.isna().mean()), 4),
            "n_unique": int(s.nunique(dropna=True)),
        }
        if is_numeric:
            clean = s.dropna()
            if len(clean):
                entry.update({
                    "min": float(clean.min()),
                    "max": float(clean.max()),
                    "mean": float(clean.mean()),
                    "std": float(clean.std(ddof=0)) if len(clean) > 1 else 0.0,
                })
        else:
            top = s.dropna().astype(str).value_counts().head(5)
            entry["top_values"] = [{"value": k, "count": int(v)} for k, v in top.items()]
        columns.append(entry)

    return {
        "row_count": int(len(df)),
        "column_count": int(df.shape[1]),
        "columns": columns,
        "kind": _classify_kind(df),
        "sample_rows": df.head(5).replace({np.nan: None}).to_dict(orient="records"),
    }

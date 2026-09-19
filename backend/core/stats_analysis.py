"""
Descriptive statistics for the Data Analysis Agent -- the "Statistics" panel's
backend counterpart to pipeline/plot_renderer.py's chart rendering. Given the
run's already-loaded DataFrame, computes a deterministic per-column summary
with plain pandas: mean, median, std, min/max, quartiles, and skewness for
numeric columns; count, cardinality, and top values for categorical ones.

Same "spec, never code" principle as the rest of this feature (see
plot_renderer.py's own docstring) -- one pure function over real columns, no
LLM call and no code execution. Deliberately pandas-only for this first
slice (no scipy dependency) -- inferential tests (t-test/ANOVA/correlation
significance) are a natural follow-on once this is in place, and would be
the first thing to reach for scipy.stats.
"""
import math
from typing import List, Optional

import pandas as pd


def _clean_float(v) -> Optional[float]:
    """NaN/inf can't round-trip through JSON -- None reads cleanly on the
    frontend as "not available" instead of a parse error."""
    if v is None:
        return None
    f = float(v)
    return None if math.isnan(f) or math.isinf(f) else f


def compute_descriptive_stats(df: pd.DataFrame, columns: Optional[List[str]] = None) -> dict:
    """columns=None means every column in the dataset (the panel's default
    "Statistics" view); a subset lets a future refinement ("just these
    columns") reuse the same endpoint without over-fetching."""
    cols = columns if columns else list(df.columns)
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError(f"Column(s) not found in this dataset: {', '.join(missing)}")

    out = []
    for col in cols:
        s = df[col]
        is_numeric = pd.api.types.is_numeric_dtype(s)
        entry = {
            "name": str(col),
            "dtype": "numeric" if is_numeric else "categorical",
            "count": int(s.notna().sum()),
            "missing_rate": round(float(s.isna().mean()), 4),
            "n_unique": int(s.nunique(dropna=True)),
        }
        if is_numeric:
            clean = s.dropna()
            if len(clean):
                entry.update({
                    "mean": _clean_float(clean.mean()),
                    "median": _clean_float(clean.median()),
                    # Sample std (ddof=1) -- the conventional choice for a
                    # dedicated stats view, unlike data_ingest.py's profile()
                    # which uses ddof=0 for its cheap upload-time summary.
                    "std": _clean_float(clean.std(ddof=1)) if len(clean) > 1 else 0.0,
                    "min": _clean_float(clean.min()),
                    "max": _clean_float(clean.max()),
                    "q1": _clean_float(clean.quantile(0.25)),
                    "q3": _clean_float(clean.quantile(0.75)),
                    "skew": _clean_float(clean.skew()) if len(clean) > 2 else None,
                })
        else:
            top = s.dropna().astype(str).value_counts().head(5)
            entry["top_values"] = [{"value": k, "count": int(v)} for k, v in top.items()]
        out.append(entry)

    return {"row_count": int(len(df)), "columns": out}

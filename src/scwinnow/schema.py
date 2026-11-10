"""Description of ``adata.obs`` columns for building filter controls."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from scwinnow.filters import as_labels, is_bool_column, is_numeric_column

DEFAULT_MAX_CATEGORIES = 200
HIST_BINS = 64


def _numeric_schema(series: pd.Series, bins: int) -> dict[str, Any] | None:
    values = series.to_numpy(dtype=np.float64, na_value=np.nan)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return None
    lo, hi = float(finite.min()), float(finite.max())
    counts, edges = np.histogram(finite, bins=bins, range=(lo, hi) if hi > lo else (lo, lo + 1))
    return {
        "kind": "numeric",
        "min": lo,
        "max": hi,
        "integer": bool(pd.api.types.is_integer_dtype(series.dtype)),
        "n_missing": int(values.size - finite.size),
        "hist": {"counts": counts.tolist(), "edges": edges.tolist()},
    }


def _category_schema(series: pd.Series, max_categories: int) -> dict[str, Any] | None:
    labels = as_labels(series)
    counts = labels.value_counts(dropna=True)
    if len(counts) > max_categories or len(counts) == 0:
        return None
    if isinstance(series.dtype, pd.CategoricalDtype):
        order = [str(c) for c in series.cat.categories if str(c) in counts.index]
    else:
        order = sorted(counts.index.astype(str))
    return {
        "kind": "category",
        "categories": [{"label": c, "count": int(counts[c])} for c in order],
        "n_missing": int(labels.isna().sum()),
    }


def column_schema(
    series: pd.Series,
    max_categories: int = DEFAULT_MAX_CATEGORIES,
    bins: int = HIST_BINS,
) -> dict[str, Any] | None:
    """Schema entry for one column, or ``None`` when it has no usable filter control."""
    if is_bool_column(series):
        values = series.to_numpy(dtype=bool, na_value=False)
        return {"kind": "bool", "n_true": int(values.sum()), "n_false": int((~values).sum())}
    if is_numeric_column(series):
        return _numeric_schema(series, bins)
    return _category_schema(series, max_categories)


def obs_schema(
    obs: pd.DataFrame,
    max_categories: int = DEFAULT_MAX_CATEGORIES,
    bins: int = HIST_BINS,
) -> dict[str, Any]:
    """``{"n_obs": int, "columns": [{"name": ..., "kind": ..., ...}, ...]}`` in obs column order."""
    columns = []
    for name in obs.columns:
        entry = column_schema(obs[name], max_categories=max_categories, bins=bins)
        if entry is not None:
            columns.append({"name": str(name), **entry})
    return {"n_obs": len(obs), "columns": columns}

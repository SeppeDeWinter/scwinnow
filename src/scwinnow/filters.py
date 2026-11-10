"""Filter specifications over ``adata.obs`` and their boolean masks.

Filters are combined with logical AND. Each filter has a JSON form (``to_dict`` /
``filter_from_dict``) used as the wire format between engine and frontends.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, ClassVar

import numpy as np
import pandas as pd


class FilterError(ValueError):
    """Filter does not match the obs table (unknown column, wrong dtype) or is malformed."""


def as_labels(series: pd.Series) -> pd.Series:
    """String labels of a categorical-like column; missing values stay ``<NA>``."""
    return series.astype("string")


def is_bool_column(series: pd.Series) -> bool:
    return pd.api.types.is_bool_dtype(series.dtype)


def is_numeric_column(series: pd.Series) -> bool:
    return pd.api.types.is_numeric_dtype(series.dtype) and not is_bool_column(series)


def _column(obs: pd.DataFrame, column: str) -> pd.Series:
    if column not in obs.columns:
        raise FilterError(f"unknown obs column: {column!r}")
    return obs[column]


@dataclass(frozen=True)
class CategoryFilter:
    """Keep cells whose label (string form of the value) is in ``keep``."""

    column: str
    keep: frozenset[str]
    kind: ClassVar[str] = "category"

    def mask(self, obs: pd.DataFrame) -> np.ndarray:
        labels = as_labels(_column(obs, self.column))
        return labels.isin(list(self.keep)).to_numpy(dtype=bool, na_value=False)

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "column": self.column, "keep": sorted(self.keep)}

    def code(self, obs_expr: str) -> str:
        keep = sorted(self.keep)
        return (
            f'{obs_expr}["{self.column}"].astype("string").isin({keep!r})'
            ".to_numpy(dtype=bool, na_value=False)"
        )


@dataclass(frozen=True)
class RangeFilter:
    """Keep cells with ``lo <= value <= hi``; ``None`` leaves that side open. NaN never passes."""

    column: str
    lo: float | None = None
    hi: float | None = None
    kind: ClassVar[str] = "range"

    def mask(self, obs: pd.DataFrame) -> np.ndarray:
        series = _column(obs, self.column)
        if not is_numeric_column(series):
            raise FilterError(f"range filter on non-numeric column {self.column!r}")
        values = series.to_numpy(dtype=np.float64, na_value=np.nan)
        keep = ~np.isnan(values)
        if self.lo is not None:
            keep &= values >= self.lo
        if self.hi is not None:
            keep &= values <= self.hi
        return keep

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "column": self.column, "lo": self.lo, "hi": self.hi}

    def code(self, obs_expr: str) -> str:
        values = f'{obs_expr}["{self.column}"].to_numpy(dtype=float, na_value=np.nan)'
        parts = [f"~np.isnan({values})"]
        if self.lo is not None:
            parts.append(f"({values} >= {self.lo!r})")
        if self.hi is not None:
            parts.append(f"({values} <= {self.hi!r})")
        return " & ".join(parts)


@dataclass(frozen=True)
class BoolFilter:
    """Keep cells whose boolean column equals ``value``."""

    column: str
    value: bool
    kind: ClassVar[str] = "bool"

    def mask(self, obs: pd.DataFrame) -> np.ndarray:
        series = _column(obs, self.column)
        if not is_bool_column(series):
            raise FilterError(f"bool filter on non-bool column {self.column!r}")
        values = series.to_numpy(dtype=bool, na_value=not self.value)
        return values if self.value else ~values

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "column": self.column, "value": self.value}

    def code(self, obs_expr: str) -> str:
        values = f'{obs_expr}["{self.column}"].to_numpy(dtype=bool, na_value={not self.value!r})'
        return values if self.value else f"~{values}"


Filter = CategoryFilter | RangeFilter | BoolFilter


def _opt_float(value: Any) -> float | None:
    return None if value is None else float(value)


def filter_from_dict(data: Mapping[str, Any]) -> Filter:
    try:
        kind = data["kind"]
        column = str(data["column"])
        if kind == "category":
            return CategoryFilter(column, frozenset(str(v) for v in data["keep"]))
        if kind == "range":
            return RangeFilter(column, _opt_float(data.get("lo")), _opt_float(data.get("hi")))
        if kind == "bool":
            return BoolFilter(column, bool(data["value"]))
    except (KeyError, TypeError, ValueError) as err:
        raise FilterError(f"malformed filter {dict(data)!r}: {err}") from err
    raise FilterError(f"unknown filter kind {kind!r}")


def filters_from_json(items: Iterable[Mapping[str, Any]]) -> list[Filter]:
    return [filter_from_dict(item) for item in items]


def filters_to_json(filters: Iterable[Filter]) -> list[dict[str, Any]]:
    return [f.to_dict() for f in filters]


def compute_mask(obs: pd.DataFrame, filters: Iterable[Filter]) -> np.ndarray:
    """AND of all filter masks; all-True when ``filters`` is empty."""
    mask = np.ones(len(obs), dtype=bool)
    for f in filters:
        mask &= f.mask(obs)
    return mask


def filters_code(filters: Iterable[Filter], adata_name: str = "adata") -> str:
    """Python source that recomputes the mask and subsets ``adata_name``."""
    obs_expr = f"{adata_name}.obs"
    lines = [
        "import numpy as np",
        "",
        f"mask = np.ones({adata_name}.n_obs, dtype=bool)",
    ]
    lines += [f"mask &= {f.code(obs_expr)}" for f in filters]
    lines.append(f"{adata_name}_sub = {adata_name}[mask].copy()")
    return "\n".join(lines) + "\n"

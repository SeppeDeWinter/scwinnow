"""Interactive filtering of AnnData objects with GPU re-embedding."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from scwinnow.filters import BoolFilter, CategoryFilter, Filter, RangeFilter, compute_mask

if TYPE_CHECKING:
    from scwinnow.pipeline import Params
    from scwinnow.session import Session

__all__ = [
    "BoolFilter",
    "CategoryFilter",
    "Filter",
    "Params",
    "RangeFilter",
    "Session",
    "compute_mask",
]


def __getattr__(name: str) -> Any:
    # anndata (and through it cupy) load only when these are used
    if name == "Params":
        from scwinnow.pipeline import Params

        return Params
    if name == "Session":
        from scwinnow.session import Session

        return Session
    raise AttributeError(f"module 'scwinnow' has no attribute {name!r}")

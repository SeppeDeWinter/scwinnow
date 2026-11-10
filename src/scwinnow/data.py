"""Loading and validation of the AnnData object to explore.

Expected input: log-normalised expression in ``X`` (or in ``layers[expr_layer]``), cell metadata in
``obs``. A raw counts layer is optional and enables the ``seurat_v3`` HVG flavor.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import anndata as ad
import numpy as np
import scipy.sparse as sp


def read(path: str | Path) -> ad.AnnData:
    path = Path(path)
    if path.suffix != ".h5ad":
        raise ValueError(f"unsupported input {path}: expected an .h5ad file")
    return ad.read_h5ad(path)


def _sample_values(x: Any, n: int = 100_000) -> np.ndarray:
    if sp.issparse(x):
        return np.asarray(x.data[:n])
    return np.asarray(x).ravel()[:n]


def looks_like_counts(x: Any) -> bool:
    values = _sample_values(x)
    return bool(values.size and np.all(values >= 0) and np.allclose(values, np.round(values)))


def validate(
    adata: ad.AnnData,
    *,
    expr_layer: str | None = None,
    counts_layer: str | None = None,
) -> list[str]:
    """Raise on unusable input; return warnings for input that works but looks unusual."""
    warnings: list[str] = []
    if adata.n_obs == 0 or adata.n_vars == 0:
        raise ValueError(f"empty AnnData ({adata.n_obs} x {adata.n_vars})")
    if expr_layer is not None and expr_layer not in adata.layers:
        raise ValueError(f"expression layer {expr_layer!r} not in adata.layers")
    if counts_layer is not None and counts_layer not in adata.layers:
        raise ValueError(f"counts layer {counts_layer!r} not in adata.layers")
    if not adata.obs_names.is_unique:
        raise ValueError("adata.obs_names must be unique")
    expr = adata.X if expr_layer is None else adata.layers[expr_layer]
    if expr is None:
        raise ValueError("adata.X is empty; pass expr_layer")
    if looks_like_counts(expr):
        warnings.append(
            "expression matrix looks like raw counts; scwinnow expects log-normalised values"
        )
    if counts_layer is not None and not looks_like_counts(adata.layers[counts_layer]):
        warnings.append(f"layer {counts_layer!r} does not look like raw counts")
    return warnings

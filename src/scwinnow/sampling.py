"""Stable subsampling of selected cells.

Every cell gets a fixed random rank. A subsample of size ``n_max`` is the ``n_max`` selected cells
with the lowest rank, so a cell that is in the sample stays in it when other cells are filtered out.
"""

from __future__ import annotations

import numpy as np


def cell_ranks(n_cells: int, seed: int = 0) -> np.ndarray:
    """Random rank per cell (a permutation of ``0..n_cells-1``)."""
    ranks = np.empty(n_cells, dtype=np.int64)
    ranks[np.random.default_rng(seed).permutation(n_cells)] = np.arange(n_cells)
    return ranks


def subsample(mask: np.ndarray, n_max: int | None, ranks: np.ndarray) -> np.ndarray:
    """Sorted indices of at most ``n_max`` selected cells (all of them if ``n_max`` is None)."""
    idx = np.flatnonzero(mask)
    if n_max is None or idx.size <= n_max:
        return idx
    if n_max <= 0:
        return idx[:0]
    lowest = np.argpartition(ranks[idx], n_max - 1)[:n_max]
    return np.sort(idx[lowest])

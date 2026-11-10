"""UMAP initial positions from a previous embedding.

Cells present in the previous embedding keep their coordinates. New cells are placed at the
weighted mean of their already-placed kNN neighbours, repeated outward over the graph; cells that
the graph never reaches go to the centroid with small jitter.
"""

from __future__ import annotations

import numpy as np
import scipy.sparse as sp


def match_previous(obs_idx: np.ndarray, prev_idx: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """``(known, pos)``: whether each cell of ``obs_idx`` is in sorted ``prev_idx``, and where."""
    if prev_idx.size == 0:
        return np.zeros(obs_idx.size, dtype=bool), np.zeros(obs_idx.size, dtype=np.int64)
    pos = np.searchsorted(prev_idx, obs_idx)
    pos_c = np.minimum(pos, prev_idx.size - 1)
    known = prev_idx[pos_c] == obs_idx
    return known, pos_c


def init_from_previous(
    obs_idx: np.ndarray,
    prev_idx: np.ndarray,
    prev_coords: np.ndarray,
    connectivities: sp.spmatrix | sp.sparray,
    *,
    min_overlap: float = 0.3,
    max_rounds: int = 20,
    seed: int = 0,
) -> np.ndarray | None:
    """Initial coordinates for ``obs_idx``; ``None`` when too few cells overlap the previous run."""
    known, pos = match_previous(obs_idx, prev_idx)
    if obs_idx.size == 0 or known.mean() < min_overlap:
        return None
    graph = sp.csr_matrix(connectivities, dtype=np.float64)
    graph = graph.maximum(graph.T)
    init = np.zeros((obs_idx.size, prev_coords.shape[1]), dtype=np.float64)
    init[known] = prev_coords[pos[known]]
    placed = known.copy()
    for _ in range(max_rounds):
        if placed.all():
            break
        weight = graph @ placed.astype(np.float64)
        total = graph @ (init * placed[:, None])
        new = ~placed & (weight > 0)
        if not new.any():
            break
        init[new] = total[new] / weight[new, None]
        placed |= new
    if not placed.all():
        rng = np.random.default_rng(seed)
        center = init[placed].mean(axis=0)
        spread = init[placed].std(axis=0) * 0.05 + 1e-3
        n_left = int((~placed).sum())
        init[~placed] = center + rng.normal(size=(n_left, init.shape[1])) * spread
    return init.astype(np.float32)

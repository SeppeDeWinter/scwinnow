from __future__ import annotations

import numpy as np
import scipy.sparse as sp

from scwinnow.warmstart import init_from_previous, match_previous


def chain_graph(n: int) -> sp.csr_matrix:
    rows = np.arange(n - 1)
    g = sp.coo_matrix((np.ones(n - 1), (rows, rows + 1)), shape=(n, n))
    return sp.csr_matrix(g + g.T)


def test_match_previous():
    known, pos = match_previous(np.array([1, 4, 5, 9]), np.array([0, 4, 9]))
    np.testing.assert_array_equal(known, [False, True, False, True])
    assert pos[1] == 1 and pos[3] == 2


def test_known_cells_keep_coordinates_and_new_cells_interpolate():
    obs_idx = np.arange(5)
    prev_idx = np.array([0, 4])
    prev_xy = np.array([[0.0, 0.0], [4.0, 8.0]], dtype=np.float32)
    init = init_from_previous(obs_idx, prev_idx, prev_xy, chain_graph(5), min_overlap=0.1)
    assert init is not None
    np.testing.assert_allclose(init[0], [0, 0])
    np.testing.assert_allclose(init[4], [4, 8])
    # interior points lie between the two anchors
    assert np.all((init[1:4, 0] >= 0) & (init[1:4, 0] <= 4))


def test_low_overlap_returns_none():
    obs_idx = np.arange(10)
    init = init_from_previous(
        obs_idx, np.array([0]), np.zeros((1, 2), np.float32), chain_graph(10), min_overlap=0.5
    )
    assert init is None


def test_unreachable_cells_placed_near_centroid():
    obs_idx = np.arange(4)
    graph = sp.csr_matrix((4, 4))
    prev_xy = np.array([[0.0, 0.0], [2.0, 2.0]], dtype=np.float32)
    init = init_from_previous(obs_idx, np.array([0, 1]), prev_xy, graph, min_overlap=0.1)
    assert init is not None
    assert np.isfinite(init).all()
    np.testing.assert_allclose(init[2:], [[1.0, 1.0], [1.0, 1.0]], atol=0.2)

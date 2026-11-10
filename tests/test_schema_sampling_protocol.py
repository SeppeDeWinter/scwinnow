from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from scwinnow.protocol import ALIGN, decode_frame, encode_frame
from scwinnow.sampling import cell_ranks, subsample
from scwinnow.schema import obs_schema


def test_schema_kinds(obs):
    schema = obs_schema(obs, max_categories=10)
    kinds = {c["name"]: c["kind"] for c in schema["columns"]}
    assert kinds == {
        "total_counts": "numeric",
        "n_genes": "numeric",
        "sample": "category",
        "label_obj": "category",
        "is_doublet": "bool",
    }
    assert schema["n_obs"] == len(obs)


def test_schema_numeric_stats(obs):
    col = next(c for c in obs_schema(obs)["columns"] if c["name"] == "total_counts")
    assert col["min"] == pytest.approx(np.nanmin(obs["total_counts"]))
    assert col["max"] == pytest.approx(np.nanmax(obs["total_counts"]))
    assert col["n_missing"] == int(obs["total_counts"].isna().sum())
    assert sum(col["hist"]["counts"]) == int(obs["total_counts"].notna().sum())
    assert len(col["hist"]["edges"]) == len(col["hist"]["counts"]) + 1


def test_schema_category_counts_follow_category_order(obs):
    col = next(c for c in obs_schema(obs)["columns"] if c["name"] == "sample")
    assert [c["label"] for c in col["categories"]] == list(obs["sample"].cat.categories)
    assert sum(c["count"] for c in col["categories"]) == len(obs)


def test_schema_constant_and_empty_numeric():
    obs = pd.DataFrame({"const": [2.0] * 5, "empty": [np.nan] * 5})
    names = [c["name"] for c in obs_schema(obs)["columns"]]
    assert names == ["const"]


def test_cell_ranks_is_permutation():
    r = cell_ranks(1000, seed=3)
    assert sorted(r.tolist()) == list(range(1000))


def test_subsample_size_and_membership():
    rng = np.random.default_rng(0)
    mask = rng.random(5000) < 0.5
    ranks = cell_ranks(mask.size)
    idx = subsample(mask, 400, ranks)
    assert idx.size == 400
    assert mask[idx].all()
    assert np.all(np.diff(idx) > 0)
    np.testing.assert_array_equal(subsample(mask, None, ranks), np.flatnonzero(mask))
    np.testing.assert_array_equal(subsample(mask, 10**9, ranks), np.flatnonzero(mask))


def test_subsample_stable_under_shrinking_selection():
    rng = np.random.default_rng(1)
    ranks = cell_ranks(5000, seed=1)
    mask = rng.random(5000) < 0.8
    before = subsample(mask, 500, ranks)
    smaller = mask & (rng.random(5000) < 0.7)
    after = subsample(smaller, 500, ranks)
    survivors = before[smaller[before]]
    assert np.isin(survivors, after).all()


@pytest.mark.parametrize("header_extra", ["", "x" * 13, "y" * 101])
def test_frame_round_trip_and_alignment(header_extra):
    a = np.arange(7, dtype=np.uint32)
    b = np.random.default_rng(0).random((5, 2)).astype(np.float32)
    c = np.array([1, 0, 1], dtype=np.uint8)
    frame = encode_frame({"type": "coords", "pad": header_extra}, a, b, c)
    header, (a2, b2, c2) = decode_frame(frame)
    assert header["type"] == "coords"
    np.testing.assert_array_equal(a, a2)
    np.testing.assert_array_equal(b, b2)
    np.testing.assert_array_equal(c, c2)
    assert all(s["offset"] % ALIGN == 0 for s in header["buffers"])


def test_frame_rejects_unsupported_dtype():
    with pytest.raises(TypeError):
        encode_frame({}, np.array(["a"]))

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from scwinnow.filters import (
    BoolFilter,
    CategoryFilter,
    FilterError,
    RangeFilter,
    compute_mask,
    filter_from_dict,
    filters_code,
    filters_from_json,
    filters_to_json,
)


def test_empty_filters_select_all(obs):
    assert compute_mask(obs, []).all()


def test_range_inclusive_and_excludes_nan(obs):
    f = RangeFilter("total_counts", lo=1000, hi=3000)
    m = f.mask(obs)
    v = obs["total_counts"].to_numpy()
    expected = (v >= 1000) & (v <= 3000)
    np.testing.assert_array_equal(m, expected)
    assert not m[3] and not m[7]


def test_range_open_sides(obs):
    v = obs["n_genes"].to_numpy()
    np.testing.assert_array_equal(RangeFilter("n_genes", lo=500).mask(obs), v >= 500)
    np.testing.assert_array_equal(RangeFilter("n_genes", hi=500).mask(obs), v <= 500)
    open_both = RangeFilter("total_counts").mask(obs)
    np.testing.assert_array_equal(open_both, obs["total_counts"].notna().to_numpy())


def test_category_on_categorical_and_object(obs):
    m = CategoryFilter("sample", frozenset({"s1", "s3"})).mask(obs)
    np.testing.assert_array_equal(m, obs["sample"].isin(["s1", "s3"]).to_numpy())
    m2 = CategoryFilter("label_obj", frozenset({"a"})).mask(obs)
    np.testing.assert_array_equal(m2, (obs["label_obj"] == "a").to_numpy())


def test_category_matches_string_form_of_numeric_labels():
    obs = pd.DataFrame({"cluster": pd.Categorical([0, 1, 2, 1])})
    m = CategoryFilter("cluster", frozenset({"1"})).mask(obs)
    np.testing.assert_array_equal(m, [False, True, False, True])


def test_category_missing_values_excluded():
    obs = pd.DataFrame({"c": pd.Categorical(["x", None, "y"])})
    np.testing.assert_array_equal(
        CategoryFilter("c", frozenset({"x", "y"})).mask(obs), [True, False, True]
    )


def test_bool_filter(obs):
    d = obs["is_doublet"].to_numpy()
    np.testing.assert_array_equal(BoolFilter("is_doublet", False).mask(obs), ~d)
    np.testing.assert_array_equal(BoolFilter("is_doublet", True).mask(obs), d)


def test_filters_are_anded(obs):
    fs = [RangeFilter("n_genes", lo=300), CategoryFilter("sample", frozenset({"s2"}))]
    expected = fs[0].mask(obs) & fs[1].mask(obs)
    np.testing.assert_array_equal(compute_mask(obs, fs), expected)


def test_errors(obs):
    with pytest.raises(FilterError):
        RangeFilter("nope", lo=1).mask(obs)
    with pytest.raises(FilterError):
        RangeFilter("sample", lo=1).mask(obs)
    with pytest.raises(FilterError):
        BoolFilter("n_genes", True).mask(obs)
    with pytest.raises(FilterError):
        filter_from_dict({"kind": "lasso", "column": "x"})
    with pytest.raises(FilterError):
        filter_from_dict({"kind": "range"})


def test_json_round_trip():
    fs = [
        RangeFilter("total_counts", lo=1.5, hi=None),
        CategoryFilter("sample", frozenset({"s2", "s1"})),
        BoolFilter("is_doublet", False),
    ]
    wire = json.loads(json.dumps(filters_to_json(fs)))
    assert filters_from_json(wire) == fs


def test_filters_code_reproduces_mask(obs):
    import anndata as ad

    fs = [
        RangeFilter("total_counts", lo=800.0, hi=4000.0),
        RangeFilter("n_genes", hi=1500),
        CategoryFilter("sample", frozenset({"s1", "s2"})),
        BoolFilter("is_doublet", False),
    ]
    adata = ad.AnnData(obs=obs)
    scope: dict = {"adata": adata}
    exec(filters_code(fs), scope)
    np.testing.assert_array_equal(scope["mask"], compute_mask(obs, fs))
    assert scope["adata_sub"].n_obs == int(compute_mask(obs, fs).sum())

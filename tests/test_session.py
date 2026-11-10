from __future__ import annotations

import json

import anndata as ad
import numpy as np
import pytest

from scwinnow.filters import CategoryFilter, FilterError, RangeFilter, compute_mask
from scwinnow.pipeline import Params
from scwinnow.session import Session
from tests.fakes import FakeEmbedder


@pytest.fixture
def adata(obs) -> ad.AnnData:
    return ad.AnnData(X=np.ones((len(obs), 3), np.float32), obs=obs)


def make_session(adata, **kw) -> tuple[Session, FakeEmbedder]:
    emb = kw.pop("embedder", None) or FakeEmbedder()
    return Session(adata, emb, params=Params(n_neighbors=5), **kw), emb


def test_set_filters_updates_mask_and_triggers_preview(adata):
    s, emb = make_session(adata, preview_max_cells=50)
    fs = [RangeFilter("n_genes", lo=300)]
    s.set_filters(fs)
    assert s.wait_idle(5)
    expected = compute_mask(adata.obs, fs)
    np.testing.assert_array_equal(s.mask, expected)
    r = s.result
    assert r is not None
    assert r.obs_idx.size == min(50, int(expected.sum()))
    assert expected[r.obs_idx].all()
    assert r.mode == ("preview" if expected.sum() > 50 else "full")
    s.close()


def test_preview_covering_all_cells_is_full(adata):
    s, _ = make_session(adata, preview_max_cells=10_000)
    s.compute("preview")
    assert s.wait_idle(5)
    assert s.result is not None and s.result.mode == "full"
    assert s.full_result_is_current()
    s.close()


def test_auto_off_does_not_compute(adata):
    s, emb = make_session(adata, auto=False)
    s.set_filters([RangeFilter("n_genes", lo=300)])
    assert s.wait_idle(5)
    assert emb.calls == [] and s.result is None
    s.compute("full")
    assert s.wait_idle(5)
    assert s.result is not None and s.result.mode == "full"
    s.close()


def test_requests_coalesce_and_stale_results_are_dropped(adata):
    emb = FakeEmbedder(gated=True)
    s, _ = make_session(adata, embedder=emb, auto=False)
    results = []
    s.subscribe(lambda kind, payload: results.append(payload) if kind == "result" else None)
    s.compute("full")  # starts running, held by the gate
    assert emb.started.wait(5)
    s.set_filters([RangeFilter("n_genes", lo=500)])
    g2 = s.compute("full")
    s.set_filters([RangeFilter("n_genes", lo=900)])
    g3 = s.compute("full")
    assert g3 == g2 + 1
    emb.gate.set()
    assert s.wait_idle(5)
    # first (stale) job ran, g2 was superseded before it started, g3 ran last
    assert len(emb.calls) == 2
    assert [r.generation for r in results] == [g3]
    np.testing.assert_array_equal(
        results[0].obs_idx,
        np.flatnonzero(compute_mask(adata.obs, [RangeFilter("n_genes", lo=900)])),
    )
    s.close()


def test_embed_error_reported_in_state(adata):
    s, _ = make_session(adata)
    s.set_filters([CategoryFilter("sample", frozenset())])
    assert s.wait_idle(5)
    state = s.state()
    assert state["n_selected"] == 0
    assert state["status"]["state"] == "error"
    assert state["status"]["message"]
    s.close()


def test_invalid_filter_leaves_state_unchanged(adata):
    s, _ = make_session(adata, auto=False)
    with pytest.raises(FilterError):
        s.set_filters([RangeFilter("missing", lo=1)])
    assert s.state()["n_selected"] == adata.n_obs
    s.close()


def test_params_update_and_warm_start_previous(adata):
    s, emb = make_session(adata, preview_max_cells=10_000)
    s.compute("full")
    assert s.wait_idle(5)
    s.set_params({"tsne": True, "n_top_genes": "500"})
    assert s.wait_idle(5)
    assert s.params.tsne and s.params.n_top_genes == 500
    assert s.result is not None and set(s.result.coords) == {"umap", "tsne"}
    _, _, previous = emb.calls[-1]
    assert previous is not None and "umap" in previous
    with pytest.raises(ValueError):
        s.set_params({"umap": False, "tsne": False})
    with pytest.raises(ValueError):
        s.set_params({"bogus": 1})
    s.close()


def test_filtered_and_export(adata, tmp_path):
    s, _ = make_session(adata, preview_max_cells=10_000)
    fs = [CategoryFilter("sample", frozenset({"s1"}))]
    s.set_filters(fs)
    assert s.wait_idle(5)
    sub = s.filtered()
    assert sub.n_obs == int(compute_mask(adata.obs, fs).sum())
    assert "X_umap" in sub.obsm and sub.obsm["X_umap"].shape == (sub.n_obs, 2)
    assert json.loads(sub.uns["scwinnow"]["filters"]) == [f.to_dict() for f in fs]
    out = s.export(tmp_path / "sub.h5ad")
    back = ad.read_h5ad(out["path"])
    assert back.n_obs == sub.n_obs and "X_umap" in back.obsm
    s.close()


def test_filtered_omits_embedding_after_preview_only(adata):
    s, _ = make_session(adata, preview_max_cells=20)
    s.set_filters([RangeFilter("n_genes", lo=100)])
    assert s.wait_idle(5)
    assert s.result is not None and s.result.mode == "preview"
    assert "X_umap" not in s.filtered().obsm
    s.close()


def test_concurrent_exports_to_same_path(adata, tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    s, _ = make_session(adata, preview_max_cells=10_000)
    s.compute("full")
    assert s.wait_idle(5)
    target = tmp_path / "same.h5ad"
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: s.export(target), range(4)))
    assert all(r["n_obs"] == adata.n_obs for r in results)
    assert ad.read_h5ad(target).n_obs == adata.n_obs
    assert [p.name for p in tmp_path.iterdir()] == ["same.h5ad"]
    s.close()

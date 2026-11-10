from __future__ import annotations

import numpy as np
import pytest
import scanpy as sc
import scipy.sparse as sp

from scwinnow.pipeline import EmbedError, Params
from tests.conftest import DATA_DIR, make_counts_adata

pytestmark = pytest.mark.gpu


@pytest.fixture(scope="module")
def lognorm():
    adata = make_counts_adata(n_obs=600, n_vars=500)
    adata.layers["counts"] = sp.csr_matrix(adata.X)
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    return adata


@pytest.fixture(scope="module")
def embedder(lognorm):
    from scwinnow.pipeline import GpuEmbedder

    return GpuEmbedder(lognorm, counts_layer="counts")


@pytest.mark.parametrize(
    "params",
    [
        Params(n_top_genes=200, n_pcs=20),
        Params(n_top_genes=200, n_pcs=20, umap=False, tsne=True),
        Params(n_top_genes=200, n_pcs=20, tsne=True, hvg_flavor="seurat_v3"),
        Params(n_top_genes=200, n_pcs=20, hvg_flavor="cell_ranger"),
    ],
)
def test_shapes_and_embeddings(embedder, params):
    idx = np.arange(0, 600, 2)
    emb = embedder.run(idx, params)
    assert set(emb.coords) == set(params.embeddings)
    for xy in emb.coords.values():
        assert xy.shape == (idx.size, 2) and xy.dtype == np.float32
        assert np.isfinite(xy).all()
    assert emb.info["n_cells"] == idx.size
    assert {"subset", "hvg", "pca", "neighbors"} <= set(emb.timings)


def test_groups_separate_in_umap(embedder, lognorm):
    idx = np.arange(lognorm.n_obs)
    xy = embedder.run(idx, Params(n_top_genes=200, n_pcs=20)).coords["umap"]
    groups = lognorm.obs["group"].cat.codes.to_numpy()
    centers = np.stack([xy[groups == g].mean(0) for g in range(3)])
    within = np.mean(
        [np.linalg.norm(xy[groups == g] - centers[g], axis=1).mean() for g in range(3)]
    )
    between = np.mean([np.linalg.norm(centers[a] - centers[b]) for a in range(3) for b in range(a)])
    assert between > 2 * within


def test_warm_start_keeps_layout(embedder, lognorm):
    params = Params(n_top_genes=200, n_pcs=20)
    full = np.arange(lognorm.n_obs)
    first = embedder.run(full, params).coords["umap"]
    sub = full[::3]
    emb = embedder.run(sub, params, previous={"umap": (full, first)})
    assert emb.info.get("umap_init") == "warm"
    assert np.isfinite(emb.coords["umap"]).all()


def test_tiny_subset_and_missing_counts(embedder, lognorm):
    from scwinnow.pipeline import GpuEmbedder

    with pytest.raises(EmbedError):
        embedder.run(np.arange(5), Params())
    no_counts = GpuEmbedder(lognorm)
    with pytest.raises(EmbedError):
        no_counts.run(np.arange(100), Params(hvg_flavor="seurat_v3"))


@pytest.mark.slow
def test_brain10k_preview_and_full_timings():
    import anndata as ad

    from scwinnow.pipeline import GpuEmbedder

    path = DATA_DIR / "brain10k" / "prepared.h5ad"
    if not path.exists():
        pytest.skip("run scripts/prepare_test_data.py first")
    adata = ad.read_h5ad(path)
    embedder = GpuEmbedder(adata, counts_layer="counts")
    params = Params(tsne=True)
    rng = np.random.default_rng(0)
    embedder.run(np.arange(500), Params())  # warm-up (CUDA context, kernels)
    for label, idx in [
        ("preview", np.sort(rng.choice(adata.n_obs, adata.n_obs // 2, replace=False))),
        ("full", np.arange(adata.n_obs)),
    ]:
        emb = embedder.run(idx, params)
        total = sum(emb.timings.values())
        steps = ", ".join(f"{k} {v:.2f}s" for k, v in emb.timings.items())
        print(f"\n{label}: {idx.size} cells, {total:.2f}s ({steps})")
        assert emb.coords["umap"].shape == (idx.size, 2)
        assert emb.coords["tsne"].shape == (idx.size, 2)

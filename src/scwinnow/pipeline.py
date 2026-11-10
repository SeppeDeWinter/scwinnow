"""Recompute HVG -> PCA -> kNN -> UMAP / tSNE for a subset of cells on the GPU.

``rapids_singlecell`` and ``cupy`` are imported when a ``GpuEmbedder`` is constructed, so
``Params`` and the ``Embedder`` protocol are usable without a GPU.
"""

from __future__ import annotations

import dataclasses
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp

from scwinnow.warmstart import init_from_previous

HvgFlavor = Literal["seurat", "cell_ranger", "seurat_v3"]
EMBEDDINGS = ("umap", "tsne")


class EmbedError(RuntimeError):
    """The pipeline cannot run on this subset (too few cells, invalid parameters)."""


@dataclass(frozen=True)
class Params:
    n_top_genes: int = 2000
    hvg_flavor: HvgFlavor = "seurat"
    n_pcs: int = 50
    n_neighbors: int = 15
    umap: bool = True
    umap_min_dist: float = 0.5
    umap_warm_start: bool = True
    tsne: bool = False
    tsne_perplexity: int = 30
    tsne_learning_rate: int = 200
    seed: int = 0

    def __post_init__(self) -> None:
        if not (self.umap or self.tsne):
            raise ValueError("enable at least one of umap / tsne")
        if self.hvg_flavor not in ("seurat", "cell_ranger", "seurat_v3"):
            raise ValueError(f"unknown hvg_flavor {self.hvg_flavor!r}")
        for name in ("n_top_genes", "n_pcs", "n_neighbors"):
            if getattr(self, name) < 2:
                raise ValueError(f"{name} must be >= 2")
        if self.tsne_perplexity <= 0 or self.umap_min_dist < 0:
            raise ValueError("tsne_perplexity must be > 0 and umap_min_dist >= 0")

    @property
    def embeddings(self) -> tuple[str, ...]:
        return tuple(e for e in EMBEDDINGS if getattr(self, e))

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    def updated(self, changes: Mapping[str, Any]) -> Params:
        """Copy with ``changes`` applied, coerced to the field types."""
        types = {f.name: f.type for f in dataclasses.fields(self)}
        unknown = set(changes) - set(types)
        if unknown:
            raise ValueError(f"unknown parameters: {sorted(unknown)}")
        coerced: dict[str, Any] = {}
        for key, value in changes.items():
            current = getattr(self, key)
            if isinstance(current, bool):
                coerced[key] = bool(value)
            elif isinstance(current, int):
                coerced[key] = int(value)
            elif isinstance(current, float):
                coerced[key] = float(value)
            else:
                coerced[key] = str(value)
        return dataclasses.replace(self, **coerced)


@dataclass
class Embedding:
    coords: dict[str, np.ndarray]
    timings: dict[str, float] = field(default_factory=dict)
    info: dict[str, Any] = field(default_factory=dict)


Previous = Mapping[str, tuple[np.ndarray, np.ndarray]]
"""Per embedding name: ``(sorted obs indices, coords)`` of an earlier result."""


class Embedder(Protocol):
    def run(
        self, obs_idx: np.ndarray, params: Params, previous: Previous | None = None
    ) -> Embedding: ...


def _as_csr32(x: Any) -> sp.csr_matrix:
    return sp.csr_matrix(x, dtype=np.float32)


class GpuEmbedder:
    """Holds the expression matrix on the GPU and embeds row subsets of it."""

    def __init__(
        self,
        adata: ad.AnnData,
        *,
        expr_layer: str | None = None,
        counts_layer: str | None = None,
    ) -> None:
        import cupy as cp
        import cupyx.scipy.sparse as cpsp
        import rapids_singlecell as rsc

        self._cp, self._cpsp, self._rsc = cp, cpsp, rsc
        expr = adata.X if expr_layer is None else adata.layers[expr_layer]
        self._x = cpsp.csr_matrix(_as_csr32(expr))
        self._counts = (
            cpsp.csr_matrix(_as_csr32(adata.layers[counts_layer]))
            if counts_layer is not None
            else None
        )
        self._var = pd.DataFrame(index=adata.var_names.copy())
        self.n_obs = adata.n_obs

    def _sync(self) -> None:
        self._cp.cuda.get_current_stream().synchronize()

    def _subset(self, obs_idx: np.ndarray) -> ad.AnnData:
        rows = self._cp.asarray(obs_idx)
        sub = ad.AnnData(X=self._x[rows], var=self._var.copy())
        if self._counts is not None:
            sub.layers["counts"] = self._counts[rows]
        return sub

    def run(
        self, obs_idx: np.ndarray, params: Params, previous: Previous | None = None
    ) -> Embedding:
        rsc = self._rsc
        n = int(obs_idx.size)
        if n < params.n_neighbors + 2:
            raise EmbedError(f"{n} cells selected; need at least {params.n_neighbors + 2}")
        if params.hvg_flavor == "seurat_v3" and self._counts is None:
            raise EmbedError("hvg_flavor 'seurat_v3' needs a counts layer (--counts-layer)")

        timings: dict[str, float] = {}
        t = time.perf_counter()

        def lap(name: str) -> None:
            nonlocal t
            self._sync()
            now = time.perf_counter()
            timings[name] = now - t
            t = now

        sub = self._subset(obs_idx)
        lap("subset")

        n_top = min(params.n_top_genes, sub.n_vars)
        try:
            if params.hvg_flavor == "seurat_v3":
                rsc.pp.highly_variable_genes(
                    sub, n_top_genes=n_top, flavor="seurat_v3", layer="counts"
                )
            else:
                rsc.pp.highly_variable_genes(sub, n_top_genes=n_top, flavor=params.hvg_flavor)
            hvg = sub.var["highly_variable"].to_numpy(dtype=bool)
        except Exception:  # noqa: BLE001 - tiny or degenerate subsets; fall back to all genes
            hvg = np.ones(sub.n_vars, dtype=bool)
        sub.var["highly_variable"] = hvg
        lap("hvg")

        n_pcs = max(2, min(params.n_pcs, n - 1, int(hvg.sum()) - 1))
        rsc.pp.pca(sub, n_comps=n_pcs, mask_var="highly_variable", random_state=params.seed)
        lap("pca")

        rsc.pp.neighbors(sub, n_neighbors=params.n_neighbors, use_rep="X_pca", rng=params.seed)
        lap("neighbors")

        coords: dict[str, np.ndarray] = {}
        info: dict[str, Any] = {"n_cells": n, "n_hvg": int(hvg.sum()), "n_pcs": n_pcs}
        if params.umap:
            init: Any = "spectral"
            if params.umap_warm_start and previous and "umap" in previous:
                prev_idx, prev_xy = previous["umap"]
                conn: Any = sub.obsp["connectivities"]
                conn_cpu = conn.get() if self._cpsp.issparse(conn) else conn
                warm = init_from_previous(obs_idx, prev_idx, prev_xy, conn_cpu, seed=params.seed)
                if warm is not None:
                    init = warm
                    info["umap_init"] = "warm"
            rsc.tl.umap(sub, min_dist=params.umap_min_dist, init_pos=init, rng=params.seed)
            coords["umap"] = np.asarray(sub.obsm["X_umap"], dtype=np.float32)
            lap("umap")
        if params.tsne:
            rsc.tl.tsne(
                sub,
                use_rep="X_pca",
                perplexity=params.tsne_perplexity,
                learning_rate=params.tsne_learning_rate,
            )
            coords["tsne"] = np.asarray(sub.obsm["X_tsne"], dtype=np.float32)
            lap("tsne")
        return Embedding(coords=coords, timings=timings, info=info)

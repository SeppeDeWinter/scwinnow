from __future__ import annotations

from pathlib import Path

import anndata as ad
import numpy as np
import pandas as pd
import pytest
import scipy.sparse as sp

DATA_DIR = Path(__file__).resolve().parents[1] / "data"


@pytest.fixture
def obs() -> pd.DataFrame:
    rng = np.random.default_rng(1)
    n = 200
    counts = rng.integers(100, 5000, n).astype(float)
    counts[[3, 7]] = np.nan
    return pd.DataFrame(
        {
            "total_counts": counts,
            "n_genes": rng.integers(50, 2000, n),
            "sample": pd.Categorical(rng.choice(["s1", "s2", "s3"], n)),
            "label_obj": rng.choice(["a", "b"], n).astype(object),
            "is_doublet": rng.random(n) < 0.1,
            "barcode": [f"BC{i:05d}" for i in range(n)],
        },
        index=[f"cell{i}" for i in range(n)],
    )


def make_counts_adata(n_obs: int = 300, n_vars: int = 400, seed: int = 0) -> ad.AnnData:
    """Synthetic counts with three groups that differ in a block of genes each."""
    rng = np.random.default_rng(seed)
    group = rng.integers(0, 3, n_obs)
    rate = np.full((n_obs, n_vars), 0.3)
    block = n_vars // 6
    for g in range(3):
        rate[group == g, g * block : (g + 1) * block] = 3.0
    x = sp.csr_matrix(rng.poisson(rate).astype(np.float32))
    var_names = [f"MT-{i}" if i < 5 else f"G{i}" for i in range(n_vars)]
    adata = ad.AnnData(
        X=x,
        obs=pd.DataFrame(
            {
                "group": pd.Categorical([f"g{g}" for g in group]),
                "sample": rng.choice(["a", "b"], n_obs),
            },
            index=[f"c{i}" for i in range(n_obs)],
        ),
        var=pd.DataFrame(index=var_names),
    )
    return adata


@pytest.fixture
def counts_adata() -> ad.AnnData:
    return make_counts_adata()

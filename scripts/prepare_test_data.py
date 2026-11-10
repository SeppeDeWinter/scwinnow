"""Build ``data/brain10k/prepared.h5ad`` from the 10x filtered matrix, with scanpy QC annotations.

Run ``scripts/download_test_data.sh`` first, then::

    uv run --group testdata python scripts/prepare_test_data.py

Result: raw counts in ``layers["counts"]``, log-normalised ``X``, and in obs the scanpy QC metrics
(``total_counts``, ``n_genes_by_counts``, ``pct_counts_{mt,ribo,hb}``,
``pct_counts_in_top_20_genes``),
scrublet ``doublet_score`` / ``predicted_doublet`` and a ``leiden`` clustering.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import scanpy as sc
import scipy.sparse as sp

ROOT = Path(__file__).resolve().parents[1]
GENE_SETS = {"mt": "^MT-", "ribo": "^RP[SL]", "hb": "^HB[ABDEGMQZ]"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--h5", type=Path, default=ROOT / "data/brain10k/filtered_feature_bc_matrix.h5"
    )
    parser.add_argument("--out", type=Path, default=ROOT / "data/brain10k/prepared.h5ad")
    parser.add_argument("--leiden-resolution", type=float, default=0.5)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    adata = sc.read_10x_h5(args.h5, gex_only=True)
    adata.var_names_make_unique()
    adata.X = sp.csr_matrix(adata.X, dtype=np.float32)
    adata.layers["counts"] = adata.X.copy()

    names = adata.var_names.to_series()
    for key, pattern in GENE_SETS.items():
        adata.var[key] = names.str.contains(pattern).to_numpy()
    sc.pp.calculate_qc_metrics(
        adata, qc_vars=list(GENE_SETS), percent_top=(20,), log1p=False, inplace=True
    )
    sc.pp.scrublet(adata, random_state=args.seed)

    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)

    tmp = adata.copy()
    sc.pp.highly_variable_genes(tmp, n_top_genes=2000)
    sc.pp.pca(tmp, n_comps=50, mask_var="highly_variable", random_state=args.seed)
    sc.pp.neighbors(tmp, n_neighbors=15, method="gauss", random_state=args.seed)
    sc.tl.leiden(
        tmp,
        resolution=args.leiden_resolution,
        flavor="igraph",
        n_iterations=2,
        random_state=args.seed,
    )
    adata.obs["leiden"] = tmp.obs["leiden"]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    adata.write_h5ad(args.out, compression="gzip")
    print(f"wrote {args.out}: {adata.n_obs} cells x {adata.n_vars} genes")
    print("obs columns:", ", ".join(adata.obs.columns))


if __name__ == "__main__":
    main()

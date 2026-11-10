"""Command line interface (imports the analysis stack lazily, so ``--help`` is fast)."""

from __future__ import annotations

import socket
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import tyro


@dataclass(frozen=True)
class ServeArgs:
    """Serve the interactive filtering UI for an .h5ad file."""

    h5ad: tyro.conf.Positional[Path]
    """AnnData file with log-normalised expression in X (or --expr-layer)."""
    host: str = "127.0.0.1"
    """Interface to bind; use 0.0.0.0 to reach the server from another node."""
    port: int = 8765
    expr_layer: str | None = None
    """Layer with log-normalised expression (default: X)."""
    counts_layer: str | None = None
    """Layer with raw counts; enables the seurat_v3 HVG flavor."""
    hvg_flavor: Literal["seurat", "cell_ranger", "seurat_v3"] = "seurat"
    n_top_genes: int = 2000
    n_pcs: int = 50
    n_neighbors: int = 15
    umap: bool = True
    tsne: bool = False
    preview_max_cells: int = 20_000
    """Cells used for preview embeddings while filtering."""
    seed: int = 0


def run_serve(args: ServeArgs) -> None:
    import uvicorn

    from scwinnow.data import read, validate
    from scwinnow.pipeline import GpuEmbedder, Params
    from scwinnow.server import create_app
    from scwinnow.session import Session

    print(f"reading {args.h5ad}")
    adata = read(args.h5ad)
    for warning in validate(adata, expr_layer=args.expr_layer, counts_layer=args.counts_layer):
        print(f"warning: {warning}")
    params = Params(
        n_top_genes=args.n_top_genes,
        hvg_flavor=args.hvg_flavor,
        n_pcs=args.n_pcs,
        n_neighbors=args.n_neighbors,
        umap=args.umap,
        tsne=args.tsne,
        seed=args.seed,
    )
    print(f"moving {adata.n_obs} x {adata.n_vars} matrix to the GPU")
    embedder = GpuEmbedder(adata, expr_layer=args.expr_layer, counts_layer=args.counts_layer)
    session = Session(
        adata, embedder, params=params, preview_max_cells=args.preview_max_cells, seed=args.seed
    )
    session.compute("preview")
    app = create_app(session)
    node = socket.gethostname()
    print(f"\nscwinnow running on {node}:  http://localhost:{args.port}")
    if args.host == "127.0.0.1":
        print(f"from another machine: ssh -N -L {args.port}:localhost:{args.port} {node}\n")
    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    finally:
        session.close()


SUBCOMMANDS: dict[str, Callable[..., None]] = {"serve": run_serve}


def main(argv: list[str] | None = None) -> None:
    """Entry point for the ``scwinnow`` command."""
    tyro.extras.subcommand_cli_from_dict(
        SUBCOMMANDS,
        prog="scwinnow",
        description="Interactive AnnData filtering with GPU re-embedding.",
        args=argv,
        config=(tyro.conf.OmitArgPrefixes,),
    )

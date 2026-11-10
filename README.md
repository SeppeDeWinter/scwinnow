# scwinnow

Interactive filtering of AnnData objects, with UMAP / tSNE recomputed on the GPU
([rapids-singlecell](https://github.com/scverse/rapids_singlecell)) for the selected cells.

## Install

```bash
uv sync --extra gpu-cu13      # or gpu-cu12 for CUDA 12 drivers
```

## Run

On a GPU node (e.g. in a VSCode tunnel terminal):

```bash
uv run --extra gpu-cu13 scwinnow serve data.h5ad --counts-layer counts
```

Open the printed `http://localhost:8765` in VSCode's Simple Browser. Input: log-normalised `X`,
filterable metadata in `obs`, optionally a raw counts layer. See `scwinnow serve --help`.

## Notebook widget

Select `.venv/bin/python` as the notebook kernel
(a CPU node is fine) and connect to the server's node:

```python
from scwinnow.widget import Winnow
w = Winnow("<gpu-node>:8765")   # or Winnow(adata) in a kernel on a GPU node
w
```

`w.filtered()` returns the selected cells as AnnData. See `examples/winnow.ipynb`.

## Test data

```bash
scripts/download_test_data.sh
uv run --extra gpu-cu13 --group testdata python scripts/prepare_test_data.py
```

## Development

```bash
uv run --extra gpu-cu13 pytest            # CPU tests; -m gpu on a GPU node
uv run --extra gpu-cu13 ruff check . && uv run --extra gpu-cu13 ty check
npm --prefix js install && npm --prefix js run build
```

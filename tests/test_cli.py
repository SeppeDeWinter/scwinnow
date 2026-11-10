from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from scwinnow import cli


def test_serve_parses_positional_and_flags(monkeypatch):
    seen = {}

    def run_serve(args: cli.ServeArgs) -> None:
        seen["args"] = args

    monkeypatch.setitem(cli.SUBCOMMANDS, "serve", run_serve)
    cli.main(["serve", "x.h5ad", "--port", "9999", "--counts-layer", "counts", "--tsne"])
    args = seen["args"]
    assert args.h5ad == Path("x.h5ad")
    assert args.port == 9999 and args.counts_layer == "counts" and args.tsne


def test_cli_import_is_light():
    code = (
        "import json, sys, scwinnow.cli; "
        "heavy = ['anndata', 'scanpy', 'rapids_singlecell', 'cupy', 'fastapi', 'uvicorn']; "
        "print(json.dumps([m for m in heavy if m in sys.modules]))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == []


@pytest.mark.parametrize("argv", [["--help"], ["serve", "--help"]])
def test_help_exits_cleanly(argv):
    with pytest.raises(SystemExit) as exc:
        cli.main(argv)
    assert exc.value.code == 0

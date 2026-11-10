from __future__ import annotations

import socket
import threading
import time
from typing import Any

import anndata as ad
import numpy as np
import pandas as pd
import pytest

pytest.importorskip("anywidget")

from scwinnow.filters import RangeFilter, compute_mask  # noqa: E402
from scwinnow.pipeline import Params  # noqa: E402
from scwinnow.protocol import decode_frame  # noqa: E402
from scwinnow.widget import Winnow, _RemoteBackend  # noqa: E402
from tests.fakes import FakeEmbedder  # noqa: E402

FILTERS = [{"kind": "range", "column": "n_genes", "lo": 400, "hi": None}]


@pytest.fixture
def adata(obs) -> ad.AnnData:
    return ad.AnnData(X=np.ones((len(obs), 3), np.float32), obs=obs)


class Sent:
    """Captures what the widget sends to the frontend."""

    def __init__(self, widget: Winnow) -> None:
        self.items: list[tuple[str, Any]] = []
        self.lock = threading.Lock()

        def send(content, buffers=None):
            with self.lock:
                if content.get("type") == "frame":
                    assert buffers
                    header, arrays = decode_frame(bytes(buffers[0]))
                    self.items.append((header["type"], (header, arrays)))
                else:
                    self.items.append((content["type"], content))

        widget.send = send

    def wait(self, kind: str, pred=lambda p: True, timeout: float = 10.0):
        deadline = time.monotonic() + timeout
        seen = 0
        while time.monotonic() < deadline:
            with self.lock:
                items = self.items[seen:]
                seen += len(items)
            for k, p in items:
                if k == kind and pred(p):
                    return p
            time.sleep(0.02)
        raise AssertionError(f"no {kind!r} sent; got {[k for k, _ in self.items]}")


def frontend(widget: Winnow, msg: dict[str, Any]) -> None:
    widget._on_frontend_msg(widget, msg, [])


def run_flow(w: Winnow, sent: Sent, adata: ad.AnnData) -> None:
    frontend(w, {"type": "hello"})
    schema = sent.wait("schema")
    assert schema["n_obs"] == adata.n_obs and schema["obs_digest"]
    sent.wait("mask")
    frontend(w, {"type": "set_filters", "filters": FILTERS})
    obs = adata.obs
    assert isinstance(obs, pd.DataFrame)
    expected = compute_mask(obs, [RangeFilter("n_genes", lo=400)])
    _, (mask,) = sent.wait("mask", lambda p: p[0]["version"] >= 1)
    np.testing.assert_array_equal(mask.astype(bool), expected)
    frontend(w, {"type": "compute", "mode": "full"})
    header, (idx, _) = sent.wait("coords", lambda p: p[0]["mode"] == "full" and p[0]["current"])
    assert idx.size == int(expected.sum())
    sent.wait(
        "state",
        lambda s: s["status"]["state"] == "idle" and bool(s["result"]) and s["result"]["current"],
    )

    assert w.filters == FILTERS
    sub = w.filtered(adata)
    assert sub.n_obs == int(expected.sum()) and "X_umap" in sub.obsm
    downloaded = w.filtered()
    assert downloaded.n_obs == sub.n_obs and "X_umap" in downloaded.obsm
    assert "mask &=" in w.filters_code()

    other = adata[::-1].copy()
    with pytest.raises(ValueError):
        w.filtered(other)


def test_local_backend(adata):
    w = Winnow(adata, embedder=FakeEmbedder(), params=Params(n_neighbors=5))
    sent = Sent(w)
    try:
        run_flow(w, sent, adata)
    finally:
        w.close()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server(adata):
    import uvicorn

    from scwinnow.server import create_app
    from scwinnow.session import Session

    session = Session(adata, FakeEmbedder(), params=Params(n_neighbors=5), preview_max_cells=50)
    port = _free_port()
    srv = uvicorn.Server(uvicorn.Config(create_app(session), port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not srv.started and time.monotonic() < deadline:
        time.sleep(0.05)
    yield f"127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(timeout=5)
    session.close()


def test_remote_backend(server, adata):
    w = Winnow(server)
    sent = Sent(w)
    try:
        assert isinstance(w._backend, _RemoteBackend)
        assert w._backend.wait_connected(10)
        run_flow(w, sent, adata)
    finally:
        w.close()


def test_remote_unreachable_reports_error():
    w = Winnow(f"127.0.0.1:{_free_port()}")
    sent = Sent(w)
    try:
        err = sent.wait("error", timeout=15)
        assert "scwinnow server" in err["message"]
    finally:
        w.close()

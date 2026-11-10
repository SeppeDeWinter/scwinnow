"""Jupyter widget (anywidget) showing the scwinnow UI in a notebook output.

Two backends feed the same UI:

- ``Winnow("gpu-node:8765")`` relays to a running ``scwinnow serve`` over its websocket, so the
  notebook kernel can run on a CPU node while the GPU work happens in the server's job.
- ``Winnow(adata)`` runs a ``Session`` in the kernel (the kernel needs a GPU), or with a given
  ``embedder``.

JSON messages travel as widget custom messages; binary frames (``scwinnow.protocol``) as
``{"type": "frame"}`` with one buffer.
"""

from __future__ import annotations

import json
import tempfile
import threading
import time
import traceback
import urllib.request
from collections.abc import Callable
from importlib.resources import files
from pathlib import Path
from typing import Any

import anndata as ad
import anywidget
import numpy as np
import pandas as pd
import traitlets

from scwinnow.filters import compute_mask, filters_code, filters_from_json
from scwinnow.messages import MessageHandler, obs_digest
from scwinnow.protocol import decode_frame

STATIC = files("scwinnow") / "static"
Push = Callable[[dict[str, Any] | bytes], None]


class _LocalBackend:
    """Session in the kernel process."""

    def __init__(self, session: Any, push: Push) -> None:
        self.session = session
        self.handler = MessageHandler(session)
        self._push = push
        self._mask_version = session.mask_version
        self._lock = threading.Lock()
        self._unsubscribe = session.subscribe(self._on_event)

    def _on_event(self, kind: str, payload: Any) -> None:
        with self._lock:
            msgs, self._mask_version = self.handler.event_messages(
                kind, payload, self._mask_version
            )
        for m in msgs:
            self._push(m)

    def send(self, msg: dict[str, Any]) -> None:
        self.handler.handle(msg, self._push)

    def close(self) -> None:
        self._unsubscribe()
        self.session.close()


class _RemoteBackend:
    """Websocket client of a ``scwinnow serve`` process; reconnects after connection loss."""

    def __init__(self, base_url: str, push: Push) -> None:
        self.base_url = base_url
        self.ws_url = base_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        self._push = push
        self._ws: Any = None
        self._closed = False
        self._connected = threading.Event()
        self._thread = threading.Thread(target=self._run, name="scwinnow-relay", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        from websockets.exceptions import ConnectionClosed
        from websockets.sync.client import connect

        delay, first = 0.5, True
        while not self._closed:
            try:
                with connect(self.ws_url, max_size=None, open_timeout=10) as ws:
                    self._ws = ws
                    self._connected.set()
                    if not first:
                        ws.send(json.dumps({"type": "hello"}))
                    first, delay = False, 0.5
                    for message in ws:
                        self._push(message if isinstance(message, bytes) else json.loads(message))
            except (OSError, ConnectionClosed, TimeoutError) as err:
                if self._closed:
                    return
                self._connected.clear()
                self._push({"type": "error", "message": f"scwinnow server {self.base_url}: {err}"})
                time.sleep(delay)
                delay = min(delay * 2, 10.0)

    def wait_connected(self, timeout: float) -> bool:
        return self._connected.wait(timeout)

    def send(self, msg: dict[str, Any]) -> None:
        if not self._connected.wait(10):
            self._push({"type": "error", "message": f"not connected to {self.base_url}"})
            return
        self._ws.send(json.dumps(msg))

    def download_filtered(self) -> ad.AnnData:
        with tempfile.TemporaryDirectory(prefix="scwinnow-") as tmp:
            path = Path(tmp) / "filtered.h5ad"
            urllib.request.urlretrieve(self.base_url + "/api/filtered.h5ad", path)
            return ad.read_h5ad(path)

    def close(self) -> None:
        self._closed = True
        if self._ws is not None:
            self._ws.close()


def _base_url(address: str) -> str:
    url = address if "://" in address else f"http://{address}"
    return url.rstrip("/")


class Winnow(anywidget.AnyWidget):
    """Interactive filtering widget.

    ``source`` is either the address of a running ``scwinnow serve`` (``"node:8765"`` or a URL)
    or an AnnData object. For an AnnData, ``session_kwargs`` go to ``Session`` and ``embedder``
    defaults to a ``GpuEmbedder``; ``expr_layer`` / ``counts_layer`` select its matrices.
    """

    _esm = STATIC / "widget.js"
    _css = STATIC / "app.css"
    height = traitlets.Int(820).tag(sync=True)

    def __init__(
        self,
        source: str | ad.AnnData,
        *,
        height: int = 820,
        embedder: Any = None,
        expr_layer: str | None = None,
        counts_layer: str | None = None,
        **session_kwargs: Any,
    ) -> None:
        super().__init__(height=height)
        self._schema: dict[str, Any] | None = None
        self._state: dict[str, Any] | None = None
        self._mask: np.ndarray | None = None
        self._coords: dict[str, tuple[dict[str, Any], np.ndarray, np.ndarray]] = {}
        self._backend: _LocalBackend | _RemoteBackend
        if isinstance(source, str):
            self._backend = _RemoteBackend(_base_url(source), self._push)
        else:
            from scwinnow.session import Session

            if embedder is None:
                from scwinnow.pipeline import GpuEmbedder

                embedder = GpuEmbedder(source, expr_layer=expr_layer, counts_layer=counts_layer)
            session = Session(source, embedder, **session_kwargs)
            self._backend = _LocalBackend(session, self._push)
            session.compute("preview")
        self.on_msg(self._on_frontend_msg)

    # ---- relay -------------------------------------------------------------------------------

    def _push(self, item: dict[str, Any] | bytes) -> None:
        try:
            if isinstance(item, bytes):
                self._track_frame(item)
                self.send({"type": "frame"}, buffers=[item])
            else:
                self._track_message(item)
                self.send(item)
        except Exception:  # noqa: BLE001 - relay must survive a broken comm
            traceback.print_exc()

    def _on_frontend_msg(self, _widget: Any, content: dict[str, Any], _buffers: list) -> None:
        if isinstance(content, dict) and "type" in content:
            self._backend.send(content)

    def _track_message(self, msg: dict[str, Any]) -> None:
        if msg.get("type") == "schema":
            self._schema = msg
        elif msg.get("type") == "state":
            self._state = msg

    def _track_frame(self, frame: bytes) -> None:
        header, arrays = decode_frame(frame)
        if header["type"] == "mask":
            self._mask = arrays[0].astype(bool)
        elif header["type"] == "coords":
            self._coords[header["embedding"]] = (header, arrays[0].copy(), arrays[1].copy())

    def send_message(self, msg: dict[str, Any]) -> None:
        """Send one UI message (e.g. ``{"type": "compute", "mode": "full"}``) to the backend."""
        self._backend.send(msg)

    # ---- notebook API ------------------------------------------------------------------------

    def _wait_for_state(self, timeout: float = 30) -> dict[str, Any]:
        if self._state is None or self._schema is None:
            self.send_message({"type": "hello"})
            deadline = time.monotonic() + timeout
            while (self._state is None or self._schema is None) and time.monotonic() < deadline:
                time.sleep(0.05)
        if self._state is None:
            raise TimeoutError("no state received from the scwinnow backend")
        return self._state

    @property
    def state(self) -> dict[str, Any]:
        return self._wait_for_state()

    @property
    def filters(self) -> list[dict[str, Any]]:
        return self.state["filters"]

    def filters_code(self, adata_name: str = "adata") -> str:
        return filters_code(filters_from_json(self.filters), adata_name=adata_name)

    def wait_idle(self, timeout: float = 300) -> dict[str, Any]:
        """Block until the backend has no queued or running computation."""
        deadline = time.monotonic() + timeout
        state = self._wait_for_state()
        while state["status"]["state"] in ("queued", "running"):
            if time.monotonic() > deadline:
                raise TimeoutError("scwinnow backend still busy")
            time.sleep(0.1)
            state = self._wait_for_state()
        return state

    def filtered(self, adata: ad.AnnData | None = None) -> ad.AnnData:
        """Selected cells as AnnData, with ``X_umap`` / ``X_tsne`` when a full run matches them.

        With ``adata`` (the same cells, in the same order as the served data) the subset is taken
        in the kernel; otherwise it is computed by the backend (downloaded from a remote server).
        """
        state = self.wait_idle()
        if adata is None:
            if isinstance(self._backend, _LocalBackend):
                return self._backend.session.filtered()
            return self._backend.download_filtered()
        schema = self._schema or {}
        if obs_digest(adata.obs_names) != schema.get("obs_digest"):
            raise ValueError("adata has different cells (or order) than the scwinnow backend")
        obs = adata.obs
        if not isinstance(obs, pd.DataFrame):
            raise TypeError("adata.obs must be an in-memory pandas DataFrame")
        sel = compute_mask(obs, filters_from_json(state["filters"]))
        sub = adata[sel].copy()
        result = state.get("result")
        if result and result["mode"] == "full" and result["current"]:
            sel_idx = np.flatnonzero(sel)
            for name, (header, idx, xy) in self._coords.items():
                if header["generation"] == result["generation"] and np.array_equal(idx, sel_idx):
                    sub.obsm[f"X_{name}"] = np.asarray(xy)
        sub.uns["scwinnow"] = {"filters": json.dumps(state["filters"])}
        return sub

    def close(self) -> None:
        self._backend.close()
        super().close()

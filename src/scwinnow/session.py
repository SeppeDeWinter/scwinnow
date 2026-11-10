"""Interactive state: filters, mask, parameters and the latest embedding.

One background worker runs the embedder. Requests coalesce: while a job runs, only the newest
pending request is kept. A finished job whose generation is no longer the newest is discarded.
Listeners receive ``("state", None)`` after any state change and ``("result", Result)`` for each
new embedding; they may be called from the worker thread.
"""

from __future__ import annotations

import json
import os
import threading
import traceback
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import anndata as ad
import numpy as np
import pandas as pd

from scwinnow.filters import Filter, compute_mask, filters_code, filters_to_json
from scwinnow.pipeline import Embedder, EmbedError, Params, Previous
from scwinnow.sampling import cell_ranks, subsample

Mode = Literal["preview", "full"]
Listener = Callable[[str, Any], None]


@dataclass
class Result:
    generation: int
    mode: Mode
    mask_version: int
    obs_idx: np.ndarray
    coords: dict[str, np.ndarray]
    timings: dict[str, float] = field(default_factory=dict)
    info: dict[str, Any] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        return {
            "generation": self.generation,
            "mode": self.mode,
            "n_cells": int(self.obs_idx.size),
            "embeddings": sorted(self.coords),
            "timings": self.timings,
            "info": self.info,
        }


@dataclass
class _Job:
    generation: int
    mode: Mode
    mask_version: int
    obs_idx: np.ndarray
    params: Params


class Session:
    def __init__(
        self,
        adata: ad.AnnData,
        embedder: Embedder,
        *,
        params: Params | None = None,
        preview_max_cells: int | None = 20_000,
        auto: bool = True,
        seed: int = 0,
    ) -> None:
        self.adata = adata
        obs = adata.obs
        if not isinstance(obs, pd.DataFrame):
            raise TypeError("adata.obs must be an in-memory pandas DataFrame")
        self.obs: pd.DataFrame = obs
        self.n_total = adata.n_obs
        self._embedder = embedder
        self._ranks = cell_ranks(self.n_total, seed=seed)

        self._lock = threading.Condition()
        self._listeners: list[Listener] = []
        self._filters: list[Filter] = []
        self._mask = np.ones(self.n_total, dtype=bool)
        self._mask_version = 0
        self._params = params or Params()
        self._preview_max_cells = preview_max_cells
        self._auto = auto
        self._generation = 0
        self._pending: _Job | None = None
        self._running: _Job | None = None
        self._result: Result | None = None
        self._error: str | None = None
        self._closed = False
        self._export_lock = threading.Lock()
        self._worker = threading.Thread(target=self._work, name="scwinnow-worker", daemon=True)
        self._worker.start()

    # ---- listeners -------------------------------------------------------------------------

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        with self._lock:
            self._listeners.append(listener)

        def unsubscribe() -> None:
            with self._lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)

        return unsubscribe

    def _emit(self, kind: str, payload: Any = None) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(kind, payload)
            except Exception:  # noqa: BLE001 - a broken frontend must not stop the session
                traceback.print_exc()

    # ---- read-only state -------------------------------------------------------------------

    @property
    def mask(self) -> np.ndarray:
        with self._lock:
            return self._mask.copy()

    @property
    def mask_version(self) -> int:
        with self._lock:
            return self._mask_version

    @property
    def filters(self) -> list[Filter]:
        with self._lock:
            return list(self._filters)

    @property
    def params(self) -> Params:
        with self._lock:
            return self._params

    @property
    def result(self) -> Result | None:
        with self._lock:
            return self._result

    def full_result_is_current(self) -> bool:
        with self._lock:
            r = self._result
            return r is not None and r.mode == "full" and r.mask_version == self._mask_version

    def state(self) -> dict[str, Any]:
        with self._lock:
            if self._running is not None:
                status, mode = "running", self._running.mode
            elif self._pending is not None:
                status, mode = "queued", self._pending.mode
            elif self._error is not None:
                status, mode = "error", None
            else:
                status, mode = "idle", None
            r = self._result
            return {
                "n_total": self.n_total,
                "n_selected": int(self._mask.sum()),
                "filters": filters_to_json(self._filters),
                "params": self._params.to_dict(),
                "auto": self._auto,
                "preview_max_cells": self._preview_max_cells,
                "status": {"state": status, "mode": mode, "message": self._error or ""},
                "result": None
                if r is None
                else {**r.summary(), "current": r.mask_version == self._mask_version},
            }

    # ---- mutations -------------------------------------------------------------------------

    def set_filters(self, filters: Iterable[Filter]) -> None:
        filters = list(filters)
        mask = compute_mask(self.obs, filters)
        with self._lock:
            changed = filters != self._filters
            self._filters = filters
            self._mask = mask
            if changed:
                self._mask_version += 1
            auto = self._auto
        self._emit("state")
        if changed and auto:
            self.compute("preview")

    def set_params(self, changes: Mapping[str, Any]) -> None:
        with self._lock:
            self._params = self._params.updated(changes)
            auto = self._auto
        self._emit("state")
        if auto:
            self.compute("preview")

    def set_auto(self, auto: bool) -> None:
        with self._lock:
            self._auto = bool(auto)
        self._emit("state")

    def set_preview_max_cells(self, n: int | None) -> None:
        with self._lock:
            self._preview_max_cells = None if n is None else max(1, int(n))
            auto = self._auto
        self._emit("state")
        if auto:
            self.compute("preview")

    def compute(self, mode: Mode = "preview") -> int:
        """Queue a run on the current selection; returns its generation."""
        with self._lock:
            n_max = self._preview_max_cells if mode == "preview" else None
            idx = subsample(self._mask, n_max, self._ranks)
            if idx.size == int(self._mask.sum()):
                mode = "full"
            self._generation += 1
            self._pending = _Job(self._generation, mode, self._mask_version, idx, self._params)
            self._error = None
            self._lock.notify_all()
            generation = self._generation
        self._emit("state")
        return generation

    # ---- worker ----------------------------------------------------------------------------

    def _previous(self) -> Previous:
        r = self._result
        if r is None:
            return {}
        return {name: (r.obs_idx, xy) for name, xy in r.coords.items()}

    def _work(self) -> None:
        while True:
            with self._lock:
                while self._pending is None and not self._closed:
                    self._lock.wait()
                if self._closed:
                    return
                job = self._pending
                assert job is not None
                self._pending, self._running = None, job
                previous = self._previous()
            self._emit("state")
            result: Result | None = None
            error: str | None = None
            try:
                emb = self._embedder.run(job.obs_idx, job.params, previous)
                result = Result(
                    job.generation,
                    job.mode,
                    job.mask_version,
                    job.obs_idx,
                    emb.coords,
                    emb.timings,
                    emb.info,
                )
            except EmbedError as err:
                error = str(err)
            except Exception as err:  # noqa: BLE001 - reported to the frontend
                traceback.print_exc()
                error = f"{type(err).__name__}: {err}"
            with self._lock:
                self._running = None
                newest = job.generation == self._generation
                if newest and result is not None:
                    self._result = result
                if newest and error is not None:
                    self._error = error
                self._lock.notify_all()
            if newest and result is not None:
                self._emit("result", result)
            self._emit("state")

    def wait_idle(self, timeout: float | None = None) -> bool:
        with self._lock:
            return self._lock.wait_for(
                lambda: self._pending is None and self._running is None, timeout=timeout
            )

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._lock.notify_all()
        self._worker.join(timeout=5)

    # ---- output ----------------------------------------------------------------------------

    def filtered(self) -> ad.AnnData:
        """Copy of the selected cells; ``obsm["X_umap"/"X_tsne"]`` when a full run matches them."""
        with self._lock:
            mask = self._mask.copy()
            filters = filters_to_json(self._filters)
            params = self._params.to_dict()
            r = self._result
            current = r is not None and r.mode == "full" and r.mask_version == self._mask_version
        sub = self.adata[mask].copy()
        if current and r is not None:
            for name, xy in r.coords.items():
                sub.obsm[f"X_{name}"] = xy
        sub.uns["scwinnow"] = {"filters": json.dumps(filters), "params": json.dumps(params)}
        return sub

    def export(self, path: str | Path) -> dict[str, Any]:
        """Write ``filtered()`` to ``path`` (via a temporary file, then an atomic rename)."""
        path = Path(path).expanduser().resolve()
        with self._export_lock:
            sub = self.filtered()
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
            try:
                sub.write_h5ad(tmp)
                os.replace(tmp, path)
            finally:
                tmp.unlink(missing_ok=True)
        return {"path": str(path), "n_obs": sub.n_obs, "embeddings": sorted(sub.obsm.keys())}

    def filters_code(self, adata_name: str = "adata") -> str:
        return filters_code(self.filters, adata_name=adata_name)

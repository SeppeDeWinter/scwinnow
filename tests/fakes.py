from __future__ import annotations

import threading

import numpy as np

from scwinnow.pipeline import Embedding, EmbedError, Params, Previous


class FakeEmbedder:
    """Coordinates derived from obs indices; optional gate to hold a run until released."""

    def __init__(self, gated: bool = False) -> None:
        self.calls: list[tuple[np.ndarray, Params, Previous | None]] = []
        self.gate = threading.Event()
        self.started = threading.Event()
        if not gated:
            self.gate.set()

    def run(
        self, obs_idx: np.ndarray, params: Params, previous: Previous | None = None
    ) -> Embedding:
        self.calls.append((obs_idx.copy(), params, previous))
        self.started.set()
        self.gate.wait(timeout=10)
        if obs_idx.size < params.n_neighbors + 2:
            raise EmbedError("too few cells")
        xy = np.stack([obs_idx, -obs_idx], axis=1).astype(np.float32)
        coords = {name: xy.copy() for name in params.embeddings}
        return Embedding(coords=coords, timings={"total": 0.0}, info={"n_cells": int(obs_idx.size)})

"""Transport-independent message handling between a ``Session`` and one frontend.

Client -> engine (JSON objects with a ``type``):

- ``hello``: request schema, state, mask and the latest embeddings
- ``set_filters {filters}``, ``set_params {params}``, ``set_auto {auto}``,
  ``set_preview_max_cells {n}``, ``compute {mode}``, ``get_column {column}``,
  ``export {path}``, ``get_code``

Engine -> client: JSON ``schema``, ``state``, ``code``, ``exported``, ``error``; binary frames
(``scwinnow.protocol``) of type ``mask`` (uint8 per cell), ``coords`` (uint32 obs indices +
float32 n x 2) and ``column`` (uint16 category codes with 65535 = missing, or float32 values).
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from functools import lru_cache
from typing import Any

import numpy as np
import pandas as pd

from scwinnow.filters import (
    FilterError,
    as_labels,
    filters_from_json,
    is_bool_column,
    is_numeric_column,
)
from scwinnow.protocol import encode_frame
from scwinnow.schema import obs_schema
from scwinnow.session import Result, Session

MISSING_CODE = np.iinfo(np.uint16).max

Send = Callable[[dict[str, Any] | bytes], None]


def obs_digest(index: pd.Index) -> str:
    """SHA-1 of the ordered obs names; equal digests mean masks and indices are interchangeable."""
    h = hashlib.sha1()
    for name in index.astype(str):
        h.update(name.encode())
        h.update(b"\0")
    return h.hexdigest()


def encode_column(series: pd.Series, name: str) -> bytes:
    if is_numeric_column(series):
        values = series.to_numpy(dtype=np.float32, na_value=np.nan)
        return encode_frame({"type": "column", "column": name, "kind": "numeric"}, values)
    if is_bool_column(series):
        labels = as_labels(series.map({True: "true", False: "false"}))
        categories = ["false", "true"]
    else:
        labels = as_labels(series)
        if isinstance(series.dtype, pd.CategoricalDtype):
            present = set(labels.dropna().unique())
            categories = [str(c) for c in series.cat.categories if str(c) in present]
        else:
            categories = sorted(labels.dropna().unique().tolist())
    if len(categories) >= MISSING_CODE:
        raise FilterError(f"column {name!r} has too many categories to encode")
    lookup = {c: i for i, c in enumerate(categories)}
    codes = labels.map(lookup).to_numpy(dtype=np.float64, na_value=np.nan)
    codes = np.where(np.isnan(codes), MISSING_CODE, codes).astype(np.uint16)
    header = {"type": "column", "column": name, "kind": "category", "categories": categories}
    return encode_frame(header, codes)


def mask_frame(session: Session) -> bytes:
    return encode_frame(
        {"type": "mask", "version": session.mask_version}, session.mask.astype(np.uint8)
    )


def coords_frames(result: Result, current: bool) -> list[bytes]:
    return [
        encode_frame(
            {
                "type": "coords",
                "embedding": name,
                "generation": result.generation,
                "mode": result.mode,
                "current": current,
            },
            result.obs_idx.astype(np.uint32),
            np.ascontiguousarray(xy, dtype=np.float32),
        )
        for name, xy in result.coords.items()
    ]


class MessageHandler:
    """Turns client messages into session calls and session events into outgoing messages."""

    def __init__(self, session: Session) -> None:
        self.session = session
        self._schema = {**obs_schema(session.obs), "obs_digest": obs_digest(session.obs.index)}
        self._column_cache = lru_cache(maxsize=64)(self._encode_column)

    @property
    def schema(self) -> dict[str, Any]:
        return self._schema

    def _encode_column(self, name: str) -> bytes:
        if name not in self.session.obs.columns:
            raise FilterError(f"unknown obs column: {name!r}")
        return encode_column(self.session.obs[name], name)

    def state_message(self) -> dict[str, Any]:
        return {"type": "state", **self.session.state()}

    def initial_messages(self) -> list[dict[str, Any] | bytes]:
        out: list[dict[str, Any] | bytes] = [
            {"type": "schema", **self._schema},
            self.state_message(),
            mask_frame(self.session),
        ]
        r = self.session.result
        if r is not None:
            out += coords_frames(r, r.mask_version == self.session.mask_version)
        return out

    def handle(self, msg: Mapping[str, Any], reply: Send) -> None:
        """Apply one client message; direct replies go to ``reply``."""
        s = self.session
        kind = msg.get("type")
        try:
            match kind:
                case "hello":
                    for m in self.initial_messages():
                        reply(m)
                case "set_filters":
                    s.set_filters(filters_from_json(msg.get("filters", [])))
                case "set_params":
                    s.set_params(dict(msg.get("params", {})))
                case "set_auto":
                    s.set_auto(bool(msg.get("auto", True)))
                case "set_preview_max_cells":
                    n = msg.get("n")
                    s.set_preview_max_cells(None if n is None else int(n))
                case "compute":
                    mode = msg.get("mode", "preview")
                    if mode not in ("preview", "full"):
                        raise ValueError(f"unknown compute mode {mode!r}")
                    s.compute(mode)
                case "get_column":
                    reply(self._column_cache(str(msg["column"])))
                case "get_code":
                    reply({"type": "code", "code": s.filters_code()})
                case "export":
                    reply({"type": "exported", **s.export(str(msg["path"]))})
                case _:
                    raise ValueError(f"unknown message type {kind!r}")
        except (FilterError, ValueError, KeyError, TypeError, OSError) as err:
            reply({"type": "error", "request": kind, "message": str(err)})

    def event_messages(
        self, kind: str, payload: Any, last_mask_version: int
    ) -> tuple[list[dict[str, Any] | bytes], int]:
        """Outgoing messages for a session event; also returns the mask version now sent."""
        out: list[dict[str, Any] | bytes] = []
        if kind == "state":
            version = self.session.mask_version
            if version != last_mask_version:
                out.append(mask_frame(self.session))
                last_mask_version = version
            out.append(self.state_message())
        elif kind == "result" and isinstance(payload, Result):
            out += coords_frames(payload, payload.mask_version == self.session.mask_version)
        return out, last_mask_version

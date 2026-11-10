"""Binary frame format shared by the server and widget transports.

A frame is ``[u32 little-endian header length][UTF-8 JSON header][buffers]``. The header lists the
buffers as ``{"dtype", "shape", "offset", "nbytes"}``; ``offset`` is relative to the frame start
and a multiple of 8, so the browser can view each buffer as a typed array without copying.
"""

from __future__ import annotations

import json
import struct
from typing import Any

import numpy as np

ALIGN = 8
_DTYPES = {"uint8", "uint16", "uint32", "int32", "float32", "float64"}


def _pad(n: int) -> int:
    return (-n) % ALIGN


def encode_frame(header: dict[str, Any], *arrays: np.ndarray) -> bytes:
    arrays_c = [np.ascontiguousarray(a) for a in arrays]
    for a in arrays_c:
        if a.dtype.name not in _DTYPES:
            raise TypeError(f"unsupported dtype for frame buffer: {a.dtype}")
        if a.dtype.byteorder == ">":
            raise TypeError("frame buffers must be little-endian")

    def build(offset0: int) -> tuple[bytes, list[dict[str, Any]]]:
        specs, offset = [], offset0
        for a in arrays_c:
            specs.append(
                {
                    "dtype": a.dtype.name,
                    "shape": list(a.shape),
                    "offset": offset,
                    "nbytes": a.nbytes,
                }
            )
            offset += a.nbytes + _pad(a.nbytes)
        return json.dumps({**header, "buffers": specs}).encode(), specs

    # Buffer offsets depend on the header length, which depends on the offsets: iterate.
    start = 0
    while True:
        head, _ = build(start)
        new_start = 4 + len(head) + _pad(4 + len(head))
        if new_start == start:
            break
        start = new_start
    parts = [struct.pack("<I", len(head)), head, b" " * _pad(4 + len(head))]
    for a in arrays_c:
        parts += [a.tobytes(), b"\0" * _pad(a.nbytes)]
    return b"".join(parts)


def decode_frame(frame: bytes) -> tuple[dict[str, Any], list[np.ndarray]]:
    (n,) = struct.unpack_from("<I", frame, 0)
    header = json.loads(frame[4 : 4 + n])
    arrays = [
        np.frombuffer(
            frame, dtype=s["dtype"], count=int(np.prod(s["shape"])), offset=s["offset"]
        ).reshape(s["shape"])
        for s in header["buffers"]
    ]
    return header, arrays

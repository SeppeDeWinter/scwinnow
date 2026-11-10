from __future__ import annotations

import json
from typing import Any

import anndata as ad
import numpy as np
import pytest
from fastapi.testclient import TestClient

from scwinnow.filters import compute_mask, filters_from_json
from scwinnow.messages import MISSING_CODE
from scwinnow.pipeline import Params
from scwinnow.protocol import decode_frame
from scwinnow.server import create_app
from scwinnow.session import Session
from tests.fakes import FakeEmbedder


@pytest.fixture
def setup(obs):
    adata = ad.AnnData(X=np.ones((len(obs), 3), np.float32), obs=obs)
    session = Session(adata, FakeEmbedder(), params=Params(n_neighbors=5), preview_max_cells=40)
    with TestClient(create_app(session)) as client:
        yield client, session, adata
    session.close()


def receive(ws) -> tuple[str, Any]:
    msg = ws.receive()
    if msg.get("bytes") is not None:
        header, arrays = decode_frame(msg["bytes"])
        return header["type"], (header, arrays)
    data = json.loads(msg["text"])
    return data["type"], data


def receive_until(ws, kind: str, pred=lambda payload: True, limit: int = 50):
    for _ in range(limit):
        k, payload = receive(ws)
        if k == kind and pred(payload):
            return payload
    raise AssertionError(f"no {kind} message")


def test_hello_sends_schema_state_mask(setup):
    client, session, adata = setup
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello"}))
        schema = receive_until(ws, "schema")
        assert {c["name"] for c in schema["columns"]} >= {"total_counts", "sample"}
        state = receive_until(ws, "state")
        assert state["n_total"] == adata.n_obs
        header, (mask,) = receive_until(ws, "mask")
        assert mask.dtype == np.uint8 and mask.size == adata.n_obs


def test_filter_round_trip_produces_mask_and_coords(setup):
    client, session, adata = setup
    filters = [{"kind": "range", "column": "n_genes", "lo": 400, "hi": None}]
    expected = compute_mask(adata.obs, filters_from_json(filters))
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "set_filters", "filters": filters}))
        _, (mask,) = receive_until(ws, "mask", lambda p: p[0]["version"] >= 1)
        np.testing.assert_array_equal(mask.astype(bool), expected)
        header, (idx, xy) = receive_until(ws, "coords")
        assert header["embedding"] == "umap"
        assert expected[idx].all() and idx.size == min(40, int(expected.sum()))
        assert xy.shape == (idx.size, 2)
        state = receive_until(ws, "state", lambda s: s["status"]["state"] == "idle")
        assert state["n_selected"] == int(expected.sum())

        ws.send_text(json.dumps({"type": "compute", "mode": "full"}))
        header, (idx, _) = receive_until(ws, "coords", lambda p: p[0]["mode"] == "full")
        assert idx.size == int(expected.sum()) and header["current"]


def test_get_column_category_and_numeric(setup):
    client, session, adata = setup
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "get_column", "column": "sample"}))
        header, (codes,) = receive_until(ws, "column")
        assert header["kind"] == "category"
        cats = header["categories"]
        decoded = [cats[c] if c != MISSING_CODE else None for c in codes]
        assert decoded == adata.obs["sample"].astype(str).tolist()
        ws.send_text(json.dumps({"type": "get_column", "column": "total_counts"}))
        header, (values,) = receive_until(ws, "column")
        assert header["kind"] == "numeric" and values.dtype == np.float32
        np.testing.assert_allclose(values, adata.obs["total_counts"].to_numpy(), equal_nan=True)


def test_errors_are_reported_not_fatal(setup):
    client, *_ = setup
    with client.websocket_connect("/ws") as ws:
        ws.send_text(
            json.dumps({"type": "set_filters", "filters": [{"kind": "range", "column": "x"}]})
        )
        err = receive_until(ws, "error")
        assert "x" in err["message"]
        ws.send_text("not json")
        receive_until(ws, "error")
        ws.send_text(json.dumps({"type": "get_code"}))
        code = receive_until(ws, "code")
        assert "mask" in code["code"]


def test_http_endpoints_and_export(setup, tmp_path):
    client, session, adata = setup
    assert client.get("/api/schema").json()["n_obs"] == adata.n_obs
    assert client.get("/api/state").json()["n_total"] == adata.n_obs
    assert client.get("/api/filters.json").json() == []
    assert "np.ones" in client.get("/api/filters.py").text
    out = client.post("/api/export", json={"path": str(tmp_path / "x.h5ad")}).json()
    assert out["n_obs"] == adata.n_obs
    assert ad.read_h5ad(out["path"]).n_obs == adata.n_obs

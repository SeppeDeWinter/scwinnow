"""FastAPI frontend: serves the UI bundle and relays ``scwinnow.messages`` over a websocket."""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
from contextlib import asynccontextmanager, suppress
from importlib.resources import files
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
)
from pydantic import BaseModel
from starlette.background import BackgroundTask

from scwinnow.messages import MessageHandler
from scwinnow.session import Session

STATIC = files("scwinnow") / "static"
Outgoing = dict[str, Any] | bytes


class _Client:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[Outgoing | None] = asyncio.Queue()

    def put(self, item: Outgoing | None) -> None:
        self.queue.put_nowait(item)

    async def pump(self) -> None:
        while (item := await self.queue.get()) is not None:
            if isinstance(item, bytes):
                await self.ws.send_bytes(item)
            else:
                await self.ws.send_text(json.dumps(item))


class _Hub:
    """Fans session events out to all connected clients on the server event loop."""

    def __init__(self, handler: MessageHandler) -> None:
        self.handler = handler
        self.clients: set[_Client] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.mask_version = -1

    def on_event(self, kind: str, payload: Any) -> None:
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._broadcast, kind, payload)

    def _broadcast(self, kind: str, payload: Any) -> None:
        msgs, self.mask_version = self.handler.event_messages(kind, payload, self.mask_version)
        for client in self.clients:
            for m in msgs:
                client.put(m)


class ExportRequest(BaseModel):
    path: str


def _asset(name: str, media_type: str) -> Response:
    resource = STATIC / name
    if not resource.is_file():
        return PlainTextResponse(
            f"{name} missing: build the UI with `npm --prefix js run build`", 500
        )
    return Response(resource.read_bytes(), media_type=media_type)


def create_app(session: Session) -> FastAPI:
    handler = MessageHandler(session)
    hub = _Hub(handler)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        hub.loop = asyncio.get_running_loop()
        hub.mask_version = session.mask_version
        unsubscribe = session.subscribe(hub.on_event)
        try:
            yield
        finally:
            unsubscribe()
            hub.loop = None

    app = FastAPI(title="scwinnow", lifespan=lifespan)
    app.state.session = session
    app.state.handler = handler

    @app.get("/", response_class=HTMLResponse)
    def index() -> Response:
        return _asset("index.html", "text/html")

    @app.get("/app.js")
    def app_js() -> Response:
        return _asset("app.js", "text/javascript")

    @app.get("/app.css")
    def app_css() -> Response:
        return _asset("app.css", "text/css")

    @app.get("/api/schema")
    def schema() -> JSONResponse:
        return JSONResponse(handler.schema)

    @app.get("/api/state")
    def state() -> JSONResponse:
        return JSONResponse(session.state())

    @app.get("/api/filters.json")
    def filters_json() -> JSONResponse:
        return JSONResponse(session.state()["filters"])

    @app.get("/api/filters.py", response_class=PlainTextResponse)
    def filters_py() -> str:
        return session.filters_code()

    @app.post("/api/export")
    async def export(req: ExportRequest) -> JSONResponse:
        return JSONResponse(await run_in_threadpool(session.export, req.path))

    @app.get("/api/filtered.h5ad")
    async def filtered_h5ad() -> FileResponse:
        tmpdir = tempfile.mkdtemp(prefix="scwinnow-")
        path = Path(tmpdir) / "filtered.h5ad"
        await run_in_threadpool(session.export, path)
        return FileResponse(
            path,
            media_type="application/x-hdf5",
            filename="filtered.h5ad",
            background=BackgroundTask(shutil.rmtree, tmpdir, ignore_errors=True),
        )

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        client = _Client(ws)
        loop = asyncio.get_running_loop()

        def reply_threadsafe(item: Outgoing) -> None:
            loop.call_soon_threadsafe(client.put, item)

        hub.clients.add(client)
        pump = asyncio.create_task(client.pump())
        try:
            while True:
                text = await ws.receive_text()
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    client.put({"type": "error", "message": "invalid JSON"})
                    continue
                if msg.get("type") == "export":
                    await run_in_threadpool(handler.handle, msg, reply_threadsafe)
                else:
                    handler.handle(msg, client.put)
        except WebSocketDisconnect:
            pass
        finally:
            hub.clients.discard(client)
            client.put(None)
            with suppress(Exception):
                await pump

    return app

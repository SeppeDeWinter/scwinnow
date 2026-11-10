// Transports deliver JSON messages and decoded binary frames to the UI.
// Interface: send(obj), onMessage(cb(obj)), onFrame(cb({header, arrays})), onStatus(cb(str)).

import { decodeFrame } from "./frame.js";

class Emitter {
  constructor() {
    this.messageCbs = [];
    this.frameCbs = [];
    this.statusCbs = [];
  }
  onMessage(cb) { this.messageCbs.push(cb); }
  onFrame(cb) { this.frameCbs.push(cb); }
  onStatus(cb) { this.statusCbs.push(cb); }
  emitMessage(m) { for (const cb of this.messageCbs) cb(m); }
  emitFrame(f) { for (const cb of this.frameCbs) cb(f); }
  emitStatus(s) { for (const cb of this.statusCbs) cb(s); }
}

export class WebSocketTransport extends Emitter {
  constructor(url) {
    super();
    this.url = url;
    this.queue = [];
    this.retry = 500;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.emitStatus("connected");
      ws.send(JSON.stringify({ type: "hello" }));
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.emitMessage(JSON.parse(ev.data));
      else this.emitFrame(decodeFrame(ev.data));
    };
    ws.onclose = () => {
      this.emitStatus("disconnected");
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10000);
    };
  }

  send(obj) {
    const text = JSON.stringify(obj);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
  }
}

// anywidget: JSON travels as custom messages; frames as {type: "frame"} + one buffer.
export class AnyWidgetTransport extends Emitter {
  constructor(model) {
    super();
    this.model = model;
    model.on("msg:custom", (msg, buffers) => {
      if (msg && msg.type === "frame" && buffers && buffers.length) {
        const b = buffers[0];
        const ab = b instanceof DataView ? b.buffer : b.buffer ?? b;
        this.emitFrame(decodeFrame(ab, b.byteOffset ?? 0));
      } else {
        this.emitMessage(msg);
      }
    });
    queueMicrotask(() => {
      this.emitStatus("connected");
      this.send({ type: "hello" });
    });
  }

  send(obj) { this.model.send(obj); }
}

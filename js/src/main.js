import { mountApp } from "./app.js";
import { WebSocketTransport } from "./transport.js";

const proto = location.protocol === "https:" ? "wss:" : "ws:";
const base = location.pathname.replace(/[^/]*$/, "");
mountApp(document.getElementById("app"), new WebSocketTransport(`${proto}//${location.host}${base}ws`));

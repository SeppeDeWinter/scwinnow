// anywidget entry point: same UI over the widget comm.
import { mountApp } from "./app.js";
import { AnyWidgetTransport } from "./transport.js";

export default {
  render({ model, el }) {
    const root = document.createElement("div");
    root.style.height = `${model.get("height") || 900}px`;
    el.append(root);
    mountApp(root, new AnyWidgetTransport(model));
  },
};

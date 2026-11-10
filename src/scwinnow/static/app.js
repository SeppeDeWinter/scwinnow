// src/colors.js
function rgba(r, g, b, a = 255) {
  return (a << 24 | b << 16 | g << 8 | r) >>> 0;
}
function hex(h2) {
  const n = parseInt(h2.slice(1), 16);
  return rgba(n >> 16 & 255, n >> 8 & 255, n & 255);
}
var CATEGORICAL = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#aec7e8",
  "#ffbb78",
  "#98df8a",
  "#ff9896",
  "#c5b0d5",
  "#c49c94",
  "#f7b6d2",
  "#dbdb8d",
  "#9edae5",
  "#393b79"
].map(hex);
var CATEGORICAL_CSS = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#aec7e8",
  "#ffbb78",
  "#98df8a",
  "#ff9896",
  "#c5b0d5",
  "#c49c94",
  "#f7b6d2",
  "#dbdb8d",
  "#9edae5",
  "#393b79"
];
function categoryColor(code) {
  return CATEGORICAL[code % CATEGORICAL.length];
}
function categoryCss(code) {
  return CATEGORICAL_CSS[code % CATEGORICAL_CSS.length];
}
var VIRIDIS = [
  [68, 1, 84],
  [71, 44, 122],
  [59, 81, 139],
  [44, 113, 142],
  [33, 144, 141],
  [39, 173, 129],
  [92, 200, 99],
  [170, 220, 50],
  [253, 231, 37]
];
var VIRIDIS_LUT = (() => {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (VIRIDIS.length - 1);
    const k = Math.min(Math.floor(t), VIRIDIS.length - 2);
    const f = t - k;
    const [r0, g0, b0] = VIRIDIS[k];
    const [r1, g1, b1] = VIRIDIS[k + 1];
    lut[i] = rgba(
      Math.round(r0 + f * (r1 - r0)),
      Math.round(g0 + f * (g1 - g0)),
      Math.round(b0 + f * (b1 - b0))
    );
  }
  return lut;
})();
function viridisCss(t) {
  const c = VIRIDIS_LUT[Math.max(0, Math.min(255, Math.round(t * 255)))];
  return `rgb(${c & 255},${c >> 8 & 255},${c >> 16 & 255})`;
}
var DEFAULT_POINT = rgba(52, 101, 164);
var MUTED_POINT = rgba(200, 200, 200);
var MUTED_POINT_DARK = rgba(70, 70, 70);
var MISSING_POINT = rgba(150, 150, 150);
function robustRange(values) {
  const finite = [];
  const step = Math.max(1, Math.floor(values.length / 2e4));
  for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i])) finite.push(values[i]);
  if (!finite.length) return [0, 1];
  finite.sort((a, b) => a - b);
  const lo = finite[Math.floor(0.01 * (finite.length - 1))];
  const hi = finite[Math.ceil(0.99 * (finite.length - 1))];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

// src/filters.js
function normalizeRange(lo, hi, min, max) {
  let a = lo == null || Number.isNaN(lo) ? null : lo;
  let b = hi == null || Number.isNaN(hi) ? null : hi;
  if (a != null && b != null && a > b) [a, b] = [b, a];
  if (a != null && min != null && a <= min) a = null;
  if (b != null && max != null && b >= max) b = null;
  return [a, b];
}
function rangeFilter(column, lo, hi, min, max) {
  const [a, b] = normalizeRange(lo, hi, min, max);
  return a == null && b == null ? null : { kind: "range", column, lo: a, hi: b };
}
function categoryFilter(column, keep, allLabels) {
  const set = new Set(keep);
  if (allLabels.every((l) => set.has(l))) return null;
  return { kind: "category", column, keep: [...set].sort() };
}
function boolFilter(column, value) {
  return value == null ? null : { kind: "bool", column, value: !!value };
}
function withFilter(draft, column, filter) {
  const next = new Map(draft);
  if (filter == null) next.delete(column);
  else next.set(column, filter);
  return next;
}
function draftToList(draft) {
  return [...draft.values()];
}
function listToDraft(list) {
  return new Map(list.map((f) => [f.column, f]));
}
function canon(f) {
  if (f.kind === "category") return JSON.stringify([f.kind, f.column, [...f.keep].sort()]);
  if (f.kind === "range") return JSON.stringify([f.kind, f.column, f.lo ?? null, f.hi ?? null]);
  return JSON.stringify([f.kind, f.column, f.value]);
}
function sameFilters(a, b) {
  if (a.length !== b.length) return false;
  const sa = a.map(canon).sort();
  const sb = b.map(canon).sort();
  return sa.every((v, i) => v === sb[i]);
}
function describe(f, fmt2 = String) {
  if (f.kind === "range") {
    if (f.lo != null && f.hi != null) return `${fmt2(f.lo)} \u2264 ${f.column} \u2264 ${fmt2(f.hi)}`;
    if (f.lo != null) return `${f.column} \u2265 ${fmt2(f.lo)}`;
    return `${f.column} \u2264 ${fmt2(f.hi)}`;
  }
  if (f.kind === "bool") return `${f.column} = ${f.value}`;
  const shown = f.keep.slice(0, 3).join(", ");
  const more = f.keep.length > 3 ? ` +${f.keep.length - 3}` : "";
  return `${f.column} \u2208 {${shown}${more}}`;
}

// src/scatter.js
var slog = (v) => Math.sign(v) * Math.log10(1 + Math.abs(v));
var islog = (t) => Math.sign(t) * (10 ** Math.abs(t) - 1);
function fmt(v) {
  if (v == null || !Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1);
  if (a >= 100 || Number.isInteger(v)) return String(Math.round(v * 10) / 10);
  return v.toPrecision(3);
}
function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(t);
  return ticks;
}
function logTicks(lo, hi) {
  const out = [];
  if (lo <= 0 && hi >= 0) out.push(0);
  for (let k = 0; k <= 12; k++) {
    const t = slog(10 ** k);
    if (t >= lo && t <= hi) out.push(t);
  }
  return out.length >= 2 ? out : niceTicks(lo, hi);
}
function extent(values, pad = 0.03) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi === lo) return [lo - 0.5, hi + 0.5];
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}
var ScatterPanel = class {
  /**
   * @param {HTMLElement} parent
   * @param {{axes?: boolean, onThreshold?: (axis: "x"|"y", side: "lo"|"hi", value: number|null) => void}} opts
   */
  constructor(parent, opts = {}) {
    this.opts = opts;
    this.el = document.createElement("div");
    this.el.className = "panel";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "panel-title";
    this.canvas = document.createElement("canvas");
    this.el.append(this.titleEl, this.canvas);
    parent.append(this.el);
    this.ctx = this.canvas.getContext("2d");
    this.spec = null;
    this.image = null;
    this.drag = null;
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.canvas);
    if (opts.onThreshold) this.bindDrag();
  }
  destroy() {
    this.ro.disconnect();
    this.el.remove();
  }
  setTitle(text) {
    this.titleEl.textContent = text;
  }
  /**
   * spec: {n, x(k), y(k), color: Uint32Array(n), layer: Uint8Array(n) (0 hidden, 1 muted, 2 shown),
   *        bounds: [x0, x1, y0, y1], equal?: bool, pointSize, axes?: {xlabel, ylabel, logX, logY},
   *        thresholds?: {x: [lo, hi], y: [lo, hi]} in transformed units, null = open}
   */
  draw(spec) {
    this.spec = spec;
    this.render();
  }
  geometry() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h2 = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const axes = !!(this.spec && this.spec.axes);
    const m = axes ? { l: 52 * dpr, r: 10 * dpr, t: 8 * dpr, b: 34 * dpr } : { l: 6 * dpr, r: 6 * dpr, t: 6 * dpr, b: 6 * dpr };
    let [x0, x1, y0, y1] = this.spec ? this.spec.bounds : [0, 1, 0, 1];
    const pw = w - m.l - m.r;
    const ph = h2 - m.t - m.b;
    if (this.spec && this.spec.equal) {
      const sx = (x1 - x0) / pw;
      const sy = (y1 - y0) / ph;
      const s = Math.max(sx, sy);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      x0 = cx - s * pw / 2;
      x1 = cx + s * pw / 2;
      y0 = cy - s * ph / 2;
      y1 = cy + s * ph / 2;
    }
    return { dpr, w, h: h2, m, pw, ph, x0, x1, y0, y1 };
  }
  toPx(g, x, y) {
    return [g.m.l + (x - g.x0) / (g.x1 - g.x0) * g.pw, g.m.t + (1 - (y - g.y0) / (g.y1 - g.y0)) * g.ph];
  }
  fromPx(g, px, py) {
    return [g.x0 + (px - g.m.l) / g.pw * (g.x1 - g.x0), g.y0 + (1 - (py - g.m.t) / g.ph) * (g.y1 - g.y0)];
  }
  render() {
    const spec = this.spec;
    const g = this.geometry();
    if (this.canvas.width !== g.w || this.canvas.height !== g.h) {
      this.canvas.width = g.w;
      this.canvas.height = g.h;
    }
    this.g = g;
    if (!spec) {
      this.ctx.clearRect(0, 0, g.w, g.h);
      return;
    }
    this.image = this.rasterise(spec, g);
    this.paint();
  }
  rasterise(spec, g) {
    const img = this.ctx.createImageData(g.w, g.h);
    const buf = new Uint32Array(img.data.buffer);
    const s = Math.max(1, Math.round((spec.pointSize || 2) * g.dpr));
    const half = s >> 1;
    const sx = g.pw / (g.x1 - g.x0);
    const sy = g.ph / (g.y1 - g.y0);
    const xmin = Math.ceil(g.m.l);
    const xmax = Math.floor(g.m.l + g.pw) - s;
    const ymin = Math.ceil(g.m.t);
    const ymax = Math.floor(g.m.t + g.ph) - s;
    const W = g.w;
    for (const pass of [1, 2]) {
      for (let k = 0; k < spec.n; k++) {
        if (spec.layer[k] !== pass) continue;
        const x = spec.x(k);
        const y = spec.y(k);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const px = Math.round(g.m.l + (x - g.x0) * sx) - half;
        const py = Math.round(g.m.t + (g.y1 - y) * sy) - half;
        if (px < xmin || px > xmax || py < ymin || py > ymax) continue;
        const c = spec.color[k];
        let row = py * W + px;
        for (let dy = 0; dy < s; dy++, row += W) for (let dx = 0; dx < s; dx++) buf[row + dx] = c;
      }
    }
    return img;
  }
  paint() {
    const { ctx, g, spec } = this;
    if (!spec || !this.image) return;
    ctx.putImageData(this.image, 0, 0);
    if (spec.axes) this.paintAxes(spec.axes);
    if (spec.thresholds) this.paintThresholds(this.currentThresholds());
  }
  cssVar(name, fallback) {
    const v = getComputedStyle(this.el).getPropertyValue(name).trim();
    return v || fallback;
  }
  paintAxes(axes) {
    const { ctx, g } = this;
    const fg = this.cssVar("--fg-muted", "#666");
    ctx.save();
    ctx.strokeStyle = fg;
    ctx.fillStyle = fg;
    ctx.lineWidth = g.dpr;
    ctx.font = `${11 * g.dpr}px system-ui, sans-serif`;
    ctx.strokeRect(g.m.l, g.m.t, g.pw, g.ph);
    const xt = axes.logX ? logTicks(g.x0, g.x1) : niceTicks(g.x0, g.x1);
    const yt = axes.logY ? logTicks(g.y0, g.y1) : niceTicks(g.y0, g.y1);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of xt) {
      const [px] = this.toPx(g, t, g.y0);
      if (px < g.m.l - 1 || px > g.m.l + g.pw + 1) continue;
      ctx.beginPath();
      ctx.moveTo(px, g.m.t + g.ph);
      ctx.lineTo(px, g.m.t + g.ph + 4 * g.dpr);
      ctx.stroke();
      ctx.fillText(fmt(axes.logX ? islog(t) : t), px, g.m.t + g.ph + 6 * g.dpr);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of yt) {
      const [, py] = this.toPx(g, g.x0, t);
      if (py < g.m.t - 1 || py > g.m.t + g.ph + 1) continue;
      ctx.beginPath();
      ctx.moveTo(g.m.l - 4 * g.dpr, py);
      ctx.lineTo(g.m.l, py);
      ctx.stroke();
      ctx.fillText(fmt(axes.logY ? islog(t) : t), g.m.l - 6 * g.dpr, py);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(axes.xlabel || "", g.m.l + g.pw / 2, g.h - 1 * g.dpr);
    ctx.translate(11 * g.dpr, g.m.t + g.ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "top";
    ctx.fillText(axes.ylabel || "", 0, -10 * g.dpr);
    ctx.restore();
  }
  currentThresholds() {
    const t = this.spec.thresholds;
    if (!this.drag) return t;
    const copy = { x: [...t.x], y: [...t.y] };
    copy[this.drag.axis][this.drag.side === "lo" ? 0 : 1] = this.drag.value;
    return copy;
  }
  // Positions (px) of the four threshold lines; open sides sit on the plot edge.
  linePositions(th) {
    const g = this.g;
    const [xlo, xhi] = th.x;
    const [ylo, yhi] = th.y;
    const px = (v, edge) => v == null ? edge : this.toPx(g, v, 0)[0];
    const py = (v, edge) => v == null ? edge : this.toPx(g, 0, v)[1];
    return {
      xlo: px(xlo, g.m.l),
      xhi: px(xhi, g.m.l + g.pw),
      ylo: py(ylo, g.m.t + g.ph),
      yhi: py(yhi, g.m.t)
    };
  }
  paintThresholds(th) {
    const { ctx, g } = this;
    const L = this.linePositions(th);
    const accent = this.cssVar("--accent", "#d33");
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const xlo = clamp(L.xlo, g.m.l, g.m.l + g.pw);
    const xhi = clamp(L.xhi, g.m.l, g.m.l + g.pw);
    const ylo = clamp(L.ylo, g.m.t, g.m.t + g.ph);
    const yhi = clamp(L.yhi, g.m.t, g.m.t + g.ph);
    ctx.save();
    ctx.fillStyle = "rgba(128,128,128,0.18)";
    ctx.fillRect(g.m.l, g.m.t, xlo - g.m.l, g.ph);
    ctx.fillRect(xhi, g.m.t, g.m.l + g.pw - xhi, g.ph);
    ctx.fillRect(xlo, g.m.t, xhi - xlo, yhi - g.m.t);
    ctx.fillRect(xlo, ylo, xhi - xlo, g.m.t + g.ph - ylo);
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = 1.5 * g.dpr;
    const h2 = 7 * g.dpr;
    const vline = (x, open) => {
      ctx.setLineDash(open ? [3 * g.dpr, 3 * g.dpr] : []);
      ctx.globalAlpha = open ? 0.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, g.m.t);
      ctx.lineTo(x, g.m.t + g.ph);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - h2, g.m.t + g.ph);
      ctx.lineTo(x + h2, g.m.t + g.ph);
      ctx.lineTo(x, g.m.t + g.ph - h2);
      ctx.fill();
    };
    const hline = (y, open) => {
      ctx.setLineDash(open ? [3 * g.dpr, 3 * g.dpr] : []);
      ctx.globalAlpha = open ? 0.5 : 1;
      ctx.beginPath();
      ctx.moveTo(g.m.l, y);
      ctx.lineTo(g.m.l + g.pw, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(g.m.l, y - h2);
      ctx.lineTo(g.m.l, y + h2);
      ctx.lineTo(g.m.l + h2, y);
      ctx.fill();
    };
    vline(xlo, th.x[0] == null);
    vline(xhi, th.x[1] == null);
    hline(ylo, th.y[0] == null);
    hline(yhi, th.y[1] == null);
    ctx.restore();
  }
  bindDrag() {
    const c = this.canvas;
    const pos = (ev) => {
      const r = c.getBoundingClientRect();
      const dpr = this.g ? this.g.dpr : 1;
      return [(ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr];
    };
    const pick = (px, py) => {
      if (!this.spec || !this.spec.thresholds || !this.g) return null;
      const L = this.linePositions(this.spec.thresholds);
      const tol = 8 * this.g.dpr;
      const cands = [
        ["x", "lo", Math.abs(px - L.xlo)],
        ["x", "hi", Math.abs(px - L.xhi)],
        ["y", "lo", Math.abs(py - L.ylo)],
        ["y", "hi", Math.abs(py - L.yhi)]
      ].filter((d) => d[2] <= tol);
      cands.sort((a, b) => a[2] - b[2]);
      return cands.length ? { axis: cands[0][0], side: cands[0][1] } : null;
    };
    c.addEventListener("pointermove", (ev) => {
      const [px, py] = pos(ev);
      if (this.drag) {
        const [x, y] = this.fromPx(this.g, px, py);
        this.drag.value = this.drag.axis === "x" ? x : y;
        this.paint();
        return;
      }
      const hit = pick(px, py);
      c.style.cursor = hit ? hit.axis === "x" ? "ew-resize" : "ns-resize" : "default";
    });
    c.addEventListener("pointerdown", (ev) => {
      const [px, py] = pos(ev);
      const hit = pick(px, py);
      if (!hit) return;
      c.setPointerCapture(ev.pointerId);
      const [x, y] = this.fromPx(this.g, px, py);
      this.drag = { ...hit, value: hit.axis === "x" ? x : y };
      ev.preventDefault();
    });
    const end = (ev) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (c.hasPointerCapture(ev.pointerId)) c.releasePointerCapture(ev.pointerId);
      const g = this.g;
      const [px, py] = pos(ev);
      const outside = d.axis === "x" ? d.side === "lo" && px <= g.m.l || d.side === "hi" && px >= g.m.l + g.pw : d.side === "lo" && py >= g.m.t + g.ph || d.side === "hi" && py <= g.m.t;
      this.opts.onThreshold(d.axis, d.side, outside ? null : d.value);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }
};

// src/app.js
var MISSING_CODE = 65535;
var SEND_DELAY_MS = 300;
var EMBEDDING_LABEL = { umap: "UMAP", tsne: "tSNE" };
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "value" || k === "disabled" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}
var nf = new Intl.NumberFormat("en-US");
function isDark() {
  const cls = document.body ? document.body.classList : null;
  if (cls && (cls.contains("vscode-dark") || cls.contains("vscode-high-contrast"))) return true;
  if (cls && cls.contains("vscode-light")) return false;
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
function mountApp(root, transport) {
  const S = {
    schema: null,
    state: null,
    mask: null,
    coords: {},
    columns: /* @__PURE__ */ new Map(),
    requested: /* @__PURE__ */ new Set(),
    draft: /* @__PURE__ */ new Map(),
    localVersion: 0,
    sentVersion: 0,
    sentList: null,
    sendTimer: null,
    cards: /* @__PURE__ */ new Map(),
    ui: {
      colorBy: "",
      splitBy: "",
      qcX: "",
      qcY: "",
      logX: false,
      logY: false,
      pointSize: 2,
      showContext: true,
      search: ""
    }
  };
  root.classList.add("scw");
  const statusBadge = h("span", { class: "badge" }, "connecting");
  const countEl = h("span", { class: "count" });
  const resultEl = h("span", { class: "result" });
  const autoBox = h("input", {
    type: "checkbox",
    checked: true,
    onchange: () => transport.send({ type: "set_auto", auto: autoBox.checked })
  });
  const fullBtn = h(
    "button",
    { class: "primary", onclick: () => transport.send({ type: "compute", mode: "full" }) },
    "Compute on all cells"
  );
  const previewBtn = h(
    "button",
    { onclick: () => transport.send({ type: "compute", mode: "preview" }) },
    "Recompute preview"
  );
  const exportBtn = h("button", { onclick: () => doExport() }, "Export h5ad");
  const codeBtn = h("button", { onclick: () => transport.send({ type: "get_code" }) }, "Code");
  const header = h(
    "header",
    {},
    h("span", { class: "brand" }, "scwinnow"),
    countEl,
    statusBadge,
    resultEl,
    h("span", { class: "spacer" }),
    h("label", { class: "toggle", title: "Recompute a preview after every change" }, autoBox, "auto"),
    previewBtn,
    fullBtn,
    exportBtn,
    codeBtn
  );
  const chipsEl = h("div", { class: "chips" });
  const searchEl = h("input", {
    type: "search",
    placeholder: "Search obs columns\u2026",
    oninput: () => {
      S.ui.search = searchEl.value.toLowerCase();
      for (const [name, card] of S.cards) card.el.hidden = !name.toLowerCase().includes(S.ui.search);
    }
  });
  const cardsEl = h("div", { class: "cards" });
  const paramsEl = h("div", { class: "params" });
  const sidebar = h(
    "aside",
    {},
    h("h3", {}, "Filters"),
    chipsEl,
    searchEl,
    cardsEl,
    h("h3", {}, "Embedding"),
    paramsEl
  );
  const colorSel = h("select", { onchange: () => setUi({ colorBy: colorSel.value }) });
  const splitSel = h("select", { onchange: () => setUi({ splitBy: splitSel.value }) });
  const sizeInput = h("input", {
    type: "range",
    min: 1,
    max: 6,
    step: 1,
    value: 2,
    oninput: () => setUi({ pointSize: Number(sizeInput.value) })
  });
  const contextBox = h("input", {
    type: "checkbox",
    checked: true,
    onchange: () => setUi({ showContext: contextBox.checked })
  });
  const toolbar = h(
    "div",
    { class: "toolbar" },
    h("label", {}, "color ", colorSel),
    h("label", {}, "split by ", splitSel),
    h("label", {}, "point ", sizeInput),
    h("label", { class: "toggle", title: "Draw filtered-out / other-facet cells in grey" }, contextBox, "context")
  );
  const legendEl = h("div", { class: "legend" });
  const embGrid = h("div", { class: "grid emb" });
  const qcXSel = h("select", { onchange: () => setUi({ qcX: qcXSel.value }) });
  const qcYSel = h("select", { onchange: () => setUi({ qcY: qcYSel.value }) });
  const logXBox = h("input", { type: "checkbox", onchange: () => setUi({ logX: logXBox.checked }) });
  const logYBox = h("input", { type: "checkbox", onchange: () => setUi({ logY: logYBox.checked }) });
  const qcGrid = h("div", { class: "grid qc" });
  const qcSection = h(
    "section",
    {},
    h(
      "div",
      { class: "toolbar" },
      h("strong", {}, "QC scatter"),
      h("label", {}, "x ", qcXSel),
      h("label", { class: "toggle" }, logXBox, "log"),
      h("label", {}, "y ", qcYSel),
      h("label", { class: "toggle" }, logYBox, "log"),
      h("span", { class: "hint" }, "drag the red lines to set thresholds")
    ),
    qcGrid
  );
  const main = h("main", {}, toolbar, legendEl, embGrid, qcSection);
  const toastEl = h("div", { class: "toast", hidden: true });
  const modalEl = h("div", { class: "modal", hidden: true, onclick: (e) => e.target === modalEl && (modalEl.hidden = true) });
  root.append(header, h("div", { class: "body" }, sidebar, main), toastEl, modalEl);
  function toast(text, isError = false) {
    toastEl.textContent = text;
    toastEl.classList.toggle("error", isError);
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => toastEl.hidden = true, isError ? 6e3 : 3e3);
  }
  function showModal(title, body) {
    modalEl.replaceChildren(
      h("div", { class: "modal-box" }, h(
        "div",
        { class: "modal-head" },
        h("strong", {}, title),
        h("button", { onclick: () => modalEl.hidden = true }, "\xD7")
      ), body)
    );
    modalEl.hidden = false;
  }
  function doExport() {
    const path = window.prompt("Write filtered AnnData to (path on the server):", "filtered.h5ad");
    if (path) {
      transport.send({ type: "export", path });
      toast(`exporting to ${path}\u2026`);
    }
  }
  function col(name) {
    return S.schema ? S.schema.columns.find((c) => c.name === name) : null;
  }
  function need(name) {
    if (!name || S.columns.has(name) || S.requested.has(name)) return;
    S.requested.add(name);
    transport.send({ type: "get_column", column: name });
  }
  function columnData(name) {
    return name ? S.columns.get(name) : null;
  }
  function setFilter(column, filter) {
    S.draft = withFilter(S.draft, column, filter);
    S.localVersion++;
    renderChips();
    S.cards.get(column)?.update();
    invalidate();
    clearTimeout(S.sendTimer);
    S.sendTimer = setTimeout(sendFilters, SEND_DELAY_MS);
  }
  function sendFilters() {
    S.sentVersion = S.localVersion;
    S.sentList = draftToList(S.draft);
    transport.send({ type: "set_filters", filters: S.sentList });
  }
  function hasUnsyncedEdits() {
    return S.localVersion !== S.sentVersion || S.sentList !== null;
  }
  function renderChips() {
    const list = draftToList(S.draft);
    chipsEl.replaceChildren(
      ...list.length ? list.map(
        (f) => h(
          "span",
          { class: "chip", title: describe(f, fmt) },
          describe(f, fmt),
          h("button", { onclick: () => setFilter(f.column, null), title: "remove" }, "\xD7")
        )
      ) : [h("span", { class: "muted" }, "no filters \u2014 all cells selected")],
      list.length ? h("button", { class: "link", onclick: () => clearAll() }, "clear all") : null
    );
  }
  function clearAll() {
    const cols = [...S.draft.keys()];
    S.draft = /* @__PURE__ */ new Map();
    S.localVersion++;
    renderChips();
    for (const c of cols) S.cards.get(c)?.update();
    invalidate();
    clearTimeout(S.sendTimer);
    S.sendTimer = setTimeout(sendFilters, SEND_DELAY_MS);
  }
  function numericCard(c) {
    const canvas = h("canvas", { class: "hist" });
    const loIn = h("input", { type: "number", step: "any", placeholder: fmt(c.min) });
    const hiIn = h("input", { type: "number", step: "any", placeholder: fmt(c.max) });
    const commitInputs = () => {
      const lo = loIn.value === "" ? null : Number(loIn.value);
      const hi = hiIn.value === "" ? null : Number(hiIn.value);
      setFilter(c.name, rangeFilter(c.name, lo, hi, c.min, c.max));
    };
    loIn.addEventListener("change", commitInputs);
    hiIn.addEventListener("change", commitInputs);
    const summary = h("span", { class: "summary" });
    const body = h(
      "div",
      { class: "card-body" },
      canvas,
      h(
        "div",
        { class: "range-inputs" },
        loIn,
        h("span", {}, "\u2013"),
        hiIn,
        h("button", { class: "link", onclick: () => setFilter(c.name, null) }, "reset")
      )
    );
    const el = h("details", { class: "card" }, h("summary", {}, h("span", { class: "name" }, c.name), summary), body);
    el.addEventListener("toggle", () => {
      if (el.open) {
        need(c.name);
        drawHist();
      }
    });
    let brush = null;
    const valueAt = (ev) => {
      const r = canvas.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      return c.min + t * (c.max - c.min);
    };
    canvas.addEventListener("pointerdown", (ev) => {
      canvas.setPointerCapture(ev.pointerId);
      brush = [valueAt(ev), valueAt(ev)];
      drawHist();
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!brush) return;
      brush[1] = valueAt(ev);
      drawHist();
    });
    canvas.addEventListener("pointerup", () => {
      if (!brush) return;
      const [a, b] = brush[0] <= brush[1] ? brush : [brush[1], brush[0]];
      brush = null;
      const span = c.max - c.min || 1;
      if (b - a < span * 5e-3) setFilter(c.name, null);
      else setFilter(c.name, rangeFilter(c.name, a, b, c.min, c.max));
    });
    function drawHist() {
      if (!el.open) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
      canvas.width = w;
      canvas.height = hgt;
      const ctx = canvas.getContext("2d");
      const counts = c.hist.counts;
      const edges = c.hist.edges;
      const nb = counts.length;
      const sel = selectedHist(c, edges);
      const maxCount = Math.max(1, ...counts);
      const sc = (v) => Math.sqrt(v / maxCount) * (hgt - 2);
      const bw = w / nb;
      const f = S.draft.get(c.name);
      const style = getComputedStyle(root);
      ctx.clearRect(0, 0, w, hgt);
      for (let i = 0; i < nb; i++) {
        ctx.fillStyle = style.getPropertyValue("--hist-bg").trim() || "#ccc";
        ctx.fillRect(i * bw, hgt - sc(counts[i]), Math.max(1, bw - 1), sc(counts[i]));
        if (sel) {
          ctx.fillStyle = style.getPropertyValue("--accent-2").trim() || "#36c";
          ctx.fillRect(i * bw, hgt - sc(sel[i]), Math.max(1, bw - 1), sc(sel[i]));
        }
      }
      const xOf = (v) => (v - c.min) / (c.max - c.min || 1) * w;
      let range = null;
      if (brush) range = brush[0] <= brush[1] ? brush : [brush[1], brush[0]];
      else if (f && f.kind === "range") range = [f.lo ?? c.min, f.hi ?? c.max];
      if (range) {
        ctx.fillStyle = "rgba(128,128,128,0.35)";
        ctx.fillRect(0, 0, xOf(range[0]), hgt);
        ctx.fillRect(xOf(range[1]), 0, w - xOf(range[1]), hgt);
        ctx.fillStyle = style.getPropertyValue("--accent").trim() || "#d33";
        ctx.fillRect(xOf(range[0]) - dpr, 0, 2 * dpr, hgt);
        ctx.fillRect(xOf(range[1]) - dpr, 0, 2 * dpr, hgt);
      }
    }
    function update() {
      const f = S.draft.get(c.name);
      summary.textContent = f ? describe(f, fmt).replace(c.name, "x") : "";
      el.classList.toggle("active", !!f);
      if (document.activeElement !== loIn) loIn.value = f && f.lo != null ? String(f.lo) : "";
      if (document.activeElement !== hiIn) hiIn.value = f && f.hi != null ? String(f.hi) : "";
      drawHist();
    }
    return { el, update, redraw: drawHist };
  }
  function selectedHist(c, edges) {
    const data = columnData(c.name);
    if (!data || !S.mask) return null;
    const nb = edges.length - 1;
    const out = new Array(nb).fill(0);
    const lo = edges[0];
    const span = edges[nb] - lo || 1;
    const v = data.values;
    for (let i = 0; i < v.length; i++) {
      if (!S.mask[i] || !Number.isFinite(v[i])) continue;
      out[Math.min(nb - 1, Math.max(0, Math.floor((v[i] - lo) / span * nb)))]++;
    }
    return out;
  }
  function categoryCard(c) {
    const labels = c.categories.map((x) => x.label);
    const summary = h("span", { class: "summary" });
    const filterIn = h("input", { type: "search", placeholder: "filter categories\u2026", hidden: labels.length <= 12 });
    const boxes = /* @__PURE__ */ new Map();
    const list = h(
      "div",
      { class: "cat-list" },
      c.categories.map((x, i) => {
        const box = h("input", { type: "checkbox", checked: true, onchange: () => commit() });
        boxes.set(x.label, box);
        return h(
          "label",
          { class: "cat", "data-label": x.label.toLowerCase() },
          box,
          h("span", { class: "swatch", style: `background:${categoryCss(i)}` }),
          h("span", { class: "cat-label" }, x.label),
          h("span", { class: "cat-count" }, nf.format(x.count))
        );
      })
    );
    filterIn.addEventListener("input", () => {
      const q = filterIn.value.toLowerCase();
      for (const lab of list.children) lab.hidden = !lab.dataset.label.includes(q);
    });
    const setAll = (fn) => {
      for (const [l, b] of boxes) b.checked = fn(l, b.checked);
      commit();
    };
    const commit = () => {
      const keep = labels.filter((l) => boxes.get(l).checked);
      setFilter(c.name, categoryFilter(c.name, keep, labels));
    };
    const body = h(
      "div",
      { class: "card-body" },
      filterIn,
      h(
        "div",
        { class: "cat-actions" },
        h("button", { class: "link", onclick: () => setAll(() => true) }, "all"),
        h("button", { class: "link", onclick: () => setAll(() => false) }, "none"),
        h("button", { class: "link", onclick: () => setAll((_, v) => !v) }, "invert")
      ),
      list
    );
    const el = h("details", { class: "card" }, h("summary", {}, h("span", { class: "name" }, c.name), summary), body);
    function update() {
      const f = S.draft.get(c.name);
      const keep = f && f.kind === "category" ? new Set(f.keep) : null;
      for (const [l, b] of boxes) b.checked = keep ? keep.has(l) : true;
      summary.textContent = keep ? `${keep.size} of ${labels.length}` : "";
      el.classList.toggle("active", !!f);
    }
    return { el, update, redraw() {
    } };
  }
  function boolCard(c) {
    const name = `bool-${c.name}`;
    const radios = ["any", "true", "false"].map((v) => h("label", {}, h("input", { type: "radio", name, value: v, onchange: () => {
      setFilter(c.name, boolFilter(c.name, v === "any" ? null : v === "true"));
    } }), ` ${v}`, v === "true" ? ` (${nf.format(c.n_true)})` : v === "false" ? ` (${nf.format(c.n_false)})` : ""));
    const summary = h("span", { class: "summary" });
    const el = h(
      "details",
      { class: "card" },
      h("summary", {}, h("span", { class: "name" }, c.name), summary),
      h("div", { class: "card-body bool" }, radios)
    );
    function update() {
      const f = S.draft.get(c.name);
      const v = f ? String(f.value) : "any";
      for (const r of radios) r.querySelector("input").checked = r.querySelector("input").value === v;
      summary.textContent = f ? `= ${f.value}` : "";
      el.classList.toggle("active", !!f);
    }
    return { el, update, redraw() {
    } };
  }
  function renderCards() {
    S.cards.clear();
    cardsEl.replaceChildren();
    for (const c of S.schema.columns) {
      const card = c.kind === "numeric" ? numericCard(c) : c.kind === "category" ? categoryCard(c) : boolCard(c);
      S.cards.set(c.name, card);
      cardsEl.append(card.el);
      card.update();
    }
  }
  const PARAM_FIELDS = [
    ["umap", "UMAP", "bool"],
    ["umap_min_dist", "min_dist", "number", "umap"],
    ["umap_warm_start", "warm start", "bool", "umap"],
    ["tsne", "tSNE", "bool"],
    ["tsne_perplexity", "perplexity", "number", "tsne"],
    ["tsne_learning_rate", "learning rate", "number", "tsne"],
    ["hvg_flavor", "HVG flavor", ["seurat", "cell_ranger", "seurat_v3"]],
    ["n_top_genes", "top genes", "int"],
    ["n_pcs", "PCs", "int"],
    ["n_neighbors", "neighbors", "int"]
  ];
  const paramInputs = /* @__PURE__ */ new Map();
  const previewIn = h("input", { type: "number", min: 100, step: 1e3 });
  function renderParams() {
    paramsEl.replaceChildren();
    for (const [key, label, kind, dep] of PARAM_FIELDS) {
      let input;
      if (kind === "bool") {
        input = h("input", { type: "checkbox", onchange: () => sendParam(key, input.checked) });
      } else if (Array.isArray(kind)) {
        input = h("select", { onchange: () => sendParam(key, input.value) }, kind.map((o) => h("option", { value: o }, o)));
      } else {
        input = h("input", {
          type: "number",
          step: kind === "int" ? 1 : "any",
          onchange: () => input.value !== "" && sendParam(key, Number(input.value))
        });
      }
      paramInputs.set(key, input);
      paramsEl.append(h("label", { class: `param${dep ? " sub" : ""}`, "data-dep": dep || "" }, h("span", {}, label), input));
    }
    previewIn.addEventListener("change", () => {
      const n = previewIn.value === "" ? null : Number(previewIn.value);
      transport.send({ type: "set_preview_max_cells", n });
    });
    paramsEl.append(h(
      "label",
      { class: "param", title: "Cells used for preview embeddings while filtering" },
      h("span", {}, "preview cells"),
      previewIn
    ));
  }
  function sendParam(key, value) {
    const p = S.state ? S.state.params : {};
    if (key === "umap" && !value && !p.tsne || key === "tsne" && !value && !p.umap) {
      toast("enable at least one of UMAP / tSNE", true);
      updateParams();
      return;
    }
    transport.send({ type: "set_params", params: { [key]: value } });
  }
  function updateParams() {
    const p = S.state.params;
    for (const [key, input] of paramInputs) {
      if (document.activeElement === input) continue;
      if (input.type === "checkbox") input.checked = !!p[key];
      else input.value = p[key];
    }
    for (const lab of paramsEl.querySelectorAll("label[data-dep]")) {
      const dep = lab.dataset.dep;
      lab.hidden = !!dep && !p[dep];
    }
    if (document.activeElement !== previewIn) previewIn.value = S.state.preview_max_cells ?? "";
  }
  function fillSelect(sel, options, value) {
    sel.replaceChildren(...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
    sel.value = value;
  }
  function renderSelects() {
    const cols = S.schema.columns;
    const numeric = cols.filter((c) => c.kind === "numeric").map((c) => [c.name, c.name]);
    const cats = cols.filter((c) => c.kind !== "numeric").map((c) => [c.name, c.name]);
    fillSelect(colorSel, [["", "\u2014"], ...cats, ...numeric], S.ui.colorBy);
    fillSelect(splitSel, [["", "none"], ...cats], S.ui.splitBy);
    fillSelect(qcXSel, numeric, S.ui.qcX);
    fillSelect(qcYSel, numeric, S.ui.qcY);
    qcSection.hidden = numeric.length < 1;
  }
  function pickDefaults() {
    const cols = S.schema.columns;
    const names = new Set(cols.map((c) => c.name));
    const numeric = cols.filter((c) => c.kind === "numeric").map((c) => c.name);
    const firstOf = (...cands) => cands.find((c) => names.has(c));
    S.ui.qcX = firstOf("total_counts", "n_counts", "nCount_RNA") || numeric[0] || "";
    S.ui.qcY = firstOf("n_genes_by_counts", "n_genes", "nFeature_RNA", "pct_counts_mt") || numeric.find((n) => n !== S.ui.qcX) || S.ui.qcX;
    const cat = cols.find((c) => c.kind === "category");
    S.ui.colorBy = cat ? cat.name : "";
    S.ui.logX = S.ui.qcX === "total_counts";
    S.ui.logY = S.ui.qcY === "n_genes_by_counts";
    logXBox.checked = S.ui.logX;
    logYBox.checked = S.ui.logY;
  }
  function setUi(changes) {
    Object.assign(S.ui, changes);
    need(S.ui.colorBy);
    need(S.ui.splitBy);
    need(S.ui.qcX);
    need(S.ui.qcY);
    rebuildPanels();
  }
  function colorer() {
    const data = columnData(S.ui.colorBy);
    if (!data) return () => DEFAULT_POINT;
    if (data.kind === "category") {
      const codes = data.codes;
      return (i) => codes[i] === MISSING_CODE ? MISSING_POINT : categoryColor(codes[i]);
    }
    const v = data.values;
    const [lo, hi] = data.range;
    const span = hi - lo || 1;
    return (i) => {
      const x = v[i];
      if (!Number.isFinite(x)) return MISSING_POINT;
      return VIRIDIS_LUT[Math.max(0, Math.min(255, Math.round((x - lo) / span * 255)))];
    };
  }
  function renderLegend() {
    const data = columnData(S.ui.colorBy);
    if (!data) {
      legendEl.replaceChildren();
      return;
    }
    if (data.kind === "category") {
      legendEl.replaceChildren(...data.categories.map((label, i) => h("span", { class: "legend-item" }, h("span", { class: "swatch", style: `background:${categoryCss(i)}` }), label)));
    } else {
      const stops = Array.from({ length: 11 }, (_, k) => viridisCss(k / 10)).join(",");
      legendEl.replaceChildren(
        h("span", {}, fmt(data.range[0])),
        h("span", { class: "gradient", style: `background:linear-gradient(90deg,${stops})` }),
        h("span", {}, fmt(data.range[1])),
        h("span", { class: "muted" }, ` ${S.ui.colorBy} (1st\u201399th pct)`)
      );
    }
  }
  let embPanels = [];
  let qcPanels = [];
  function facets() {
    const split = columnData(S.ui.splitBy);
    if (!S.ui.splitBy || !split || split.kind !== "category") return [{ code: -1, label: "" }];
    return split.categories.map((label, code) => ({ code, label }));
  }
  function rebuildPanels() {
    for (const p of [...embPanels, ...qcPanels]) p.panel.destroy();
    embPanels = [];
    qcPanels = [];
    if (!S.schema || !S.state) return;
    const fs = facets();
    const split = fs.length > 1;
    embGrid.classList.toggle("split", split);
    qcGrid.classList.toggle("split", split);
    const embs = Object.keys(EMBEDDING_LABEL).filter((e) => S.coords[e] || S.state.params[e]);
    for (const e of embs) {
      for (const f of fs) {
        const panel = new ScatterPanel(embGrid);
        embPanels.push({ panel, embedding: e, facet: f });
      }
    }
    for (const f of fs) {
      const panel = new ScatterPanel(qcGrid, { onThreshold });
      qcPanels.push({ panel, facet: f });
    }
    renderLegend();
    invalidate();
  }
  let frameReq = 0;
  function invalidate() {
    if (frameReq) return;
    frameReq = requestAnimationFrame(() => {
      frameReq = 0;
      drawAll();
    });
  }
  function drawAll() {
    if (!S.schema || !S.state) return;
    const colorOf = colorer();
    const split = columnData(S.ui.splitBy);
    const splitCodes = split && split.kind === "category" ? split.codes : null;
    const mask = S.mask;
    const muted = isDark() ? MUTED_POINT_DARK : MUTED_POINT;
    const ctxOn = S.ui.showContext;
    for (const { panel, embedding, facet } of embPanels) {
      const c = S.coords[embedding];
      const label = EMBEDDING_LABEL[embedding];
      if (!c) {
        panel.setTitle(`${label} \u2014 ${S.state.params[embedding] ? "computing\u2026" : "off"}`);
        panel.draw(null);
        continue;
      }
      const { idx, xy } = c;
      const n = idx.length;
      const color = new Uint32Array(n);
      const layer = new Uint8Array(n);
      let shown = 0;
      for (let k = 0; k < n; k++) {
        const i = idx[k];
        const inFacet = facet.code < 0 || splitCodes && splitCodes[i] === facet.code;
        const sel = !mask || mask[i];
        if (inFacet && sel) {
          layer[k] = 2;
          color[k] = colorOf(i);
          shown++;
        } else if (ctxOn) {
          layer[k] = 1;
          color[k] = muted;
        }
      }
      if (!c.bounds) {
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let k = 0; k < n; k++) {
          xs[k] = xy[2 * k];
          ys[k] = xy[2 * k + 1];
        }
        c.bounds = [...extent(xs), ...extent(ys)];
      }
      const tag = c.header.mode === "full" ? "all cells" : "preview";
      const stale = c.header.generation !== S.state.result?.generation || !S.state.result?.current;
      panel.setTitle(`${label}${facet.label ? ` \xB7 ${facet.label}` : ""} \u2014 ${nf.format(shown)} cells (${tag}${stale ? ", outdated" : ""})`);
      panel.el.classList.toggle("stale", stale);
      panel.draw({
        n,
        x: (k) => xy[2 * k],
        y: (k) => xy[2 * k + 1],
        color,
        layer,
        bounds: c.bounds,
        equal: true,
        pointSize: S.ui.pointSize
      });
    }
    const X = columnData(S.ui.qcX);
    const Y = columnData(S.ui.qcY);
    for (const { panel, facet } of qcPanels) {
      if (!X || !Y || X.kind !== "numeric" || Y.kind !== "numeric") {
        panel.setTitle("loading\u2026");
        panel.draw(null);
        continue;
      }
      const tx = S.ui.logX ? X.slog : X.values;
      const ty = S.ui.logY ? Y.slog : Y.values;
      const n = tx.length;
      const color = new Uint32Array(n);
      const layer = new Uint8Array(n);
      let shown = 0;
      for (let i = 0; i < n; i++) {
        const inFacet = facet.code < 0 || splitCodes && splitCodes[i] === facet.code;
        if (!inFacet) continue;
        if (!mask || mask[i]) {
          layer[i] = 2;
          color[i] = colorOf(i);
          shown++;
        } else if (ctxOn) {
          layer[i] = 1;
          color[i] = muted;
        }
      }
      const bounds = [...extent(tx), ...extent(ty)];
      const range = (name, logged) => {
        const f = S.draft.get(name);
        if (!f || f.kind !== "range") return [null, null];
        const t = (v) => v == null ? null : logged ? slog(v) : v;
        return [t(f.lo), t(f.hi)];
      };
      panel.setTitle(`${facet.label ? `${facet.label} \u2014 ` : ""}${nf.format(shown)} selected`);
      panel.draw({
        n,
        x: (i) => tx[i],
        y: (i) => ty[i],
        color,
        layer,
        bounds,
        pointSize: S.ui.pointSize,
        axes: { xlabel: S.ui.qcX, ylabel: S.ui.qcY, logX: S.ui.logX, logY: S.ui.logY },
        thresholds: { x: range(S.ui.qcX, S.ui.logX), y: range(S.ui.qcY, S.ui.logY) }
      });
    }
  }
  function onThreshold(axis, side, value) {
    const name = axis === "x" ? S.ui.qcX : S.ui.qcY;
    const logged = axis === "x" ? S.ui.logX : S.ui.logY;
    const c = col(name);
    if (!c) return;
    const raw = value == null ? null : logged ? Math.sign(value) * (10 ** Math.abs(value) - 1) : value;
    const f = S.draft.get(name);
    let lo = f && f.kind === "range" ? f.lo : null;
    let hi = f && f.kind === "range" ? f.hi : null;
    if (side === "lo") lo = raw;
    else hi = raw;
    const rounded = (v) => v == null ? null : c.integer ? Math.round(v) : Number(v.toPrecision(4));
    setFilter(name, rangeFilter(name, rounded(lo), rounded(hi), c.min, c.max));
  }
  function renderHeader() {
    const st = S.state;
    countEl.textContent = `${nf.format(st.n_selected)} / ${nf.format(st.n_total)} cells`;
    const s = st.status.state;
    statusBadge.className = `badge ${s}`;
    statusBadge.textContent = s === "running" || s === "queued" ? `${s} (${st.status.mode})` : s;
    statusBadge.title = st.status.message || "";
    const r = st.result;
    if (r) {
      const total = Object.values(r.timings || {}).reduce((a, b) => a + b, 0);
      const steps = Object.entries(r.timings || {}).map(([k, v]) => `${k} ${v.toFixed(2)}s`).join(", ");
      resultEl.textContent = `${r.mode === "full" ? "all" : "preview"}: ${nf.format(r.n_cells)} cells \xB7 ${total.toFixed(1)} s${r.current ? "" : " \xB7 outdated"}`;
      resultEl.title = steps;
    } else resultEl.textContent = "";
    if (s === "error") resultEl.textContent = st.status.message;
    autoBox.checked = st.auto;
    fullBtn.disabled = st.n_selected === 0;
  }
  transport.onStatus((s) => {
    if (s === "disconnected") {
      statusBadge.className = "badge error";
      statusBadge.textContent = "disconnected";
    }
  });
  transport.onMessage((m) => {
    switch (m.type) {
      case "schema": {
        const first = !S.schema;
        S.schema = m;
        if (first) pickDefaults();
        renderCards();
        renderSelects();
        renderParams();
        setUi({});
        break;
      }
      case "state": {
        const prevParams = S.state ? JSON.stringify(S.state.params) : "";
        S.state = m;
        if (S.sentList && sameFilters(m.filters, S.sentList) && S.sentVersion === S.localVersion) S.sentList = null;
        if (!hasUnsyncedEdits() && !sameFilters(m.filters, draftToList(S.draft))) {
          S.draft = listToDraft(m.filters);
          renderChips();
          for (const card of S.cards.values()) card.update();
        }
        renderHeader();
        updateParams();
        if (prevParams !== JSON.stringify(m.params)) rebuildPanels();
        else invalidate();
        break;
      }
      case "code":
        showModal("Filter as Python", h("pre", {}, m.code));
        navigator.clipboard?.writeText(m.code).then(() => toast("copied to clipboard"), () => {
        });
        break;
      case "exported":
        toast(`wrote ${nf.format(m.n_obs)} cells to ${m.path}${m.embeddings.length ? ` (${m.embeddings.join(", ")})` : " (no embedding: run on all cells first)"}`);
        break;
      case "error":
        toast(m.message, true);
        if (m.request === "set_filters") {
          S.sentList = null;
          S.sentVersion = S.localVersion;
        }
        break;
    }
  });
  transport.onFrame(({ header: header2, arrays }) => {
    switch (header2.type) {
      case "mask":
        S.mask = arrays[0];
        for (const card of S.cards.values()) card.redraw();
        invalidate();
        break;
      case "coords":
        S.coords[header2.embedding] = { header: header2, idx: arrays[0], xy: arrays[1], bounds: null };
        for (const e of Object.keys(S.coords)) {
          if (S.coords[e].header.generation !== header2.generation && !S.state?.params?.[e]) delete S.coords[e];
        }
        if (!embPanels.some((p) => p.embedding === header2.embedding)) rebuildPanels();
        else invalidate();
        break;
      case "column": {
        const data = { ...header2 };
        if (header2.kind === "numeric") {
          data.values = arrays[0];
          data.range = robustRange(data.values);
          data.slog = data.values.map(slog);
        } else data.codes = arrays[0];
        S.columns.set(header2.column, data);
        S.requested.delete(header2.column);
        S.cards.get(header2.column)?.redraw();
        if (header2.column === S.ui.splitBy) rebuildPanels();
        else {
          renderLegend();
          invalidate();
        }
        break;
      }
    }
  });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", invalidate);
  renderChips();
}

// src/frame.js
var TYPED = {
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array
};
function decodeFrame(buffer, byteOffset = 0) {
  const view = new DataView(buffer, byteOffset);
  const n = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, byteOffset + 4, n)));
  const arrays = header.buffers.map((spec) => {
    const T = TYPED[spec.dtype];
    if (!T) throw new Error(`unsupported dtype ${spec.dtype}`);
    const offset = byteOffset + spec.offset;
    const length = spec.nbytes / T.BYTES_PER_ELEMENT;
    if (offset % T.BYTES_PER_ELEMENT === 0) return new T(buffer, offset, length);
    return new T(buffer.slice(offset, offset + spec.nbytes));
  });
  return { header, arrays };
}

// src/transport.js
var Emitter = class {
  constructor() {
    this.messageCbs = [];
    this.frameCbs = [];
    this.statusCbs = [];
  }
  onMessage(cb) {
    this.messageCbs.push(cb);
  }
  onFrame(cb) {
    this.frameCbs.push(cb);
  }
  onStatus(cb) {
    this.statusCbs.push(cb);
  }
  emitMessage(m) {
    for (const cb of this.messageCbs) cb(m);
  }
  emitFrame(f) {
    for (const cb of this.frameCbs) cb(f);
  }
  emitStatus(s) {
    for (const cb of this.statusCbs) cb(s);
  }
};
var WebSocketTransport = class extends Emitter {
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
      this.retry = Math.min(this.retry * 2, 1e4);
    };
  }
  send(obj) {
    const text = JSON.stringify(obj);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.queue.push(text);
  }
};

// src/main.js
var proto = location.protocol === "https:" ? "wss:" : "ws:";
var base = location.pathname.replace(/[^/]*$/, "");
mountApp(document.getElementById("app"), new WebSocketTransport(`${proto}//${location.host}${base}ws`));

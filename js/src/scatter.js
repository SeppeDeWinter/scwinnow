// Canvas2D scatter panel: points are rasterised into a cached ImageData; axes, threshold
// lines and their drag handles are drawn on top, so dragging only repaints the overlay.

export const slog = (v) => Math.sign(v) * Math.log10(1 + Math.abs(v));
export const islog = (t) => Math.sign(t) * (10 ** Math.abs(t) - 1);

export function fmt(v) {
  if (v == null || !Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1);
  if (a >= 100 || Number.isInteger(v)) return String(Math.round(v * 10) / 10);
  return v.toPrecision(3);
}

export function niceTicks(lo, hi, count = 5) {
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
  // ticks at 0 and powers of ten, in transformed (slog) units
  const out = [];
  if (lo <= 0 && hi >= 0) out.push(0);
  for (let k = 0; k <= 12; k++) {
    const t = slog(10 ** k);
    if (t >= lo && t <= hi) out.push(t);
  }
  return out.length >= 2 ? out : niceTicks(lo, hi);
}

/** Finite [min, max] of an array, padded by `pad` of the span. */
export function extent(values, pad = 0.03) {
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

export class ScatterPanel {
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
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const axes = !!(this.spec && this.spec.axes);
    const m = axes
      ? { l: 52 * dpr, r: 10 * dpr, t: 8 * dpr, b: 34 * dpr }
      : { l: 6 * dpr, r: 6 * dpr, t: 6 * dpr, b: 6 * dpr };
    let [x0, x1, y0, y1] = this.spec ? this.spec.bounds : [0, 1, 0, 1];
    const pw = w - m.l - m.r;
    const ph = h - m.t - m.b;
    if (this.spec && this.spec.equal) {
      const sx = (x1 - x0) / pw;
      const sy = (y1 - y0) / ph;
      const s = Math.max(sx, sy);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      x0 = cx - (s * pw) / 2;
      x1 = cx + (s * pw) / 2;
      y0 = cy - (s * ph) / 2;
      y1 = cy + (s * ph) / 2;
    }
    return { dpr, w, h, m, pw, ph, x0, x1, y0, y1 };
  }

  toPx(g, x, y) {
    return [g.m.l + ((x - g.x0) / (g.x1 - g.x0)) * g.pw, g.m.t + (1 - (y - g.y0) / (g.y1 - g.y0)) * g.ph];
  }

  fromPx(g, px, py) {
    return [g.x0 + ((px - g.m.l) / g.pw) * (g.x1 - g.x0), g.y0 + (1 - (py - g.m.t) / g.ph) * (g.y1 - g.y0)];
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
    const px = (v, edge) => (v == null ? edge : this.toPx(g, v, 0)[0]);
    const py = (v, edge) => (v == null ? edge : this.toPx(g, 0, v)[1]);
    return {
      xlo: px(xlo, g.m.l),
      xhi: px(xhi, g.m.l + g.pw),
      ylo: py(ylo, g.m.t + g.ph),
      yhi: py(yhi, g.m.t),
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
    const h = 7 * g.dpr;
    const vline = (x, open) => {
      ctx.setLineDash(open ? [3 * g.dpr, 3 * g.dpr] : []);
      ctx.globalAlpha = open ? 0.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, g.m.t);
      ctx.lineTo(x, g.m.t + g.ph);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - h, g.m.t + g.ph);
      ctx.lineTo(x + h, g.m.t + g.ph);
      ctx.lineTo(x, g.m.t + g.ph - h);
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
      ctx.moveTo(g.m.l, y - h);
      ctx.lineTo(g.m.l, y + h);
      ctx.lineTo(g.m.l + h, y);
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
        ["y", "hi", Math.abs(py - L.yhi)],
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
      c.style.cursor = hit ? (hit.axis === "x" ? "ew-resize" : "ns-resize") : "default";
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
      // dragged to (or past) the plot edge = open that side
      const [px, py] = pos(ev);
      const outside =
        d.axis === "x"
          ? (d.side === "lo" && px <= g.m.l) || (d.side === "hi" && px >= g.m.l + g.pw)
          : (d.side === "lo" && py >= g.m.t + g.ph) || (d.side === "hi" && py <= g.m.t);
      this.opts.onThreshold(d.axis, d.side, outside ? null : d.value);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }
}

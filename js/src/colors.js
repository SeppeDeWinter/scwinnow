// Point colours as packed RGBA uint32 (little-endian: 0xAABBGGRR) for ImageData writes.

export function rgba(r, g, b, a = 255) {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return rgba((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

// 20 distinguishable categorical colours, then cycled with lightness shifts.
const CATEGORICAL = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f",
  "#bcbd22", "#17becf", "#aec7e8", "#ffbb78", "#98df8a", "#ff9896", "#c5b0d5", "#c49c94",
  "#f7b6d2", "#dbdb8d", "#9edae5", "#393b79",
].map(hex);

export const CATEGORICAL_CSS = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f",
  "#bcbd22", "#17becf", "#aec7e8", "#ffbb78", "#98df8a", "#ff9896", "#c5b0d5", "#c49c94",
  "#f7b6d2", "#dbdb8d", "#9edae5", "#393b79",
];

export function categoryColor(code) {
  return CATEGORICAL[code % CATEGORICAL.length];
}

export function categoryCss(code) {
  return CATEGORICAL_CSS[code % CATEGORICAL_CSS.length];
}

// viridis, 9 stops, linearly interpolated into a 256 entry LUT
const VIRIDIS = [
  [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141],
  [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37],
];
export const VIRIDIS_LUT = (() => {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (VIRIDIS.length - 1);
    const k = Math.min(Math.floor(t), VIRIDIS.length - 2);
    const f = t - k;
    const [r0, g0, b0] = VIRIDIS[k];
    const [r1, g1, b1] = VIRIDIS[k + 1];
    lut[i] = rgba(
      Math.round(r0 + f * (r1 - r0)),
      Math.round(g0 + f * (g1 - g0)),
      Math.round(b0 + f * (b1 - b0)),
    );
  }
  return lut;
})();

export function viridisCss(t) {
  const c = VIRIDIS_LUT[Math.max(0, Math.min(255, Math.round(t * 255)))];
  return `rgb(${c & 255},${(c >> 8) & 255},${(c >> 16) & 255})`;
}

export const DEFAULT_POINT = rgba(52, 101, 164);
export const MUTED_POINT = rgba(200, 200, 200);
export const MUTED_POINT_DARK = rgba(70, 70, 70);
export const MISSING_POINT = rgba(150, 150, 150);

/** Robust [lo, hi] colour range of a float array (1st-99th percentile of finite values). */
export function robustRange(values) {
  const finite = [];
  const step = Math.max(1, Math.floor(values.length / 20000));
  for (let i = 0; i < values.length; i += step) if (Number.isFinite(values[i])) finite.push(values[i]);
  if (!finite.length) return [0, 1];
  finite.sort((a, b) => a - b);
  const lo = finite[Math.floor(0.01 * (finite.length - 1))];
  const hi = finite[Math.ceil(0.99 * (finite.length - 1))];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

// scwinnow UI. Talks only to a transport (see transport.js), so it runs both as a standalone page
// (WebSocketTransport) and inside a notebook widget (AnyWidgetTransport).

import {
  DEFAULT_POINT,
  MISSING_POINT,
  MUTED_POINT,
  MUTED_POINT_DARK,
  VIRIDIS_LUT,
  categoryColor,
  categoryCss,
  robustRange,
  viridisCss,
} from "./colors.js";
import {
  boolFilter,
  categoryFilter,
  describe,
  draftToList,
  listToDraft,
  rangeFilter,
  sameFilters,
  withFilter,
} from "./filters.js";
import { ScatterPanel, extent, fmt, slog } from "./scatter.js";

const MISSING_CODE = 65535;
const SEND_DELAY_MS = 300;
const EMBEDDING_LABEL = { umap: "UMAP", tsne: "tSNE" };

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

const nf = new Intl.NumberFormat("en-US");

function isDark() {
  const cls = document.body ? document.body.classList : null;
  if (cls && (cls.contains("vscode-dark") || cls.contains("vscode-high-contrast"))) return true;
  if (cls && cls.contains("vscode-light")) return false;
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function mountApp(root, transport) {
  const S = {
    schema: null,
    state: null,
    mask: null,
    coords: {},
    columns: new Map(),
    requested: new Set(),
    draft: new Map(),
    localVersion: 0,
    sentVersion: 0,
    sentList: null,
    sendTimer: null,
    cards: new Map(),
    ui: {
      colorBy: "",
      splitBy: "",
      qcX: "",
      qcY: "",
      logX: false,
      logY: false,
      pointSize: 2,
      showContext: true,
      search: "",
    },
  };

  // ---------------------------------------------------------------- layout

  root.classList.add("scw");
  const statusBadge = h("span", { class: "badge" }, "connecting");
  const countEl = h("span", { class: "count" });
  const resultEl = h("span", { class: "result" });
  const autoBox = h("input", {
    type: "checkbox",
    checked: true,
    onchange: () => transport.send({ type: "set_auto", auto: autoBox.checked }),
  });
  const fullBtn = h(
    "button",
    { class: "primary", onclick: () => transport.send({ type: "compute", mode: "full" }) },
    "Compute on all cells",
  );
  const previewBtn = h(
    "button",
    { onclick: () => transport.send({ type: "compute", mode: "preview" }) },
    "Recompute preview",
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
    codeBtn,
  );

  const chipsEl = h("div", { class: "chips" });
  const searchEl = h("input", {
    type: "search",
    placeholder: "Search obs columns…",
    oninput: () => {
      S.ui.search = searchEl.value.toLowerCase();
      for (const [name, card] of S.cards) card.el.hidden = !name.toLowerCase().includes(S.ui.search);
    },
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
    paramsEl,
  );

  const colorSel = h("select", { onchange: () => setUi({ colorBy: colorSel.value }) });
  const splitSel = h("select", { onchange: () => setUi({ splitBy: splitSel.value }) });
  const sizeInput = h("input", {
    type: "range",
    min: 1,
    max: 6,
    step: 1,
    value: 2,
    oninput: () => setUi({ pointSize: Number(sizeInput.value) }),
  });
  const contextBox = h("input", {
    type: "checkbox",
    checked: true,
    onchange: () => setUi({ showContext: contextBox.checked }),
  });
  const toolbar = h(
    "div",
    { class: "toolbar" },
    h("label", {}, "color ", colorSel),
    h("label", {}, "split by ", splitSel),
    h("label", {}, "point ", sizeInput),
    h("label", { class: "toggle", title: "Draw filtered-out / other-facet cells in grey" }, contextBox, "context"),
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
      h("span", { class: "hint" }, "drag the red lines to set thresholds"),
    ),
    qcGrid,
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
    toast.t = setTimeout(() => (toastEl.hidden = true), isError ? 6000 : 3000);
  }

  function showModal(title, body) {
    modalEl.replaceChildren(
      h("div", { class: "modal-box" }, h("div", { class: "modal-head" }, h("strong", {}, title),
        h("button", { onclick: () => (modalEl.hidden = true) }, "×")), body),
    );
    modalEl.hidden = false;
  }

  function doExport() {
    const path = window.prompt("Write filtered AnnData to (path on the server):", "filtered.h5ad");
    if (path) {
      transport.send({ type: "export", path });
      toast(`exporting to ${path}…`);
    }
  }

  // ---------------------------------------------------------------- columns

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

  // ---------------------------------------------------------------- filters

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
      ...(list.length
        ? list.map((f) =>
            h("span", { class: "chip", title: describe(f, fmt) }, describe(f, fmt),
              h("button", { onclick: () => setFilter(f.column, null), title: "remove" }, "×")),
          )
        : [h("span", { class: "muted" }, "no filters — all cells selected")]),
      list.length ? h("button", { class: "link", onclick: () => clearAll() }, "clear all") : null,
    );
  }

  function clearAll() {
    const cols = [...S.draft.keys()];
    S.draft = new Map();
    S.localVersion++;
    renderChips();
    for (const c of cols) S.cards.get(c)?.update();
    invalidate();
    clearTimeout(S.sendTimer);
    S.sendTimer = setTimeout(sendFilters, SEND_DELAY_MS);
  }

  // ---------------------------------------------------------------- filter cards

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
    const body = h("div", { class: "card-body" }, canvas,
      h("div", { class: "range-inputs" }, loIn, h("span", {}, "–"), hiIn,
        h("button", { class: "link", onclick: () => setFilter(c.name, null) }, "reset")));
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
      if (b - a < span * 0.005) setFilter(c.name, null);
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
      const xOf = (v) => ((v - c.min) / (c.max - c.min || 1)) * w;
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

  // Histogram of the currently selected cells over the schema bin edges (null if data missing).
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
      out[Math.min(nb - 1, Math.max(0, Math.floor(((v[i] - lo) / span) * nb)))]++;
    }
    return out;
  }

  function categoryCard(c) {
    const labels = c.categories.map((x) => x.label);
    const summary = h("span", { class: "summary" });
    const filterIn = h("input", { type: "search", placeholder: "filter categories…", hidden: labels.length <= 12 });
    const boxes = new Map();
    const list = h("div", { class: "cat-list" },
      c.categories.map((x, i) => {
        const box = h("input", { type: "checkbox", checked: true, onchange: () => commit() });
        boxes.set(x.label, box);
        return h("label", { class: "cat", "data-label": x.label.toLowerCase() },
          box, h("span", { class: "swatch", style: `background:${categoryCss(i)}` }),
          h("span", { class: "cat-label" }, x.label), h("span", { class: "cat-count" }, nf.format(x.count)));
      }));
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
    const body = h("div", { class: "card-body" }, filterIn,
      h("div", { class: "cat-actions" },
        h("button", { class: "link", onclick: () => setAll(() => true) }, "all"),
        h("button", { class: "link", onclick: () => setAll(() => false) }, "none"),
        h("button", { class: "link", onclick: () => setAll((_, v) => !v) }, "invert")),
      list);
    const el = h("details", { class: "card" }, h("summary", {}, h("span", { class: "name" }, c.name), summary), body);
    function update() {
      const f = S.draft.get(c.name);
      const keep = f && f.kind === "category" ? new Set(f.keep) : null;
      for (const [l, b] of boxes) b.checked = keep ? keep.has(l) : true;
      summary.textContent = keep ? `${keep.size} of ${labels.length}` : "";
      el.classList.toggle("active", !!f);
    }
    return { el, update, redraw() {} };
  }

  function boolCard(c) {
    const name = `bool-${c.name}`;
    const radios = ["any", "true", "false"].map((v) =>
      h("label", {}, h("input", { type: "radio", name, value: v, onchange: () => {
        setFilter(c.name, boolFilter(c.name, v === "any" ? null : v === "true"));
      } }), ` ${v}`, v === "true" ? ` (${nf.format(c.n_true)})` : v === "false" ? ` (${nf.format(c.n_false)})` : ""));
    const summary = h("span", { class: "summary" });
    const el = h("details", { class: "card" }, h("summary", {}, h("span", { class: "name" }, c.name), summary),
      h("div", { class: "card-body bool" }, radios));
    function update() {
      const f = S.draft.get(c.name);
      const v = f ? String(f.value) : "any";
      for (const r of radios) r.querySelector("input").checked = r.querySelector("input").value === v;
      summary.textContent = f ? `= ${f.value}` : "";
      el.classList.toggle("active", !!f);
    }
    return { el, update, redraw() {} };
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

  // ---------------------------------------------------------------- params

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
    ["n_neighbors", "neighbors", "int"],
  ];
  const paramInputs = new Map();
  const previewIn = h("input", { type: "number", min: 100, step: 1000 });

  function renderParams() {
    paramsEl.replaceChildren();
    for (const [key, label, kind, dep] of PARAM_FIELDS) {
      let input;
      if (kind === "bool") {
        input = h("input", { type: "checkbox", onchange: () => sendParam(key, input.checked) });
      } else if (Array.isArray(kind)) {
        input = h("select", { onchange: () => sendParam(key, input.value) }, kind.map((o) => h("option", { value: o }, o)));
      } else {
        input = h("input", { type: "number", step: kind === "int" ? 1 : "any",
          onchange: () => input.value !== "" && sendParam(key, Number(input.value)) });
      }
      paramInputs.set(key, input);
      paramsEl.append(h("label", { class: `param${dep ? " sub" : ""}`, "data-dep": dep || "" }, h("span", {}, label), input));
    }
    previewIn.addEventListener("change", () => {
      const n = previewIn.value === "" ? null : Number(previewIn.value);
      transport.send({ type: "set_preview_max_cells", n });
    });
    paramsEl.append(h("label", { class: "param", title: "Cells used for preview embeddings while filtering" },
      h("span", {}, "preview cells"), previewIn));
  }

  function sendParam(key, value) {
    const p = S.state ? S.state.params : {};
    if ((key === "umap" && !value && !p.tsne) || (key === "tsne" && !value && !p.umap)) {
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

  // ---------------------------------------------------------------- toolbar selects

  function fillSelect(sel, options, value) {
    sel.replaceChildren(...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
    sel.value = value;
  }

  function renderSelects() {
    const cols = S.schema.columns;
    const numeric = cols.filter((c) => c.kind === "numeric").map((c) => [c.name, c.name]);
    const cats = cols.filter((c) => c.kind !== "numeric").map((c) => [c.name, c.name]);
    fillSelect(colorSel, [["", "—"], ...cats, ...numeric], S.ui.colorBy);
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
    S.ui.qcY = firstOf("n_genes_by_counts", "n_genes", "nFeature_RNA", "pct_counts_mt") ||
      numeric.find((n) => n !== S.ui.qcX) || S.ui.qcX;
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

  // ---------------------------------------------------------------- colouring

  function colorer() {
    const data = columnData(S.ui.colorBy);
    if (!data) return () => DEFAULT_POINT;
    if (data.kind === "category") {
      const codes = data.codes;
      return (i) => (codes[i] === MISSING_CODE ? MISSING_POINT : categoryColor(codes[i]));
    }
    const v = data.values;
    const [lo, hi] = data.range;
    const span = hi - lo || 1;
    return (i) => {
      const x = v[i];
      if (!Number.isFinite(x)) return MISSING_POINT;
      return VIRIDIS_LUT[Math.max(0, Math.min(255, Math.round(((x - lo) / span) * 255)))];
    };
  }

  function renderLegend() {
    const data = columnData(S.ui.colorBy);
    if (!data) {
      legendEl.replaceChildren();
      return;
    }
    if (data.kind === "category") {
      legendEl.replaceChildren(...data.categories.map((label, i) =>
        h("span", { class: "legend-item" }, h("span", { class: "swatch", style: `background:${categoryCss(i)}` }), label)));
    } else {
      const stops = Array.from({ length: 11 }, (_, k) => viridisCss(k / 10)).join(",");
      legendEl.replaceChildren(h("span", {}, fmt(data.range[0])),
        h("span", { class: "gradient", style: `background:linear-gradient(90deg,${stops})` }),
        h("span", {}, fmt(data.range[1])), h("span", { class: "muted" }, ` ${S.ui.colorBy} (1st–99th pct)`));
    }
  }

  // ---------------------------------------------------------------- panels

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
      const panel = new ScatterPanel(qcGrid, { onThreshold: onThreshold });
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
        panel.setTitle(`${label} — ${S.state.params[embedding] ? "computing…" : "off"}`);
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
        const inFacet = facet.code < 0 || (splitCodes && splitCodes[i] === facet.code);
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
      panel.setTitle(`${label}${facet.label ? ` · ${facet.label}` : ""} — ${nf.format(shown)} cells (${tag}${stale ? ", outdated" : ""})`);
      panel.el.classList.toggle("stale", stale);
      panel.draw({
        n,
        x: (k) => xy[2 * k],
        y: (k) => xy[2 * k + 1],
        color,
        layer,
        bounds: c.bounds,
        equal: true,
        pointSize: S.ui.pointSize,
      });
    }

    const X = columnData(S.ui.qcX);
    const Y = columnData(S.ui.qcY);
    for (const { panel, facet } of qcPanels) {
      if (!X || !Y || X.kind !== "numeric" || Y.kind !== "numeric") {
        panel.setTitle("loading…");
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
        const inFacet = facet.code < 0 || (splitCodes && splitCodes[i] === facet.code);
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
        const t = (v) => (v == null ? null : logged ? slog(v) : v);
        return [t(f.lo), t(f.hi)];
      };
      panel.setTitle(`${facet.label ? `${facet.label} — ` : ""}${nf.format(shown)} selected`);
      panel.draw({
        n,
        x: (i) => tx[i],
        y: (i) => ty[i],
        color,
        layer,
        bounds,
        pointSize: S.ui.pointSize,
        axes: { xlabel: S.ui.qcX, ylabel: S.ui.qcY, logX: S.ui.logX, logY: S.ui.logY },
        thresholds: { x: range(S.ui.qcX, S.ui.logX), y: range(S.ui.qcY, S.ui.logY) },
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
    const rounded = (v) => (v == null ? null : c.integer ? Math.round(v) : Number(v.toPrecision(4)));
    setFilter(name, rangeFilter(name, rounded(lo), rounded(hi), c.min, c.max));
  }

  // ---------------------------------------------------------------- header

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
      resultEl.textContent = `${r.mode === "full" ? "all" : "preview"}: ${nf.format(r.n_cells)} cells · ${total.toFixed(1)} s${r.current ? "" : " · outdated"}`;
      resultEl.title = steps;
    } else resultEl.textContent = "";
    if (s === "error") resultEl.textContent = st.status.message;
    autoBox.checked = st.auto;
    fullBtn.disabled = st.n_selected === 0;
  }

  // ---------------------------------------------------------------- transport

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
        navigator.clipboard?.writeText(m.code).then(() => toast("copied to clipboard"), () => {});
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

  transport.onFrame(({ header, arrays }) => {
    switch (header.type) {
      case "mask":
        S.mask = arrays[0];
        for (const card of S.cards.values()) card.redraw();
        invalidate();
        break;
      case "coords":
        S.coords[header.embedding] = { header, idx: arrays[0], xy: arrays[1], bounds: null };
        for (const e of Object.keys(S.coords)) {
          if (S.coords[e].header.generation !== header.generation && !(S.state?.params?.[e])) delete S.coords[e];
        }
        if (!embPanels.some((p) => p.embedding === header.embedding)) rebuildPanels();
        else invalidate();
        break;
      case "column": {
        const data = { ...header };
        if (header.kind === "numeric") {
          data.values = arrays[0];
          data.range = robustRange(data.values);
          data.slog = data.values.map(slog);
        } else data.codes = arrays[0];
        S.columns.set(header.column, data);
        S.requested.delete(header.column);
        S.cards.get(header.column)?.redraw();
        if (header.column === S.ui.splitBy) rebuildPanels();
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

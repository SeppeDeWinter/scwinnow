import assert from "node:assert/strict";
import { test } from "node:test";

import { robustRange } from "../src/colors.js";
import {
  categoryFilter,
  describe,
  draftToList,
  listToDraft,
  rangeFilter,
  sameFilters,
  withFilter,
} from "../src/filters.js";
import { decodeFrame } from "../src/frame.js";
import { extent, islog, niceTicks, slog } from "../src/scatter.js";

function encode(header, arrays) {
  // mirror of scwinnow.protocol.encode_frame for the decoder test
  const pad = (n) => (8 - (n % 8)) % 8;
  let start = 0;
  let head;
  for (;;) {
    let off = start;
    const buffers = arrays.map((a) => {
      const spec = { dtype: a.constructor.name.replace("Array", "").toLowerCase(), shape: [a.length], offset: off, nbytes: a.byteLength };
      off += a.byteLength + pad(a.byteLength);
      return spec;
    });
    head = new TextEncoder().encode(JSON.stringify({ ...header, buffers }));
    const s = 4 + head.length + pad(4 + head.length);
    if (s === start) break;
    start = s;
  }
  const total = arrays.reduce((n, a) => n + a.byteLength + pad(a.byteLength), start);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let off = start;
  for (const a of arrays) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), off);
    off += a.byteLength + pad(a.byteLength);
  }
  return out.buffer;
}

test("decodeFrame round trip", () => {
  const a = new Uint32Array([1, 2, 3]);
  const b = new Float32Array([0.5, -1.5]);
  const { header, arrays } = decodeFrame(encode({ type: "coords" }, [a, b]));
  assert.equal(header.type, "coords");
  assert.deepEqual([...arrays[0]], [1, 2, 3]);
  assert.deepEqual([...arrays[1]], [0.5, -1.5]);
});

test("rangeFilter drops sides at the data extent", () => {
  assert.equal(rangeFilter("x", 0, 10, 0, 10), null);
  assert.deepEqual(rangeFilter("x", 2, 10, 0, 10), { kind: "range", column: "x", lo: 2, hi: null });
  assert.deepEqual(rangeFilter("x", 8, 3, 0, 10), { kind: "range", column: "x", lo: 3, hi: 8 });
});

test("categoryFilter is null when everything is kept", () => {
  assert.equal(categoryFilter("c", ["a", "b"], ["a", "b"]), null);
  assert.deepEqual(categoryFilter("c", ["b"], ["a", "b"]).keep, ["b"]);
});

test("draft helpers and equality", () => {
  let d = new Map();
  d = withFilter(d, "x", rangeFilter("x", 1, null, 0, 10));
  d = withFilter(d, "c", categoryFilter("c", ["b", "a"], ["a", "b", "z"]));
  const list = draftToList(d);
  assert.equal(list.length, 2);
  assert.ok(sameFilters(list, [...list].reverse()));
  assert.ok(sameFilters(draftToList(listToDraft(list)), list));
  d = withFilter(d, "x", null);
  assert.equal(draftToList(d).length, 1);
  assert.ok(!sameFilters(draftToList(d), list));
  assert.match(describe(list[0]), /x ≥ 1/);
});

test("slog is inverted by islog", () => {
  for (const v of [0, 1, 9, 123.4, -5]) assert.ok(Math.abs(islog(slog(v)) - v) < 1e-9);
});

test("ticks and extent", () => {
  const t = niceTicks(0, 97);
  assert.ok(t.length >= 3 && t[0] >= 0 && t.at(-1) <= 97);
  const [lo, hi] = extent(new Float32Array([1, 2, NaN, 3]));
  assert.ok(lo < 1 && hi > 3);
  const [a, b] = robustRange(new Float32Array([NaN, 1, 2, 3]));
  assert.ok(a <= b);
});

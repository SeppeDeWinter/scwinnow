// Filter draft: one filter per obs column, keyed by column name.

export function normalizeRange(lo, hi, min, max) {
  let a = lo == null || Number.isNaN(lo) ? null : lo;
  let b = hi == null || Number.isNaN(hi) ? null : hi;
  if (a != null && b != null && a > b) [a, b] = [b, a];
  if (a != null && min != null && a <= min) a = null;
  if (b != null && max != null && b >= max) b = null;
  return [a, b];
}

/** Range filter, or null when both sides are open. */
export function rangeFilter(column, lo, hi, min, max) {
  const [a, b] = normalizeRange(lo, hi, min, max);
  return a == null && b == null ? null : { kind: "range", column, lo: a, hi: b };
}

/** Category filter, or null when every category is kept. */
export function categoryFilter(column, keep, allLabels) {
  const set = new Set(keep);
  if (allLabels.every((l) => set.has(l))) return null;
  return { kind: "category", column, keep: [...set].sort() };
}

export function boolFilter(column, value) {
  return value == null ? null : { kind: "bool", column, value: !!value };
}

/** Return a new draft with `filter` set (or removed when null) for `column`. */
export function withFilter(draft, column, filter) {
  const next = new Map(draft);
  if (filter == null) next.delete(column);
  else next.set(column, filter);
  return next;
}

export function draftToList(draft) {
  return [...draft.values()];
}

export function listToDraft(list) {
  return new Map(list.map((f) => [f.column, f]));
}

function canon(f) {
  if (f.kind === "category") return JSON.stringify([f.kind, f.column, [...f.keep].sort()]);
  if (f.kind === "range") return JSON.stringify([f.kind, f.column, f.lo ?? null, f.hi ?? null]);
  return JSON.stringify([f.kind, f.column, f.value]);
}

export function sameFilters(a, b) {
  if (a.length !== b.length) return false;
  const sa = a.map(canon).sort();
  const sb = b.map(canon).sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Short human-readable description of a filter. */
export function describe(f, fmt = String) {
  if (f.kind === "range") {
    if (f.lo != null && f.hi != null) return `${fmt(f.lo)} ≤ ${f.column} ≤ ${fmt(f.hi)}`;
    if (f.lo != null) return `${f.column} ≥ ${fmt(f.lo)}`;
    return `${f.column} ≤ ${fmt(f.hi)}`;
  }
  if (f.kind === "bool") return `${f.column} = ${f.value}`;
  const shown = f.keep.slice(0, 3).join(", ");
  const more = f.keep.length > 3 ? ` +${f.keep.length - 3}` : "";
  return `${f.column} ∈ {${shown}${more}}`;
}

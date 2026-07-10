// values.ts — the value types + serialization for the Patch execution core.
//
// The Player lowers each canonical frame into a PlrCall whose kwargs are a
// tree of these value types. The final NDJSON line is produced by `pyJson`,
// which composes a strict JSON rendering (with the default ", "/": "
// separators) with a `_serializable` fallback (str() on unknown objects) —
// the exact two-stage rendering the `--json` path performs.
//
// Why custom types instead of raw JS values:
//   - RoleRef must render either as "role:N" (legacy top-level scalar) or as
//     "RoleRef(role_id=N)" (everything nested + all v1b1). The class keeps the
//     un-coerced sentinel around so the adapter decides which, and pyJson
//     renders any survivor via str() = "RoleRef(role_id=N)".
//   - Tup marks a tuple (vs a list). Only relevant to legacy coercion,
//     which recurses tuples but NOT lists. Both render as JSON arrays.
//   - Flt marks a float so an integer-valued float (e.g. 0.0) renders "0.0";
//     a bare JS number would print "0".
//   - LabwareStub reproduces the frozen dataclass repr that seeds the legacy
//     Absorbance _returned RNG.

/** Sentinel for a role reference inside PlrCall kwargs. */
export class RoleRef {
  /** Wrap a role_id sentinel. */
  constructor(public readonly roleId: number) {}
  /** Load-bearing: renders the dataclass repr `RoleRef(role_id=N)`. */
  toString(): string {
    return `RoleRef(role_id=${this.roleId})`;
  }
}

/** A tuple (distinct from a list only for legacy coercion recursion). */
export class Tup {
  /** Wrap the tuple's items. */
  constructor(public readonly items: unknown[]) {}
}

/** A float — forces float-style repr (integer-valued floats keep the `.0`). */
export class Flt {
  /** Wrap the float value. */
  constructor(public readonly v: number) {}
}

/** Reproduces `_LabwareStub(kind=..., name=...)` (frozen slots dataclass repr). */
export class LabwareStub {
  /** Wrap the labware kind + factory name. */
  constructor(public readonly kind: string, public readonly name: string) {}
  /** Reproduce the frozen dataclass repr `_LabwareStub(kind=..., name=...)`. */
  toString(): string {
    return `_LabwareStub(kind='${this.kind}', name='${this.name}')`;
  }
}

/** Float `repr`-equivalent. Integer-valued finite floats get `.0`. */
export function pyFloatRepr(x: number): string {
  if (!Number.isFinite(x)) {
    if (Number.isNaN(x)) return "NaN";
    return x > 0 ? "Infinity" : "-Infinity";
  }
  if (Number.isInteger(x)) return `${x}.0`;
  // JS shortest-round-trip toString matches the expected float repr for the
  // values exercised here (verified against the golden NDJSON).
  return x.toString();
}

/** JSON string encoding for an ASCII string (matches json.dumps + str keys). */
function pyStr(s: string): string {
  return JSON.stringify(s);
}

/**
 * Render a value tree exactly as the `--json` path does: a strict JSON
 * rendering with the default ", "/": " separators, composed with the
 * `_serializable` fallback that str()'s unknown objects (RoleRef / LabwareStub
 * survivors).
 */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Flt) return pyFloatRepr(v.v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toString() : pyFloatRepr(v);
  }
  if (typeof v === "string") return pyStr(v);
  if (v instanceof RoleRef) return pyStr(v.toString());
  if (v instanceof LabwareStub) return pyStr(v.toString());
  if (v instanceof Tup) return `[${v.items.map(pyJson).join(", ")}]`;
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (v instanceof Map) {
    const parts: string[] = [];
    for (const [k, val] of v) parts.push(`${pyStr(String(k))}: ${pyJson(val)}`);
    return `{${parts.join(", ")}}`;
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj)) parts.push(`${pyStr(k)}: ${pyJson(obj[k])}`);
    return `{${parts.join(", ")}}`;
  }
  // Fallback mirrors CLI `_serializable`: str() anything else.
  return pyStr(String(v));
}

/**
 * `repr()` for the small value set that seeds the legacy/v1b1
 * Absorbance RNG: lists, tuples, strings, ints, RoleRef, LabwareStub.
 */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toString() : pyFloatRepr(v);
  }
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (v instanceof RoleRef) return v.toString();
  if (v instanceof LabwareStub) return v.toString();
  if (v instanceof Tup) {
    if (v.items.length === 1) return `(${pyRepr(v.items[0])},)`;
    return `(${v.items.map(pyRepr).join(", ")})`;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return String(v);
}

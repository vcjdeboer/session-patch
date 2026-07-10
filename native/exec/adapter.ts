// adapter.ts — the injected adapter layer.
//
// The adapter-neutral core (lowering.ts) produces a PlrCall whose kwargs hold
// RoleRef / Tup / Flt sentinels. The adapter turns that into the event-ready
// {method_name, kwargs} tree, deciding the two things that actually differ
// between recording backends:
//   1. role representation — legacy renders a TOP-LEVEL scalar RoleRef as
//      "role:N" (and recurses tuples), but leaves list-nested RoleRefs to
//      str() as "RoleRef(role_id=N)"; v1b1 renders EVERY RoleRef as
//      "RoleRef(role_id=N)".
//   2. dispatch specifics — the Absorbance.read `_returned` value, seeded off
//      the RESOLVED labware repr (legacy) vs the UNRESOLVED RoleRef (v1b1).
//
// A neutral default adapter is provided for Stage 3; a later stage specializes
// it. `legacyAdapter` / `v1b1Adapter` reproduce the two golden NDJSON streams.

import { Flt, RoleRef, Tup, pyRepr } from "./values.ts";
import type { PlrCall } from "./lowering.ts";
import { round4, MT19937 } from "./mt19937.ts";
import type { ResourceModel } from "./resourceModel.ts";

/** The injected adapter contract. */
export interface Adapter {
  /** Backend identity (e.g. "plr-legacy", "plr-v1b1", "neutral"). */
  readonly name: string;
  /**
   * Turn a lowered PlrCall into the event-ready call summary. Async because
   * dispatch (e.g. the Absorbance RNG seed) hashes with Web Crypto.
   */
  lowerCall(
    schemaId: number,
    deviceRole: number,
    call: PlrCall,
    rm: ResourceModel,
  ): Promise<{ method_name: string; kwargs: Record<string, unknown> }>;
}

async function sha256First4BE(s: string): Promise<number> {
  const bytes = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  const d = new Uint8Array(buf);
  return ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
}

/** round(Random(seed_from_repr).uniform(0.1, 1.5), 4). */
async function seededAbsorbance(seedSrc: string): Promise<number> {
  const seed = await sha256First4BE(seedSrc);
  return round4(new MT19937(seed).uniform(0.1, 1.5));
}

/** sorted(kwargs.items()) as a list-of-2-tuples, for repr(). */
function sortedItemsRepr(entries: [string, unknown][]): string {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pyRepr(sorted.map(([k, v]) => new Tup([k, v])));
}

// --- role coercion ----------------------------------------------------------

// legacy `_coerce`: top-level scalar RoleRef → "role:N"; recurse tuples (so a
// tuple-reachable RoleRef also becomes "role:N"); DO NOT recurse lists (leave
// list-nested RoleRefs for pyJson to str() as "RoleRef(role_id=N)").
function legacyCoerce(v: unknown): unknown {
  if (v instanceof RoleRef) return `role:${v.roleId}`;
  if (v instanceof Tup) return new Tup(v.items.map(legacyCoerce));
  return v; // arrays (lists) pass through untouched
}

// v1b1 `_coerce_kwarg`: recurse tuples AND lists; never touch RoleRef (pyJson
// str()'s every survivor → "RoleRef(role_id=N)").
function v1b1Coerce(v: unknown): unknown {
  if (v instanceof Tup) return new Tup(v.items.map(v1b1Coerce));
  if (Array.isArray(v)) return v.map(v1b1Coerce);
  return v;
}

function coerceKwargs(call: PlrCall, coerce: (v: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(call.kwargs)) out[k] = coerce(call.kwargs[k]);
  return out;
}

// --- adapters ---------------------------------------------------------------

/**
 * Neutral default: v1b1-style role representation ("RoleRef(role_id=N)"
 * everywhere), no dispatch-return injection. A later stage specializes this
 * for a concrete backend.
 */
export const neutralAdapter: Adapter = {
  name: "neutral",
  // deno-lint-ignore require-await
  async lowerCall(_schemaId, _deviceRole, call, _rm) {
    return { method_name: call.method_name, kwargs: coerceKwargs(call, v1b1Coerce) };
  },
};

/** plr-legacy recording path. */
export const legacyAdapter: Adapter = {
  name: "plr-legacy",
  async lowerCall(_schemaId, _deviceRole, call, rm) {
    const kwargs = coerceKwargs(call, legacyCoerce);
    if (call.method_name === "read") {
      // Seed off the RESOLVED labware repr (RoleRef → _LabwareStub).
      const entries: [string, unknown][] = Object.keys(call.kwargs).map((k) => {
        const v = call.kwargs[k];
        return [k, v instanceof RoleRef ? rm.resolveLabware(v.roleId) : v];
      });
      kwargs["_returned"] = new Flt(await seededAbsorbance(sortedItemsRepr(entries)));
    }
    return { method_name: call.method_name, kwargs };
  },
};

/** plr-v1b1 recording path. */
export const v1b1Adapter: Adapter = {
  name: "plr-v1b1",
  async lowerCall(_schemaId, _deviceRole, call, _rm) {
    const kwargs = coerceKwargs(call, v1b1Coerce);
    if (call.method_name === "read") {
      // Seed off the UNRESOLVED RoleRef repr.
      const entries: [string, unknown][] = Object.keys(call.kwargs).map((k) => [k, call.kwargs[k]]);
      kwargs["_returned"] = new Flt(await seededAbsorbance(sortedItemsRepr(entries)));
    }
    return { method_name: call.method_name, kwargs };
  },
};

/** Resolve an adapter by `<adapter>:<inner>` backend string (recording only). */
export function adapterFor(backend: string): Adapter {
  const head = backend.split(":", 1)[0];
  if (head === "plr-legacy") return legacyAdapter;
  if (head === "plr-v1b1") return v1b1Adapter;
  if (head === "neutral") return neutralAdapter;
  throw new Error(`unknown adapter '${head}' (expected plr-legacy | plr-v1b1 | neutral)`);
}

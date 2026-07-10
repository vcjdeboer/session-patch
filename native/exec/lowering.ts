// lowering.ts — per-capability schema → PlrCall lowering for the BCA schema
// set, covering the PIP, Absorbance, GripperArm and TemperatureController
// capabilities. Each lowering is a pure (payload) -> PlrCall; the Player calls
// it once per invocation frame.
//
// kwargs are built with the value types from values.ts (RoleRef / Tup / Flt)
// so the adapter can apply per-adapter role representation and the serializer
// can apply the correct float formatting.

import { RoleRef, Tup, Flt } from "./values.ts";
import { scaleLinear, scaleLog, decodeWell } from "./codec_scale.ts";

const DEFAULT_SENTINEL = 0xff;

/** A lowered call: PLR method name + kwargs value tree (pre-coercion). */
export interface PlrCall {
  /** The PLR method name (e.g. "aspirate", "read"). */
  method_name: string;
  /** The kwargs value tree (RoleRef / Tup / Flt sentinels, pre-coercion). */
  kwargs: Record<string, unknown>;
}

/** schema_id → SchemaDef.name (the NDJSON `invocation_name`). */
export const SCHEMA_NAMES: ReadonlyMap<number, string> = new Map<number, string>([
  [0x60005001, "PIP.pick_up_tips"],
  [0x60005002, "PIP.drop_tips"],
  [0x60005003, "PIP.aspirate"],
  [0x60005004, "PIP.dispense"],
  [0x60006001, "Absorbance.read"],
  [0x60008001, "GripperArm.move_resource"],
  [0x60002001, "TemperatureController.set_temperature"],
  [0x60002002, "TemperatureController.request_temperature"],
  [0x60002003, "TemperatureController.wait_for_temperature"],
  [0x60002004, "TemperatureController.deactivate"],
  [0x70000002, "wire.sleep"],
]);

/** wire.sleep — Player-native, no lowering / no PLR call. */
export const WIRE_SLEEP_SCHEMA_ID = 0x70000002;

// --- shared offset (PIP + GripperArm) --------------------------------------

// Decode the 3-byte shared offset at payload[2:5]. Byte 0 → exactly 0.0
// (the `!= 0` guard); otherwise scale_linear(byte, -5, 5).
function decodeSharedOffset(payload: Uint8Array): Tup {
  const ox = payload[2] !== 0 ? scaleLinear(payload[2], -5.0, 5.0) : 0.0;
  const oy = payload[3] !== 0 ? scaleLinear(payload[3], -5.0, 5.0) : 0.0;
  const oz = payload[4] !== 0 ? scaleLinear(payload[4], -5.0, 5.0) : 0.0;
  return new Tup([new Flt(ox), new Flt(oy), new Flt(oz)]);
}

function wellInt(byte: number): number {
  const [row, col] = decodeWell(byte);
  return row * 12 + col; // round-trips back to `byte`; kept per PLR-side form.
}

// --- PIP.pick_up_tips (0x60005001) / drop_tips (0x60005002) -----------------

function lowerTips(methodName: string, payload: Uint8Array): PlrCall {
  if (payload.length < 5) throw new Error(`PIP.${methodName} payload must be >= 5 bytes`);
  const n = payload[0];
  if (payload.length !== 5 + n) {
    throw new Error(`PIP.${methodName} payload mismatch: n=${n}, got ${payload.length}`);
  }
  if (!(n >= 1 && n <= 8)) throw new Error(`PIP.${methodName} channel_count must be 1..8, got ${n}`);
  const role = payload[1];
  const offsetsShared = decodeSharedOffset(payload);
  const tipSpots: unknown[] = [];
  const useChannels: number[] = [];
  const offsets: unknown[] = [];
  for (let ch = 0; ch < n; ch++) {
    tipSpots.push(new Tup([new RoleRef(role), wellInt(payload[5 + ch])]));
    useChannels.push(ch);
    offsets.push(offsetsShared);
  }
  return {
    method_name: methodName,
    kwargs: { tip_spots: tipSpots, use_channels: useChannels, offsets },
  };
}

// --- PIP.aspirate (0x60005003) / dispense (0x60005004) ----------------------

function lowerAspDisp(methodName: string, payload: Uint8Array): PlrCall {
  if (payload.length < 5) throw new Error(`PIP.${methodName} payload must be >= 5 bytes`);
  const n = payload[0];
  if (payload.length !== 5 + 4 * n) {
    throw new Error(`PIP.${methodName} payload mismatch: n=${n}, got ${payload.length}`);
  }
  if (!(n >= 1 && n <= 8)) throw new Error(`PIP.${methodName} channel_count must be 1..8, got ${n}`);
  const role = payload[1];
  const offsetsShared = decodeSharedOffset(payload);
  const wells = payload.subarray(5, 5 + n);
  const volsB = payload.subarray(5 + n, 5 + 2 * n);
  const ratesB = payload.subarray(5 + 2 * n, 5 + 3 * n);
  const heightsB = payload.subarray(5 + 3 * n, 5 + 4 * n);

  const resources: unknown[] = [];
  const vols: unknown[] = [];
  const useChannels: number[] = [];
  const flowRates: unknown[] = [];
  const offsets: unknown[] = [];
  const liquidHeight: unknown[] = [];
  for (let ch = 0; ch < n; ch++) {
    resources.push(new Tup([new RoleRef(role), wellInt(wells[ch])]));
    vols.push(new Flt(scaleLog(volsB[ch], 1.0, 300.0)));
    useChannels.push(ch);
    flowRates.push(
      ratesB[ch] === DEFAULT_SENTINEL ? null : new Flt(scaleLog(ratesB[ch], 1.0, 300.0)),
    );
    offsets.push(offsetsShared);
    liquidHeight.push(
      heightsB[ch] === DEFAULT_SENTINEL ? null : new Flt(scaleLog(heightsB[ch], 0.1, 50.0)),
    );
  }
  return {
    method_name: methodName,
    kwargs: {
      resources,
      vols,
      use_channels: useChannels,
      flow_rates: flowRates,
      offsets,
      liquid_height: liquidHeight,
    },
  };
}

// --- Absorbance.read (0x60006001) -------------------------------------------

function lowerAbsorbanceRead(payload: Uint8Array): PlrCall {
  if (payload.length !== 3) throw new Error(`Absorbance.read payload must be 3 bytes, got ${payload.length}`);
  const plateRole = payload[0];
  const wavelength = payload[1] | (payload[2] << 8); // uint16 LITTLE-endian
  return { method_name: "read", kwargs: { plate: new RoleRef(plateRole), wavelength } };
}

// --- GripperArm.move_resource (0x60008001) ----------------------------------

function lowerMoveResource(payload: Uint8Array): PlrCall {
  if (payload.length !== 9) throw new Error(`GripperArm.move_resource payload must be 9 bytes, got ${payload.length}`);
  const resourceRole = payload[0];
  const destRole = payload[1];
  const off = (i: number) => (payload[i] !== 0 ? scaleLinear(payload[i], -5.0, 5.0) : 0.0);
  const pdbByte = payload[8];
  const pdb = pdbByte === DEFAULT_SENTINEL ? null : new Flt(scaleLog(pdbByte, 0.1, 50.0));
  return {
    method_name: "move_resource",
    kwargs: {
      resource: new RoleRef(resourceRole),
      to: new RoleRef(destRole),
      pickup_offset: new Tup([new Flt(off(2)), new Flt(off(3)), new Flt(off(4))]),
      destination_offset: new Tup([new Flt(off(5)), new Flt(off(6)), new Flt(off(7))]),
      pickup_distance_from_bottom: pdb,
    },
  };
}

// --- TemperatureController --------------------------------------------------

function lowerSetTemperature(payload: Uint8Array): PlrCall {
  if (payload.length !== 2) throw new Error(`set_temperature payload must be 2 bytes, got ${payload.length}`);
  return {
    method_name: "set_temperature",
    kwargs: { temperature: new Flt(scaleLinear(payload[0], 0.0, 100.0)), passive: Boolean(payload[1]) },
  };
}

function lowerRequestTemperature(payload: Uint8Array): PlrCall {
  if (payload.length !== 0) throw new Error(`request_temperature payload must be empty, got ${payload.length}`);
  return { method_name: "request_temperature", kwargs: {} };
}

function lowerWaitForTemperature(payload: Uint8Array): PlrCall {
  if (payload.length !== 2) throw new Error(`wait_for_temperature payload must be 2 bytes, got ${payload.length}`);
  return {
    method_name: "wait_for_temperature",
    kwargs: { timeout: new Flt(scaleLog(payload[0], 1.0, 3600.0)), tolerance: new Flt(scaleLinear(payload[1], 0.1, 5.0)) },
  };
}

function lowerDeactivate(payload: Uint8Array): PlrCall {
  if (payload.length !== 0) throw new Error(`deactivate payload must be empty, got ${payload.length}`);
  return { method_name: "deactivate", kwargs: {} };
}

/** schema_id → lowering fn. */
export const LOWERING: ReadonlyMap<number, (p: Uint8Array) => PlrCall> = new Map([
  [0x60005001, (p: Uint8Array) => lowerTips("pick_up_tips", p)],
  [0x60005002, (p: Uint8Array) => lowerTips("drop_tips", p)],
  [0x60005003, (p: Uint8Array) => lowerAspDisp("aspirate", p)],
  [0x60005004, (p: Uint8Array) => lowerAspDisp("dispense", p)],
  [0x60006001, lowerAbsorbanceRead],
  [0x60008001, lowerMoveResource],
  [0x60002001, lowerSetTemperature],
  [0x60002002, lowerRequestTemperature],
  [0x60002003, lowerWaitForTemperature],
  [0x60002004, lowerDeactivate],
]);

/** Lower one frame; throws if the schema_id has no registered lowering. */
export function lower(schemaId: number, payload: Uint8Array): PlrCall {
  const fn = LOWERING.get(schemaId >>> 0);
  if (fn === undefined) throw new Error(`no lowering for schema 0x${(schemaId >>> 0).toString(16)}`);
  return fn(payload);
}

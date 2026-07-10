// player.ts — the invocation loop + event framework.
//
// The Player drives the RECORDING path: walk the canonical invocation frames
// in order, emit INVOCATION_STARTED, lower + dispatch each frame (wire.sleep
// is native and emits no PLR call), emit the DISPATCHED/COMPLETED pair, then
// INVOCATION_COMPLETED; finish with RUN_COMPLETED (invocation_index = len,
// invocation_name = ""). The Player owns the DISPATCHED→COMPLETED pairing and
// re-emits both back-to-back from the single call summary the adapter yields.

import type { Frame, PatchFile } from "../canonical.ts";
// Re-export the canonical shapes that appear in this module's public surface
// (runPlayer takes a PatchFile, whose closure pulls in the header/footer/frame
// interfaces) so the exec doc graph is self-contained. These are the codec's
// own exported types (see ../canonical.ts); surfacing them here does not
// redefine them.
export type { Frame, PatchFile, PatchFooter, PatchHeader } from "../canonical.ts";
import { EventType, type PlayerEvent } from "./events.ts";
import { lower, SCHEMA_NAMES, WIRE_SLEEP_SCHEMA_ID, type PlrCall } from "./lowering.ts";
import { RoleRef, Tup } from "./values.ts";
import type { Adapter } from "./adapter.ts";
import type { ResourceModel } from "./resourceModel.ts";

/** A role_ref that references a role absent from the resource model. */
export class RoleResolutionError extends Error {
  /** Build the error from a human-readable message. */
  constructor(message: string) {
    super(message);
    this.name = "RoleResolutionError";
  }
}

function hexId(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function schemaName(schemaId: number): string {
  return SCHEMA_NAMES.get(schemaId >>> 0) ?? "";
}

// Walk a lowered kwargs tree and validate every RoleRef against the RM —
// the load-time role_ref position check.
function validateRoles(call: PlrCall, rm: ResourceModel): void {
  const visit = (v: unknown): void => {
    if (v instanceof RoleRef) {
      if (!rm.hasRole(v.roleId)) {
        throw new RoleResolutionError(
          `invocation references role ${v.roleId} but resource model ${rm.id} has no such role`,
        );
      }
    } else if (v instanceof Tup) {
      v.items.forEach(visit);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    }
  };
  for (const k of Object.keys(call.kwargs)) visit(call.kwargs[k]);
}

/**
 * Drive one patch to completion, yielding the ordered Player events exactly as
 * the CLI `--json` path streams them on stdout.
 */
export async function* runPlayer(
  patch: PatchFile,
  adapter: Adapter,
  rm: ResourceModel,
): AsyncGenerator<PlayerEvent> {
  const patchId = hexId(patch.header.patchIdHash);
  const invocations: Frame[] = patch.invocations;
  const n = invocations.length;

  for (let idx = 0; idx < n; idx++) {
    const inv = invocations[idx];
    const name = schemaName(inv.schemaId);

    yield {
      event_type: EventType.INVOCATION_STARTED,
      patch_id: patchId,
      invocation_index: idx,
      invocation_name: name,
      payload: { invocation_index: idx, schema_name: name },
    };

    if (inv.schemaId === WIRE_SLEEP_SCHEMA_ID) {
      // Player-native: 2-byte big-endian seconds, zero-duration shortcut,
      // NO PLR call.
      if (inv.payload.length !== 2) {
        throw new Error(`wire.sleep payload must be 2 bytes, got ${inv.payload.length}`);
      }
      yield {
        event_type: EventType.INVOCATION_COMPLETED,
        patch_id: patchId,
        invocation_index: idx,
        invocation_name: name,
        payload: { invocation_index: idx },
      };
      continue;
    }

    const call = lower(inv.schemaId, inv.payload);
    validateRoles(call, rm);
    const summary = await adapter.lowerCall(inv.schemaId, inv.instanceId, call, rm);

    // Player emits DISPATCHED then COMPLETED back-to-back with the same call.
    for (const et of [EventType.PLR_CALL_DISPATCHED, EventType.PLR_CALL_COMPLETED] as const) {
      yield {
        event_type: et,
        patch_id: patchId,
        invocation_index: idx,
        invocation_name: name,
        payload: { call: { method_name: summary.method_name, kwargs: summary.kwargs } },
      };
    }

    yield {
      event_type: EventType.INVOCATION_COMPLETED,
      patch_id: patchId,
      invocation_index: idx,
      invocation_name: name,
      payload: { invocation_index: idx },
    };
  }

  // RUN_COMPLETED: invocation_index == len (out of range → name ""), payload {}.
  yield {
    event_type: EventType.RUN_COMPLETED,
    patch_id: patchId,
    invocation_index: n,
    invocation_name: "",
    payload: {},
  };
}

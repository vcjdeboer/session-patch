// events.ts — the Player event model + the NDJSON line serializer.
//
// Only the events the `--json` path streams on stdout are modeled:
// invocation_started / plr_call_dispatched / plr_call_completed /
// invocation_completed / run_completed. (patch_loaded / preflight_* /
// run/orchestration-root events go only to the event bus, never stdout.)

import { pyJson } from "./values.ts";

/** EventType string values — these ARE the NDJSON `event` field. */
export const EventType = {
  INVOCATION_STARTED: "invocation_started",
  INVOCATION_COMPLETED: "invocation_completed",
  PLR_CALL_DISPATCHED: "plr_call_dispatched",
  PLR_CALL_COMPLETED: "plr_call_completed",
  RUN_COMPLETED: "run_completed",
} as const;

/** The union of the five NDJSON `event` string values. */
export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

/** One Player event; its fields become the serialized NDJSON line. */
export interface PlayerEvent {
  /** Which event this is — becomes the NDJSON `event` field. */
  event_type: EventTypeValue;
  /** Hex patch id (sha of the canonical bytes' patch-id hash). */
  patch_id: string;
  /** 0-based invocation index; equals the frame count on RUN_COMPLETED. */
  invocation_index: number;
  /** Schema name of the invocation ("" on RUN_COMPLETED). */
  invocation_name: string;
  /** Value tree (may hold RoleRef / Tup / Flt); rendered by pyJson. */
  payload: Record<string, unknown>;
}

/**
 * Serialize one event to its NDJSON line:
 * `{event, patch_id, invocation_index, invocation_name, payload}` rendered
 * with the standard ", "/": " separators and float formatting.
 */
export function serializeEvent(ev: PlayerEvent): string {
  return pyJson({
    event: ev.event_type,
    patch_id: ev.patch_id,
    invocation_index: ev.invocation_index,
    invocation_name: ev.invocation_name,
    payload: ev.payload,
  });
}

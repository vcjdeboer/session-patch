// run.ts — the run entrypoint.
//
//   runPatch(canonicalBytes, adapter, resourceModel) -> NDJSON lines[]
//
// Parses the sealed canonical patch bytes with the codec, drives the
// Player + injected adapter, and serializes each event to the NDJSON line
// shape of the `--json` output.

import { parse } from "../canonical.ts";
import { serializeEvent } from "./events.ts";
import { runPlayer } from "./player.ts";
import type { Adapter } from "./adapter.ts";
import { neutralAdapter } from "./adapter.ts";
import {
  loadResourceModel,
  ResourceModel,
  type ResourceModelJson,
} from "./resourceModel.ts";

export { neutralAdapter, legacyAdapter, v1b1Adapter, adapterFor } from "./adapter.ts";
export { loadResourceModel, ResourceModel } from "./resourceModel.ts";
export type { Adapter } from "./adapter.ts";
export type { PlayerEvent } from "./events.ts";

/**
 * Run a sealed canonical patch through the execution core.
 *
 * @param canonicalBytes  the `.patch` bytes (header + invocations + footer).
 * @param adapter         injected adapter (defaults to the neutral adapter).
 * @param resourceModel   a loaded ResourceModel or its `resource-model show
 *                        --json` document.
 * @returns the ordered NDJSON lines (one event per line), matching the
 *          `run <sha> --json` stdout stream call-for-call.
 */
export async function runPatch(
  canonicalBytes: Uint8Array,
  adapter: Adapter = neutralAdapter,
  resourceModel: ResourceModel | ResourceModelJson,
): Promise<string[]> {
  const rm = resourceModel instanceof ResourceModel
    ? resourceModel
    : loadResourceModel(resourceModel);

  const patch = await parse(canonicalBytes);

  const lines: string[] = [];
  for await (const ev of runPlayer(patch, adapter, rm)) {
    lines.push(serializeEvent(ev));
  }
  return lines;
}

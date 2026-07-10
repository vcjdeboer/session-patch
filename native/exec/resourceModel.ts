// resourceModel.ts — resource-model loader + role-resolution scaffold.
//
// Loads the JSON emitted by the engine's `resource-model show <ref>` (e.g.
// wur_flex_bca@1.0.0) and exposes role → slot → labware resolution. The final
// role STRING representation is left to the adapter layer (per Stage-3 scope);
// this module resolves a role_id to a concrete LabwareStub (kind + name),
// which is what the legacy recording backend seeds its RNG on.

import { LabwareStub } from "./values.ts";

/** Shape of `resource-model show <ref> --json`. */
export interface ResourceModelJson {
  /** slot name → deck kind (labware type). */
  deck_slots: Record<string, string>;
  /** Content-hash id of the model, if present. */
  hash_id?: string;
  /** Model id (e.g. "wur_flex_bca"). */
  id: string;
  /** role_id → constraint expression, if declared. */
  role_constraints?: Record<string, string>;
  /** role_id → human-readable role name, if declared. */
  role_names?: Record<string, string>;
  /** role_id (string key) → slot name. */
  roles: Record<string, string>;
  /** Model version string, if present. */
  version?: string;
  /** device role_id (string key) → device metadata, if present. */
  devices?: Record<string, unknown>;
}

/**
 * kind → labware "name" — the legacy `LABWARE_FACTORIES` mapping. The name is
 * the second field of the frozen `_LabwareStub` repr that seeds the legacy
 * Absorbance RNG.
 */
const LABWARE_NAMES: Record<string, string> = {
  flex_96_tiprack_1000ul: "tip_rack",
  nest_12_reservoir_15ml: "source_reservoir",
  corning_96_wellplate_360ul_flat: "dest_plate",
  opentrons_flex_trash: "trash",
  plate_reader_station: "reader_slot",
};

/** Loaded resource model with role/device resolution. */
export class ResourceModel {
  /** Model id (e.g. "wur_flex_bca"). */
  readonly id: string;
  /** Model version string ("" if absent). */
  readonly version: string;
  /** slot name → deck kind (labware type). */
  readonly deckSlots: Record<string, string>;
  /** role_id → slot name. */
  readonly roles: Map<number, string>;
  /** The set of role_ids that are devices. */
  readonly devices: Set<number>;

  /** Build from a `resource-model show --json` document. */
  constructor(json: ResourceModelJson) {
    this.id = json.id;
    this.version = json.version ?? "";
    this.deckSlots = json.deck_slots;
    this.roles = new Map();
    for (const [k, slot] of Object.entries(json.roles)) {
      this.roles.set(Number(k), slot);
    }
    this.devices = new Set(
      Object.keys(json.devices ?? {}).map((k) => Number(k)),
    );
  }

  /** True if role_id is declared in this model (Player load-time validation). */
  hasRole(roleId: number): boolean {
    return this.roles.has(roleId);
  }

  /** Resolve a role_id to its deck kind (labware type). */
  kindForRole(roleId: number): string {
    const slot = this.roles.get(roleId);
    if (slot === undefined) throw new Error(`role ${roleId} not in resource model ${this.id}`);
    const kind = this.deckSlots[slot];
    if (kind === undefined) throw new Error(`slot ${slot} has no deck kind`);
    return kind;
  }

  /**
   * Resolve a role_id to a LabwareStub (kind + factory name) — the object the
   * legacy recording backend receives after RoleRef resolution.
   */
  resolveLabware(roleId: number): LabwareStub {
    const kind = this.kindForRole(roleId);
    const name = LABWARE_NAMES[kind];
    if (name === undefined) {
      throw new Error(`no labware factory for kind '${kind}'`);
    }
    return new LabwareStub(kind, name);
  }
}

/** Parse a `resource-model show --json` document into a ResourceModel. */
export function loadResourceModel(json: ResourceModelJson): ResourceModel {
  return new ResourceModel(json);
}

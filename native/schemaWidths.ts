// schemaWidths.ts — schema_id -> payload width table.
//
// The Patch schema registry (v5 / schema_set_version 5). This table holds the
// byte-*width* information the canonical frame parser needs to know how many
// bytes each frame consumes.
//
// Two kinds of schema:
//   - Fixed:    a constant `payloadLength`.
//   - Variable: a `prologueLength` (bytes read first) + a `payloadLengthFn`
//               that maps the prologue bytes to the TOTAL payload length
//               (including the prologue).
//
// Covers every registered schema, a superset of those exercised by the
// column_fill_demo and bca_standard_curve fixtures.

/** Width spec for one schema_id. Exactly one of payloadLength / payloadLengthFn is used. */
export interface SchemaWidth {
  /** Fixed payload length in bytes. Present for fixed-length schemas. */
  readonly payloadLength?: number;
  /** For variable-length schemas: bytes to read before calling payloadLengthFn. */
  readonly prologueLength?: number;
  /**
   * For variable-length schemas: maps the prologue bytes to the TOTAL payload
   * length (including the prologue). Must return an int >= prologueLength.
   * Throws on an invalid prologue.
   */
  readonly payloadLengthFn?: (prologue: Uint8Array) => number;
}

/**
 * Thrown when a schema_id has no registered width spec. A distinct error type
 * (extends {@link Error}, NOT CanonicalParseError) — schema-not-found is
 * deliberately kept separate from structural parse errors.
 */
export class SchemaNotFoundError extends Error {
  /** Construct from the unregistered schema_id (rendered as hex in the message). */
  constructor(schemaId: number) {
    super(`no schema registered for id 0x${(schemaId >>> 0).toString(16).padStart(8, "0")}`);
    this.name = "SchemaNotFoundError";
  }
}

// --- variable-length payload_length_fn implementations ----------------------

// PIP.pick_up_tips (0x60005001) / PIP.drop_tips (0x60005002): 5 + N, N=1..8.
function pipChannelsPlus5(prologue: Uint8Array): number {
  const n = prologue[0];
  if (!(n >= 1 && n <= 8)) {
    throw new Error(`PIP channel count must be 1..8, got ${n}`);
  }
  return 5 + n;
}

// PIP.aspirate (0x60005003) / PIP.dispense (0x60005004): 5 + 4N, N=1..8.
function pipChannelsPlus5x4(prologue: Uint8Array): number {
  const n = prologue[0];
  if (!(n >= 1 && n <= 8)) {
    throw new Error(`PIP channel count must be 1..8, got ${n}`);
  }
  return 5 + 4 * n;
}

// PIP.transfer (0x60005005): 6 + 3N, N=1..96.
function pipTransferLength(prologue: Uint8Array): number {
  const n = prologue[0];
  if (!(n >= 1 && n <= 96)) {
    throw new Error(`PIP.transfer target count must be 1..96, got ${n}`);
  }
  return 6 + 3 * n;
}

// Luminescence.read ext (0x60007002): 3-byte prologue (plate_role, focal_height, selector).
function luminescenceReadExtLength(prologue: Uint8Array): number {
  const selector = prologue[2];
  if (selector === 0x00) return 3;
  if (selector === 0x01) return 3 + 1 + 4;
  throw new Error(
    `Luminescence.read(ext) selector reserved value 0x${selector.toString(16).padStart(2, "0")} (only 0x00, 0x01 defined)`,
  );
}

// --- the width table --------------------------------------------------------

/**
 * The schema_id -> {@link SchemaWidth} registry: byte-width info for every
 * schema the canonical frame parser may encounter. Keys are 32-bit schema_ids.
 */
export const SCHEMA_WIDTHS: ReadonlyMap<number, SchemaWidth> = new Map<number, SchemaWidth>([
  // plr-legacy compound (0x40 namespace)
  [0x40000001, { payloadLength: 13 }], // transfer
  [0x40000002, { payloadLength: 8 }], // incubate
  [0x40000003, { payloadLength: 16 }], // plate_read

  // plr-v1b1 Capability (0x60 namespace)
  [0x60002001, { payloadLength: 2 }], // TemperatureController.set_temperature
  [0x60002002, { payloadLength: 0 }], // TemperatureController.request_temperature
  [0x60002003, { payloadLength: 2 }], // TemperatureController.wait_for_temperature
  [0x60002004, { payloadLength: 0 }], // TemperatureController.deactivate
  [0x60003001, { payloadLength: 2 }], // Shaker.shake
  [0x60003002, { payloadLength: 0 }], // Shaker.stop_shaking
  [0x60005001, { prologueLength: 1, payloadLengthFn: pipChannelsPlus5 }], // PIP.pick_up_tips
  [0x60005002, { prologueLength: 1, payloadLengthFn: pipChannelsPlus5 }], // PIP.drop_tips
  [0x60005003, { prologueLength: 1, payloadLengthFn: pipChannelsPlus5x4 }], // PIP.aspirate
  [0x60005004, { prologueLength: 1, payloadLengthFn: pipChannelsPlus5x4 }], // PIP.dispense
  [0x60005005, { prologueLength: 1, payloadLengthFn: pipTransferLength }], // PIP.transfer
  [0x60006001, { payloadLength: 3 }], // Absorbance.read
  [0x60007001, { payloadLength: 2 }], // Luminescence.read (legacy fixed)
  [0x60007002, { prologueLength: 3, payloadLengthFn: luminescenceReadExtLength }], // Luminescence.read (ext)
  [0x60008001, { payloadLength: 9 }], // GripperArm.move_resource

  // wire native (0x70 namespace)
  [0x70000000, { payloadLength: 52 }], // patch.header
  [0x70000001, { payloadLength: 32 }], // patch.footer
  [0x70000002, { payloadLength: 2 }], // wire.sleep

  // device locality (0x80 namespace)
  [0x80001001, { payloadLength: 6 }], // ByonoyL96 led.set_color
]);

/**
 * Look up the width spec for a schema_id. Throws SchemaNotFoundError if the
 * schema is not registered.
 */
export function getSchemaWidth(schemaId: number): SchemaWidth {
  const w = SCHEMA_WIDTHS.get(schemaId >>> 0);
  if (w === undefined) throw new SchemaNotFoundError(schemaId);
  return w;
}

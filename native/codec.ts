// codec.ts — codec façade: sniff encoding by first byte + decode/encode dispatch.
//
// Auto-detection rule (R-009):
//   1. First byte == 0xF0            -> SysEx 1.
//   2. First-byte high nybble == 0x5 -> UMP (SysEx 8 message-type).
//   3. Otherwise                     -> raw canonical.
//   4. Empty input or a standalone leading 0xF7 -> error.

import * as sysex1 from "./sysex1.ts";
import * as ump from "./ump.ts";

/**
 * Wire encoding selector for {@link decode}:
 * - `"auto"` — sniff the encoding from the first byte.
 * - `"sysex1"` — MIDI 1.0 SysEx (F0/F7 envelope).
 * - `"ump"` — MIDI 2.0 Universal MIDI Packet (SysEx 8).
 * - `"canonical"` — raw canonical bytes, no envelope.
 */
export type Encoding = "auto" | "sysex1" | "ump" | "canonical";

/** Thrown when {@link sniffEncoding} cannot determine the encoding (empty input or a standalone leading 0xF7). */
export class CodecAutoDetectError extends Error {
  /** Construct with a message describing why detection failed. */
  constructor(message: string) {
    super(message);
    this.name = "CodecAutoDetectError";
  }
}

/** Return one of 'sysex1', 'ump', 'canonical'. */
export function sniffEncoding(data: Uint8Array): "sysex1" | "ump" | "canonical" {
  if (data.length === 0) {
    throw new CodecAutoDetectError("empty input — no encoding to detect");
  }
  const first = data[0];
  if (first === 0xf0) return "sysex1";
  if ((first & 0xf0) === 0x50) return "ump";
  if (first === 0xf7) {
    throw new CodecAutoDetectError("input begins with 0xF7 standalone — not a valid encoding");
  }
  // The schema set uses high-byte 0x40/0x60/0x70/0x80 — none collide with 0x50..0x5F.
  return "canonical";
}

/**
 * Decode wire bytes to canonical bytes.
 * encoding: 'auto' (default — sniff first byte), 'sysex1', 'ump', or 'canonical'.
 */
export function decode(data: Uint8Array, encoding: Encoding = "auto"): Uint8Array {
  const enc: Exclude<Encoding, "auto"> = encoding === "auto" ? sniffEncoding(data) : encoding;
  if (enc === "sysex1") return sysex1.decode(data);
  if (enc === "ump") return ump.decode(data);
  if (enc === "canonical") return data.slice();
  throw new Error(`unknown encoding ${enc}`);
}

/**
 * Encode canonical bytes to a wire format.
 * encoding: 'ump' (default, primary), 'sysex1' (legacy/Juno), or 'canonical' (no envelope).
 */
export function encode(
  canonicalBytes: Uint8Array,
  encoding: "ump" | "sysex1" | "canonical" = "ump",
): Uint8Array {
  if (encoding === "ump") return ump.encode(canonicalBytes);
  if (encoding === "sysex1") return sysex1.encode(canonicalBytes);
  if (encoding === "canonical") return canonicalBytes.slice();
  throw new Error(`unknown encoding ${encoding}`);
}

// Re-export the canonical surface so callers get the whole codec from here.
export {
  CanonicalParseError,
  ContentHashError,
  emit,
  emitFrame,
  FOOTER_PAYLOAD_LENGTH,
  FOOTER_SCHEMA_ID,
  type Frame,
  HEADER_PAYLOAD_LENGTH,
  HEADER_SCHEMA_ID,
  parse,
  parseFrame,
  type PatchFile,
  type PatchFooter,
  type PatchHeader,
  patchId,
  patchIdHex,
  V1_1_SCHEMA_SET_VERSION,
} from "./canonical.ts";

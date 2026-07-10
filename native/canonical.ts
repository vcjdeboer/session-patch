// canonical.ts — canonical 8-bit frame layer (the single source of truth
// above the wire).
//
// Frame layout (v3 wire format, 046), big-endian throughout:
//     <schema_id:4 big-endian><instance_id:1><payload:N>
// where N = payload width per schema_id (looked up in schemaWidths.ts).
//
// No F0/F7 envelope — that's SysEx 1 framing, not canonical framing.
// Payload bytes are 0..255. Hash fields are full-width, no masking.

import { getSchemaWidth } from "./schemaWidths.ts";

// --- constants --------------------------------------------------------------

/** Header frame schema_id (wire.header) — native wire namespace 0x70. */
export const HEADER_SCHEMA_ID = 0x70000000;
/** Footer frame schema_id (wire.footer) — native wire namespace 0x70. */
export const FOOTER_SCHEMA_ID = 0x70000001;

/** Header payload width in bytes (v1.1, unchanged in v1.13): 2 + 16 + 16 + 16 + 2 = 52. */
export const HEADER_PAYLOAD_LENGTH = 52; // 2 + 16 + 16 + 16 + 2
/** Footer payload width in bytes (v1.1, unchanged in v1.13): the full SHA-256 digest = 32. */
export const FOOTER_PAYLOAD_LENGTH = 32; // full SHA-256

/** v5 (064) schema set version. v2/v3/v4 patches are fast-rejected. */
export const V1_1_SCHEMA_SET_VERSION = 5;

/** Native schema_id partition — full namespace 0x70xxxxxx. */
const NATIVE_NAMESPACE = 0x70;

/** Frame header width: 4-byte schema_id + 1-byte instance_id = 5 bytes. */
const FRAME_HEADER_LEN = 5;

/** The only native invocation frame allowed mid-stream (wire.sleep). */
const WIRE_SLEEP_SCHEMA_ID = 0x70000002;

// --- exceptions -------------------------------------------------------------

/**
 * Thrown when canonical patch bytes are structurally invalid: a frame is
 * truncated, the header/footer schema_ids or ordering are wrong, an
 * invocation frame is not allowed mid-stream, or the header payload fails
 * validation (bad schema_set_version, wrong length).
 */
export class CanonicalParseError extends Error {
  /** Construct with a message describing the structural violation. */
  constructor(message: string) {
    super(message);
    this.name = "CanonicalParseError";
  }
}

/**
 * Thrown when the footer's stored SHA-256 does not match the digest recomputed
 * over the header + invocation frames (the patch content was altered).
 * A subtype of {@link CanonicalParseError}.
 */
export class ContentHashError extends CanonicalParseError {
  /** Construct with a message describing the hash mismatch. */
  constructor(message: string) {
    super(message);
    this.name = "ContentHashError";
  }
}

// --- data structures --------------------------------------------------------

/** One canonical frame. */
export interface Frame {
  /** 32-bit identifier. */
  readonly schemaId: number;
  /** 0..255 (device_role in v5; instance_id historically). */
  readonly instanceId: number;
  /** Schema-determined body, one byte 0..255 each. */
  readonly payload: Uint8Array;
}

/** v1.1 header frame (schema_id 0x70000000 — wire.header). */
export interface PatchHeader {
  /** Schema set version; must equal {@link V1_1_SCHEMA_SET_VERSION} (5). */
  readonly schemaSetVersion: number;
  /** 16-byte hash identifying the patch's authoring source. */
  readonly patchIdHash: Uint8Array;
  /** 16-byte identifier of the resource model this patch targets. */
  readonly resourceModelId: Uint8Array;
  /** 16-byte reference to the patch this one derives from; all-zero = root. */
  readonly derivedFromRef: Uint8Array;
  /** Monotonic patch version number (0..65535). */
  readonly patchVersion: number;
  /** Frame instance_id (device_role in v5), 0..255. */
  readonly instanceId: number;
}

/** v1.1 footer frame (schema_id 0x70000001 — wire.footer). */
export interface PatchFooter {
  /** Full 32-byte SHA-256 over the header + invocation frames. */
  readonly contentHash: Uint8Array;
}

/** A parsed canonical patch. */
export interface PatchFile {
  /** The parsed header frame. */
  readonly header: PatchHeader;
  /** The invocation frames between header and footer, in order. */
  readonly invocations: Frame[];
  /** The parsed footer frame carrying the verified content hash. */
  readonly footer: PatchFooter;
  /**
   * The exact bytes the footer's SHA-256 is computed over: the header frame
   * followed by all invocation frames (canonical, no envelope).
   */
  readonly contentHashPreimage: Uint8Array;
}

// --- helpers ----------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(buf);
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function schemaHex(schemaId: number): string {
  return `0x${(schemaId >>> 0).toString(16).padStart(8, "0")}`;
}

// --- frame parse / emit -----------------------------------------------------

/**
 * Parse one frame starting at `position` in `data`.
 * Returns [frame, nextPosition]. Schema-driven: looks up payload width in the
 * registry to know exactly how many bytes the frame consumes.
 */
export function parseFrame(data: Uint8Array, position = 0): [Frame, number] {
  if (position + FRAME_HEADER_LEN > data.length) {
    throw new CanonicalParseError(
      `frame at offset ${position} truncated before schema_id+instance_id`,
    );
  }
  const schemaId = ((data[position] << 24) |
    (data[position + 1] << 16) |
    (data[position + 2] << 8) |
    data[position + 3]) >>> 0;

  // Look up width (throws SchemaNotFoundError, re-raised as-is).
  const width = getSchemaWidth(schemaId);

  const instanceId = data[position + 4];

  let payloadLength: number;
  if (width.payloadLengthFn !== undefined) {
    const prologue = width.prologueLength ?? 0;
    const prologueStart = position + FRAME_HEADER_LEN;
    const prologueEnd = prologueStart + prologue;
    if (prologueEnd > data.length) {
      throw new CanonicalParseError(
        `frame at offset ${position} (schema ${schemaHex(schemaId)}, ` +
          `variable-length, prologue ${prologue} bytes) truncated`,
      );
    }
    const prologueBytes = data.subarray(prologueStart, prologueEnd);
    try {
      payloadLength = width.payloadLengthFn(prologueBytes);
    } catch (exc) {
      throw new CanonicalParseError(
        `frame at offset ${position} (schema ${schemaHex(schemaId)}): ` +
          `payload_length_fn raised: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
    if (!Number.isInteger(payloadLength) || payloadLength < prologue) {
      throw new CanonicalParseError(
        `frame at offset ${position} (schema ${schemaHex(schemaId)}): ` +
          `payload_length_fn returned ${payloadLength}; must be int >= prologue_length (${prologue})`,
      );
    }
  } else {
    payloadLength = width.payloadLength ?? 0;
  }

  const payloadEnd = position + FRAME_HEADER_LEN + payloadLength;
  if (payloadEnd > data.length) {
    throw new CanonicalParseError(
      `frame at offset ${position} (schema ${schemaHex(schemaId)}, ` +
        `payload ${payloadLength} bytes) truncated`,
    );
  }
  const payload = data.slice(position + FRAME_HEADER_LEN, payloadEnd);
  return [{ schemaId, instanceId, payload }, payloadEnd];
}

/** Serialize one frame to canonical bytes (no envelope). */
export function emitFrame(frame: Frame): Uint8Array {
  if (!(frame.schemaId >= 0 && frame.schemaId < 0x100000000)) {
    throw new Error(`schema_id must fit in 32 bits, got ${frame.schemaId}`);
  }
  if (!(frame.instanceId >= 0 && frame.instanceId <= 255)) {
    throw new Error(`instance_id must fit in 8 bits (0..255), got ${frame.instanceId}`);
  }
  const out = new Uint8Array(FRAME_HEADER_LEN + frame.payload.length);
  out[0] = (frame.schemaId >>> 24) & 0xff;
  out[1] = (frame.schemaId >>> 16) & 0xff;
  out[2] = (frame.schemaId >>> 8) & 0xff;
  out[3] = frame.schemaId & 0xff;
  out[4] = frame.instanceId;
  out.set(frame.payload, FRAME_HEADER_LEN);
  return out;
}

// --- header parse / emit ----------------------------------------------------

function parseHeaderPayload(payload: Uint8Array, instanceId: number): PatchHeader {
  if (payload.length !== HEADER_PAYLOAD_LENGTH) {
    throw new CanonicalParseError(
      `header payload must be ${HEADER_PAYLOAD_LENGTH} bytes, got ${payload.length}`,
    );
  }
  const schemaSetVersion = (payload[0] << 8) | payload[1];
  if (schemaSetVersion !== V1_1_SCHEMA_SET_VERSION) {
    if (schemaSetVersion === 1) {
      throw new CanonicalParseError(
        "v1 patch presented to v3 reader (schema_set_version=1); rebuild the patch with the v1.13 builder",
      );
    }
    if (schemaSetVersion === 2) {
      throw new CanonicalParseError(
        `v2 schema_set_version (${schemaSetVersion}) is not supported by v4 parser; ` +
          `046 introduced 32-bit schema_ids — v2 Patches must stay on v1.12`,
      );
    }
    if (schemaSetVersion === 3) {
      throw new CanonicalParseError(
        "v3 patch presented to v4 reader (schema_set_version=3); 049 retired the compound schemas",
      );
    }
    if (schemaSetVersion === 4) {
      throw new CanonicalParseError(
        "schema_set_version=4 patches are not loadable under v5. Regenerate from source YAML against v5 schemas.",
      );
    }
    if (schemaSetVersion > V1_1_SCHEMA_SET_VERSION) {
      throw new CanonicalParseError(
        `future schema_set_version (${schemaSetVersion}) not supported by this parser; upgrade to read it`,
      );
    }
    throw new CanonicalParseError(
      `unknown schema_set_version ${schemaSetVersion}; current parser expects ${V1_1_SCHEMA_SET_VERSION}`,
    );
  }
  return {
    schemaSetVersion,
    patchIdHash: payload.slice(2, 18),
    resourceModelId: payload.slice(18, 34),
    derivedFromRef: payload.slice(34, 50),
    patchVersion: (payload[50] << 8) | payload[51],
    instanceId,
  };
}

function emitHeaderPayload(header: PatchHeader): Uint8Array {
  if (header.patchIdHash.length !== 16) {
    throw new Error(`patch_id_hash must be 16 bytes, got ${header.patchIdHash.length}`);
  }
  if (header.resourceModelId.length !== 16) {
    throw new Error(`resource_model_id must be 16 bytes, got ${header.resourceModelId.length}`);
  }
  if (header.derivedFromRef.length !== 16) {
    throw new Error(`derived_from_ref must be 16 bytes, got ${header.derivedFromRef.length}`);
  }
  if (!(header.schemaSetVersion >= 0 && header.schemaSetVersion <= 0xffff)) {
    throw new Error("schema_set_version must fit in 16 bits");
  }
  if (!(header.patchVersion >= 0 && header.patchVersion <= 0xffff)) {
    throw new Error("patch_version must fit in 16 bits");
  }
  if (header.schemaSetVersion !== V1_1_SCHEMA_SET_VERSION) {
    throw new Error(
      `v4 builder must write schema_set_version=${V1_1_SCHEMA_SET_VERSION}, got ${header.schemaSetVersion}`,
    );
  }
  const out = new Uint8Array(HEADER_PAYLOAD_LENGTH);
  out[0] = (header.schemaSetVersion >> 8) & 0xff;
  out[1] = header.schemaSetVersion & 0xff;
  out.set(header.patchIdHash, 2);
  out.set(header.resourceModelId, 18);
  out.set(header.derivedFromRef, 34);
  out[50] = (header.patchVersion >> 8) & 0xff;
  out[51] = header.patchVersion & 0xff;
  return out;
}

// --- file parse / emit ------------------------------------------------------

/**
 * Parse a complete canonical patch (header + invocations + footer).
 * Validates the footer's full 32-byte SHA-256 against the recomputed digest.
 * Async because SHA-256 uses Web Crypto (crypto.subtle.digest).
 */
export async function parse(data: Uint8Array): Promise<PatchFile> {
  const frames: Frame[] = [];
  let pos = 0;
  const n = data.length;
  while (pos < n) {
    const [frame, next] = parseFrame(data, pos);
    frames.push(frame);
    pos = next;
  }

  if (frames.length < 2) {
    throw new CanonicalParseError(
      `patch must have at least 2 frames (header + footer), got ${frames.length}`,
    );
  }
  if (frames[0].schemaId !== HEADER_SCHEMA_ID) {
    throw new CanonicalParseError(
      `first frame schema_id must be ${schemaHex(HEADER_SCHEMA_ID)}, got ${schemaHex(frames[0].schemaId)}`,
    );
  }
  if (frames[frames.length - 1].schemaId !== FOOTER_SCHEMA_ID) {
    throw new CanonicalParseError(
      `last frame schema_id must be ${schemaHex(FOOTER_SCHEMA_ID)}, got ${schemaHex(frames[frames.length - 1].schemaId)}`,
    );
  }
  for (const f of frames.slice(1, -1)) {
    // Native = top byte 0x70. Header/footer are NOT allowed mid-stream.
    // wire.sleep (0x70000002) is the sole allowed native invocation frame.
    if (((f.schemaId >>> 24) & 0xff) === NATIVE_NAMESPACE) {
      if (f.schemaId === WIRE_SLEEP_SCHEMA_ID) continue;
      throw new CanonicalParseError(
        `invocation frame at native schema_id ${schemaHex(f.schemaId)} not allowed`,
      );
    }
  }

  const header = parseHeaderPayload(frames[0].payload, frames[0].instanceId);
  const footerFrame = frames[frames.length - 1];
  if (footerFrame.payload.length !== FOOTER_PAYLOAD_LENGTH) {
    throw new CanonicalParseError(
      `footer payload must be ${FOOTER_PAYLOAD_LENGTH} bytes, got ${footerFrame.payload.length}`,
    );
  }
  const footer: PatchFooter = { contentHash: footerFrame.payload };

  const invocations = frames.slice(1, -1);

  // The bytes the footer hashes over are header + all invocations (canonical, no envelope).
  const parts: Uint8Array[] = [emitFrame(frames[0])];
  for (const inv of invocations) parts.push(emitFrame(inv));
  const rawBytes = concat(parts);
  const computed = await sha256(rawBytes);
  if (!bytesEqual(computed, footer.contentHash)) {
    throw new ContentHashError(
      `content hash mismatch: expected ${toHex(computed)}, got ${toHex(footer.contentHash)}`,
    );
  }

  return {
    header,
    invocations,
    footer,
    contentHashPreimage: rawBytes,
  };
}

/**
 * Serialize a complete canonical patch. Computes the full 32-byte SHA-256
 * content hash internally and writes the footer.
 * Async because SHA-256 uses Web Crypto.
 */
export async function emit(header: PatchHeader, invocations: Frame[]): Promise<Uint8Array> {
  const headerFrame: Frame = {
    schemaId: HEADER_SCHEMA_ID,
    instanceId: header.instanceId,
    payload: emitHeaderPayload(header),
  };

  const parts: Uint8Array[] = [emitFrame(headerFrame)];
  for (const inv of invocations) parts.push(emitFrame(inv));
  const body = concat(parts);

  const digest = await sha256(body);
  const footerFrame: Frame = {
    schemaId: FOOTER_SCHEMA_ID,
    instanceId: 0,
    payload: digest,
  };
  return concat([body, emitFrame(footerFrame)]);
}

// --- identity ---------------------------------------------------------------

/**
 * The raw 64-hex SHA-256 of the canonical patch bytes. This hex IS the .patch
 * filename / the patch identity.
 */
export async function patchIdHex(canonicalBytes: Uint8Array): Promise<string> {
  return toHex(await sha256(canonicalBytes));
}

/**
 * The "sha256:"-prefixed patch identity (matches manifest.patch_id):
 * `sha256:` + hex(sha256(canonical_bytes)).
 */
export async function patchId(canonicalBytes: Uint8Array): Promise<string> {
  return "sha256:" + (await patchIdHex(canonicalBytes));
}

// --- internal ---------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

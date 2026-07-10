// sysex1.ts — MIDI 1.0 SysEx codec (canonical <-> SysEx1 wire).
//
// Wraps canonical bytes in F0/F7 envelopes with 7-byte-group MSB packing so
// the wire bytes satisfy the MIDI 1.0 invariant (top bit clear on every data
// byte). Round-trips losslessly to/from canonical.
//
// The 7-byte-group MSB packing is the Roland convention:
//   For every 7 canonical bytes b0..b6, emit 8 wire bytes:
//     msb_byte = sum over i of (b_i >> 7) << i   (top bits collected)
//     then b0&0x7F, b1&0x7F, ..., b6&0x7F        (data with top bit cleared)
//   Final partial group of k < 7 bytes: 1 + k wire bytes.

const F0 = 0xf0;
const F7 = 0xf7;

/** v1.1 manufacturer ID — MMA "non-commercial / educational" range. */
const MANUFACTURER_ID_NONCOMMERCIAL = 0x7d;

/**
 * Thrown when SysEx 1 wire bytes are malformed: the F0/F7 envelope is missing
 * or too short, a byte between the delimiters violates the 7-bit data
 * invariant, or a packed group has a top bit set during unpacking.
 */
export class SysEx1ParseError extends Error {
  /** Construct with a message describing the SysEx 1 wire-format violation. */
  constructor(message: string) {
    super(message);
    this.name = "SysEx1ParseError";
  }
}

// --- 7-byte-group MSB packing -----------------------------------------------

/** Pack 8-bit canonical bytes into the MIDI 1.0 7-bit wire form. */
export function pack7bit(canonicalBytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = canonicalBytes.length;
  let i = 0;
  while (i < n) {
    const group = canonicalBytes.subarray(i, i + 7);
    let msb = 0;
    for (let j = 0; j < group.length; j++) {
      if (group[j] >> 7) msb |= 1 << j;
    }
    out.push(msb);
    for (const b of group) out.push(b & 0x7f);
    i += 7;
  }
  return Uint8Array.from(out);
}

/** Inverse of pack7bit. Strict: rejects bytes with top bit set. */
export function unpack7bit(packedBytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = packedBytes.length;
  let i = 0;
  while (i < n) {
    const msb = packedBytes[i];
    if (msb & 0x80) {
      throw new SysEx1ParseError(
        `packed MSB byte at offset ${i} has top bit set: 0x${msb.toString(16).padStart(2, "0")}`,
      );
    }
    const dataCount = Math.min(7, n - i - 1);
    for (let j = 0; j < dataCount; j++) {
      const wireB = packedBytes[i + 1 + j];
      if (wireB & 0x80) {
        throw new SysEx1ParseError(
          `packed data byte at offset ${i + 1 + j} has top bit set: 0x${wireB.toString(16).padStart(2, "0")}`,
        );
      }
      const topBit = (msb >> j) & 1;
      out.push(wireB | (topBit << 7));
    }
    i += 1 + dataCount;
  }
  return Uint8Array.from(out);
}

// --- envelope encode / decode -----------------------------------------------

/** Wrap canonical bytes in `F0 <manufacturer_id> <packed> F7`. */
export function encode(
  canonicalBytes: Uint8Array,
  manufacturerId = MANUFACTURER_ID_NONCOMMERCIAL,
): Uint8Array {
  if (!(manufacturerId >= 0 && manufacturerId <= 0x7f)) {
    throw new Error(
      `manufacturer_id must be 0..0x7F for 1-byte form, got 0x${manufacturerId.toString(16).padStart(2, "0")}`,
    );
  }
  if (canonicalBytes.length === 0) throw new Error("canonical_bytes is empty");
  const packed = pack7bit(canonicalBytes);
  const out = new Uint8Array(2 + packed.length + 1);
  out[0] = F0;
  out[1] = manufacturerId;
  out.set(packed, 2);
  out[out.length - 1] = F7;
  return out;
}

/** Decode a `F0 <manufacturer_id> <packed> F7` envelope back to canonical bytes. */
export function decode(sysexBytes: Uint8Array): Uint8Array {
  if (sysexBytes.length < 3) {
    throw new SysEx1ParseError(
      `SysEx envelope must be at least 3 bytes (F0 mfg F7), got ${sysexBytes.length}`,
    );
  }
  if (sysexBytes[0] !== F0) {
    throw new SysEx1ParseError(`envelope must start with F0, got 0x${sysexBytes[0].toString(16).padStart(2, "0")}`);
  }
  if (sysexBytes[sysexBytes.length - 1] !== F7) {
    throw new SysEx1ParseError(
      `envelope must end with F7, got 0x${sysexBytes[sysexBytes.length - 1].toString(16).padStart(2, "0")}`,
    );
  }
  // All bytes between F0 and F7 (exclusive) must have top bit clear.
  for (let i = 1; i < sysexBytes.length - 1; i++) {
    if (sysexBytes[i] & 0x80) {
      throw new SysEx1ParseError(
        `envelope byte at offset ${i} violates 7-bit data invariant: 0x${sysexBytes[i].toString(16).padStart(2, "0")}`,
      );
    }
  }
  // sysexBytes[1] is the manufacturer ID; the rest is the packed payload.
  const packed = sysexBytes.subarray(2, sysexBytes.length - 1);
  return unpack7bit(packed);
}

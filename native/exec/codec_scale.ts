// codec_scale.ts — the three wire scale/decode helpers. These are the single
// source of truth for the float scaling the lowering applies.

/**
 * Linear map 0..255 → lo..hi (inclusive endpoints).
 * Symmetric convention: |lo|==|hi| ⇒ byte 128 lands on the midpoint.
 */
export function scaleLinear(byteValue: number, lo: number, hi: number): number {
  return lo + (byteValue / 255.0) * (hi - lo);
}

/** Log map 0..255 → lo..hi (lo, hi > 0). byte 0 → lo, byte 255 → hi. */
export function scaleLog(byteValue: number, lo: number, hi: number): number {
  if (lo <= 0 || hi <= 0) throw new Error("scale_log requires lo, hi > 0");
  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  return Math.exp(logLo + (byteValue / 255.0) * (logHi - logLo));
}

/** byte 0..95 → [row 0..7, col 0..11], row-major. */
export function decodeWell(byteValue: number): [number, number] {
  if (!(byteValue >= 0 && byteValue < 96)) {
    throw new Error(`well byte must be in [0, 96), got ${byteValue}`);
  }
  return [Math.floor(byteValue / 12), byteValue % 12];
}

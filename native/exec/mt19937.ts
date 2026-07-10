// mt19937.ts — MT19937 (Mersenne Twister) PRNG. Produces the recording-path
// Absorbance _returned values (legacy 1.3379, v1b1 0.528).
//
// Provides: init_genrand, init_by_array (int-seed path), genrand_uint32,
// genrand_res53 (== the [0,1) float draw), and uniform(a,b) = a+(b-a)*random().
//
// 32-bit arithmetic uses Math.imul + `>>> 0` so the products stay exact.

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/** MT19937 (Mersenne Twister) PRNG, seeded from a non-negative integer. */
export class MT19937 {
  private mt = new Uint32Array(N);
  private mti = N + 1;

  /** Seed the generator from a non-negative integer. */
  constructor(seed: number) {
    // n = abs(seed) → array of 32-bit little-endian words.
    const key: number[] = [];
    let n = Math.abs(seed);
    if (n === 0) {
      key.push(0);
    } else {
      while (n > 0) {
        key.push(n >>> 0 & 0xffffffff);
        // For seeds < 2^53 this loop peels 32-bit words; our seeds are < 2^32.
        n = Math.floor(n / 0x100000000);
      }
    }
    this.initByArray(key);
  }

  /** `init_genrand`: seed the state array from a single 32-bit word. */
  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  /** `init_by_array`: seed the state from the key words. */
  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);
    for (; k; k--) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev, 1664525)) >>> 0) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k; k--) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev, 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  /** Draw the next tempered 32-bit output (`genrand_uint32`). */
  genrandUint32(): number {
    let y: number;
    if (this.mti >= N) {
      let kk: number;
      for (kk = 0; kk < N - M; kk++) {
        y = ((this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)) >>> 0;
        this.mt[kk] = (this.mt[kk + M] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk++) {
        y = ((this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)) >>> 0;
        this.mt[kk] = (this.mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      }
      y = ((this.mt[N - 1] & UPPER_MASK) | (this.mt[0] & LOWER_MASK)) >>> 0;
      this.mt[N - 1] = (this.mt[M - 1] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }
    y = this.mt[this.mti++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** genrand_res53: a 53-bit float in [0,1). */
  random(): number {
    const a = this.genrandUint32() >>> 5; // 27 bits
    const b = this.genrandUint32() >>> 6; // 26 bits
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** random.uniform(lo, hi) = lo + (hi-lo)*random() — one random() draw. */
  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.random();
  }
}

/**
 * `round(x, 4)` — round-half-to-EVEN (banker's rounding) at 4 fractional
 * decimals. Unlike `Math.round(x*1e4)/1e4` (round-half-AWAY), exact half-way
 * ties break to the even neighbour via a decimal-correct rounding.
 *
 * Works off the 17-significant-digit decimal expansion of the IEEE-754 double
 * (17 digits uniquely identify a double and expose the 5th-decimal decision
 * digit plus its tail), so the tie decision is made on the true value rather
 * than on a lossy `x*1e4` product. Handles the full float domain, not just the
 * BCA values (which land on 0.528 and 1.3379).
 *
 * Note: a genuine binary-exact tie whose tail only resolves beyond 17 digits
 * cannot arise for these magnitudes; such a value is likewise sent to even.
 */
export function round4(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  // 17 sig digits round-trips a double and reveals the decision digit + tail.
  const [mant, expPart] = Math.abs(x).toPrecision(17).split("e");
  const exp = expPart ? parseInt(expPart, 10) : 0;
  const [ip, fp = ""] = mant.split(".");
  let digits = ip + fp;
  let point = ip.length + exp; // index in `digits` of the decimal point
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  if (digits.length < point + 6) {
    digits = digits + "0".repeat(point + 6 - digits.length);
  }
  const keepStr = digits.slice(0, point + 4); // value scaled by 1e4, truncated
  const decide = digits.charCodeAt(point + 4) - 48; // 5th decimal digit
  const tailNonZero = /[1-9]/.test(digits.slice(point + 5));
  let n = BigInt(keepStr || "0");
  if (decide > 5 || (decide === 5 && tailNonZero)) {
    n += 1n;
  } else if (decide === 5 && !tailNonZero) {
    if (n % 2n === 1n) n += 1n; // exact half → round to even
  }
  const result = Number(n) / 1e4;
  return neg ? -result : result;
}

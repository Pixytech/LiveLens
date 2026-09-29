// Fountain code over GF(2) for the frame stream.
//
// The file is split into K equal chunks. Frame i < K carries chunk i as is
// (systematic); every later frame carries the XOR of a pseudo-random subset
// of chunks, chosen from the frame index. The encoder can produce frames
// forever and the decoder needs any K independent frames, usually K + 1 or
// K + 2 of whatever the camera happened to catch. A missed frame costs
// nothing: the next one is just as useful, so there is no waiting for a
// specific frame to come round again.

// mulberry32: a small non-linear generator. A linear one (xorshift) would
// make every coefficient vector a linear function of the 32-bit seed, so
// the repair frames could never reach full rank for K > 32.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Coefficient bitset (32-bit words) for frame `index` of a K-chunk stream. */
export function coefficients(index: number, K: number): Uint32Array {
  const words = Math.ceil(K / 32);
  const c = new Uint32Array(words);
  if (index < K) {
    c[index >> 5] = 1 << (index & 31);
    return c;
  }
  const next = rng(Math.imul(index, 0x9e3779b1) ^ Math.imul(K, 0x85ebca6b));
  for (let w = 0; w < words; w++) c[w] = next();
  const tail = K & 31;
  if (tail) c[words - 1] &= (1 << tail) - 1;
  if (c.every((v) => v === 0)) c[0] = 1;
  return c;
}

/** Build the payload for frame `index` from the source chunks. */
export function encodeSymbol(chunks: Uint8Array[], index: number): Uint8Array {
  const K = chunks.length;
  const size = chunks[0].length;
  if (index < K) return chunks[index];
  const c = coefficients(index, K);
  const out = new Uint8Array(size);
  const o32 = new Uint32Array(out.buffer);
  for (let k = 0; k < K; k++) {
    if (!(c[k >> 5] & (1 << (k & 31)))) continue;
    const s = chunks[k];
    const s32 = new Uint32Array(s.buffer, s.byteOffset, size / 4);
    for (let j = 0; j < o32.length; j++) o32[j] ^= s32[j];
  }
  return out;
}

/** Split a stream into K chunks of `size` bytes (size is a multiple of 4). */
export function splitChunks(stream: Uint8Array, size: number): Uint8Array[] {
  const K = Math.max(1, Math.ceil(stream.length / size));
  const chunks: Uint8Array[] = [];
  for (let k = 0; k < K; k++) {
    const c = new Uint8Array(size);
    c.set(stream.subarray(k * size, Math.min(stream.length, (k + 1) * size)));
    chunks.push(c);
  }
  return chunks;
}

interface Row { coef: Uint32Array; data: Uint32Array; }

/** Incremental Gaussian elimination. Each received frame is reduced against
 *  the rows already held; if anything is left it becomes a new row. */
export class FountainDecoder {
  readonly K: number;
  readonly size: number;
  private pivots: (Row | undefined)[];
  private seen = new Set<number>();
  rank = 0;

  constructor(K: number, size: number) {
    this.K = K;
    this.size = size;
    this.pivots = new Array(K);
  }

  get done() { return this.rank === this.K; }

  /** Has the systematic chunk `k` arrived directly? (for early metadata) */
  chunkIfDirect(k: number): Uint8Array | null {
    const row = this.pivots[k];
    if (!row) return null;
    for (let w = 0; w < row.coef.length; w++) {
      const expect = w === k >> 5 ? 1 << (k & 31) : 0;
      if ((row.coef[w] | 0) !== (expect | 0)) return null;
    }
    return new Uint8Array(row.data.buffer.slice(0));
  }

  /** Returns true when the frame added new information. */
  add(index: number, payload: Uint8Array): boolean {
    if (this.done || this.seen.has(index) || payload.length !== this.size) return false;
    this.seen.add(index);
    const coef = coefficients(index, this.K);
    const data = new Uint32Array(payload.slice().buffer);
    for (;;) {
      const lead = lowestBit(coef);
      if (lead < 0) return false; // nothing new
      const p = this.pivots[lead];
      if (!p) {
        this.pivots[lead] = { coef, data };
        this.rank++;
        return true;
      }
      for (let w = 0; w < coef.length; w++) coef[w] ^= p.coef[w];
      for (let j = 0; j < data.length; j++) data[j] ^= p.data[j];
    }
  }

  /** Back-substitute and return the K source chunks. Call when done. */
  solve(): Uint8Array[] {
    if (!this.done) throw new Error("not enough frames yet");
    for (let k = this.K - 1; k >= 0; k--) {
      const row = this.pivots[k]!;
      for (let b = k + 1; b < this.K; b++) {
        if (!(row.coef[b >> 5] & (1 << (b & 31)))) continue;
        const other = this.pivots[b]!;
        for (let w = 0; w < row.coef.length; w++) row.coef[w] ^= other.coef[w];
        for (let j = 0; j < row.data.length; j++) row.data[j] ^= other.data[j];
      }
    }
    return this.pivots.map((r) => new Uint8Array(r!.data.buffer));
  }
}

function lowestBit(c: Uint32Array): number {
  for (let w = 0; w < c.length; w++) {
    const v = c[w];
    if (v) return w * 32 + (31 - Math.clz32(v & -v));
  }
  return -1;
}

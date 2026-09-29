// Reed-Solomon error correction over GF(2^8) - the same family of code QR
// codes use. A block of k data bytes gets `nsym` parity bytes appended; the
// decoder can then repair up to floor(nsym / 2) corrupted bytes anywhere in
// the block (codeword length n = k + nsym <= 255).
//
// Primitive polynomial 0x11d, generator roots a^0 .. a^(nsym-1).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const gdiv = (a: number, b: number) => {
  if (b === 0) throw new Error("GF divide by zero");
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const gpow = (x: number, p: number) => EXP[(((LOG[x] * p) % 255) + 255) % 255];
const ginv = (x: number) => EXP[255 - LOG[x]];

// Polynomials are arrays, highest-degree coefficient first.
function polyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++)
    for (let i = 0; i < p.length; i++) r[i + j] ^= gmul(p[i], q[j]);
  return r;
}
function polyAdd(p: number[], q: number[]): number[] {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}
function polyScale(p: number[], x: number): number[] {
  return p.map((c) => gmul(c, x));
}
function polyEval(p: number[], x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gmul(y, x) ^ p[i];
  return y;
}

const genCache = new Map<number, Uint8Array>();
function generator(nsym: number): Uint8Array {
  let g = genCache.get(nsym);
  if (!g) {
    let p = [1];
    for (let i = 0; i < nsym; i++) p = polyMul(p, [1, gpow(2, i)]);
    g = Uint8Array.from(p);
    genCache.set(nsym, g);
  }
  return g;
}

/** Returns data followed by nsym parity bytes. */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  if (data.length + nsym > 255) throw new Error("RS block too long");
  const gen = generator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      const lc = LOG[coef];
      for (let j = 1; j < gen.length; j++) {
        if (gen[j] !== 0) out[i + j] ^= EXP[lc + LOG[gen[j]]];
      }
    }
  }
  out.set(data); // restore systematic part (the loop overwrote it)
  return out;
}

export interface RsResult {
  data: Uint8Array;   // corrected message (without parity)
  corrected: number;  // number of bytes that were repaired
}

/** Decode a codeword. Returns null if it has more errors than can be fixed. */
export function rsDecode(codeword: Uint8Array, nsym: number): RsResult | null {
  const n = codeword.length;
  const msg = Array.from(codeword);

  // Syndromes
  const synd = new Array(nsym);
  let hasErr = false;
  for (let i = 0; i < nsym; i++) {
    synd[i] = polyEval(msg, gpow(2, i));
    if (synd[i] !== 0) hasErr = true;
  }
  if (!hasErr) return { data: codeword.slice(0, n - nsym), corrected: 0 };

  // Berlekamp-Massey: error locator polynomial Lambda (highest degree first).
  const S = (k: number) => (k >= 0 ? synd[k] : 0);
  let errLoc = [1];
  let oldLoc = [1];
  for (let i = 0; i < nsym; i++) {
    let delta = synd[i];
    for (let j = 1; j < errLoc.length; j++) delta ^= gmul(errLoc[errLoc.length - 1 - j], S(i - j));
    oldLoc.push(0);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, ginv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) return null;

  // Chien search on the reversed locator.
  const locRev = errLoc.slice().reverse();
  const errPos: number[] = [];
  for (let i = 0; i < n; i++) {
    if (polyEval(locRev, gpow(2, i)) === 0) errPos.push(n - 1 - i);
  }
  if (errPos.length !== errs) return null;

  // Forney algorithm for the error magnitudes (polynomials lowest degree
  // first here). Omega(x) = S(x) * Lambda(x) mod x^nsym, and with fcr = 0:
  //   e_i = Omega(1/X_i) / product over j != i of (1 + X_j / X_i)
  const coefPos = errPos.map((p) => n - 1 - p);
  const X = coefPos.map((cp) => gpow(2, cp));
  let lam = [1];
  for (const x of X) {
    const next = new Array(lam.length + 1).fill(0);
    for (let k = 0; k < lam.length; k++) {
      next[k] ^= lam[k];
      next[k + 1] ^= gmul(lam[k], x);
    }
    lam = next;
  }
  const omega = new Array(nsym).fill(0);
  for (let a = 0; a < nsym; a++)
    for (let b = 0; b < lam.length && a + b < nsym; b++) omega[a + b] ^= gmul(synd[a], lam[b]);
  const evalLow = (p: number[], x: number) => {
    let y = 0;
    for (let k = p.length - 1; k >= 0; k--) y = gmul(y, x) ^ p[k];
    return y;
  };

  for (let i = 0; i < X.length; i++) {
    const XiInv = ginv(X[i]);
    let denom = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) denom = gmul(denom, 1 ^ gmul(X[j], XiInv));
    }
    if (denom === 0) return null;
    msg[errPos[i]] ^= gdiv(evalLow(omega, XiInv), denom);
  }

  // Verify
  for (let i = 0; i < nsym; i++) if (polyEval(msg, gpow(2, i)) !== 0) return null;
  return { data: Uint8Array.from(msg.slice(0, n - nsym)), corrected: errPos.length };
}

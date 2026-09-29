// Packs bytes into a grid of black/white (or grey) cells and reads them back
// from a captured image.
//
// Grid layout (units are cells):
//   - four finder patterns (1:1:3:1:1, like QR) in the corners locate the grid
//   - rows 0-15 hold the finders and a small format header next to the
//     top-left finder: grid size, bits per cell and parity level, protected by
//     its own Reed-Solomon code, so the decoder adapts to the encoder settings
//   - every other cell carries data: whitened, Reed-Solomon protected and
//     byte-interleaved across blocks

import { rsDecode, rsEncode } from "./rs";

// Geometry constants (in cells)

export const QUIET = 4;          // white margin around the grid
const FMOD = 2;                  // cells per finder module
const FINDER = 7 * FMOD;         // finder side, cells (14)
const RESERVED = FINDER + FMOD;  // finder + separator (16)
const FC = FINDER / 2;           // finder centre offset from grid edge (7)
const HDR_ROWS = 6;              // header module rows (each module 2x2 cells)
const HDR_ROW0 = 2;              // first cell row of the header
const HDR_COL0 = RESERVED;       // first cell column of the header
const HDR_NSYM = 8;
const HDR_LEN = 9;               // bytes before RS parity
const HDR_BITS = (HDR_LEN + HDR_NSYM) * 8;
const HDR_MODCOLS = Math.ceil(HDR_BITS / HDR_ROWS);

export const MIN_COLS = RESERVED * 2 + HDR_MODCOLS * 2 + 4;
export const MIN_ROWS = RESERVED * 2 + 24;

const FRAME_MAGIC = [0x4c, 0x46]; // "LF"
const FRAME_HDR = 26;

// Small utilities

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Deterministic byte mask XORed over the data so long runs of equal bytes
 *  (e.g. zero padding) never form solid areas or fake finder patterns. */
function whitenMask(len: number): Uint8Array {
  const out = new Uint8Array(len);
  let s = 0x2545f491;
  for (let i = 0; i < len; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}
const maskCache = new Map<number, Uint8Array>();
function mask(len: number) {
  let m = maskCache.get(len);
  if (!m) { m = whitenMask(len); maskCache.set(len, m); }
  return m;
}

// Grey-level mapping for 2 bits per cell uses Gray code so a one-level
// misread only flips a single bit.
const GRAY = [0, 1, 3, 2];
const GRAY_INV = [0, 1, 3, 2];

// Layout

export interface Layout {
  cols: number;
  rows: number;
  bpc: 1 | 2;
  parity: number;              // RS parity bytes per 255-byte block
  dataCells: Int32Array;       // cell indices (r * cols + c) in fill order
  capacityBytes: number;       // raw bytes the data cells hold
  blocks: { n: number; k: number }[];
  msgCapacity: number;         // sum of k - bytes before parity
  payloadCapacity: number;     // msgCapacity - frame header
}

const layoutCache = new Map<string, Layout>();

export function makeLayout(cols: number, rows: number, bpc: 1 | 2, parity: number): Layout {
  const key = `${cols}x${rows}x${bpc}x${parity}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  if (cols < MIN_COLS || rows < MIN_ROWS) throw new Error(`Grid too small (min ${MIN_COLS}x${MIN_ROWS})`);

  const cells: number[] = [];
  for (let r = RESERVED; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r >= rows - RESERVED && (c < RESERVED || c >= cols - RESERVED)) continue;
      cells.push(r * cols + c);
    }
  }
  const capacityBytes = Math.floor((cells.length * bpc) / 8);
  const nBlocks = Math.ceil(capacityBytes / 255);
  const blocks: { n: number; k: number }[] = [];
  const base = Math.floor(capacityBytes / nBlocks);
  const extra = capacityBytes - base * nBlocks;
  for (let b = 0; b < nBlocks; b++) {
    const n = base + (b < extra ? 1 : 0);
    blocks.push({ n, k: n - parity });
  }
  if (blocks.some((b) => b.k < 1)) throw new Error("Parity too high for this grid");
  const msgCapacity = blocks.reduce((a, b) => a + b.k, 0);
  const layout: Layout = {
    cols, rows, bpc, parity,
    dataCells: Int32Array.from(cells),
    capacityBytes, blocks, msgCapacity,
    payloadCapacity: msgCapacity - FRAME_HDR,
  };
  layoutCache.set(key, layout);
  return layout;
}

/** Byte-interleave order: stream position -> (block, offset). Consecutive
 *  bytes on screen belong to different RS blocks, so a smudge that wipes
 *  out a patch of cells costs each block only a byte or two. */
function interleave(layout: Layout): { block: Uint16Array; offset: Uint16Array } {
  const total = layout.capacityBytes;
  const block = new Uint16Array(total);
  const offset = new Uint16Array(total);
  const maxN = Math.max(...layout.blocks.map((b) => b.n));
  let i = 0;
  for (let o = 0; o < maxN; o++) {
    for (let b = 0; b < layout.blocks.length; b++) {
      if (o < layout.blocks[b].n) { block[i] = b; offset[i] = o; i++; }
    }
  }
  return { block, offset };
}
const ilCache = new WeakMap<Layout, ReturnType<typeof interleave>>();
function getInterleave(l: Layout) {
  let v = ilCache.get(l);
  if (!v) { v = interleave(l); ilCache.set(l, v); }
  return v;
}

// Frame header

export interface FrameInfo {
  session: number;
  index: number;
  count: number;
  chunkSize: number;   // payload bytes per full frame (offset = index x chunkSize)
  streamLen: number;   // total bytes being transferred
}

// Encoder

/** Encode one frame. Returns luminance per cell (0 = black, 255 = white). */
export function encodeFrame(layout: Layout, info: FrameInfo, payload: Uint8Array): Uint8Array {
  const { cols, rows, bpc } = layout;
  if (payload.length > layout.payloadCapacity) throw new Error("payload too large");

  // 1. Message = frame header + payload (+ zero padding)
  const msg = new Uint8Array(layout.msgCapacity);
  const dv = new DataView(msg.buffer);
  msg[0] = FRAME_MAGIC[0]; msg[1] = FRAME_MAGIC[1];
  dv.setUint32(2, info.session);
  dv.setUint16(6, info.index);
  dv.setUint16(8, info.count);
  dv.setUint32(10, info.chunkSize);
  dv.setUint32(14, info.streamLen);
  dv.setUint32(18, payload.length);
  dv.setUint32(22, crc32(payload));
  msg.set(payload, FRAME_HDR);

  // 2. RS-encode each block and interleave into the stream
  const stream = new Uint8Array(layout.capacityBytes);
  const { block, offset } = getInterleave(layout);
  const codewords: Uint8Array[] = [];
  let p = 0;
  for (const b of layout.blocks) {
    codewords.push(rsEncode(msg.subarray(p, p + b.k), layout.parity));
    p += b.k;
  }
  const m = mask(stream.length);
  for (let i = 0; i < stream.length; i++) stream[i] = codewords[block[i]][offset[i]] ^ m[i];

  // 3. Paint the grid
  const grid = new Uint8Array(cols * rows).fill(255);
  paintFixed(grid, layout);
  const levels = bpc === 1 ? [255, 0] : [255, 170, 85, 0];
  let bit = 0;
  for (let ci = 0; ci < layout.dataCells.length; ci++) {
    let sym = 0;
    for (let k = 0; k < bpc; k++) {
      const byte = bit >> 3;
      const v = byte < stream.length ? (stream[byte] >> (7 - (bit & 7))) & 1 : 0;
      sym = (sym << 1) | v;
      bit++;
    }
    grid[layout.dataCells[ci]] = levels[bpc === 1 ? sym : GRAY[sym]];
  }
  return grid;
}

function paintFixed(grid: Uint8Array, layout: Layout) {
  const { cols, rows } = layout;
  const set = (c: number, r: number, v: number) => { grid[r * cols + c] = v; };
  const finder = (c0: number, r0: number) => {
    for (let my = 0; my < 7; my++) for (let mx = 0; mx < 7; mx++) {
      const ring = Math.min(mx, my, 6 - mx, 6 - my);
      const dark = ring !== 1;
      for (let dy = 0; dy < FMOD; dy++) for (let dx = 0; dx < FMOD; dx++)
        set(c0 + mx * FMOD + dx, r0 + my * FMOD + dy, dark ? 0 : 255);
    }
  };
  finder(0, 0);
  finder(cols - FINDER, 0);
  finder(0, rows - FINDER);
  finder(cols - FINDER, rows - FINDER);

  // Format header
  const hdr = new Uint8Array(HDR_LEN);
  const dv = new DataView(hdr.buffer);
  hdr[0] = 0x4c; hdr[1] = 0x54; hdr[2] = 1; // "LT" v1
  dv.setUint16(3, cols);
  dv.setUint16(5, rows);
  hdr[7] = layout.bpc;
  hdr[8] = layout.parity;
  const cw = rsEncode(hdr, HDR_NSYM);
  for (let i = 0; i < HDR_BITS; i++) {
    const bitv = (cw[i >> 3] >> (7 - (i & 7))) & 1;
    const mr = i % HDR_ROWS, mc = Math.floor(i / HDR_ROWS);
    const c = HDR_COL0 + mc * 2, r = HDR_ROW0 + mr * 2;
    const v = bitv ? 0 : 255;
    set(c, r, v); set(c + 1, r, v); set(c, r + 1, v); set(c + 1, r + 1, v);
  }
}

/** Render a cell grid into RGBA pixels, including the quiet zone. */
export function renderGrid(grid: Uint8Array, cols: number, rows: number, cellPx: number, out?: ImageData): ImageData {
  const W = (cols + QUIET * 2) * cellPx, H = (rows + QUIET * 2) * cellPx;
  const img = out ?? new ImageData(W, H);
  const d = img.data;
  d.fill(255);
  const off = QUIET * cellPx;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r * cols + c];
      if (v === 255) continue;
      const x0 = off + c * cellPx, y0 = off + r * cellPx;
      for (let y = 0; y < cellPx; y++) {
        let p = ((y0 + y) * W + x0) * 4;
        for (let x = 0; x < cellPx; x++, p += 4) { d[p] = v; d[p + 1] = v; d[p + 2] = v; }
      }
    }
  }
  return img;
}

/** Largest grid that fits in a pixel box. */
export function gridForPixels(width: number, height: number, cellPx: number) {
  return {
    cols: Math.floor(width / cellPx) - QUIET * 2,
    rows: Math.floor(height / cellPx) - QUIET * 2,
  };
}

// Decoder

export interface Pt { x: number; y: number; }
export interface Finder extends Pt { m: number; hits: number; }

export interface DecodeResult {
  finders: Finder[] | null;           // TL, TR, BL, BR when found
  layout?: { cols: number; rows: number; bpc: number; parity: number; cellPx: number };
  frame?: FrameInfo & { payload: Uint8Array };
  corrected: number;                  // bytes repaired by Reed-Solomon
  failedBlocks: number;
  error?: string;
}

/** Luminance from RGBA. */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  return g;
}

function otsu(g: Uint8Array): number {
  const hist = new Float64Array(256);
  const step = g.length > 400000 ? 3 : 1;
  let total = 0;
  for (let i = 0; i < g.length; i += step) { hist[g[i]]++; total++; }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function ratioOk(r: number[]): number {
  const total = r[0] + r[1] + r[2] + r[3] + r[4];
  if (total < 10) return 0;
  const m = total / 7;
  const tol = m * 0.7;
  if (Math.abs(r[0] - m) > tol || Math.abs(r[1] - m) > tol || Math.abs(r[3] - m) > tol || Math.abs(r[4] - m) > tol) return 0;
  if (Math.abs(r[2] - 3 * m) > tol * 2.2) return 0;
  return m;
}

/** Walk outward from a point along one axis, returning the five run lengths
 *  of a finder cross-section and the centre coordinate, or null. */
function crossCheck(bin: Uint8Array, w: number, h: number, x: number, y: number, dx: number, dy: number, maxRun: number) {
  const at = (i: number) => {
    const px = x + dx * i, py = y + dy * i;
    if (px < 0 || py < 0 || px >= w || py >= h) return -1;
    return bin[py * w + px];
  };
  if (at(0) !== 1) return null;
  // centre dark run
  let a = 0; while (at(-a - 1) === 1 && a <= maxRun * 3) a++;
  let b = 0; while (at(b + 1) === 1 && b <= maxRun * 3) b++;
  const center = a + b + 1;
  // light runs
  let la = 0; while (at(-a - 1 - la) === 0 && la <= maxRun) la++;
  let lb = 0; while (at(b + 1 + lb) === 0 && lb <= maxRun) lb++;
  if (!la || !lb || at(-a - 1 - la) !== 1 || at(b + 1 + lb) !== 1) return null;
  let da = 0; while (at(-a - 1 - la - da) === 1 && da <= maxRun) da++;
  let db = 0; while (at(b + 1 + lb + db) === 1 && db <= maxRun) db++;
  const m = ratioOk([da, la, center, lb, db]);
  if (!m) return null;
  return { m, centre: -a + center / 2 - 0.5 };
}

/** Integral image of the grey values, used for local (adaptive) thresholds. */
function integral(g: Uint8Array, w: number, h: number): Float64Array {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const src = y * w, dst = (y + 1) * (w + 1), prev = y * (w + 1);
    for (let x = 0; x < w; x++) {
      rowSum += g[src + x];
      I[dst + x + 1] = I[prev + x + 1] + rowSum;
    }
  }
  return I;
}

function boxMean(I: Float64Array, w: number, h: number, cx: number, cy: number, r: number): number {
  const x0 = Math.max(0, Math.round(cx - r)), x1 = Math.min(w, Math.round(cx + r));
  const y0 = Math.max(0, Math.round(cy - r)), y1 = Math.min(h, Math.round(cy + r));
  const W = w + 1;
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  return (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / area;
}

/** Dark/light map. Uses a local mean (Bradley) so uneven lighting from a
 *  camera does not hide the finders; falls back to the global Otsu level in
 *  flat regions. */
function binarize(g: Uint8Array, w: number, h: number, I: Float64Array): Uint8Array {
  const thr = otsu(g);
  const bin = new Uint8Array(w * h);
  const r = Math.max(8, Math.round(Math.max(w, h) / 16));
  const W = w + 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
      const v = g[y * w + x];
      bin[y * w + x] = v < mean * 0.85 || (v <= thr && mean - v > 8) ? 1 : 0;
    }
  }
  return bin;
}

function findFinders(g: Uint8Array, w: number, h: number, I?: Float64Array): Finder[] {
  const bin = binarize(g, w, h, I ?? integral(g, w, h));

  const clusters: { x: number; y: number; m: number; hits: number }[] = [];
  const runs = new Int32Array(w + 1);
  const starts = new Int32Array(w + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let n = 0, cur = bin[row], start = 0;
    for (let x = 1; x <= w; x++) {
      const v = x < w ? bin[row + x] : -1;
      if (v !== cur) { starts[n] = start; runs[n] = x - start; n++; start = x; cur = v; }
    }
    const firstDark = bin[row] === 1 ? 0 : 1;
    for (let i = firstDark; i + 4 < n; i += 2) {
      const r = [runs[i], runs[i + 1], runs[i + 2], runs[i + 3], runs[i + 4]];
      const m = ratioOk(r);
      if (!m) continue;
      const cx = Math.round(starts[i + 2] + runs[i + 2] / 2 - 0.5);
      const maxRun = Math.ceil(m * 2.2);
      const v = crossCheck(bin, w, h, cx, y, 0, 1, maxRun);
      if (!v) continue;
      const cy = Math.round(y + v.centre);
      const hz = crossCheck(bin, w, h, cx, cy, 1, 0, maxRun);
      if (!hz) continue;
      const fx = cx + hz.centre + 0.5, fy = y + v.centre + 0.5;
      const fm = (v.m + hz.m) / 2;
      if (Math.abs(v.m - hz.m) > fm * 0.5) continue;
      let merged = false;
      for (const c of clusters) {
        if (Math.abs(c.x - fx) < c.m * 2 && Math.abs(c.y - fy) < c.m * 2 && Math.abs(c.m - fm) < c.m * 0.5) {
          c.x = (c.x * c.hits + fx) / (c.hits + 1);
          c.y = (c.y * c.hits + fy) / (c.hits + 1);
          c.m = (c.m * c.hits + fm) / (c.hits + 1);
          c.hits++;
          merged = true;
          break;
        }
      }
      if (!merged) clusters.push({ x: fx, y: fy, m: fm, hits: 1 });
    }
  }
  return clusters.filter((c) => c.hits >= 2);
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Candidate quadrilaterals of finders, returned clockwise (in image space)
 *  starting from the corner nearest the top-left of the image. Perspective
 *  and rotation are allowed, so a phone camera can look at the screen at an
 *  angle. When only three finders are visible the fourth is extrapolated
 *  and marked with hits = 0. */
function pickQuads(cands: Finder[]): Finder[][] {
  const top = cands.slice().sort((a, b) => b.hits - a.hits).slice(0, 16);
  const n = top.length;
  const out: { q: Finder[]; score: number }[] = [];

  const order = (pts: Finder[]) => {
    const cx = pts.reduce((a, p) => a + p.x, 0) / 4, cy = pts.reduce((a, p) => a + p.y, 0) / 4;
    const s = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let k = 0;
    for (let i = 1; i < 4; i++) if (s[i].x + s[i].y < s[k].x + s[k].y) k = i;
    return [s[k], s[(k + 1) % 4], s[(k + 2) % 4], s[(k + 3) % 4]];
  };
  const score = (p: Finder[]) => {
    const ms = p.filter((f) => f.hits > 0).map((f) => f.m);
    const mMax = Math.max(...ms), mMin = Math.min(...ms);
    if (mMax / mMin > 2) return 0;
    const mAvg = ms.reduce((a, b) => a + b, 0) / ms.length;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const c = cross(p[i], p[(i + 1) % 4], p[(i + 2) % 4]);
      const s = Math.sign(c);
      if (!s || (sign && s !== sign)) return 0;
      sign = s;
    }
    const sides = [0, 1, 2, 3].map((i) => dist(p[i], p[(i + 1) % 4]));
    if (Math.min(...sides) / mAvg < 15) return 0;
    if (sides[0] / sides[2] > 2.2 || sides[2] / sides[0] > 2.2) return 0;
    if (sides[1] / sides[3] > 2.2 || sides[3] / sides[1] > 2.2) return 0;
    for (let i = 0; i < 4; i++) {
      const a = p[(i + 3) % 4], b = p[i], c = p[(i + 1) % 4];
      const cos = ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) / (dist(a, b) * dist(b, c));
      if (Math.abs(cos) > 0.6) return 0;
    }
    return Math.abs(cross(p[0], p[1], p[2])) / 2 + Math.abs(cross(p[0], p[2], p[3])) / 2;
  };

  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) {
    for (let d = c + 1; d < n; d++) {
      const q = order([top[a], top[b], top[c], top[d]]);
      const s = score(q);
      if (s) out.push({ q, score: s * 2 });
    }
    // Three finders: the missing corner completes a parallelogram opposite
    // whichever of the three sits at the right-angle-ish vertex.
    const tri = [top[a], top[b], top[c]];
    for (let v = 0; v < 3; v++) {
      const A = tri[v], B = tri[(v + 1) % 3], C = tri[(v + 2) % 3];
      const D: Finder = { x: B.x + C.x - A.x, y: B.y + C.y - A.y, m: (A.m + B.m + C.m) / 3, hits: 0 };
      const q = order([A, B, C, D]);
      const s = score(q);
      if (s) out.push({ q, score: s });
    }
  }
  out.sort((x, y) => y.score - x.score);
  const seen = new Set<string>();
  const uniq: Finder[][] = [];
  for (const o of out) {
    const key = o.q.map((f) => `${Math.round(f.x / 4)},${Math.round(f.y / 4)}`).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(o.q);
    if (uniq.length === 3) break;
  }
  return uniq;
}

function bilinearSample(g: Uint8Array, w: number, h: number, x: number, y: number): number {
  x -= 0.5; y -= 0.5; // pixel centres
  if (x < 0) x = 0; if (y < 0) y = 0;
  if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  const a = g[i], b = g[i + 1], c = g[i + w], d = g[i + w + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Perspective transform (homography) taking 4 source points to 4 targets. */
function homography(src: Pt[], dst: Pt[]): (x: number, y: number) => Pt {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let k = c; k < 9; k++) A[c][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const [a, b, c, d, e, f, g, h] = A.map((row) => row[8]);
  return (x, y) => {
    const z = g * x + h * y + 1;
    return { x: (a * x + b * y + c) / z, y: (d * x + e * y + f) / z };
  };
}

/** q = [TL, TR, BL, BR] in image pixels. Returns cell coords -> pixels. */
function makeMapper(q: Finder[], cols: number, rows: number) {
  const src = [
    { x: FC, y: FC }, { x: cols - FC, y: FC },
    { x: FC, y: rows - FC }, { x: cols - FC, y: rows - FC },
  ];
  return homography(src, q);
}

type Mapper = ReturnType<typeof makeMapper>;

/** Black/white reference at each finder: dark centre and light ring, found
 *  through the mapper so rotation and perspective are handled. */
function calibrate(g: Uint8Array, w: number, h: number, q: Finder[], map: Mapper, cols: number, rows: number) {
  const centres = [[FC, FC], [cols - FC, FC], [FC, rows - FC], [cols - FC, rows - FC]];
  const ring = 2 * FMOD; // light ring is 2 modules from the centre
  const cal = q.map((f, i) => {
    if (f.hits === 0) return null;
    const [cx, cy] = centres[i];
    const at = (dx: number, dy: number) => { const p = map(cx + dx, cy + dy); return bilinearSample(g, w, h, p.x, p.y); };
    return {
      black: at(0, 0),
      white: (at(-ring, 0) + at(ring, 0) + at(0, -ring) + at(0, ring)) / 4,
    };
  });
  const real = cal.filter((c): c is { black: number; white: number } => !!c);
  const avg = {
    black: real.reduce((a, c) => a + c.black, 0) / Math.max(1, real.length),
    white: real.reduce((a, c) => a + c.white, 0) / Math.max(1, real.length),
  };
  return cal.map((c) => c ?? avg);
}

function readHeader(g: Uint8Array, w: number, h: number, q: Finder[], cols: number, rows: number) {
  const map = makeMapper(q, cols, rows);
  const cal = calibrate(g, w, h, q, map, cols, rows)[0];
  const mid = (cal.black + cal.white) / 2;
  const cw = new Uint8Array(HDR_BITS / 8);
  for (let i = 0; i < HDR_BITS; i++) {
    const mr = i % HDR_ROWS, mc = Math.floor(i / HDR_ROWS);
    const p = map(HDR_COL0 + mc * 2 + 1, HDR_ROW0 + mr * 2 + 1);
    if (bilinearSample(g, w, h, p.x, p.y) < mid) cw[i >> 3] |= 0x80 >> (i & 7);
  }
  const res = rsDecode(cw, HDR_NSYM);
  if (!res) return null;
  const d = res.data;
  if (d[0] !== 0x4c || d[1] !== 0x54 || d[2] !== 1) return null;
  const dv = new DataView(d.buffer, d.byteOffset);
  const hc = dv.getUint16(3), hr = dv.getUint16(5), bpc = d[7], parity = d[8];
  if ((bpc !== 1 && bpc !== 2) || hc < MIN_COLS || hr < MIN_ROWS) return null;
  return { cols: hc, rows: hr, bpc: bpc as 1 | 2, parity };
}

/** Try to read the format header for one corner assignment. The grid size is
 *  not known yet, so candidate column counts are tried outward from an
 *  estimate based on the finder size; the header's own checksum confirms
 *  the right one. */
function findHeader(g: Uint8Array, w: number, h: number, q: Finder[]) {
  const [tl, tr, bl] = q;
  const real = q.filter((f) => f.hits > 0);
  const mRaw = real.reduce((a, f) => a + f.m, 0) / real.length;
  // Run lengths through a rotated square are stretched by 1/cos(angle).
  const ang = Math.atan2(tr.y - tl.y, tr.x - tl.x);
  const stretch = Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
  const cellPx = (mRaw * stretch) / FMOD;
  const top = dist(tl, tr), left = dist(tl, bl);
  const colsEst = Math.round(top / cellPx) + 2 * FC;
  const ratio = left / top;
  const lo = Math.max(MIN_COLS, Math.round(colsEst * 0.7)), hi = Math.round(colsEst * 1.35);
  for (let d = 0; ; d++) {
    const tries = d === 0 ? [colsEst] : [colsEst + d, colsEst - d];
    let inRange = false;
    for (const cols of tries) {
      if (cols < lo || cols > hi) continue;
      inRange = true;
      const rows = Math.max(MIN_ROWS, Math.round(ratio * (cols - 2 * FC)) + 2 * FC);
      const hdr = readHeader(g, w, h, q, cols, rows);
      if (hdr) return hdr;
    }
    if (!inRange) return null;
  }
}

export function decodeImage(g: Uint8Array, w: number, h: number): DecodeResult {
  const I = integral(g, w, h);
  const cands = findFinders(g, w, h, I);
  const quads = pickQuads(cands);
  if (!quads.length) return { finders: null, corrected: 0, failedBlocks: 0, error: "No code found" };

  for (const p of quads) {
    // p is clockwise: try each corner as the grid's top-left, so the image
    // can be rotated by any multiple of 90 degrees.
    for (let rot = 0; rot < 4; rot++) {
      const c = [p[rot], p[(rot + 1) % 4], p[(rot + 2) % 4], p[(rot + 3) % 4]];
      const q = [c[0], c[1], c[3], c[2]]; // TL, TR, BL, BR
      const hdr = findHeader(g, w, h, q);
      if (!hdr) continue;
      const layout = makeLayout(hdr.cols, hdr.rows, hdr.bpc, hdr.parity);
      const lay = { cols: hdr.cols, rows: hdr.rows, bpc: hdr.bpc, parity: hdr.parity, cellPx: dist(q[0], q[1]) / (hdr.cols - 2 * FC) };
      const r = decodeData(g, w, h, q, layout, I);
      return { finders: q, layout: lay, ...r };
    }
  }
  const p = quads[0];
  return { finders: [p[0], p[1], p[3], p[2]], corrected: 0, failedBlocks: 0, error: "Format header unreadable" };
}

function decodeData(g: Uint8Array, w: number, h: number, q: Finder[], layout: Layout, I: Float64Array) {
  const { cols, rows, bpc } = layout;
  const map = makeMapper(q, cols, rows);
  const cal = calibrate(g, w, h, q, map, cols, rows);
  const cellPx = dist(q[0], q[1]) / (cols - 2 * FC);
  const win = Math.max(3, cellPx * 5);
  const sx = cols - 2 * FC, sy = rows - 2 * FC;

  // For 1 bit per cell the data is whitened, so about half the cells around
  // any point are dark: the local mean is a good threshold even under
  // uneven lighting from a camera.
  const stream = new Uint8Array(layout.capacityBytes);
  let bit = 0;
  const cells = layout.dataCells;
  for (let ci = 0; ci < cells.length; ci++) {
    const idx = cells[ci];
    const c = idx % cols, r = (idx - c) / cols;
    const p = map(c + 0.5, r + 0.5);
    const lum = bilinearSample(g, w, h, p.x, p.y);
    let sym: number;
    if (bpc === 1) {
      sym = lum < boxMean(I, w, h, p.x, p.y, win) ? 1 : 0;
    } else {
      // Four grey levels need absolute references: interpolate the finder
      // black/white levels across the grid.
      const u = Math.min(1, Math.max(0, (c + 0.5 - FC) / sx));
      const v = Math.min(1, Math.max(0, (r + 0.5 - FC) / sy));
      const blk = (1 - u) * (1 - v) * cal[0].black + u * (1 - v) * cal[1].black + (1 - u) * v * cal[2].black + u * v * cal[3].black;
      const wht = (1 - u) * (1 - v) * cal[0].white + u * (1 - v) * cal[1].white + (1 - u) * v * cal[2].white + u * v * cal[3].white;
      const t = (lum - blk) / Math.max(1, wht - blk); // 0 = black, 1 = white
      sym = GRAY_INV[Math.max(0, Math.min(3, Math.round((1 - t) * 3)))];
    }
    for (let k = bpc - 1; k >= 0; k--) {
      const byte = bit >> 3;
      if (byte < stream.length && ((sym >> k) & 1)) stream[byte] |= 0x80 >> (bit & 7);
      bit++;
    }
  }

  const m = mask(stream.length);
  const { block, offset } = getInterleave(layout);
  const cws = layout.blocks.map((b) => new Uint8Array(b.n));
  for (let i = 0; i < stream.length; i++) cws[block[i]][offset[i]] = stream[i] ^ m[i];

  const msg = new Uint8Array(layout.msgCapacity);
  let p = 0, corrected = 0, failedBlocks = 0;
  for (let b = 0; b < cws.length; b++) {
    const res = rsDecode(cws[b], layout.parity);
    if (!res) { failedBlocks++; msg.set(cws[b].subarray(0, layout.blocks[b].k), p); }
    else { corrected += res.corrected; msg.set(res.data, p); }
    p += layout.blocks[b].k;
  }
  if (failedBlocks) return { corrected, failedBlocks, error: `${failedBlocks}/${cws.length} blocks beyond repair` };

  if (msg[0] !== FRAME_MAGIC[0] || msg[1] !== FRAME_MAGIC[1]) return { corrected, failedBlocks, error: "Bad frame magic" };
  const dv = new DataView(msg.buffer);
  const info: FrameInfo = {
    session: dv.getUint32(2),
    index: dv.getUint16(6),
    count: dv.getUint16(8),
    chunkSize: dv.getUint32(10),
    streamLen: dv.getUint32(14),
  };
  const len = dv.getUint32(18);
  const crc = dv.getUint32(22);
  if (len > layout.payloadCapacity) return { corrected, failedBlocks, error: "Bad payload length" };
  const payload = msg.slice(FRAME_HDR, FRAME_HDR + len);
  if (crc32(payload) !== crc) return { corrected, failedBlocks, error: "CRC mismatch" };
  return { corrected, failedBlocks, frame: { ...info, payload } };
}

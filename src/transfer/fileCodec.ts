// File to byte-stream packaging, optional AES-GCM encryption, and the
// "direct" lossless PNG representation (3 bytes per RGB pixel).
//
// Stream layout:
//   "LLF1" | flags u8 | nameLen u16 | name (UTF-8) | size u32 | SHA-256 (32) | body
// flags bit 0 = encrypted. When encrypted, body = salt(16) | iv(12) | ciphertext,
// key = PBKDF2-SHA256(passphrase, salt, 150000 iterations), AES-256-GCM.
// The SHA-256 is always of the ORIGINAL file, so the receiver can prove the
// round trip was bit-for-bit exact.

const MAGIC = [0x4c, 0x4c, 0x46, 0x31]; // "LLF1"
const PBKDF2_ITER = 150_000;

export interface PackedMeta {
  name: string;
  size: number;
  sha256: Uint8Array;
  encrypted: boolean;
}

export interface UnpackedStream extends PackedMeta {
  body: Uint8Array;
}

// Copy into a fresh ArrayBuffer-backed view (WebCrypto's BufferSource typing
// rejects views over SharedArrayBuffer-compatible ArrayBufferLike).
const ab = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", ab(data)));
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function deriveKey(pass: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", ab(new TextEncoder().encode(pass)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: ab(salt), iterations: PBKDF2_ITER, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function packFile(bytes: Uint8Array, name: string, passphrase?: string): Promise<Uint8Array> {
  const nameBytes = new TextEncoder().encode(name).slice(0, 400);
  const digest = await sha256(bytes);
  let body = bytes;
  const encrypted = !!passphrase;
  if (encrypted) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase!, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(bytes)));
    body = new Uint8Array(28 + ct.length);
    body.set(salt, 0); body.set(iv, 16); body.set(ct, 28);
  }
  const out = new Uint8Array(4 + 1 + 2 + nameBytes.length + 4 + 32 + body.length);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = encrypted ? 1 : 0;
  dv.setUint16(5, nameBytes.length);
  out.set(nameBytes, 7);
  let p = 7 + nameBytes.length;
  dv.setUint32(p, bytes.length); p += 4;
  out.set(digest, p); p += 32;
  out.set(body, p);
  return out;
}

/** Parse just the header - works on a partial stream (e.g. the first frame). */
export function peekMeta(stream: Uint8Array): PackedMeta | null {
  if (stream.length < 7 || MAGIC.some((m, i) => stream[i] !== m)) return null;
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const nameLen = dv.getUint16(5);
  const end = 7 + nameLen + 4 + 32;
  if (stream.length < end) return null;
  const name = new TextDecoder().decode(stream.subarray(7, 7 + nameLen));
  const size = dv.getUint32(7 + nameLen);
  const sha = stream.slice(7 + nameLen + 4, end);
  return { name, size, sha256: sha, encrypted: (stream[4] & 1) === 1 };
}

export function unpackStream(stream: Uint8Array): UnpackedStream | null {
  const meta = peekMeta(stream);
  if (!meta) return null;
  const nameLen = new DataView(stream.buffer, stream.byteOffset).getUint16(5);
  return { ...meta, body: stream.subarray(7 + nameLen + 4 + 32) };
}

export class WrongPassphraseError extends Error {}

/** Returns the original file bytes, verified against the embedded SHA-256. */
export async function recoverFile(u: UnpackedStream, passphrase?: string): Promise<Uint8Array> {
  let bytes = u.body;
  if (u.encrypted) {
    if (!passphrase) throw new WrongPassphraseError("Passphrase required");
    const salt = bytes.subarray(0, 16), iv = bytes.subarray(16, 28), ct = bytes.subarray(28);
    const key = await deriveKey(passphrase, salt);
    try {
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(ct)));
    } catch {
      throw new WrongPassphraseError("Wrong passphrase");
    }
  }
  if (bytes.length !== u.size) throw new Error(`Size mismatch: expected ${u.size}, got ${bytes.length}`);
  const digest = await sha256(bytes);
  if (toHex(digest) !== toHex(u.sha256)) throw new Error("SHA-256 mismatch, data corrupted");
  return bytes;
}

// Direct PNG (lossless, 3 bytes per pixel)
// Pixel stream = streamLen u32 | stream | zero padding, packed as R,G,B,R,G,B,...
// Alpha is always 255 so the browser never premultiplies (which would be lossy).

export function streamToImageData(stream: Uint8Array): ImageData {
  const total = 4 + stream.length;
  const px = Math.ceil(total / 3);
  const width = Math.max(1, Math.ceil(Math.sqrt(px)));
  const height = Math.ceil(px / width);
  const buf = new Uint8Array(width * height * 3);
  new DataView(buf.buffer).setUint32(0, stream.length);
  buf.set(stream, 4);
  const img = new ImageData(width, height);
  const d = img.data;
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    d[i * 4] = buf[j]; d[i * 4 + 1] = buf[j + 1]; d[i * 4 + 2] = buf[j + 2]; d[i * 4 + 3] = 255;
  }
  return img;
}

export function imageDataToStream(img: { data: Uint8ClampedArray; width: number; height: number }): Uint8Array {
  const n = img.width * img.height;
  const buf = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = img.data[i * 4]; buf[i * 3 + 1] = img.data[i * 4 + 1]; buf[i * 3 + 2] = img.data[i * 4 + 2];
  }
  const len = new DataView(buf.buffer).getUint32(0);
  if (len > buf.length - 4) throw new Error("Not a LiveLens data image");
  return buf.slice(4, 4 + len);
}

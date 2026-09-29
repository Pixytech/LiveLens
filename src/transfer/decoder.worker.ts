// Decodes captured screen frames off the main thread so the live preview
// stays smooth while finder detection + Reed-Solomon run (about 50-150 ms per frame).

import { decodeImage, toGray, type DecodeResult, type Finder } from "./codec";

export interface DecodeRequest {
  id: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

export interface DecodeResponse {
  id: number;
  ms: number;
  result: DecodeResult;
}

// Last grid position that decoded, used as a hint so a hand-held camera
// stays locked on the grid between frames.
let hint: Finder[] | null = null;
let hintAt = 0;

self.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const { id, width, height, rgba } = e.data;
  const t0 = performance.now();
  let result: DecodeResult;
  try {
    const gray = toGray(new Uint8ClampedArray(rgba), width, height);
    const t = performance.now();
    result = decodeImage(gray, width, height, t - hintAt < 2000 ? hint : null);
    if (result.layout && result.finders) { hint = result.finders; hintAt = t; }
  } catch (err) {
    result = { finders: null, corrected: 0, failedBlocks: 0, error: String((err as Error)?.message ?? err) };
  }
  const msg: DecodeResponse = { id, ms: performance.now() - t0, result };
  const transfer = result.frame ? [result.frame.payload.buffer as ArrayBuffer] : [];
  (self as unknown as Worker).postMessage(msg, transfer);
};

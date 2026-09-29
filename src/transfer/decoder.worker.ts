// Decodes captured screen frames off the main thread so the live preview
// stays smooth while finder detection + Reed-Solomon run (about 50-150 ms per frame).

import { decodeImage, toGray, type DecodeResult } from "./codec";

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

self.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const { id, width, height, rgba } = e.data;
  const t0 = performance.now();
  let result: DecodeResult;
  try {
    const gray = toGray(new Uint8ClampedArray(rgba), width, height);
    result = decodeImage(gray, width, height);
  } catch (err) {
    result = { finders: null, corrected: 0, failedBlocks: 0, error: String((err as Error)?.message ?? err) };
  }
  const msg: DecodeResponse = { id, ms: performance.now() - t0, result };
  const transfer = result.frame ? [result.frame.payload.buffer as ArrayBuffer] : [];
  (self as unknown as Worker).postMessage(msg, transfer);
};

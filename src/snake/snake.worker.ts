import { pipeline, TextStreamer } from '@huggingface/transformers';
import type { TextGenerationPipeline } from '@huggingface/transformers';

type InMsg =
  | { type: 'load'; modelId: string }
  | { type: 'decide'; prompt: string };

let pipe: TextGenerationPipeline | null = null;

async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return 'wasm';
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

self.addEventListener('message', async ({ data }: MessageEvent<InMsg>) => {

  // ── Load ──────────────────────────────────────────────────────────────────
  if (data.type === 'load') {
    try {
      pipe = null;
      const device = await detectDevice();
      const fileProgress = new Map<string, { loaded: number; total: number }>();
      pipe = await pipeline('text-generation', data.modelId, {
        device,
        dtype: device === 'webgpu' ? 'q4f16' : 'q4',
        progress_callback: (p: { status: string; loaded?: number; total?: number; file?: string }) => {
          if (p.status === 'progress' && p.total && p.file) {
            fileProgress.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
            let totalLoaded = 0, totalSize = 0;
            for (const v of fileProgress.values()) { totalLoaded += v.loaded; totalSize += v.total; }
            self.postMessage({ type: 'progress', loaded: totalLoaded, total: totalSize, file: p.file });
          }
        },
      }) as TextGenerationPipeline;
      self.postMessage({ type: 'ready', device });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err as Error).message ?? err) });
    }
    return;
  }

  // ── Decide (single-shot move, no streaming to the caller — only timing) ────
  if (data.type === 'decide') {
    if (!pipe) { self.postMessage({ type: 'error', message: 'Model not loaded' }); return; }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenizer = (pipe as any).tokenizer;
      const promptText: string = await tokenizer.apply_chat_template(
        [
          { role: 'system', content: 'Snake game. Reply one word only: UP, DOWN, LEFT, or RIGHT.' },
          { role: 'user', content: data.prompt },
        ],
        { tokenize: false, add_generation_prompt: true }
      );

      let tokenCount = 0;
      let text = '';
      const streamer = new TextStreamer(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk: string) => { tokenCount++; text += chunk; },
      });

      const start = performance.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (pipe as any)(promptText, {
        max_new_tokens: 3,
        do_sample: false,
        return_full_text: false,
        streamer,
      });
      const elapsedMs = performance.now() - start;

      self.postMessage({
        type: 'result',
        text,
        tokens: tokenCount,
        elapsedMs,
        tokensPerSec: tokenCount > 0 ? (tokenCount / elapsedMs) * 1000 : 0,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err as Error).message ?? err) });
    }
    return;
  }
});

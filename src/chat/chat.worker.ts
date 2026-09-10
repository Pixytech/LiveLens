import { pipeline, TextStreamer } from '@huggingface/transformers';
import type { TextGenerationPipeline } from '@huggingface/transformers';

type InMsg =
  | { type: 'load'; modelId: string }
  | { type: 'generate'; messages: ChatMessage[]; maxTokens: number; temperature: number }
  | { type: 'abort' };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

let pipe: TextGenerationPipeline | null = null;
let abortController: AbortController | null = null;

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

  // ── Generate ──────────────────────────────────────────────────────────────
  if (data.type === 'generate') {
    if (!pipe) { self.postMessage({ type: 'error', message: 'Model not loaded' }); return; }

    abortController = new AbortController();
    const signal = abortController.signal;

    try {
      // Apply the chat template manually → we get a plain string prompt.
      // Passing a string (not a messages array) to the pipeline makes
      // TextStreamer's skip_prompt:true work correctly — it knows exactly
      // how many tokens to skip and won't echo the prompt back.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenizer = (pipe as any).tokenizer;
      const promptText: string = await tokenizer.apply_chat_template(
        data.messages,
        { tokenize: false, add_generation_prompt: true }
      );

      const streamer = new TextStreamer(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callback_function: (text: string) => {
          if (!signal.aborted) self.postMessage({ type: 'token', text });
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (pipe as any)(promptText, {
        max_new_tokens: data.maxTokens,
        temperature: data.temperature,
        do_sample: data.temperature > 0,
        return_full_text: false,
        streamer,
      });

      self.postMessage({ type: 'done' });
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (!msg.includes('abort')) self.postMessage({ type: 'error', message: msg });
      else self.postMessage({ type: 'done' });
    }

    abortController = null;
    return;
  }

  // ── Abort ─────────────────────────────────────────────────────────────────
  if (data.type === 'abort') {
    abortController?.abort();
  }
});

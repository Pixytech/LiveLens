export interface OfflineModel {
  id: string; label: string; size: string; speed: string; note: string;
  ctxTokens: number; group: 'General' | 'Code';
}

export const OFFLINE_MODELS: OfflineModel[] = [
  { id: 'HuggingFaceTB/SmolLM2-135M-Instruct',      label: 'SmolLM2 135M',       size: '~270 MB',  speed: '⚡⚡⚡', note: 'Very small model — loads instantly. Suitable for simple, short factual Q&A only. Struggles with multi-turn conversation or complex reasoning.',        ctxTokens: 2048,   group: 'General' },
  { id: 'HuggingFaceTB/SmolLM2-360M-Instruct',      label: 'SmolLM2 360M',       size: '~720 MB',  speed: '⚡⚡',  note: 'Small general-purpose model. Better than 135M for basic chat, still limited on nuanced or multi-step questions.',                               ctxTokens: 2048,   group: 'General' },
  { id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',      label: 'SmolLM2 1.7B',       size: '~3.4 GB',  speed: '⚡',   note: 'Best of the SmolLM2 series. Good for general conversation, summaries, and light reasoning. Recommended starting point for general chat.',       ctxTokens: 8192,   group: 'General' },
  { id: 'onnx-community/Qwen2.5-0.5B-Instruct',      label: 'Qwen 2.5 0.5B',      size: '~1 GB',    speed: '⚡⚡',  note: 'Very small model from Alibaba. Fast but limited — only suitable for short, structured tasks. Not recommended for open-ended conversation.',      ctxTokens: 4096,   group: 'General' },
  { id: 'onnx-community/Qwen2.5-1.5B-Instruct',      label: 'Qwen 2.5 1.5B',      size: '~2 GB',    speed: '⚡',   note: 'Solid general-purpose model. Handles conversation, multilingual input, and light reasoning well. Good balance of size and quality.',             ctxTokens: 4096,   group: 'General' },
  { id: 'onnx-community/Llama-3.2-1B-Instruct',      label: 'Llama 3.2 1B',       size: '~2 GB',    speed: '⚡',   note: 'Meta\'s smallest Llama model. Well-rounded for general chat, instruction-following, and summaries. A reliable all-rounder for everyday use.',  ctxTokens: 131072, group: 'General' },
  { id: 'onnx-community/Phi-3.5-mini-instruct-onnx-web', label: 'Phi 3.5 Mini',      size: '~2.3 GB',  speed: '⚡',   note: 'Microsoft\'s compact but capable model. Excels at reasoning, structured tasks, and code. Punches well above its size — best overall quality here.', ctxTokens: 131072, group: 'General' },
  { id: 'onnx-community/Qwen2.5-Coder-0.5B-Instruct', label: 'Qwen2.5-Coder 0.5B', size: '~1 GB',    speed: '⚡⚡⚡', note: 'Code-only model — do not use for general chat. Best for quick syntax questions, short snippets, and code completion hints. Very limited reasoning.', ctxTokens: 32768,  group: 'Code' },
  { id: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct', label: 'Qwen2.5-Coder 1.5B', size: '~2 GB',    speed: '⚡⚡',  note: 'Code-focused model. Good for explaining code, debugging, and answering technical questions. Not designed for general conversation.',             ctxTokens: 32768,  group: 'Code' },
  { id: 'onnx-community/Qwen2.5-Coder-3B-Instruct',   label: 'Qwen2.5-Coder 3B',   size: '~3 GB',    speed: '⚡',   note: 'Best in-browser coding model. Handles code review, refactoring, and technical explanations well. Use a General model if you need general chat.', ctxTokens: 32768,  group: 'Code' },
];

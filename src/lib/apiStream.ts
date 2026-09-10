export type ChatMsg = { role: 'user' | 'assistant'; content: string };

async function* readSSE(response: Response, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        if (!payload) continue;
        try { yield JSON.parse(payload); } catch { /* skip malformed */ }
      }
    }
  } catch (err) {
    if (!signal.aborted) throw err;
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
  let msg = `HTTP ${res.status}`;
  try {
    const body = await res.clone().json();
    msg = body?.error?.message ?? body?.message ?? msg;
  } catch { /* use default */ }
  throw new Error(msg);
}

export async function* streamClaude(
  apiKey: string, model: string, messages: ChatMsg[], systemPrompt: string, signal: AbortSignal
): AsyncGenerator<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required header to allow direct browser access
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages, stream: true }),
  });
  await assertOk(res);
  for await (const chunk of readSSE(res, signal)) {
    const c = chunk as { type?: string; delta?: { type?: string; text?: string } };
    if (c?.type === 'content_block_delta' && c?.delta?.type === 'text_delta' && c.delta.text) {
      yield c.delta.text;
    }
  }
}

export async function* streamOpenAI(
  apiKey: string, model: string, messages: ChatMsg[], systemPrompt: string, signal: AbortSignal
): AsyncGenerator<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, stream: true, max_tokens: 1024,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  await assertOk(res);
  for await (const chunk of readSSE(res, signal)) {
    const text = (chunk as { choices?: [{ delta?: { content?: string } }] })?.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

export async function* streamGemini(
  accessToken: string, model: string, messages: ChatMsg[], systemPrompt: string, signal: AbortSignal
): AsyncGenerator<string> {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );
  await assertOk(res);
  for await (const chunk of readSSE(res, signal)) {
    const text = (chunk as { candidates?: [{ content?: { parts?: [{ text?: string }] } }] })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) yield text;
  }
}

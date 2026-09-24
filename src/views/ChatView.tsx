import { useCallback, useEffect, useRef, useState } from 'react';
import { streamClaude, streamOpenAI, streamGemini, type ChatMsg } from '../lib/apiStream';
import { OFFLINE_MODELS } from '../lib/offlineModels';

// ── API providers ─────────────────────────────────────────────────────────────

type ApiProvider = 'claude' | 'openai' | 'gemini';

const API_PROVIDERS = {
  claude: {
    label: 'Claude', color: '#d4a27f', authType: 'key' as const,
    keyPlaceholder: 'sk-ant-api03-…',
    docsLabel: 'console.anthropic.com', docsUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-5',         label: 'Claude Sonnet 4.5',  note: 'Best balance of speed and intelligence. Ideal for most tasks — writing, analysis, coding, and complex reasoning. Recommended default.' },
      { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',   note: 'Fastest and most cost-efficient Claude model. Great for simple Q&A, quick summaries, and high-volume tasks where speed matters.' },
      { id: 'claude-opus-4-5',            label: 'Claude Opus 4.5',    note: 'Most capable Claude model. Best for deeply complex reasoning, nuanced writing, and tasks where quality matters more than speed.' },
    ],
    defaultModel: 'claude-sonnet-4-5',
  },
  openai: {
    label: 'OpenAI', color: '#74aa9c', authType: 'key' as const,
    keyPlaceholder: 'sk-proj-…',
    docsLabel: 'platform.openai.com', docsUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', note: 'Fast and affordable GPT-4 class model. Good for everyday chat, drafting, and coding assistance. Best value for most use cases.' },
      { id: 'gpt-4o',      label: 'GPT-4o',      note: 'Flagship multimodal model. Excels at complex reasoning, coding, and nuanced tasks. Slower and more expensive than Mini but significantly more capable.' },
      { id: 'o1-mini',     label: 'o1 Mini',      note: 'Reasoning-focused model that thinks before answering. Best for math, logic, and multi-step problems. Slower by design — not suited for casual chat.' },
    ],
    defaultModel: 'gpt-4o-mini',
  },
  gemini: {
    label: 'Gemini', color: '#4285f4', authType: 'oauth' as const,
    keyPlaceholder: '',
    docsLabel: 'console.cloud.google.com', docsUrl: 'https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com',
    models: [
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', note: 'Latest and fastest Gemini model. Excellent for general chat, coding, and real-time tasks. Recommended default for most Gemini users.' },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', note: 'Older but very capable fast model. Good all-rounder for conversation, summarisation, and structured tasks at lower cost.' },
      { id: 'gemini-1.5-pro',   label: 'Gemini 1.5 Pro',   note: 'Most capable Gemini 1.5 model with a very large context window. Best for long documents, in-depth analysis, and complex reasoning.' },
    ],
    defaultModel: 'gemini-2.0-flash',
  },
} as const;

// ── System prompts ────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM = 'You are a helpful assistant. Answer clearly and concisely.';

function estimateTokens(msgs: ChatMsg[], sys: string) {
  return Math.round((sys + msgs.map(m => m.content).join(' ')).length / 4);
}
function fmtCtx(n: number) { return n >= 1024 ? `${(n / 1024).toFixed(0)}K` : String(n); }

// ── Types ─────────────────────────────────────────────────────────────────────

type Source = 'offline' | ApiProvider;
type Status = 'idle' | 'loading' | 'ready' | 'generating' | 'error';

interface Progress { file: string; loaded: number; total: number; }

// ── Component ─────────────────────────────────────────────────────────────────

export function ChatView() {
  // Source & model selection — persisted across reloads
  const [source, setSource]     = useState<Source>(() => {
    const s = localStorage.getItem('chat_source') as Source | null;
    return s && ['offline','claude','openai','gemini'].includes(s) ? s : 'offline';
  });
  const [offlineId, setOfflineId] = useState(() => {
    const id = localStorage.getItem('chat_offline_model');
    return OFFLINE_MODELS.some(m => m.id === id) ? id! : OFFLINE_MODELS[0].id;
  });
  const [apiModel, setApiModel] = useState<string>(() => {
    return localStorage.getItem('chat_api_model') ?? API_PROVIDERS.claude.defaultModel;
  });

  // Shared chat state
  const [messages, setMessages]       = useState<ChatMsg[]>([]);
  const [input, setInput]             = useState('');
  const [streamBuf, setStreamBuf]     = useState('');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [showSettings, setShowSettings] = useState(false);
  const [showSysPrompt, setShowSysPrompt] = useState(false);
  const [status, setStatus]           = useState<Status>('idle');
  const [error, setError]             = useState<string | null>(null);

  // Offline-specific
  const [progress, setProgress]       = useState<Progress | null>(null);
  const [device, setDevice]           = useState('');
  const workerRef                     = useRef<Worker | null>(null);

  // API keys
  const [claudeKey, setClaudeKey]     = useState(() => localStorage.getItem('api_key_claude') ?? '');
  const [openaiKey, setOpenaiKey]     = useState(() => localStorage.getItem('api_key_openai') ?? '');
  const [clientId, setClientId]       = useState(() => localStorage.getItem('gemini_client_id') ?? '');
  const [geminiToken, setGeminiToken] = useState<string | null>(null);
  const tokenClientRef                = useRef<{ requestAccessToken: (c?: object) => void } | null>(null);

  // Abort for API streaming
  const abortRef  = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  // Derived
  const offlineModel  = OFFLINE_MODELS.find(m => m.id === offlineId) ?? OFFLINE_MODELS[0];
  const apiCfg        = source !== 'offline' ? API_PROVIDERS[source as ApiProvider] : null;
  const apiModels     = apiCfg?.models as readonly { id: string; label: string; note: string }[] | undefined;
  const ctxTokens     = source === 'offline' ? offlineModel.ctxTokens : 131072;
  const usedTokens    = estimateTokens(messages, systemPrompt);
  const ctxPct        = Math.min(100, Math.round((usedTokens / ctxTokens) * 100));
  const ctxWarning    = ctxPct >= 80;
  const progressPct   = progress?.total ? Math.round((progress.loaded / progress.total) * 100) : 0;

  const isReady =
    (source === 'offline'  && status === 'ready') ||
    (source === 'claude'   && !!claudeKey) ||
    (source === 'openai'   && !!openaiKey) ||
    (source === 'gemini'   && !!geminiToken);

  // Auto-scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamBuf]);

  // Set API status when keys change
  useEffect(() => {
    if (source === 'claude')  setStatus(claudeKey  ? 'ready' : 'idle');
    if (source === 'openai')  setStatus(openaiKey  ? 'ready' : 'idle');
    if (source === 'gemini')  setStatus(geminiToken ? 'ready' : 'idle');
  }, [source, claudeKey, openaiKey, geminiToken]);


  // Persist selections
  useEffect(() => { localStorage.setItem('chat_source', source); }, [source]);
  useEffect(() => { localStorage.setItem('chat_offline_model', offlineId); }, [offlineId]);
  useEffect(() => { localStorage.setItem('chat_api_model', apiModel); }, [apiModel]);

  // Reset api model when source changes (only if stored model doesn't belong to this provider)
  useEffect(() => {
    if (source === 'offline') return;
    const prov = API_PROVIDERS[source as ApiProvider];
    if (!prov.models.some(m => m.id === apiModel)) {
      setApiModel(prov.defaultModel);
    }
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-load offline model on mount if that was the last source
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    if (source === 'offline') {
      // Kick off load after a short tick so the worker URL is available
      setTimeout(() => loadOfflineModel(), 100);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Offline: load model ────────────────────────────────────────────────────
  const loadOfflineModel = useCallback(() => {
    workerRef.current?.terminate();
    const worker = new Worker(new URL('../chat/chat.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    setStatus('loading'); setProgress(null); setError(null); setMessages([]); setShowSettings(false); setShowSysPrompt(false);

    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'progress': setProgress({ file: data.file, loaded: data.loaded, total: data.total }); break;
        case 'ready':    setDevice(data.device); setStatus('ready'); setProgress(null); break;
        case 'token':    setStreamBuf(prev => prev + data.text); break;
        case 'done':
          setStreamBuf(buf => { if (buf) setMessages(prev => [...prev, { role: 'assistant', content: buf }]); return ''; });
          setStatus('ready'); break;
        case 'error':    setError(data.message); setStatus('error'); break;
      }
    };
    worker.onerror = e => { setError(e.message); setStatus('error'); };
    worker.postMessage({ type: 'load', modelId: offlineId });
  }, [offlineId]);

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  // ── Google OAuth ───────────────────────────────────────────────────────────
  const signInGoogle = useCallback(() => {
    if (!clientId.trim()) { setError('Enter your Google Client ID first'); return; }
    if (typeof google === 'undefined' || !google?.accounts?.oauth2) {
      setError('Google Identity Services not loaded — check your internet connection'); return;
    }
    setError(null);
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope: 'https://www.googleapis.com/auth/generative-language',
      callback: (resp) => {
        if (resp.error) { setError(`Sign-in failed: ${resp.error_description ?? resp.error}`); return; }
        setGeminiToken(resp.access_token);
        setStatus('ready'); setShowSettings(false);
      },
      error_callback: (err) => setError(`Sign-in error: ${err.type}`),
    });
    tokenClientRef.current = tc;
    tc.requestAccessToken({ prompt: '' });
  }, [clientId]);

  const signOutGoogle = () => {
    if (geminiToken) google?.accounts?.oauth2?.revoke(geminiToken, () => {});
    setGeminiToken(null); setStatus('idle'); setMessages([]); setStreamBuf('');
  };

  // ── Stop (saves partial, returns to ready) ────────────────────────────────
  const stop = useCallback((currentBuf: string) => {
    if (source === 'offline') workerRef.current?.postMessage({ type: 'abort' });
    else { abortRef.current?.abort(); abortRef.current = null; }
    if (currentBuf.trim()) setMessages(prev => [...prev, { role: 'assistant', content: currentBuf }]);
    setStreamBuf('');
    setStatus('ready');
  }, [source]);

  // ── Send ───────────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || (!isReady && status !== 'generating')) return;

    // If currently generating, abort and save the partial response first,
    // then immediately start the new request without waiting.
    let baseMessages = messages;
    if (status === 'generating') {
      if (source === 'offline') workerRef.current?.postMessage({ type: 'abort' });
      else { abortRef.current?.abort(); abortRef.current = null; }
      // Capture the current stream buffer synchronously via ref
      const partial = streamBuf.trim();
      if (partial) baseMessages = [...messages, { role: 'assistant', content: partial }];
      setStreamBuf('');
    }

    const newMessages: ChatMsg[] = [...baseMessages, { role: 'user', content: text }];
    setMessages(newMessages); setInput(''); setStatus('generating'); setError(null);

    if (source === 'offline') {
      workerRef.current?.postMessage({
        type: 'generate',
        messages: [{ role: 'system', content: systemPrompt }, ...newMessages],
        maxTokens: 256, temperature: 0.7,
      });
      return;
    }

    // API streaming
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      let gen: AsyncGenerator<string>;
      if (source === 'claude')       gen = streamClaude(claudeKey,    apiModel, newMessages, systemPrompt, ctrl.signal);
      else if (source === 'openai')  gen = streamOpenAI(openaiKey,    apiModel, newMessages, systemPrompt, ctrl.signal);
      else                           gen = streamGemini(geminiToken!, apiModel, newMessages, systemPrompt, ctrl.signal);

      let acc = '';
      for await (const token of gen) { acc += token; setStreamBuf(acc); }

      if (!ctrl.signal.aborted) {
        setMessages(prev => [...prev, { role: 'assistant', content: acc }]);
        setStreamBuf(''); setStatus('ready');
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const msg = (err as Error).message ?? String(err);
        if (source === 'gemini' && (msg.includes('401') || msg.includes('403'))) {
          setGeminiToken(null); setStatus('idle');
          setError('Session expired — please sign in again');
        } else { setError(msg); setStatus('error'); }
        setStreamBuf('');
      }
    }
    abortRef.current = null;
  }, [input, isReady, status, source, messages, streamBuf, systemPrompt, claudeKey, openaiKey, geminiToken, apiModel]);

  const clearContext = () => { setMessages([]); setStreamBuf(''); };
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  const dotClass = { idle: 'chat-dot--idle', loading: 'chat-dot--loading', ready: 'chat-dot--ready', generating: 'chat-dot--generating', error: 'chat-dot--error' }[status];

  const saveKey = (k: 'claude' | 'openai', v: string) => {
    if (k === 'claude') { setClaudeKey(v); localStorage.setItem('api_key_claude', v); }
    else                { setOpenaiKey(v); localStorage.setItem('api_key_openai', v); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="view chat-view">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="panel chat-topbar">
        <div className="chat-topbar-left">
          <span className={`chat-dot ${dotClass}`} />
          {source !== 'offline' && (
            <span className="api-provider-label" style={{ color: API_PROVIDERS[source as ApiProvider].color }}>
              {API_PROVIDERS[source as ApiProvider].label}
            </span>
          )}
          <span className="chat-topbar-model">
            {source === 'offline'
              ? (status === 'idle' ? 'No model loaded' : offlineModel.label)
              : (apiModels?.find(m => m.id === apiModel)?.label ?? apiModel)}
          </span>
          {source === 'offline' && device && <span className="engine-badge">{device.toUpperCase()}</span>}
          {source === 'gemini'  && geminiToken && <span className="engine-badge">OAuth</span>}
          {status === 'loading' && (
            <span className="chat-topbar-loading dim">
              {progress ? `${progress.file} · ${progressPct}%` : 'Initialising…'}
            </span>
          )}
        </div>
        <div className="chat-topbar-right">
          {messages.length > 0 && (
            <span className={`chat-ctx-pill${ctxWarning ? ' chat-ctx-pill--warn' : ''}`}
              title={`~${usedTokens.toLocaleString()} tokens used`}>
              {ctxPct}%{ctxWarning ? ' ⚠' : ''}
            </span>
          )}
          {/* System prompt icon */}
          <button
            className={`chat-icon-btn${showSysPrompt ? ' chat-settings-btn--active' : ''}`}
            title="System prompt"
            onClick={() => { setShowSysPrompt(p => !p); setShowSettings(false); }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </button>
          {/* Settings icon */}
          <button
            className={`chat-icon-btn${showSettings ? ' chat-settings-btn--active' : ''}`}
            title="Settings"
            onClick={() => { setShowSettings(p => !p); setShowSysPrompt(false); }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Offline loading bar */}
      {status === 'loading' && (
        <div className="chat-load-bar">
          <div className="chat-load-fill" style={{ width: `${progressPct}%` }} />
        </div>
      )}

      {error && <p className="error-banner">{error}</p>}

      {/* ── Body: messages + floating panels ─────────────────────────────── */}
      <div className="chat-body">

        {/* Messages (always full-width; panels float over) */}
        <div className="panel chat-messages">
          {messages.length === 0 && !streamBuf && (
            <p className="chat-empty">
              {source === 'offline' && status === 'idle'    && 'Open Settings → select a model → Load model.'}
              {source === 'offline' && status === 'loading' && "Downloading — this only happens once, then it's cached."}
              {source === 'offline' && status === 'ready'   && 'Model ready. Type a message below.'}
              {source !== 'offline' && !isReady             && 'Open the settings icon → choose a provider → add your key or sign in.'}
              {source !== 'offline' && isReady              && `${API_PROVIDERS[source as ApiProvider].label} ready. Type a message below.`}
              {status === 'error' && 'Something went wrong — check Settings and try again.'}
            </p>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`chat-bubble chat-bubble--${m.role}`}>
              <span className="chat-role">
                {m.role === 'user' ? 'You' : source === 'offline' ? 'AI' : API_PROVIDERS[source as ApiProvider].label}
              </span>
              <p className="chat-text">{m.content}</p>
            </div>
          ))}

          {streamBuf && (
            <div className="chat-bubble chat-bubble--assistant">
              <span className="chat-role">
                {source === 'offline' ? 'AI' : API_PROVIDERS[source as ApiProvider].label}
              </span>
              <p className="chat-text">{streamBuf}<span className="chat-cursor">▌</span></p>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* ── Floating settings panel ────────────────────────────────────── */}
        {showSettings && (
          <div className="chat-float-panel">
            <div className="chat-float-panel-header">
              <span className="chat-float-panel-title">Model</span>
              <button className="chat-settings-close-btn" onClick={() => setShowSettings(false)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {/* Source selector */}
            <div className="chat-settings-section">
              <span className="chat-settings-label">Source</span>
              <div className="api-provider-tabs">
                {(['offline', 'claude', 'openai', 'gemini'] as Source[]).map(s => {
                  const lbl = s === 'offline' ? 'Offline' : API_PROVIDERS[s as ApiProvider].label;
                  const col = s !== 'offline' ? API_PROVIDERS[s as ApiProvider].color : undefined;
                  return (
                    <button
                      key={s}
                      className={`api-provider-tab${source === s ? ' api-provider-tab--active' : ''}`}
                      style={source === s && col ? { borderColor: col, color: col } : {}}
                      onClick={() => { setSource(s); setError(null); setMessages([]); setStreamBuf(''); }}
                    >
                      {lbl}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="chat-settings-divider" />

            {/* Offline */}
            {source === 'offline' && (
              <div className="chat-settings-section">
                <span className="chat-settings-label">Model</span>
                <div className="chat-settings-model-row">
                  <select
                    className="speech-select" style={{ flex: 1 }}
                    value={offlineId}
                    onChange={e => setOfflineId(e.target.value)}
                    disabled={status === 'loading' || status === 'generating'}
                  >
                    {(['General', 'Code'] as const).map(group => (
                      <optgroup key={group} label={group}>
                        {OFFLINE_MODELS.filter(m => m.group === group).map(m => (
                          <option key={m.id} value={m.id}>{m.label} — {m.size} {m.speed}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <button
                    className="action-btn action-btn--start"
                    onClick={loadOfflineModel}
                    disabled={status === 'loading' || status === 'generating'}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {status === 'loading' ? 'Loading…' : status === 'idle' || status === 'error' ? 'Load' : 'Reload'}
                  </button>
                </div>
                <p className="chat-settings-hint">
                  {offlineModel.note} · {offlineModel.size} · {fmtCtx(offlineModel.ctxTokens)} tok ctx · runs in-browser
                </p>
              </div>
            )}

            {/* API key (Claude / OpenAI) */}
            {(source === 'claude' || source === 'openai') && (
              <div className="chat-settings-section">
                <span className="chat-settings-label">Model</span>
                <select className="speech-select" value={apiModel} onChange={e => setApiModel(e.target.value)} disabled={status === 'generating'}>
                  {apiModels?.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                {apiModels?.find(m => m.id === apiModel)?.note && (
                  <p className="chat-settings-hint">{apiModels.find(m => m.id === apiModel)!.note}</p>
                )}
                <div style={{ height: 6 }} />
                <span className="chat-settings-label">API Key</span>
                <input
                  type="password"
                  className="chat-input api-key-input"
                  placeholder={API_PROVIDERS[source].keyPlaceholder}
                  value={source === 'claude' ? claudeKey : openaiKey}
                  onChange={e => saveKey(source, e.target.value)}
                  autoComplete="off" spellCheck={false}
                />
                <p className="chat-settings-hint">
                  Stored in localStorage only.{' '}
                  <a href={API_PROVIDERS[source].docsUrl} target="_blank" rel="noopener noreferrer" className="chat-settings-link">Get key ↗</a>
                </p>
              </div>
            )}

            {/* Gemini OAuth */}
            {source === 'gemini' && (
              <div className="chat-settings-section">
                <span className="chat-settings-label">Model</span>
                <select className="speech-select" value={apiModel} onChange={e => setApiModel(e.target.value)} disabled={status === 'generating'}>
                  {apiModels?.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                {apiModels?.find(m => m.id === apiModel)?.note && (
                  <p className="chat-settings-hint">{apiModels.find(m => m.id === apiModel)!.note}</p>
                )}
                <div style={{ height: 6 }} />
                <span className="chat-settings-label">Google Client ID</span>
                <input
                  type="text"
                  className="chat-input api-key-input"
                  placeholder="…apps.googleusercontent.com"
                  value={clientId}
                  onChange={e => { setClientId(e.target.value); localStorage.setItem('gemini_client_id', e.target.value); }}
                  autoComplete="off" spellCheck={false}
                />
                <p className="chat-settings-hint">
                  OAuth 2.0 Web Client ID.{' '}
                  <a href={API_PROVIDERS.gemini.docsUrl} target="_blank" rel="noopener noreferrer" className="chat-settings-link">Enable API ↗</a>
                </p>
                {geminiToken ? (
                  <div className="api-oauth-signed-in">
                    <span className="engine-badge">Signed in</span>
                    <button className="chat-ctx-clear" onClick={signOutGoogle}>Sign out</button>
                  </div>
                ) : (
                  <button className="google-signin-btn" onClick={signInGoogle} disabled={!clientId.trim()}>
                    <svg width="18" height="18" viewBox="0 0 48 48">
                      <path fill="#EA4335" d="M24 9.5c3.5 0 6.4 1.2 8.7 3.2l6.5-6.5C35.3 2.8 30 .5 24 .5 14.8.5 7 6.3 3.5 14.3l7.6 5.9C13 14.5 18 9.5 24 9.5z"/>
                      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17z"/>
                      <path fill="#FBBC05" d="M11.1 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.6-5.9A23.5 23.5 0 0 0 .5 24c0 3.8.9 7.4 2.5 10.6l8.1-6z"/>
                      <path fill="#34A853" d="M24 47.5c6 0 11-2 14.7-5.4l-7.5-5.8c-2 1.4-4.6 2.2-7.2 2.2-6 0-11-4-12.9-9.5l-8 6.2C7.1 41.8 14.8 47.5 24 47.5z"/>
                    </svg>
                    Sign in with Google
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Floating system prompt panel ───────────────────────────────── */}
        {showSysPrompt && (
          <div className="chat-float-panel">
            <div className="chat-float-panel-header">
              <span className="chat-float-panel-title">System prompt</span>
              <button className="chat-settings-close-btn" onClick={() => setShowSysPrompt(false)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <div className="chat-settings-section" style={{ flex: 1 }}>
              <p className="chat-settings-hint" style={{ marginTop: 0 }}>
                A system prompt tells the AI <strong>who it is</strong> and <strong>how to behave</strong> before the conversation starts — like giving someone a briefing before a meeting. Use it to set the tone, topic, or personality. Leave it as-is for general use.
              </p>
              <textarea
                className="chat-input chat-system-prompt"
                style={{ flex: 1, resize: 'vertical', minHeight: 100 }}
                value={systemPrompt}
                onChange={e => setSystemPrompt(e.target.value)}
                placeholder={`Examples:\n• "You are a friendly cooking assistant. Suggest recipes based on ingredients I have."\n• "You are a travel guide. Give practical tips and destination ideas."\n• "You are a fitness coach. Give workout advice tailored to beginners."\n• "You are a creative writing partner. Help me brainstorm and refine story ideas."`}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p className="chat-settings-hint" style={{ margin: 0 }}>Changes take effect on the next message you send.</p>
                <button
                  className="chat-ctx-reset"
                  onClick={() => setSystemPrompt(DEFAULT_SYSTEM)}
                  disabled={systemPrompt === DEFAULT_SYSTEM}
                >
                  Reset
                </button>
              </div>
            </div>
          </div>
        )}

      </div>{/* /chat-body */}

      {/* ── Input ─────────────────────────────────────────────────────────── */}
      <div className="panel chat-input-wrap">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={
            isReady || status === 'generating'
              ? 'Message… (Enter to send, Shift+Enter for newline)'
              : 'Open Settings to configure a model or provider…'
          }
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={!isReady && status !== 'generating'}
          rows={2}
        />
        <div className="chat-input-footer">
          <div className="chat-input-ctx">
            {status === 'generating' && (
              <button
                className="chat-stop-inline"
                onClick={() => stop(streamBuf)}
                title="Stop generating"
              >
                <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor"/></svg>
                Stop
              </button>
            )}
            {messages.length > 0 && status !== 'generating' && (
              <>
                <span
                  className={`chat-ctx-pill${ctxWarning ? ' chat-ctx-pill--warn' : ''}`}
                  title={`~${usedTokens.toLocaleString()} tokens in context`}
                >
                  {ctxPct}%{ctxWarning ? ' ⚠' : ''}
                </span>
                <button className="chat-ctx-clear-inline" onClick={clearContext}>
                  Clear context
                </button>
              </>
            )}
          </div>
          <div className="chat-input-actions">
            <button
              className="action-btn action-btn--start"
              onClick={() => void send()}
              disabled={!isReady && status !== 'generating' || !input.trim()}
            >
              {status === 'generating' ? 'Interrupt & Send' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

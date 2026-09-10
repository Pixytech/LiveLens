import { useCallback, useEffect, useRef, useState } from 'react';
import { streamClaude, streamOpenAI, streamGemini, type ChatMsg } from '../lib/apiStream';

// ── Provider config ───────────────────────────────────────────────────────────

type Provider = 'claude' | 'openai' | 'gemini';

const PROVIDERS = {
  claude: {
    label: 'Claude',
    authType: 'key' as const,
    keyPlaceholder: 'sk-ant-api03-…',
    docsLabel: 'Get key at console.anthropic.com',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-5',         label: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4-5',            label: 'Claude Opus 4.5' },
    ],
    defaultModel: 'claude-sonnet-4-5',
    color: '#d4a27f',
  },
  openai: {
    label: 'OpenAI',
    authType: 'key' as const,
    keyPlaceholder: 'sk-proj-…',
    docsLabel: 'Get key at platform.openai.com',
    docsUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
      { id: 'gpt-4o',      label: 'GPT-4o' },
      { id: 'o1-mini',     label: 'o1 Mini (reasoning)' },
    ],
    defaultModel: 'gpt-4o-mini',
    color: '#74aa9c',
  },
  gemini: {
    label: 'Gemini',
    authType: 'oauth' as const,
    keyPlaceholder: '',
    docsLabel: 'Enable API at console.cloud.google.com',
    docsUrl: 'https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com',
    models: [
      { id: 'gemini-2.0-flash',  label: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-flash',  label: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-pro',    label: 'Gemini 1.5 Pro' },
    ],
    defaultModel: 'gemini-2.0-flash',
    color: '#4285f4',
  },
} as const;

const DEFAULT_SYSTEM = 'You are a helpful, concise assistant. Keep answers short and clear.';

// ── Component ─────────────────────────────────────────────────────────────────

type Status = 'idle' | 'ready' | 'generating' | 'error';

export function ApiChatView() {
  const [provider, setProvider]             = useState<Provider>('claude');
  const [model, setModel]                   = useState<string>(PROVIDERS.claude.defaultModel);
  const [showSettings, setShowSettings]     = useState(true);
  const [systemPrompt, setSystemPrompt]     = useState(DEFAULT_SYSTEM);
  const [status, setStatus]                 = useState<Status>('idle');
  const [error, setError]                   = useState<string | null>(null);
  const [messages, setMessages]             = useState<ChatMsg[]>([]);
  const [input, setInput]                   = useState('');
  const [streamBuf, setStreamBuf]           = useState('');

  // API keys (persisted to localStorage)
  const [claudeKey, setClaudeKey] = useState(() => localStorage.getItem('api_key_claude') ?? '');
  const [openaiKey, setOpenaiKey] = useState(() => localStorage.getItem('api_key_openai') ?? '');

  // Gemini OAuth
  const [clientId, setClientId]     = useState(() => localStorage.getItem('gemini_client_id') ?? '');
  const [geminiToken, setGeminiToken] = useState<string | null>(null);
  const tokenClientRef = useRef<{ requestAccessToken: (c?: object) => void } | null>(null);

  const abortRef  = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  const cfg = PROVIDERS[provider];
  const models = cfg.models as readonly { id: string; label: string }[];

  // Reset model when switching provider
  useEffect(() => { setModel(PROVIDERS[provider].defaultModel); }, [provider]);

  // Auto-scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamBuf]);

  const isReady =
    (provider === 'claude' && !!claudeKey) ||
    (provider === 'openai' && !!openaiKey) ||
    (provider === 'gemini' && !!geminiToken);

  // Token estimate for context pill
  const usedTokens = Math.round((systemPrompt + messages.map(m => m.content).join(' ')).length / 4);

  // ── Key / ID save helpers ──────────────────────────────────────────────────
  const saveClaudeKey = (v: string) => { setClaudeKey(v); localStorage.setItem('api_key_claude', v); };
  const saveOpenaiKey = (v: string) => { setOpenaiKey(v); localStorage.setItem('api_key_openai', v); };
  const saveClientId  = (v: string) => { setClientId(v);  localStorage.setItem('gemini_client_id', v); };

  // ── Google OAuth ──────────────────────────────────────────────────────────
  const signInWithGoogle = useCallback(() => {
    if (!clientId.trim()) { setError('Enter your Google Client ID first'); return; }
    if (typeof google === 'undefined' || !google?.accounts?.oauth2) {
      setError('Google Identity Services not loaded — check your connection'); return;
    }
    setError(null);
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope: 'https://www.googleapis.com/auth/generative-language',
      callback: (resp) => {
        if (resp.error) { setError(`Sign-in failed: ${resp.error_description ?? resp.error}`); return; }
        setGeminiToken(resp.access_token);
        setStatus('ready');
        setShowSettings(false);
      },
      error_callback: (err) => setError(`Sign-in error: ${err.type}`),
    });
    tokenClientRef.current = tc;
    tc.requestAccessToken({ prompt: '' });
  }, [clientId]);

  const signOut = () => {
    if (geminiToken) google?.accounts?.oauth2?.revoke(geminiToken, () => {});
    setGeminiToken(null);
    setStatus('idle');
    setMessages([]);
    setStreamBuf('');
  };

  // ── Send ──────────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || status !== 'ready') return;

    const newMessages: ChatMsg[] = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setStatus('generating');
    setError(null);

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      let gen: AsyncGenerator<string>;
      if (provider === 'claude') {
        gen = streamClaude(claudeKey, model, newMessages, systemPrompt, ctrl.signal);
      } else if (provider === 'openai') {
        gen = streamOpenAI(openaiKey, model, newMessages, systemPrompt, ctrl.signal);
      } else {
        gen = streamGemini(geminiToken!, model, newMessages, systemPrompt, ctrl.signal);
      }

      let acc = '';
      for await (const token of gen) {
        acc += token;
        setStreamBuf(acc);
      }

      if (!ctrl.signal.aborted) {
        setMessages(prev => [...prev, { role: 'assistant', content: acc }]);
        setStreamBuf('');
        setStatus('ready');
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const msg = (err as Error).message ?? String(err);
        if (provider === 'gemini' && (msg.includes('401') || msg.includes('403'))) {
          setGeminiToken(null);
          setStatus('idle');
          setError('Session expired — please sign in again');
        } else {
          setError(msg);
          setStatus('error');
        }
        setStreamBuf('');
      }
    }
    abortRef.current = null;
  }, [input, status, messages, provider, claudeKey, openaiKey, geminiToken, model, systemPrompt]);

  const stop = () => {
    abortRef.current?.abort();
    setStreamBuf(buf => {
      if (buf) setMessages(prev => [...prev, { role: 'assistant', content: buf }]);
      return '';
    });
    setStatus('ready');
  };

  const clearContext = () => { setMessages([]); setStreamBuf(''); };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Mark ready when key is saved for key-based providers
  useEffect(() => {
    if (provider === 'claude' && claudeKey) setStatus('ready');
    else if (provider === 'openai' && openaiKey) setStatus('ready');
    else if (provider !== 'gemini') setStatus('idle');
  }, [provider, claudeKey, openaiKey]);

  // ── Status dot ────────────────────────────────────────────────────────────
  const dotClass = {
    idle: 'chat-dot--idle',
    ready: 'chat-dot--ready',
    generating: 'chat-dot--generating',
    error: 'chat-dot--error',
  }[status];

  return (
    <div className="view chat-view">

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="panel chat-topbar">
        <div className="chat-topbar-left">
          <span className={`chat-dot ${dotClass}`} />
          <span
            className="api-provider-label"
            style={{ color: cfg.color }}
          >
            {cfg.label}
          </span>
          <span className="chat-topbar-model dim">
            {models.find(m => m.id === model)?.label ?? model}
          </span>
          {provider === 'gemini' && geminiToken && (
            <span className="engine-badge">OAuth</span>
          )}
        </div>
        <div className="chat-topbar-right">
          <button
            className={`chat-settings-btn${showSettings ? ' chat-settings-btn--active' : ''}`}
            onClick={() => setShowSettings(p => !p)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            Settings
          </button>
        </div>
      </div>

      {/* ── Settings drawer ───────────────────────────────────────────────── */}
      {showSettings && (
        <div className="panel chat-settings-drawer">

          {/* Header */}
          <div className="chat-settings-section chat-settings-header-row">
            <span className="chat-settings-label" style={{ fontSize: '0.85rem', color: 'var(--ink)' }}>Settings</span>
            <button className="chat-settings-close-btn" onClick={() => setShowSettings(false)}>✕ Close</button>
          </div>

          <div className="chat-settings-divider" />

          {/* Provider tabs */}
          <div className="chat-settings-section">
            <span className="chat-settings-label">Provider</span>
            <div className="api-provider-tabs">
              {(Object.keys(PROVIDERS) as Provider[]).map(p => (
                <button
                  key={p}
                  className={`api-provider-tab${provider === p ? ' api-provider-tab--active' : ''}`}
                  style={provider === p ? { borderColor: PROVIDERS[p].color, color: PROVIDERS[p].color } : {}}
                  onClick={() => { setProvider(p); setError(null); }}
                >
                  {PROVIDERS[p].label}
                </button>
              ))}
            </div>
          </div>

          <div className="chat-settings-divider" />

          {/* Model */}
          <div className="chat-settings-section">
            <span className="chat-settings-label">Model</span>
            <select
              className="speech-select"
              value={model}
              onChange={e => setModel(e.target.value)}
              disabled={status === 'generating'}
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>

          <div className="chat-settings-divider" />

          {/* Auth — key entry or Google OAuth */}
          <div className="chat-settings-section">
            {cfg.authType === 'key' ? (
              <>
                <span className="chat-settings-label">API Key</span>
                <div className="api-key-row">
                  <input
                    type="password"
                    className="chat-input api-key-input"
                    placeholder={cfg.keyPlaceholder}
                    value={provider === 'claude' ? claudeKey : openaiKey}
                    onChange={e => provider === 'claude' ? saveClaudeKey(e.target.value) : saveOpenaiKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <p className="chat-settings-hint">
                  Stored in browser localStorage only — never sent anywhere except {cfg.label}'s API.{' '}
                  <a href={cfg.docsUrl} target="_blank" rel="noopener noreferrer" className="chat-settings-link">
                    {cfg.docsLabel} ↗
                  </a>
                </p>
              </>
            ) : (
              <>
                <span className="chat-settings-label">Google OAuth</span>
                <div className="api-key-row">
                  <input
                    type="text"
                    className="chat-input api-key-input"
                    placeholder="Google OAuth Client ID (…apps.googleusercontent.com)"
                    value={clientId}
                    onChange={e => saveClientId(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <p className="chat-settings-hint">
                  Create an OAuth 2.0 Client ID (Web application) in Google Cloud Console, add{' '}
                  <code>http://localhost:5173</code> to Authorised JavaScript origins.{' '}
                  <a href={cfg.docsUrl} target="_blank" rel="noopener noreferrer" className="chat-settings-link">
                    Enable Generative Language API ↗
                  </a>
                </p>

                {geminiToken ? (
                  <div className="api-oauth-signed-in">
                    <span className="engine-badge">Signed in</span>
                    <button className="chat-ctx-clear" onClick={signOut}>Sign out</button>
                  </div>
                ) : (
                  <button className="google-signin-btn" onClick={signInWithGoogle} disabled={!clientId.trim()}>
                    <svg width="18" height="18" viewBox="0 0 48 48">
                      <path fill="#EA4335" d="M24 9.5c3.5 0 6.4 1.2 8.7 3.2l6.5-6.5C35.3 2.8 30 .5 24 .5 14.8.5 7 6.3 3.5 14.3l7.6 5.9C13 14.5 18 9.5 24 9.5z"/>
                      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17z"/>
                      <path fill="#FBBC05" d="M11.1 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.6-5.9A23.5 23.5 0 0 0 .5 24c0 3.8.9 7.4 2.5 10.6l8.1-6z"/>
                      <path fill="#34A853" d="M24 47.5c6 0 11-2 14.7-5.4l-7.5-5.8c-2 1.4-4.6 2.2-7.2 2.2-6 0-11-4-12.9-9.5l-8 6.2C7.1 41.8 14.8 47.5 24 47.5z"/>
                    </svg>
                    Sign in with Google
                  </button>
                )}
              </>
            )}
          </div>

          <div className="chat-settings-divider" />

          {/* System prompt */}
          <div className="chat-settings-section">
            <div className="chat-settings-label-row">
              <span className="chat-settings-label">System prompt</span>
              <button
                className="chat-ctx-reset"
                onClick={() => setSystemPrompt(DEFAULT_SYSTEM)}
                disabled={systemPrompt === DEFAULT_SYSTEM}
              >
                Reset
              </button>
            </div>
            <textarea
              className="chat-input chat-system-prompt"
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              rows={3}
            />
            <p className="chat-settings-hint">Takes effect on the next message.</p>
          </div>
        </div>
      )}

      {error && <p className="error-banner">{error}</p>}

      {/* ── Messages ──────────────────────────────────────────────────────── */}
      <div className="panel chat-messages">
        {messages.length === 0 && !streamBuf && (
          <p className="chat-empty">
            {!isReady
              ? 'Open Settings → choose a provider → add your key or sign in.'
              : 'Ready. Type a message below.'}
          </p>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble chat-bubble--${m.role}`}>
            <span className="chat-role">{m.role === 'user' ? 'You' : cfg.label}</span>
            <p className="chat-text">{m.content}</p>
          </div>
        ))}

        {streamBuf && (
          <div className="chat-bubble chat-bubble--assistant">
            <span className="chat-role">{cfg.label}</span>
            <p className="chat-text">{streamBuf}<span className="chat-cursor">▌</span></p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ─────────────────────────────────────────────────────────── */}
      <div className="panel chat-input-wrap">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={isReady || status === 'generating'
            ? 'Message… (Enter to send, Shift+Enter for newline)'
            : 'Configure a provider in Settings first…'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={!isReady && status !== 'generating'}
          rows={2}
        />
        <div className="chat-input-footer">
          <div className="chat-input-ctx">
            {messages.length > 0 && (
              <>
                <span className="chat-ctx-pill dim" title={`~${usedTokens.toLocaleString()} tokens in context`}>
                  ~{usedTokens.toLocaleString()} tk
                </span>
                <button
                  className="chat-ctx-clear-inline"
                  onClick={clearContext}
                  disabled={status === 'generating'}
                >
                  Clear context
                </button>
              </>
            )}
          </div>
          <div className="chat-input-actions">
            {status === 'generating' ? (
              <button className="action-btn action-btn--stop" onClick={stop}>Stop</button>
            ) : (
              <button
                className="action-btn action-btn--start"
                onClick={send}
                disabled={!isReady || !input.trim()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

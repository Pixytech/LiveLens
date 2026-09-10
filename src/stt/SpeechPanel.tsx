import { CSSProperties, useEffect, useRef } from 'react';
import { useSpeechToText } from './useSpeechToText';

interface SpeechPanelProps {
  language?: string;
  onTranscript?: (text: string) => void;
}

type Status = 'idle' | 'listening' | 'reconnecting' | 'error';

const STATUS_LABEL: Record<Status, string> = {
  idle:         'Idle',
  listening:    'Listening…',
  reconnecting: 'Reconnecting…',
  error:        'Error',
};

const STATUS_COLOR: Record<Status, string> = {
  idle:         '#6b7280',
  listening:    '#22c55e',
  reconnecting: '#f59e0b',
  error:        '#ef4444',
};

export function SpeechPanel({ language = 'en-US', onTranscript }: SpeechPanelProps) {
  const { status, transcript, partial, error, start, stop, clearTranscript } =
    useSpeechToText({ language });

  const prevLenRef = useRef(0);

  useEffect(() => {
    if (!transcript || !onTranscript) return;
    if (transcript.length <= prevLenRef.current) return;
    const delta = prevLenRef.current ? transcript.slice(prevLenRef.current + 1) : transcript;
    if (delta) onTranscript(delta);
    prevLenRef.current = transcript.length;
  }, [transcript, onTranscript]);

  useEffect(() => {
    if (!transcript) prevLenRef.current = 0;
  }, [transcript]);

  const active = status === 'listening' || status === 'reconnecting';

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Speech</span>
        <span style={{ ...styles.dot, background: STATUS_COLOR[status] }} />
        <span style={styles.statusLabel}>{STATUS_LABEL[status]}</span>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.transcriptBox}>
        {transcript && <span style={styles.committed}>{transcript}</span>}
        {partial && (
          <span style={styles.partialText}>{transcript ? ` ${partial}` : partial}</span>
        )}
        {!transcript && !partial && (
          <span style={styles.placeholder}>Transcript will appear here…</span>
        )}
      </div>

      <div style={styles.controls}>
        {active ? (
          <button style={{ ...styles.btn, ...styles.btnStop }} onClick={stop}>Stop</button>
        ) : (
          <button style={{ ...styles.btn, ...styles.btnStart }} onClick={start}>Start</button>
        )}
        <button
          style={{ ...styles.btn, ...styles.btnClear }}
          onClick={clearTranscript}
          disabled={!transcript}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    background: '#1a1a2e',
    border: '1px solid #2d2d4a',
    borderRadius: 10,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    minWidth: 280,
    fontFamily: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: '#e2e8f0',
    fontWeight: 600,
    fontSize: 14,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  },
  statusLabel: { color: '#94a3b8', fontSize: 12, flexGrow: 1 },
  error: {
    color: '#f87171',
    fontSize: 12,
    margin: 0,
    padding: '6px 8px',
    background: 'rgba(69,10,10,0.27)',
    borderRadius: 6,
  },
  transcriptBox: {
    background: '#0f0f1a',
    borderRadius: 6,
    padding: '10px 12px',
    minHeight: 80,
    maxHeight: 200,
    overflowY: 'auto',
    fontSize: 14,
    lineHeight: 1.6,
    wordBreak: 'break-word',
  },
  committed:   { color: '#e2e8f0' },
  partialText: { color: '#94a3b8', fontStyle: 'italic' },
  placeholder: { color: '#475569', fontStyle: 'italic' },
  controls: { display: 'flex', gap: 8 },
  btn: {
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  btnStart: { background: '#22c55e', color: '#fff' },
  btnStop:  { background: '#ef4444', color: '#fff' },
  btnClear: { background: '#334155', color: '#cbd5e1' },
};

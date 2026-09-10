import { useCallback, useEffect, useRef, useState } from 'react';


type Status = 'idle' | 'listening' | 'reconnecting' | 'error';

interface Options {
  language?: string;
  onSegment?: (text: string) => void;
}

interface Result {
  status: Status;
  transcript: string;
  partial: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  clearTranscript: () => void;
}

const TRANSIENT = new Set(['no-speech', 'network', 'aborted', 'audio-capture']);

export function useSpeechToText({ language = 'en-US', onSegment }: Options = {}): Result {
  const [status, setStatus]             = useState<Status>('idle');
  const [transcript, setTranscript]     = useState('');
  const [partial, setPartial]           = useState('');
  const [error, setError]               = useState<string | null>(null);
  const recRef    = useRef<SpeechRecognition | null>(null);
  const activeRef = useRef(false);

  const start = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    setError(null);

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;

    if (!SR) {
      setError('SpeechRecognition is not supported in this browser. Use Chrome or Edge.');
      setStatus('error');
      activeRef.current = false;
      return;
    }

    // Accepted after the guard — SR is a defined constructor here.
    function makeRec(): SpeechRecognition {
      const rec = new SR!();
      rec.continuous     = true;
      rec.interimResults = true;
      rec.lang           = language;

      rec.onstart = () => setStatus('listening');

      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) {
            const text = r[0].transcript.trim();
            if (text) {
              setTranscript((prev) => (prev ? `${prev} ${text}` : text));
              onSegment?.(text);
            }
            setPartial('');
          } else {
            interim += r[0].transcript;
          }
        }
        if (interim) setPartial(interim);
      };

      rec.onerror = (event) => {
        if (TRANSIENT.has(event.error)) {
          if (event.error === 'network') setStatus('reconnecting');
          return;
        }
        setError(`Microphone error: ${event.error}`);
        setStatus('error');
        activeRef.current = false;
      };

      // Re-create the recogniser on each restart — avoids a Chrome bug where
      // calling .start() on a used instance accumulates stale session state.
      rec.onend = () => {
        if (!activeRef.current) { setStatus('idle'); return; }
        setTimeout(() => {
          if (!activeRef.current) { setStatus('idle'); return; }
          const next = makeRec();
          recRef.current = next;
          try { next.start(); } catch { /* race — ignore */ }
        }, 150);
      };

      return rec;
    }

    const rec = makeRec();
    recRef.current = rec;
    rec.start();
  }, [language, onSegment]);

  const stop = useCallback(() => {
    activeRef.current = false;
    recRef.current?.stop();
    recRef.current = null;
    setStatus('idle');
    setPartial('');
  }, []);

  const clearTranscript = useCallback(() => setTranscript(''), []);

  useEffect(() => () => stop(), [stop]);

  return { status, transcript, partial, error, start, stop, clearTranscript };
}

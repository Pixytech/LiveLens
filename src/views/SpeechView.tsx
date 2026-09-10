import { useEffect, useRef, useState } from "react";
import { useSpeechToText } from "../stt/useSpeechToText";

const LANGUAGES = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "hi-IN", label: "Hindi" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ar-SA", label: "Arabic" },
];

const STATUS_COLOR: Record<string, string> = {
  idle:         "var(--dim)",
  loading:      "#f59e0b",
  listening:    "var(--teal)",
  transcribing: "#a855f7",
  reconnecting: "#f59e0b",
  error:        "var(--red)",
};

export function SpeechView() {
  const [lang, setLang] = useState("en-US");

  // Always use the native engine; Whisper only kicks in automatically on
  // Firefox where SpeechRecognition is unavailable — not exposed as a choice.
  const { status, transcript, partial, error, start, stop, clearTranscript } =
    useSpeechToText({ language: lang });

  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [transcript, partial]);

  const active   = status === "listening" || status === "reconnecting";
  const dotColor = STATUS_COLOR[status] ?? "var(--dim)";

  return (
    <div className="view speech-view">
      <div className="view-arch">
        <span className="view-arch-label">How it works</span>
        Audio is streamed to the browser's built-in SpeechRecognition API — backed by Google's cloud recogniser on Chrome/Edge — delivering interim words in ~100 ms with no model download or local processing.
      </div>

      {/* Transcript */}
      <div className="speech-transcript-wrap panel">
        <div className="panel-header">
          <span>Transcript</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="speech-status-dot" style={{ background: dotColor }} />
            <span className="pyodide-status" style={{ color: dotColor }}>{status}</span>
          </span>
        </div>

        <div className="speech-transcript" ref={boxRef}>
          {transcript ? (
            <>
              <span className="speech-committed">{transcript}</span>
              {partial && <span className="speech-partial"> {partial}</span>}
            </>
          ) : partial ? (
            <span className="speech-partial">{partial}</span>
          ) : (
            <span className="speech-placeholder">
              {active ? "Listening for speech…" : "Press Start to begin transcription."}
            </span>
          )}
        </div>
      </div>

      {error && <p className="error-banner">{error}</p>}

      {/* Controls */}
      <div className="speech-controls panel">
        <div className="speech-control-group">
          <label className="speech-ctrl-label" htmlFor="lang-select">Language</label>
          <select
            id="lang-select"
            className="speech-select"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            disabled={active}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        <div className="speech-actions">
          {active ? (
            <button className="action-btn action-btn--stop" onClick={stop}>Stop</button>
          ) : (
            <button className="action-btn action-btn--start" onClick={start}>
              Start
            </button>
          )}
          <button
            className="action-btn action-btn--clear"
            onClick={clearTranscript}
            disabled={!transcript}
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

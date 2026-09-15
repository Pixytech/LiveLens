import { useCallback, useEffect, useRef, useState } from 'react';
import Tesseract from 'tesseract.js';

// ── Languages ─────────────────────────────────────────────────────────────────

const LANGUAGES = [
  { code: 'eng',     label: 'English' },
  { code: 'fra',     label: 'French' },
  { code: 'deu',     label: 'German' },
  { code: 'spa',     label: 'Spanish' },
  { code: 'por',     label: 'Portuguese' },
  { code: 'ita',     label: 'Italian' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' },
  { code: 'chi_tra', label: 'Chinese (Traditional)' },
  { code: 'jpn',     label: 'Japanese' },
  { code: 'kor',     label: 'Korean' },
  { code: 'ara',     label: 'Arabic' },
  { code: 'hin',     label: 'Hindi' },
  { code: 'rus',     label: 'Russian' },
];

// ── Types ─────────────────────────────────────────────────────────────────────

type OcrStatus = 'idle' | 'loading' | 'ready' | 'scanning' | 'error';

interface NormRect { x: number; y: number; w: number; h: number; }

const LOAD_BANDS: Record<string, [number, number]> = {
  'loading tesseract core':       [0,  25],
  'initializing tesseract':       [25, 45],
  'loading language traineddata': [45, 85],
  'initializing api':             [85, 100],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function videoRenderArea(bounds: DOMRect, video: HTMLVideoElement) {
  const cW = bounds.width, cH = bounds.height;
  const vW = video.videoWidth, vH = video.videoHeight;
  if (!vW || !vH) return null;
  const vA = vW / vH, cA = cW / cH;
  let rX: number, rY: number, rW: number, rH: number;
  if (vA > cA) { rW = cW; rH = cW / vA; rX = 0;           rY = (cH - rH) / 2; }
  else          { rH = cH; rW = cH * vA; rX = (cW - rW) / 2; rY = 0; }
  return { rX, rY, rW, rH };
}

function pointToNorm(cx: number, cy: number, bounds: DOMRect, video: HTMLVideoElement) {
  const area = videoRenderArea(bounds, video);
  if (!area) return null;
  return {
    nx: Math.max(0, Math.min(1, (cx - area.rX) / area.rW)),
    ny: Math.max(0, Math.min(1, (cy - area.rY) / area.rH)),
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MonitorView() {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const workerRef  = useRef<Tesseract.Worker | null>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const phaseRef   = useRef<'loading' | 'scanning'>('loading');
  const dragStartRef = useRef<{ nx: number; ny: number } | null>(null);
  const dragCurrRef  = useRef<{ nx: number; ny: number } | null>(null);
  const selRef       = useRef<NormRect | null>(null);

  const [hasStream,   setHasStream]   = useState(false);
  const [lang,        setLang]        = useState('eng');
  const [loadedLang,  setLoadedLang]  = useState<string | null>(null);
  const [ocrStatus,   setOcrStatus]   = useState<OcrStatus>('idle');
  const [ocrProgress, setOcrProgress] = useState(0);
  const [output,      setOutput]      = useState('');
  const [ocrError,    setOcrError]    = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [selection,   setSelection]   = useState<NormRect | null>(null);

  // ── Stream ────────────────────────────────────────────────────────────────

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setHasStream(false);
  }, []);

  const selectScreen = useCallback(async () => {
    setScreenError(null);
    stopStream();
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 15 } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play().catch(() => null);
      }
      setHasStream(true);
      s.getVideoTracks()[0].addEventListener('ended', stopStream);
    } catch (e) {
      if ((e as Error)?.name !== 'NotAllowedError') {
        setScreenError(`Screen capture failed: ${(e as Error)?.message ?? ''}`);
      }
    }
  }, [stopStream]);

  // ── Selection overlay ─────────────────────────────────────────────────────

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const video  = videoRef.current;
    if (!canvas) return;

    const bounds = canvas.getBoundingClientRect();
    const cW = Math.round(bounds.width), cH = Math.round(bounds.height);
    if (!cW || !cH) return;

    canvas.width  = cW;
    canvas.height = cH;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cW, cH);

    const area = video ? videoRenderArea(bounds, video) : null;
    if (!area) return;

    let rect: NormRect | null = null;
    if (dragStartRef.current && dragCurrRef.current) {
      const { nx: x1, ny: y1 } = dragStartRef.current;
      const { nx: x2, ny: y2 } = dragCurrRef.current;
      rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    } else {
      rect = selRef.current;
    }

    if (!rect || rect.w < 0.005 || rect.h < 0.005) return;

    const sX = area.rX + rect.x * area.rW;
    const sY = area.rY + rect.y * area.rH;
    const sW = rect.w * area.rW;
    const sH = rect.h * area.rH;

    ctx.fillStyle = 'rgba(0,0,0,0.48)';
    ctx.fillRect(0, 0, cW, cH);
    ctx.clearRect(sX, sY, sW, sH);

    ctx.strokeStyle = '#00d4b4';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(sX + 1, sY + 1, sW - 2, sH - 2);
    ctx.setLineDash([]);

    ctx.fillStyle = '#00d4b4';
    for (const [hx, hy] of [[sX, sY], [sX + sW, sY], [sX, sY + sH], [sX + sW, sY + sH]] as [number, number][]) {
      ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill();
    }
  }, []);

  useEffect(() => { drawOverlay(); }, [selection, drawOverlay]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!hasStream) return;
    e.preventDefault();

    const canvas = overlayRef.current;
    const video  = videoRef.current;
    if (!canvas || !video) return;

    const bounds = canvas.getBoundingClientRect();
    const ptFrom = (ev: { clientX: number; clientY: number }) =>
      pointToNorm(ev.clientX - bounds.left, ev.clientY - bounds.top, bounds, video);

    const startPt = ptFrom(e);
    if (!startPt) return;

    dragStartRef.current = startPt;
    dragCurrRef.current  = startPt;
    selRef.current = null;
    setSelection(null);

    const onMove = (ev: MouseEvent) => {
      const pt = ptFrom(ev);
      if (!pt) return;
      dragCurrRef.current = pt;
      drawOverlay();
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      const pt = ptFrom(ev);
      if (pt) dragCurrRef.current = pt;

      const s = dragStartRef.current, c = dragCurrRef.current;
      dragStartRef.current = null;
      dragCurrRef.current  = null;

      if (s && c) {
        const r: NormRect = {
          x: Math.min(s.nx, c.nx), y: Math.min(s.ny, c.ny),
          w: Math.abs(c.nx - s.nx), h: Math.abs(c.ny - s.ny),
        };
        if (r.w > 0.01 && r.h > 0.01) {
          selRef.current = r;
          setSelection(r);
        } else {
          selRef.current = null;
          setSelection(null);
        }
      }
      drawOverlay();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }, [hasStream, drawOverlay]);

  const clearSelection = useCallback(() => {
    selRef.current = null;
    dragStartRef.current = null;
    dragCurrRef.current  = null;
    setSelection(null);
    const canvas = overlayRef.current;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  // ── OCR engine ────────────────────────────────────────────────────────────

  const loadEngine = useCallback(async () => {
    if (workerRef.current) {
      await workerRef.current.terminate().catch(() => null);
      workerRef.current = null;
    }
    setOcrStatus('loading');
    setOcrProgress(0);
    setOcrError(null);
    phaseRef.current = 'loading';

    try {
      const worker = await Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
        logger: (m: Tesseract.LoggerMessage) => {
          if (phaseRef.current === 'loading') {
            const band = LOAD_BANDS[m.status];
            if (band) setOcrProgress(band[0] + Math.round((m.progress ?? 0) * (band[1] - band[0])));
          } else if (m.status === 'recognizing text') {
            setOcrProgress(Math.round((m.progress ?? 0) * 100));
          }
        },
      });
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
      workerRef.current = worker;
      setLoadedLang(lang);
      setOcrProgress(100);
      setOcrStatus('ready');
    } catch (err) {
      setOcrError(String((err as Error).message ?? err));
      setOcrStatus('error');
    }
  }, [lang]);

  // Auto-load on mount and when language changes so the engine is ready
  // before the user finishes picking a screen.
  useEffect(() => { loadEngine(); }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = useCallback(async () => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !workerRef.current || ocrStatus !== 'ready') return;

    const sel = selRef.current;
    const ctx  = canvas.getContext('2d');
    if (!ctx) return;

    if (sel && sel.w > 0.01 && sel.h > 0.01) {
      const vW = video.videoWidth, vH = video.videoHeight;
      const srcX = Math.round(sel.x * vW), srcY = Math.round(sel.y * vH);
      const srcW = Math.round(sel.w * vW), srcH = Math.round(sel.h * vH);

      const MIN_DIM = 600;
      const scale   = srcW < MIN_DIM || srcH < MIN_DIM ? Math.max(MIN_DIM / srcW, MIN_DIM / srcH) : 1;
      canvas.width  = Math.round(srcW * scale);
      canvas.height = Math.round(srcH * scale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
    } else {
      canvas.width  = video.videoWidth  || 1280;
      canvas.height = video.videoHeight || 720;
      ctx.drawImage(video, 0, 0);
    }

    setOcrStatus('scanning');
    setOutput('');
    setOcrError(null);
    setOcrProgress(0);
    phaseRef.current = 'scanning';

    try {
      const { data: { text } } = await workerRef.current.recognize(canvas);
      setOutput(text.trim());
      setOcrStatus('ready');
    } catch (err) {
      setOcrError(String((err as Error).message ?? err));
      setOcrStatus('error');
    }
  }, [ocrStatus]);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      workerRef.current?.terminate().catch(() => null);
      stopStream();
    };
  }, [stopStream]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const isOcrLoading = ocrStatus === 'loading';
  const isScanning   = ocrStatus === 'scanning';
  const canScan      = ocrStatus === 'ready' && hasStream;

  const ocrDot = { idle: 'chat-dot--idle', loading: 'chat-dot--loading', ready: 'chat-dot--ready', scanning: 'chat-dot--generating', error: 'chat-dot--error' }[ocrStatus];

  const ocrStatusLabel = {
    idle:     'Initialising…',
    loading:  'Loading Tesseract…',
    ready:    `Ready · ${LANGUAGES.find(l => l.code === loadedLang)?.label ?? loadedLang}`,
    scanning: 'Scanning…',
    error:    'Error',
  }[ocrStatus];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="view monitor-view">
      <p className="view-arch">
        <span className="view-arch-label">How it works</span>
        Select a monitor or window to preview it live. Drag on the feed to restrict the scan area, then hit Scan to extract text with Tesseract OCR. Nothing leaves your browser.
      </p>

      {screenError && <p className="error-banner" style={{ marginBottom: 0 }}>{screenError}</p>}

      <div className="monitor-grid">

        {/* ── Left: live feed ── */}
        <div className="monitor-feed-wrap">
          <div className="monitor-feed">
            {!hasStream && (
              <div className="monitor-feed-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="1.5">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
                <p style={{ margin: 0 }}>No screen selected</p>
                <button className="action-btn action-btn--start" onClick={selectScreen}>
                  Select Screen
                </button>
              </div>
            )}

            <video
              ref={videoRef}
              className="monitor-video"
              autoPlay
              playsInline
              muted
              style={{ display: hasStream ? 'block' : 'none' }}
            />

            {hasStream && (
              <canvas
                ref={overlayRef}
                className="monitor-overlay"
                onMouseDown={handleMouseDown}
                title="Drag to select scan area"
              />
            )}

            {hasStream && (
              <div className="monitor-feed-controls">
                {selection && (
                  <button className="monitor-ctrl-btn monitor-ctrl-btn--accent" onClick={clearSelection}>
                    ✕ Clear
                  </button>
                )}
                <button className="monitor-ctrl-btn" onClick={selectScreen}>Change</button>
                <button
                  className={`action-btn ${canScan ? 'action-btn--start' : ''} monitor-scan-btn`}
                  onClick={scan}
                  disabled={!canScan}
                >
                  {isScanning ? 'Scanning…' : '⊙ Scan'}
                </button>
              </div>
            )}
          </div>

          {selection && (
            <p className="monitor-selection-hint">
              Scan area: {Math.round(selection.x * 100)}%,{Math.round(selection.y * 100)}%
              {' → '}{Math.round((selection.x + selection.w) * 100)}%,{Math.round((selection.y + selection.h) * 100)}%
              &ensp;({Math.round(selection.w * 100)}×{Math.round(selection.h * 100)}%)
            </p>
          )}
        </div>

        {/* ── Right: OCR settings ── */}
        <div className="monitor-settings-col">
          <div className="panel">
            <div className="panel-header">OCR Engine</div>

            <div className="monitor-status-row">
              <span className={`chat-dot ${ocrDot}`} />
              <span className="monitor-status-label">{ocrStatusLabel}</span>
            </div>

            {(isOcrLoading || isScanning) && (
              <div style={{ marginBottom: 12 }}>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${ocrProgress}%` }} />
                </div>
                <p className="monitor-progress-label">
                  {isOcrLoading ? `Loading · ${ocrProgress}%` : `Recognising · ${ocrProgress}%`}
                </p>
              </div>
            )}

            <div className="monitor-field">
              <label className="chat-settings-label">Language</label>
              <select
                className="speech-select"
                value={lang}
                onChange={e => setLang(e.target.value)}
                disabled={isOcrLoading}
              >
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
              <p className="chat-settings-hint">Language data (~10 MB) caches after first load.</p>
            </div>

            <button
              className="action-btn action-btn--start monitor-load-btn"
              onClick={loadEngine}
              disabled={isOcrLoading}
            >
              {isOcrLoading ? 'Loading…' : loadedLang === lang && ocrStatus === 'ready' ? 'Reload Engine' : 'Load Engine'}
            </button>

            {ocrError && <p className="monitor-error">{ocrError}</p>}
          </div>
        </div>
      </div>

      {/* ── Output ── */}
      <div className="panel monitor-output-panel">
        <div className="panel-header">
          Extracted Text
          {output && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="chat-ctx-clear"
                onClick={() => navigator.clipboard?.writeText(output)}
                style={{ fontSize: '0.7rem', padding: '2px 8px' }}
              >Copy</button>
              <button
                className="chat-ctx-clear"
                onClick={() => setOutput('')}
                style={{ fontSize: '0.7rem', padding: '2px 8px' }}
              >Clear</button>
            </div>
          )}
        </div>
        <textarea
          className="monitor-output"
          readOnly
          value={isScanning ? 'Scanning…' : output}
          placeholder={
            ocrStatus === 'loading'
              ? 'Loading OCR engine…'
              : !hasStream
              ? 'Select a screen, then click Scan.'
              : 'Click Scan to extract text.'
          }
          rows={8}
        />
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}

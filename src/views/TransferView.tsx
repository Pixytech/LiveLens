import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeImage, encodeFrame, gridForPixels, makeLayout, renderGrid, toGray, MIN_COLS, MIN_ROWS, QUIET,
  type Finder, type Layout,
} from "../transfer/codec";
import {
  imageDataToStream, packFile, peekMeta, recoverFile, streamToImageData, toHex, unpackStream,
  WrongPassphraseError, type PackedMeta,
} from "../transfer/fileCodec";
import { encodeSymbol, FountainDecoder, splitChunks } from "../transfer/fountain";
import type { DecodeRequest, DecodeResponse } from "../transfer/decoder.worker";

// Shared helpers

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;

function downloadBytes(bytes: Uint8Array, name: string, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function fileToImageData(file: Blob): Promise<ImageData> {
  // colorSpaceConversion: 'none' + premultiplyAlpha: 'none' keep pixels exact.
  const bmp = await createImageBitmap(file, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

const ECC_LEVELS = [
  { parity: 16, label: "Low (6%)",    hint: "repairs 8 bytes per 255" },
  { parity: 32, label: "Medium (13%)", hint: "repairs 16 bytes per 255" },
  { parity: 64, label: "High (25%)",  hint: "repairs 32 bytes per 255" },
  { parity: 96, label: "Max (38%)",   hint: "repairs 48 bytes per 255" },
];

type Mode = "send" | "receive";
type Source = "camera" | "screen";

// Phones and tablets have no screen capture API, only the camera.
const canCaptureScreen = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
const canUseCamera = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
const canFullscreen = typeof document !== "undefined" && !!document.fullscreenEnabled;

export function TransferView() {
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem("xfer_mode") as Mode) || "send");
  const switchMode = (m: Mode) => { setMode(m); localStorage.setItem("xfer_mode", m); };

  return (
    <div className="view xfer-view">
      <details className="view-arch xfer-arch">
        <summary className="view-arch-label">How it works</summary>
        Computers usually exchange data over a network or a cable. This tab shows that data can also travel
        through a sensor. The encoder turns a file into bytes, adds Reed-Solomon error correction and draws the
        result as a grid of black and white cells. Think of it as a live QR code: instead of one static image
        holding a few hundred bytes, the grid changes frame by frame and carries a whole file. The decoder, another instance of this app, watches that grid with
        a phone camera or screen capture, finds the corner markers, reads each cell, fixes any errors and checks the SHA-256 hash, so
        the rebuilt file is identical to the original. Small alignment squares spread across the grid let the
        decoder follow curved screens and lens distortion, and after the first pass every frame is a fresh mix of
        the file (a fountain code), so any frames the camera happens to catch are useful. The idea works in both directions if each side runs an
        encoder and a decoder, and it is not limited to vision: sound, light or any other signal one device can
        produce and the other can sense could carry the same data. Everything runs locally in the browser.
      </details>

      <div className="xfer-mode-row">
        <div className="engine-toggle">
          <button className={`engine-btn${mode === "send" ? " engine-btn--active" : ""}`} onClick={() => switchMode("send")}>
            Encode
          </button>
          <button className={`engine-btn${mode === "receive" ? " engine-btn--active" : ""}`} onClick={() => switchMode("receive")}>
            Decode
          </button>
        </div>
      </div>

      {mode === "send" ? <SendPanel /> : <ReceivePanel />}
    </div>
  );
}

//  SEND

interface Prepared {
  file: File;
  bytes: Uint8Array;
  stream: Uint8Array;
  sha: string;
  encrypted: boolean;
}

function SendPanel() {
  const stageRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [cellPx, setCellPx] = useState(() => Number(localStorage.getItem("xfer_cell")) || 3);
  const [bpc, setBpc] = useState<1 | 2>(() => (Number(localStorage.getItem("xfer_bpc")) === 2 ? 2 : 1));
  const [parity, setParity] = useState(() => Number(localStorage.getItem("xfer_parity")) || 32);
  const [fps, setFps] = useState(() => Number(localStorage.getItem("xfer_fps")) || 4);
  const [running, setRunning] = useState(false);
  const [frameIdx, setFrameIdx] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [box, setBox] = useState({ w: 1280, h: 720 }); // device pixels available
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => { localStorage.setItem("xfer_cell", String(cellPx)); }, [cellPx]);
  useEffect(() => { localStorage.setItem("xfer_bpc", String(bpc)); }, [bpc]);
  useEffect(() => { localStorage.setItem("xfer_parity", String(parity)); }, [parity]);
  useEffect(() => { localStorage.setItem("xfer_fps", String(fps)); }, [fps]);

  // Measure the stage in DEVICE pixels so one cell = N real screen pixels
  useEffect(() => {
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const area = areaRef.current;
      if (!area) return;
      const w = Math.floor(area.clientWidth * dpr);
      const h = document.fullscreenElement === stageRef.current
        ? Math.floor(area.clientHeight * dpr)
        : Math.floor((w * 9) / 16);
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (areaRef.current) ro.observe(areaRef.current);
    const onFs = () => { setFullscreen(document.fullscreenElement === stageRef.current); measure(); };
    document.addEventListener("fullscreenchange", onFs);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); document.removeEventListener("fullscreenchange", onFs); window.removeEventListener("resize", measure); };
  }, []);

  // Layout for the current box/settings
  const layoutInfo = useMemo((): { layout: Layout | null; err?: string } => {
    const { cols, rows } = gridForPixels(box.w, box.h, cellPx);
    if (cols < MIN_COLS || rows < MIN_ROWS) return { layout: null, err: `Area too small for ${cellPx}px cells . Use a smaller cell or go fullscreen.` };
    try { return { layout: makeLayout(cols, rows, bpc, parity) }; }
    catch (e) { return { layout: null, err: (e as Error).message }; }
  }, [box, cellPx, bpc, parity]);
  const layout = layoutInfo.layout;

  // Split the stream into fountain chunks for the current layout. A new
  // session id tells the decoder to start over whenever the chunks change.
  const coded = useMemo(() => {
    if (!prepared || !layout) return null;
    const chunkSize = Math.floor(layout.payloadCapacity / 4) * 4;
    const chunks = splitChunks(prepared.stream, chunkSize);
    return { chunks, chunkSize, session: (Math.random() * 0xffffffff) >>> 0 };
  }, [prepared, layout]);
  const frameCount = coded ? coded.chunks.length : 0;
  useEffect(() => { setFrameIdx(0); }, [coded]);

  // File handling
  const prepare = useCallback(async (file: File, pass: string) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stream = await packFile(bytes, file.name, pass || undefined);
      const meta = peekMeta(stream)!;
      setPrepared({ file, bytes, stream, sha: toHex(meta.sha256), encrypted: !!pass });
    } catch (e) {
      setError(`Could not read file: ${(e as Error).message}`);
    }
  }, []);

  const onPick = (f: File | undefined) => {
    if (!f) return;
    setRunning(false);
    prepare(f, passphrase);
  };

  // Re-pack when the passphrase changes (debounced) so encryption is applied.
  useEffect(() => {
    if (!prepared) return;
    if (!passphrase && !prepared.encrypted) return;
    const t = setTimeout(() => prepare(prepared.file, passphrase), 400);
    return () => clearTimeout(t);
  }, [passphrase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawing
  const draw = useCallback((idx: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !layout || !prepared || !coded) return;
    const { cols, rows } = layout;
    const W = (cols + QUIET * 2) * cellPx, H = (rows + QUIET * 2) * cellPx;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${W / dpr}px`;
    canvas.style.height = `${H / dpr}px`;

    // Frames 0..K-1 carry the chunks directly, later frames carry mixes of
    // them (fountain code), so the index just keeps counting up.
    const grid = encodeFrame(layout, {
      session: coded.session, index: idx, count: coded.chunks.length,
      chunkSize: coded.chunkSize, streamLen: prepared.stream.length,
    }, encodeSymbol(coded.chunks, idx));
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    renderGrid(grid, cols, rows, cellPx, img);
    ctx.putImageData(img, 0, 0);
  }, [layout, prepared, cellPx, coded]);

  // Redraw the current frame whenever geometry/data change.
  useEffect(() => { draw(frameIdx); }, [draw]); // eslint-disable-line react-hooks/exhaustive-deps

  // Frame loop
  useEffect(() => {
    if (!running || !frameCount) return;
    let i = frameIdx;
    const t = setInterval(() => {
      i = (i + 1) >>> 0;
      setFrameIdx(i);
      draw(i);
    }, 1000 / fps);
    return () => clearInterval(t);
  }, [running, fps, frameCount, draw]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stageRef.current?.requestFullscreen().catch(() => null);
  };

  const savePng = async () => {
    if (!prepared) return;
    const img = streamToImageData(prepared.stream);
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    c.getContext("2d")!.putImageData(img, 0, 0);
    const blob: Blob | null = await new Promise((res) => c.toBlob(res, "image/png"));
    if (blob) downloadBytes(new Uint8Array(await blob.arrayBuffer()), `${prepared.file.name}.png`, "image/png");
  };

  const minSecs = frameCount / fps;
  const cameraPreset = () => { setCellPx(8); setBpc(1); setParity(64); setFps(3); };
  const eccHint = ECC_LEVELS.find((l) => l.parity === parity)?.hint;

  return (
    <div className="monitor-grid">
      <div className="monitor-feed-wrap">
        <div ref={stageRef} className={`xfer-stage${fullscreen ? " xfer-stage--fs" : ""}`}>
          <div
            ref={areaRef}
            className={`xfer-area${prepared ? "" : " xfer-area--empty"}${dragOver ? " xfer-area--drag" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); onPick(e.dataTransfer.files?.[0]); }}
            onDoubleClick={() => prepared && canFullscreen && toggleFullscreen()}
          >
            {!prepared ? (
              <div className="monitor-feed-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="1.5">
                  <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" />
                </svg>
                <p style={{ margin: 0 }}>Drop a file here</p>
                <label className="action-btn action-btn--start xfer-file-btn">
                  Choose File
                  <input type="file" hidden onChange={(e) => onPick(e.target.files?.[0] ?? undefined)} />
                </label>
              </div>
            ) : (
              <canvas ref={canvasRef} className="xfer-canvas" />
            )}
          </div>

          {/* Controls live in a bar below the grid, never on top of it. An
              overlay would hide a finder corner or smear data cells. */}
          {prepared && (
            <div className="xfer-bar">
              <span className="xfer-frame-badge">
                Frame {frameIdx + 1}, file needs {frameCount}
              </span>
              <span style={{ flex: 1 }} />
              {canFullscreen && (
                <button className="monitor-ctrl-btn" onClick={toggleFullscreen}>{fullscreen ? "Exit full screen" : "Full screen"}</button>
              )}
              <button
                className={`action-btn ${running ? "action-btn--stop" : "action-btn--start"} monitor-scan-btn`}
                onClick={() => setRunning((r) => !r)}
                disabled={!layout}
              >
                {running ? "Stop" : "Play frames"}
              </button>
            </div>
          )}
        </div>
        {layoutInfo.err && <p className="monitor-error">{layoutInfo.err}</p>}
        {error && <p className="monitor-error">{error}</p>}
        <p className="monitor-selection-hint">
          Tip: go full screen for the largest, sharpest image. Frames never repeat: after the first pass every
          frame is a new mix of the file, so the decoder can use whichever frames it catches and needs only
          about as many as the file has chunks.
        </p>
      </div>

      <div className="monitor-settings-col">
        <div className="panel">
          <div className="panel-header">File</div>
          {prepared ? (
            <div className="xfer-kv">
              <span>Name</span><b title={prepared.file.name}>{prepared.file.name}</b>
              <span>Size</span><b>{fmtBytes(prepared.bytes.length)}</b>
              <span>Stream</span><b>{fmtBytes(prepared.stream.length)}{prepared.encrypted ? ", AES-GCM" : ""}</b>
              <span>SHA-256</span><b className="xfer-mono" title={prepared.sha}>{prepared.sha.slice(0, 16)}...</b>
            </div>
          ) : (
            <p className="empty">No file selected.</p>
          )}
          <div className="xfer-row">
            <label className="monitor-ctrl-btn xfer-inline-btn">
              {prepared ? "Change" : "Choose file"}
              <input type="file" hidden onChange={(e) => onPick(e.target.files?.[0] ?? undefined)} />
            </label>
            <button className="monitor-ctrl-btn xfer-inline-btn" onClick={savePng} disabled={!prepared}
              title="Save the file as a lossless PNG (3 bytes per pixel). Load it in Decode, Open image">
              Save as PNG
            </button>
          </div>

          <div className="monitor-field" style={{ marginTop: 14 }}>
            <label className="chat-settings-label">Passphrase (optional)</label>
            <input
              className="speech-select"
              type="password"
              value={passphrase}
              placeholder="Encrypt with AES-256-GCM"
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
        </div>

        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-header">
            Encoding
            <button className="monitor-ctrl-btn xfer-inline-btn" onClick={cameraPreset}
              title="8 px cells, black and white, high error correction, 3 fps">
              Phone camera preset
            </button>
          </div>
          <div className="monitor-field">
            <label className="chat-settings-label">Cell size</label>
            <select className="speech-select" value={cellPx} onChange={(e) => setCellPx(Number(e.target.value))}>
              {[2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n} px{n === 3 ? " (screen capture)" : n <= 2 ? " (screen capture, sharp)" : n >= 6 ? " (phone camera)" : ""}</option>)}
            </select>
          </div>
          <div className="monitor-field">
            <label className="chat-settings-label">Bits per cell</label>
            <select className="speech-select" value={bpc} onChange={(e) => setBpc(Number(e.target.value) as 1 | 2)}>
              <option value={1}>1, black and white (robust)</option>
              <option value={2}>2, four grey levels (2x faster)</option>
            </select>
          </div>
          <div className="monitor-field">
            <label className="chat-settings-label">Error correction (Reed-Solomon)</label>
            <select className="speech-select" value={parity} onChange={(e) => setParity(Number(e.target.value))}>
              {ECC_LEVELS.map((l) => <option key={l.parity} value={l.parity}>{l.label}</option>)}
            </select>
            <p className="chat-settings-hint">{eccHint}, interleaved so smudges are spread across blocks.</p>
          </div>
          <div className="monitor-field">
            <label className="chat-settings-label">Frame rate</label>
            <select className="speech-select" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8, 10].map((n) => <option key={n} value={n}>{n} fps</option>)}
            </select>
          </div>
          {layout && (
            <div className="xfer-kv">
              <span>Grid</span><b>{layout.cols} x {layout.rows} cells</b>
              <span>Per frame</span><b>{fmtBytes(layout.payloadCapacity)}</b>
              {prepared && <><span>Frames</span><b>{frameCount}</b></>}
              {prepared && <><span>At best</span><b>{minSecs < 60 ? `${minSecs.toFixed(1)} s` : `${(minSecs / 60).toFixed(1)} min`}</b></>}
              <span>Throughput</span><b>{fmtBytes(Math.round(layout.payloadCapacity * fps))}/s</b>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

//  RECEIVE

interface Transfer {
  session: number;
  count: number;              // chunks the file was split into (K)
  chunkSize: number;
  streamLen: number;
  dec: FountainDecoder | null;
  stream: Uint8Array | null;  // set once all chunks are recovered
  received: number;           // useful frames so far (decoder rank)
  seen: number;               // frames read, useful or not
  meta: PackedMeta | null;
  startedAt: number;
}

interface Done {
  name: string;
  bytes: Uint8Array;
  sha: string;
  ms: number;
}

function ReceivePanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const busyRef = useRef(false);
  const reqIdRef = useRef(0);
  const xferRef = useRef<Transfer | null>(null);
  const doneRef = useRef(false);
  const autoSaveRef = useRef(true);
  const lastLockRef = useRef(0);

  const [hasStream, setHasStream] = useState(false);
  const [source, setSource] = useState<Source>("camera");
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [aspect, setAspect] = useState(16 / 9);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [xfer, setXfer] = useState<Transfer | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [needPass, setNeedPass] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passError, setPassError] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState(true);
  const [stats, setStats] = useState({ scanned: 0, decoded: 0, corrected: 0, lastMs: 0, lastError: "", grid: "" });
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => { autoSaveRef.current = autoSave; }, [autoSave]);

  const addLog = useCallback((s: string) => {
    const t = new Date().toLocaleTimeString();
    setLog((l) => [`${t}  ${s}`, ...l].slice(0, 60));
  }, []);

  // Assemble / finish
  const finish = useCallback(async (x: Transfer, pass?: string) => {
    if (!x.stream && x.dec?.done) {
      const all = new Uint8Array(x.count * x.chunkSize);
      x.dec.solve().forEach((c, i) => all.set(c, i * x.chunkSize));
      x.stream = all.subarray(0, x.streamLen);
    }
    if (!x.stream) return;
    const u = unpackStream(x.stream);
    if (!u) { addLog("Error: stream header invalid"); return; }
    try {
      const bytes = await recoverFile(u, pass);
      const d: Done = { name: u.name, bytes, sha: toHex(u.sha256), ms: Date.now() - x.startedAt };
      doneRef.current = true;
      setDone(d);
      setNeedPass(false);
      setPassError(null);
      addLog(`Done: ${u.name}, ${fmtBytes(bytes.length)}, SHA-256 verified`);
      if (autoSaveRef.current) downloadBytes(bytes, u.name);
    } catch (e) {
      if (e instanceof WrongPassphraseError) {
        setNeedPass(true);
        if (pass) setPassError("Wrong passphrase, try again.");
        else addLog("All frames received. The file is encrypted, enter the passphrase.");
      } else {
        addLog(`Error: ${(e as Error).message}`);
      }
    }
  }, [addLog]);

  const acceptFrame = useCallback((f: NonNullable<DecodeResponse["result"]["frame"]>) => {
    let x = xferRef.current;
    if (!x || x.session !== f.session) {
      x = {
        session: f.session, count: f.count, chunkSize: f.chunkSize, streamLen: f.streamLen,
        dec: new FountainDecoder(f.count, f.chunkSize), stream: null,
        received: 0, seen: 0, meta: null, startedAt: Date.now(),
      };
      xferRef.current = x;
      doneRef.current = false;
      setDone(null); setNeedPass(false); setPassError(null);
      addLog(`New sequence ${f.session.toString(16)}: ${f.count} frames, ${fmtBytes(f.streamLen)}`);
    }
    if (doneRef.current || x.stream || !x.dec) return;
    x.seen++;
    x.dec.add(f.index, f.payload);
    x.received = x.dec.rank;
    if (f.index === 0 && !x.meta) {
      x.meta = peekMeta(f.payload);
      if (x.meta) addLog(`File: ${x.meta.name} (${fmtBytes(x.meta.size)})${x.meta.encrypted ? ", encrypted" : ""}`);
    }
    setXfer({ ...x });
    if (x.dec.done) finish(x);
  }, [addLog, finish]);

  // Worker
  useEffect(() => {
    const w = new Worker(new URL("../transfer/decoder.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    busyRef.current = false;
    w.onmessage = (e: MessageEvent<DecodeResponse>) => {
      busyRef.current = false;
      const { result, ms } = e.data;
      // Only draw the outline once the format header has been read, so the
      // box does not flicker over look-alike patterns; keep it briefly after.
      const now = performance.now();
      if (result.layout) { lastLockRef.current = now; drawOverlay(result.finders); }
      else if (now - lastLockRef.current > 800) drawOverlay(null);
      setStats((s) => ({
        scanned: s.scanned + 1,
        decoded: s.decoded + (result.frame ? 1 : 0),
        corrected: s.corrected + (result.frame ? result.corrected : 0),
        lastMs: Math.round(ms),
        lastError: result.frame ? "" : result.error ?? "",
        grid: result.layout
          ? `grid ${result.layout.cols} x ${result.layout.rows}, ${result.layout.bpc} bit per cell, ${result.layout.cellPx.toFixed(2)} px per cell, alignment ${result.layout.aligned} of ${result.layout.patterns}`
          : s.grid,
      }));
      if (result.frame) acceptFrame(result.frame);
    };
    return () => w.terminate();
  }, [acceptFrame]); // eslint-disable-line react-hooks/exhaustive-deps

  // Overlay (detected finders)
  const drawOverlay = (finders: Finder[] | null) => {
    const canvas = overlayRef.current, video = videoRef.current;
    if (!canvas || !video || !video.videoWidth) return;
    const b = canvas.getBoundingClientRect();
    canvas.width = Math.round(b.width); canvas.height = Math.round(b.height);
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!finders) return;
    const s = Math.min(b.width / video.videoWidth, b.height / video.videoHeight);
    const ox = (b.width - video.videoWidth * s) / 2, oy = (b.height - video.videoHeight * s) / 2;
    const P = (f: Finder) => [ox + f.x * s, oy + f.y * s] as const;
    ctx.strokeStyle = "#00d4b4"; ctx.lineWidth = 2;
    ctx.beginPath();
    const [tl, tr, bl, br] = finders.map(P);
    ctx.moveTo(...tl); ctx.lineTo(...tr); ctx.lineTo(...br); ctx.lineTo(...bl); ctx.closePath();
    ctx.stroke();
    for (const f of finders) {
      const [x, y] = P(f);
      const r = Math.max(4, f.m * 3.5 * s);
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    }
  };

  // Capture
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setHasStream(false);
  }, []);

  const attach = useCallback(async (stream: MediaStream, src: Source) => {
    streamRef.current = stream;
    setSource(src);
    const v = videoRef.current;
    if (v) {
      v.srcObject = stream;
      await v.play().catch(() => null);
    }
    setHasStream(true);
    stream.getVideoTracks()[0].addEventListener("ended", stopStream);
  }, [stopStream]);

  const selectScreen = useCallback(async () => {
    setScreenError(null);
    stopStream();
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, width: { ideal: 3840 }, height: { ideal: 2160 } } as MediaTrackConstraints,
        audio: false,
      });
      await attach(s, "screen");
    } catch (e) {
      if ((e as Error)?.name !== "NotAllowedError") setScreenError(`Screen capture failed: ${(e as Error)?.message ?? ""}`);
    }
  }, [stopStream, attach]);

  const startCamera = useCallback(async (facing: "environment" | "user") => {
    setScreenError(null);
    stopStream();
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      setFacing(facing);
      await attach(s, "camera");
    } catch (e) {
      const name = (e as Error)?.name;
      setScreenError(name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access for this site and try again."
        : `Camera failed: ${(e as Error)?.message ?? ""}`);
    }
  }, [stopStream, attach]);

  // Grab a frame whenever the worker is free.
  useEffect(() => {
    if (!hasStream) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const v = videoRef.current, w = workerRef.current;
      if (v && w && !busyRef.current && v.videoWidth) {
        if (!grabRef.current) grabRef.current = document.createElement("canvas");
        const c = grabRef.current;
        if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        busyRef.current = true;
        const req: DecodeRequest = { id: ++reqIdRef.current, width: img.width, height: img.height, rgba: img.data.buffer as ArrayBuffer };
        w.postMessage(req, [req.rgba]);
      }
      setTimeout(tick, 25);
    };
    tick();
    return () => { alive = false; };
  }, [hasStream]);

  useEffect(() => () => stopStream(), [stopStream]);

  // Open an image file (direct PNG or a screenshot of a frame)
  const openImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const img = await fileToImageData(file);
      // 1. Direct lossless PNG?
      try {
        const stream = imageDataToStream(img);
        const u = unpackStream(stream);
        if (u) {
          addLog(`Image ${file.name}: direct PNG, ${fmtBytes(stream.length)} stream`);
          const x: Transfer = {
            session: 0, count: 1, chunkSize: stream.length, streamLen: stream.length, dec: null, stream,
            received: 1, seen: 1, meta: peekMeta(stream), startedAt: Date.now(),
          };
          xferRef.current = x; doneRef.current = false; setDone(null); setXfer({ ...x });
          await finish(x);
          return;
        }
      } catch { /* not a direct PNG, try frame decoding */ }
      // 2. A screenshot of a transmitted frame?
      const r = decodeImage(toGray(img.data, img.width, img.height), img.width, img.height);
      if (r.frame) { addLog(`Image ${file.name}: frame ${r.frame.index + 1}/${r.frame.count} (${r.corrected} bytes repaired)`); acceptFrame(r.frame); }
      else addLog(`Image ${file.name}: ${r.error ?? "no data found"}`);
    } catch (e) {
      addLog(`Error: ${(e as Error).message}`);
    }
  };

  const reset = () => {
    xferRef.current = null; doneRef.current = false;
    setXfer(null); setDone(null); setNeedPass(false); setPassError(null);
    setStats({ scanned: 0, decoded: 0, corrected: 0, lastMs: 0, lastError: "", grid: "" });
  };

  const pct = xfer ? Math.round((xfer.received / xfer.count) * 100) : 0;
  const status = done ? "ready" : hasStream ? (xfer ? "generating" : "loading") : "idle";

  return (
    <>
      {screenError && <p className="error-banner" style={{ marginBottom: 0 }}>{screenError}</p>}
      <div className="monitor-grid">
        <div className="monitor-feed-wrap">
          <div className="monitor-feed xfer-feed" style={{ aspectRatio: String(hasStream ? aspect : 16 / 9) }}>
            {!hasStream && (
              <div className="monitor-feed-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="1.5">
                  <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
                </svg>
                <p style={{ margin: 0, textAlign: "center", padding: "0 16px" }}>
                  Point a camera at the encoded grid, or capture the screen or window showing it
                </p>
                <div className="xfer-row" style={{ marginTop: 0, flexWrap: "wrap", justifyContent: "center" }}>
                  {canUseCamera && (
                    <button className="action-btn action-btn--start" onClick={() => startCamera("environment")}>Use Camera</button>
                  )}
                  {canCaptureScreen && (
                    <button className="action-btn action-btn--clear" onClick={selectScreen}>Capture Screen</button>
                  )}
                </div>
                {!canUseCamera && !canCaptureScreen && (
                  <p style={{ margin: 0 }}>This browser has no camera or screen capture access. Try opening the page over HTTPS.</p>
                )}
              </div>
            )}
            <video
              ref={videoRef}
              className="monitor-video"
              autoPlay
              playsInline
              muted
              style={{ display: hasStream ? "block" : "none" }}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
              }}
            />
            {hasStream && <canvas ref={overlayRef} className="monitor-overlay" style={{ cursor: "default" }} />}
            {hasStream && (
              <div className="monitor-feed-controls">
                {source === "camera" && (
                  <button className="monitor-ctrl-btn" onClick={() => startCamera(facing === "environment" ? "user" : "environment")}>
                    Switch camera
                  </button>
                )}
                {source === "screen" && <button className="monitor-ctrl-btn" onClick={selectScreen}>Change</button>}
                <button className="monitor-ctrl-btn" onClick={stopStream}>Stop</button>
              </div>
            )}
          </div>
          <p className="monitor-selection-hint">
            {stats.scanned > 0
              ? `Scanned ${stats.scanned}, decoded ${stats.decoded}, ${stats.lastMs} ms per frame${stats.grid ? `, ${stats.grid}` : ""}${stats.lastError ? `. ${stats.lastError}` : ""}`
              : "Tip: keep all four corner squares in view. The grid can be small, tilted or seen at an angle. For a phone camera, use 6 or 8 px cells and a low frame rate on the encoder."}
          </p>
        </div>

        <div className="monitor-settings-col">
          <div className="panel">
            <div className="panel-header">Decoder</div>
            <div className="monitor-status-row">
              <span className={`chat-dot chat-dot--${status}`} />
              <span className="monitor-status-label">
                {done ? "Complete, verified" : !hasStream ? "Idle" : xfer ? `Receiving ${xfer.received} of ${xfer.count}` : "Searching for grid"}
              </span>
            </div>

            {xfer && (
              <>
                <div className="xfer-kv">
                  <span>File</span><b title={xfer.meta?.name}>{xfer.meta?.name ?? "(waiting for frame 1)"}</b>
                  <span>Size</span><b>{xfer.meta ? fmtBytes(xfer.meta.size) : fmtBytes(xfer.streamLen)}{xfer.meta?.encrypted ? ", encrypted" : ""}</b>
                  <span>Repaired</span><b>{stats.corrected.toLocaleString()} bytes</b>
                </div>
                <div className="bar-track" style={{ marginTop: 10 }}>
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <p className="monitor-progress-label">
                  {pct}%, {xfer.received} of {xfer.count} frames needed ({xfer.seen} read)
                </p>
              </>
            )}

            {needPass && !done && (
              <div className="monitor-field" style={{ marginTop: 12 }}>
                <label className="chat-settings-label">Passphrase</label>
                <div className="xfer-row">
                  <input className="speech-select" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && xferRef.current && finish(xferRef.current, passphrase)} />
                  <button className="action-btn action-btn--start" style={{ padding: "6px 14px" }}
                    onClick={() => xferRef.current && finish(xferRef.current, passphrase)}>Decrypt</button>
                </div>
                {passError && <p className="monitor-error">{passError}</p>}
              </div>
            )}

            {done && (
              <div className="xfer-done">
                <div className="xfer-kv">
                  <span>Saved as</span><b title={done.name}>{done.name}</b>
                  <span>SHA-256</span><b className="xfer-mono" title={done.sha}>{done.sha.slice(0, 16)}... (verified)</b>
                  <span>Time</span><b>{(done.ms / 1000).toFixed(1)} s</b>
                </div>
                <button className="action-btn action-btn--start" style={{ width: "100%", marginTop: 10 }}
                  onClick={() => downloadBytes(done.bytes, done.name)}>Save file again</button>
              </div>
            )}

            <div className="xfer-row" style={{ marginTop: 14 }}>
              <label className="monitor-ctrl-btn xfer-inline-btn" title="Decode a lossless PNG from Encode, Save as PNG, or a screenshot of a frame">
                Open image
                <input type="file" accept="image/*" hidden onChange={(e) => { openImage(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              <button className="monitor-ctrl-btn xfer-inline-btn" onClick={reset}>Reset</button>
            </div>
            <label className="xfer-check">
              <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} /> Auto-save when complete
            </label>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">Log</div>
        <pre className="xfer-log">{log.length ? log.join("\n") : "No activity yet."}</pre>
      </div>
    </>
  );
}

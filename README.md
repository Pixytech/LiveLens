# LiveLens

Six browser-only demos built around one idea: run the model in the tab, not
on a server. No backend, no uploaded video, no API keys required for any of
it — client-side computer vision, in-browser LLMs, and a Python statistics
layer via WebAssembly.

**[Live demo →](https://pixytech.github.io/LiveLens/)** _(after first deploy — see below)_

## What's in it

- **Detect** — webcam object detection (TensorFlow.js / coco-ssd), an IoU
  tracker that carries identity across frames for dwell time, and a Python
  module running in [Pyodide](https://pyodide.org) that computes rolling
  counts and flags statistically unusual activity with a z-score check.
- **Snake** — an offline LLM (SmolLM2, Qwen2.5, Llama 3.2, Phi-3.5, in
  various sizes) plays Snake one move at a time, described in text and asked
  to reply with a direction. A safety shield overrides moves that would hit
  a wall or the snake's own body, so small models don't just lose instantly
  — every override counts as "corrected," which keeps latency and survival
  comparable across very different model sizes. Runs and logs are kept
  side-by-side so you can compare models and devices (WebGPU vs WASM).
- **Chat** — the same offline models as Snake, or bring your own key for
  Claude, OpenAI, or Gemini (Gemini via Google OAuth, not a key). Offline
  inference runs through `@huggingface/transformers` in a Web Worker.
- **Speech** — live transcription via the browser's SpeechRecognition API.
  On Chrome/Edge this is Google's cloud recogniser, not a local model — the
  only tab in this app where audio actually leaves the browser.
- **Monitor** — pick a window or screen with `getDisplayMedia`, drag to
  select a region, and run OCR on it with Tesseract.js. Fully local.

- **Pixel Codec** - moves data between two programs with computer vision.
  The encoder turns a file into bytes (optionally AES-256-GCM encrypted),
  adds Reed-Solomon error correction and draws the result as a grid of
  black and white (or four grey level) cells with QR-style corner markers,
  in effect a live QR code that changes frame by frame and carries a whole
  file instead of a few hundred bytes.
  The decoder, a second instance of the app, reads that grid through screen
  capture, corrects errors, checks the SHA-256 and rebuilds the identical
  file. The same approach works in both directions, and with other media
  such as sound or light. The file can also be saved and loaded as a
  lossless PNG (3 bytes per pixel).

## Architecture (Detect tab)

The tab this repo started as, and still the clearest example of the split:

```
┌─────────────────────────────────────────────────────────┐
│  Browser tab                                             │
│                                                            │
│  ┌───────────────┐   detections    ┌──────────────────┐  │
│  │ TensorFlow.js  │ ──────────────► │  TS object        │  │
│  │ (coco-ssd)     │   per frame     │  tracker (IoU)     │  │
│  │ — perception   │                 │  — identity        │  │
│  └───────────────┘                 └─────────┬──────────┘  │
│                                               │ tracked      │
│                                               │ objects      │
│                                               ▼ (every 1.2s) │
│                                     ┌──────────────────┐    │
│                                     │  Pyodide          │    │
│                                     │  (numpy, pandas)  │    │
│                                     │  — statistics      │    │
│                                     └──────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

- **Perception — TensorFlow.js.** The neural net (coco-ssd, a MobileNet-based
  detector) runs client-side via TensorFlow.js. Browser neural-net inference
  is a mature, WebGL/WebGPU-accelerated path in the JS ecosystem; Pyodide has
  no equivalent runtime for this, so asking Python to do it would be the
  wrong tool for the job.
- **Identity — a small TypeScript tracker.** coco-ssd returns a fresh,
  unlabelled set of boxes every frame. It has no concept of "the same cup as
  last frame." `src/lib/tracker.ts` does simple IoU-based matching to carry
  an object's identity across frames, which is what makes dwell time
  possible.
- **Statistics — Python, via Pyodide.** `public/python/analytics.py` is
  genuine Python: pandas for grouping/aggregation, numpy for the rolling
  z-score anomaly check. It runs *in the browser tab*, loaded once via
  Pyodide and called on an interval. No server round-trip, no API.

The other four tabs don't need this split — Snake and Chat lean entirely on
`transformers.js`, Speech on the browser's own STT, Monitor on Tesseract.js.

## How the Pixel Codec tab encodes data

```
file -> "LLF1" | name | size | SHA-256 | body   (body is AES-GCM encrypted if a passphrase is set)
     -> split into frame-sized chunks
     -> per frame: 26-byte header (session, index, count, CRC-32) + chunk
     -> Reed-Solomon blocks (up to 255 bytes, 16 to 96 parity bytes each), byte-interleaved
     -> XOR whitening mask -> 1 or 2 bits per cell -> grid + corner markers + format header
```

- **Corner markers**: four 1:1:3:1:1 square patterns, found by scanning runs
  of dark and light pixels in both directions, as a QR reader does. Their
  centres give a bilinear map from cell coordinates to captured pixels, so
  the grid can be scaled, moved or shown at any size in the capture.
- **Format header**: a small Reed-Solomon protected strip beside the
  top-left marker records grid size, bits per cell and parity, so the
  decoder adapts to whatever the encoder chose.
- **Reed-Solomon and interleaving**: `src/transfer/rs.ts` is a GF(256)
  codec (Berlekamp-Massey, Chien search, Forney). Interleaving puts
  neighbouring bytes on screen into different blocks, so a compression
  artefact costs each block only a byte or two.
- **Integrity**: each frame carries a CRC-32 and the whole file a SHA-256.
  Frames can arrive in any order; the encoder loops until the decoder has
  them all.

There is no fixed size limit. With 3 px cells on a 1280 x 720 area a frame
holds about 9.5 KB, so 1 MB is about 108 frames, roughly 30 seconds at
4 fps. Larger files work the same way and just take proportionally longer.

## Running locally

```bash
npm install
npm run dev
```

Open the printed local URL. The Detect tab asks for camera permission the
first time you visit it, not on startup. First load of Detect or
Snake/Chat's offline models will take a few seconds while the model weights
are fetched — everything is cached by the browser afterwards.

## Deploying to GitHub Pages

This repo ships with `.github/workflows/deploy.yml`, which builds and
deploys to GitHub Pages on every push to `main`.

1. Push this repo to GitHub as `LiveLens` (or update `base` in
   `vite.config.ts` to match whatever you name it).
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow builds and deploys automatically; check the
   **Actions** tab for progress and the deployed URL.

## Project structure

```
LiveLens/
├── src/
│   ├── App.tsx                      # camera setup, wires detection + analytics
│   ├── hooks/
│   │   ├── useObjectDetection.ts    # TensorFlow.js model + detection loop
│   │   └── usePyodideAnalytics.ts   # Pyodide runtime + periodic analysis
│   ├── components/
│   │   ├── AppTabs.tsx              # tab switching, keeps the camera feed alive across tabs
│   │   ├── VideoCanvas.tsx          # video feed + bounding-box overlay
│   │   └── Header.tsx
│   ├── views/
│   │   ├── DetectView.tsx           # object detection + live analytics
│   │   ├── SnakeView.tsx            # offline LLM plays Snake, perf comparison log
│   │   ├── ChatView.tsx             # offline models or Claude/OpenAI/Gemini
│   │   ├── SpeechView.tsx           # live transcription
│   │   └── MonitorView.tsx          # screen capture + OCR
│   ├── lib/
│   │   ├── tracker.ts               # IoU-based object identity tracker
│   │   ├── snakeGame.ts             # Snake rules + the safety shield
│   │   ├── offlineModels.ts         # offline model catalogue (id, size, notes)
│   │   └── apiStream.ts             # SSE streaming for Claude/OpenAI/Gemini
│   ├── chat/chat.worker.ts          # transformers.js chat inference, off the main thread
│   ├── snake/snake.worker.ts        # transformers.js move inference for Snake
│   └── stt/useSpeechToText.ts       # SpeechRecognition wrapper with auto-reconnect
└── public/python/
    └── analytics.py                 # runs inside Pyodide, not on a server
```

## Known limitations

- Detection quality depends on lighting and the `lite_mobilenet_v2` model's
  accuracy trade-offs — it's tuned for speed, not benchmark precision.
- WebGL is the preferred TensorFlow.js backend; on devices without it, the
  app falls back to WASM, which is noticeably slower. Offline LLMs prefer
  WebGPU and fall back to WASM the same way.
- Pyodide's first load fetches numpy and pandas as WASM packages (a few MB)
  — expect a short pause before "Python ready" appears in the analytics
  panel.
- The object tracker is intentionally simple (greedy IoU matching, no
  motion prediction) — fast-moving objects or heavy occlusion can split one
  physical object into two tracked IDs.
- Speech transcription on Chrome/Edge goes through Google's cloud
  recogniser, not a local model — the one tab where audio leaves the tab.
- API keys for Claude/OpenAI (Chat tab) are stored in `localStorage` only,
  never sent anywhere but the provider's API — but that also means anyone
  with access to the browser profile can read them back out.

## License

MIT — see [LICENSE](./LICENSE).

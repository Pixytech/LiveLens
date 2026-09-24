# LiveLens

Five browser-only demos built around one idea: run the model in the tab, not
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

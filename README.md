# LiveLens

Real-time webcam object detection with live statistical analytics — entirely
client-side. No backend, no API keys, no uploaded video. Everything runs in
the browser tab, including the Python.

**[Live demo →](https://pixytech.github.io/LiveLens/)** _(after first deploy — see below)_

## What it does

Point your webcam at something and LiveLens will:

- Detect and label objects in the frame in real time (TensorFlow.js)
- Track each object's identity across frames and report how long it's been
  in view ("dwell time")
- Continuously compute rolling per-class counts and flag statistically
  unusual activity — e.g. a sudden spike in how many people are in frame —
  using a small Python module running via [Pyodide](https://pyodide.org)

## Architecture

Three layers, each doing the thing it's actually good at:

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
  detector) runs client-side via TensorFlow.js. This is deliberate: browser
  neural-net inference is a mature, WebGL/WebGPU-accelerated path in the JS
  ecosystem. Pyodide has no equivalent runtime for this yet, so asking Python
  to do it would be the wrong tool for the job.
- **Identity — a small TypeScript tracker.** coco-ssd returns a fresh,
  unlabelled set of boxes every frame; it has no concept of "the same cup as
  last frame." `src/lib/tracker.ts` does simple IoU-based matching to carry
  an object's identity across frames, which is what makes dwell time
  possible.
- **Statistics — Python, via Pyodide.** `public/python/analytics.py` is
  genuine Python: pandas for grouping/aggregation, numpy for the rolling
  z-score anomaly check. It runs *in the browser tab*, loaded once via
  Pyodide and called on an interval — no server round-trip, no API.

See the [companion blog post](./blog/live-lens-post.md) for the full
write-up, including why the model and the statistics layer are split across
languages instead of picking one.

## Running locally

```bash
npm install
npm run dev
```

Open the printed local URL and grant camera permission. First load will take
a few seconds while the detection model and Pyodide (with numpy/pandas) are
fetched — both are cached by the browser afterwards.

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
│   ├── App.tsx                  # camera setup, wires detection + analytics
│   ├── hooks/
│   │   ├── useObjectDetection.ts    # TensorFlow.js model + detection loop
│   │   └── usePyodideAnalytics.ts   # Pyodide runtime + periodic analysis
│   ├── components/
│   │   ├── VideoCanvas.tsx      # video feed + bounding-box overlay
│   │   ├── AnalyticsPanel.tsx   # live counts / dwell time
│   │   ├── AnomalyBanner.tsx    # Python-flagged anomalies
│   │   └── Header.tsx
│   └── lib/
│       └── tracker.ts           # IoU-based object identity tracker
├── public/python/
│   └── analytics.py             # runs inside Pyodide, not on a server
└── blog/
    └── live-lens-post.md        # companion write-up
```

## Known limitations

- Detection quality depends on lighting and the `lite_mobilenet_v2` model's
  accuracy trade-offs — it's tuned for speed, not benchmark precision.
- WebGL is the preferred TensorFlow.js backend; on devices without it, the
  app falls back to WASM, which is noticeably slower.
- Pyodide's first load fetches numpy and pandas as WASM packages (a few MB)
  — expect a short pause before "Python ready" appears in the analytics
  panel.
- The object tracker is intentionally simple (greedy IoU matching, no
  motion prediction) — fast-moving objects or heavy occlusion can split one
  physical object into two tracked IDs.

## License

MIT — see [LICENSE](./LICENSE).

# LiveLens: Two Languages, One Browser Tab, Zero Servers

A real-time trading blotter and a webcam object detector have more in
common than they look like they should. Both are event-driven: a stream of
updates arrives continuously, something needs to render the current state
without falling behind, and something else needs to watch that stream for
patterns worth flagging — a position that's moved too far, a count that's
spiked. I've spent most of the last decade building the first kind of
system for capital markets. LiveLens is what happens when you point the
same architectural instincts at a webcam instead of a market feed, and run
the whole thing client-side, in a single browser tab, with no backend at
all.

**[Try it live](https://pixytech.github.io/LiveLens/)** · [source on
GitHub](https://github.com/Pixytech/LiveLens)

## What it does

Grant camera access and LiveLens detects objects in the live feed, tracks
each one's identity across frames, and continuously computes rolling
statistics — per-class counts, average dwell time — flagging anything
that looks like a genuine anomaly rather than normal frame-to-frame noise.
None of the video, and none of the analysis, ever leaves the tab.

## Three layers, three tools, on purpose

It would be tempting to reach for one language and use it for everything.
I split LiveLens into three layers instead, each running the tool that's
actually good at that job:

- **Perception** — TensorFlow.js runs a MobileNet-based object detector
  (`coco-ssd`) directly in the browser, WebGL-accelerated.
- **Identity** — a small TypeScript tracker turns a stream of unlabelled
  per-frame detections into persistent tracked objects.
- **Statistics** — a genuine Python module, running in-browser via
  [Pyodide](https://pyodide.org), does the counting, aggregation, and
  anomaly detection with pandas and numpy.

## Why the neural net runs in JavaScript, not Python

This is worth being upfront about, because "Python in the browser" is the
headline feature and it would be easy to assume the model runs there too.
It doesn't, deliberately.

In-browser neural-net inference is a mature, well-supported path in the
JavaScript ecosystem — TensorFlow.js and `transformers.js` both have
WebGL/WebGPU-accelerated runtimes, wide model support, and years of
production hardening. Pyodide, which compiles the CPython interpreter and
the scientific Python stack to WebAssembly, doesn't have an equivalent
neural-net execution engine yet. Asking it to run the detector would mean
either a much slower pure-Python inference path or shipping a second
runtime just to reinvent what TensorFlow.js already does well.

So the detector runs where the ecosystem is strongest, and Python gets
used for what it's actually strong at: data manipulation and statistics.
That division of labour is the whole point of the architecture, not an
incidental detail.

## The tracker: turning detections into objects

`coco-ssd` gives you a fresh, unlabelled set of bounding boxes on every
frame. It has no concept of "the same coffee cup as last frame" — as far
as the model is concerned, every detection is a new observation with no
history.

To compute dwell time, or to feed any kind of coherent time series into the
analytics layer, that identity has to come from somewhere. LiveLens uses a
lightweight IoU-based tracker: on each frame, every new detection is
matched to the closest existing track of the same class by bounding-box
overlap, using greedy matching against an intersection-over-union
threshold.

```ts
function intersectionOverUnion(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const unionArea = aw * ah + bw * bh - interArea;
  return unionArea <= 0 ? 0 : interArea / unionArea;
}
```

Tracks that go unmatched for more than 1.5 seconds are dropped — long
enough to bridge a missed frame or brief occlusion without inventing a new
identity for the same physical object, short enough that a track doesn't
linger indefinitely after something actually leaves the frame. It's a
simplified relative of the greedy-matching idea behind SORT-style
trackers, without a Kalman filter — accurate enough for a browser demo,
not accurate enough for a production tracking system.

## Pyodide: real pandas, real numpy, zero server

This is the part that made the project worth writing up. Pyodide loads the
full CPython interpreter, plus numpy and pandas, compiled to WebAssembly,
and runs it in the same tab as the React app:

```python
def analyze(window_json: str) -> str:
    objects = json.loads(window_json)
    df = pd.DataFrame(objects)

    counts = df.groupby("class")["id"].nunique().to_dict()
    df["dwell"] = df["last_seen"] - df["first_seen"]
    dwell_ms = df.groupby("class")["dwell"].mean().to_dict()

    anomalies = []
    for cls, count in counts.items():
        hist = _history[cls]
        if len(hist) >= 5:
            mean, std = np.mean(hist), np.std(hist)
            z = (count - mean) / std if std > 0 else 0
            if abs(z) >= 2.5:
                anomalies.append({"class": cls, "count": count, "z": round(z, 2)})
        hist.append(count)

    return json.dumps({"counts": counts, "dwell_ms": dwell_ms, "anomalies": anomalies})
```

`_history` is module-level state inside the Pyodide runtime, so it
persists across calls for the life of the tab without React having to
manage a rolling buffer itself — React just calls `analyze()` on an
interval with the current tracked-object snapshot and gets back a JSON
summary, exactly as if it were talking to a REST endpoint. The difference
is there's no network hop, no serialization over the wire beyond a
function call boundary, and no server to deploy or pay for.

The anomaly check itself is deliberately simple: a rolling per-class
count history, a z-score against the mean and standard deviation of the
last ~60 windows, and a threshold. It won't catch anything subtle, but
it's the same basic shape as the alerting logic behind far more
sophisticated systems — computed live, over a real stream, with real
statistics.

## Why this matters beyond a toy demo

The pattern here — a continuous event stream, an identity/state layer
sitting between raw events and anything downstream, and a statistics
layer watching for deviation from a rolling baseline — is the same shape
as a real-time trading blotter watching market data for anomalous price
moves, or an operations dashboard flagging unusual order flow. The
domain changed from financial instruments to webcam detections; the
architecture didn't. Being able to build that shape entirely client-side,
with a real statistical computing stack and no backend at all, says
something about how far browser runtimes have come — Pyodide making
`pandas.groupby` a genuine option inside a static site would have sounded
like a joke five years ago.

## Practical implications

**Detection quality depends on lighting and the model's speed/accuracy
trade-off.** `lite_mobilenet_v2` is tuned to keep up with live video, not
to win accuracy benchmarks — expect it to miss small or partially
occluded objects.

**WebGL matters.** TensorFlow.js prefers a WebGL backend; without it the
app falls back to WASM, which noticeably slower. Most modern browsers and
GPUs handle this fine, but it's worth knowing if performance looks off on
an older machine.

**Pyodide's first load has a real cost.** Fetching the CPython
interpreter plus numpy and pandas as WASM packages is a few megabytes of
one-time download, cached by the browser afterwards. The analytics panel
shows "Loading Python…" for exactly this reason — it's not a bug, it's an
honest reflection of what's happening.

**The tracker is intentionally simple.** Greedy IoU matching with no
motion prediction means fast-moving objects or heavy occlusion can split
one physical object into two tracked IDs. A production system would add a
motion model; a demo doesn't need one to make the point.

## Summary

LiveLens detects objects with TensorFlow.js because that's where
browser-native neural-net inference is mature. It tracks identity with a
small TypeScript IoU matcher because the model itself doesn't provide
one. And it computes live statistics with real pandas and numpy, running
inside a WebAssembly Python interpreter in the same tab, because that
turns out to be a completely viable way to build a stateful analytics
layer with zero servers. None of these choices were made to show off a
single "AI in the browser" trick — each layer is there because it's the
right tool for that specific job, which is the same principle that
governs how I'd architect any production system, just applied here to
something you can try in a browser tab in under a minute.

Source, README, and setup instructions are on
[GitHub](https://github.com/Pixytech/LiveLens).

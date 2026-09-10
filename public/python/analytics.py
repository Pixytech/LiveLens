"""
LiveLens analytics — runs inside the browser tab via Pyodide.

The React side hands this module a JSON snapshot of currently-tracked
objects every ~1.2 seconds. This module is the only part of LiveLens that
does statistics: rolling per-class counts, dwell time, and a simple
z-score anomaly check against recent history. Nothing here touches pixels
or the neural net — that separation of concerns is the whole point of the
architecture (see the accompanying blog post for why).

`_history` is module-level state, which persists for the lifetime of the
Pyodide runtime in the tab (it is not re-imported per call), so the rolling
window survives across `analyze()` calls without React having to manage it.
"""

import json
from collections import defaultdict

import numpy as np
import pandas as pd

# class name -> list of recent per-window counts, oldest first
_history: dict[str, list[int]] = defaultdict(list)

_MAX_HISTORY_WINDOWS = 60      # ~72s of history at a 1.2s tick
_MIN_WINDOWS_FOR_BASELINE = 5  # don't flag anomalies until we have a baseline
_Z_SCORE_THRESHOLD = 2.5


def analyze(window_json: str) -> str:
    """
    window_json: JSON array of currently-tracked objects, e.g.

        [
          {"id": 3, "class": "person", "first_seen": 1699999998000,
           "last_seen": 1699999999200, "score": 0.87},
          ...
        ]

    Returns a JSON object:

        {
          "counts": {"person": 2, "cup": 1},
          "dwell_ms": {"person": 842.5, "cup": 210.0},
          "anomalies": [
            {"class": "person", "count": 5, "expected": 1.2, "z": 3.1}
          ]
        }
    """
    objects = json.loads(window_json)

    counts: dict[str, int] = {}
    dwell_ms: dict[str, float] = {}

    if objects:
        df = pd.DataFrame(objects)
        counts = df.groupby("class")["id"].nunique().to_dict()

        df["dwell"] = df["last_seen"] - df["first_seen"]
        dwell_ms = {
            cls: round(float(v), 1)
            for cls, v in df.groupby("class")["dwell"].mean().items()
        }

    anomalies = []
    seen_this_window = set(counts.keys())

    for cls, count in counts.items():
        hist = _history[cls]
        if len(hist) >= _MIN_WINDOWS_FOR_BASELINE:
            arr = np.array(hist, dtype=float)
            mean, std = float(arr.mean()), float(arr.std())
            if std > 0:
                z = (count - mean) / std
                if abs(z) >= _Z_SCORE_THRESHOLD:
                    anomalies.append(
                        {
                            "class": cls,
                            "count": count,
                            "expected": round(mean, 2),
                            "z": round(z, 2),
                        }
                    )
        hist.append(count)
        if len(hist) > _MAX_HISTORY_WINDOWS:
            del hist[0]

    # Classes with no detections this window still decay their history to 0,
    # so a class that was steady and then vanishes doesn't silently freeze
    # its baseline forever.
    for cls in list(_history.keys()):
        if cls not in seen_this_window:
            hist = _history[cls]
            hist.append(0)
            if len(hist) > _MAX_HISTORY_WINDOWS:
                del hist[0]

    return json.dumps(
        {
            "counts": counts,
            "dwell_ms": dwell_ms,
            "anomalies": anomalies,
        }
    )

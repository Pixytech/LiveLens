import { TrackedObject } from "../lib/tracker";
import { AnalyticsResult } from "../hooks/usePyodideAnalytics";

const BOX_COLORS = ["#00d4b4", "#ff8a5c", "#ffd166", "#4dabf7", "#c084fc", "#f472b6"];
function colorForClass(cls: string) {
  let h = 0;
  for (let i = 0; i < cls.length; i++) h = (h * 31 + cls.charCodeAt(i)) >>> 0;
  return BOX_COLORS[h % BOX_COLORS.length];
}

interface Props {
  // Ref to the DOM node <VideoCanvas> gets portalled into (see AppTabs) —
  // this component only owns the slot, not the video content itself.
  feedRef: (node: HTMLDivElement | null) => void;
  tracked: TrackedObject[];
  modelReady: boolean;
  result: AnalyticsResult | null;
  pyodideReady: boolean;
}

export function DetectView({ feedRef, tracked, modelReady, result, pyodideReady }: Props) {
  const now     = Date.now();
  const counts  = result?.counts  ?? {};
  const dwell   = result?.dwellMs ?? {};
  const anomalies = result?.anomalies ?? [];
  const classes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const maxCount = Math.max(1, ...Object.values(counts));
  const sorted  = [...tracked].sort((a, b) => b.lastSeen - a.lastSeen);

  return (
    <div className="view">
      <div className="view-arch">
        <span className="view-arch-label">How it works</span>
        TensorFlow.js loads COCO-SSD (lite MobileNetV2) and runs inference on every webcam frame via WebGL — nothing leaves the browser.
        A centroid tracker links detections across frames, assigns persistent IDs, and accumulates dwell times.
        Pyodide then runs numpy + pandas in a WebAssembly Python runtime to compute statistics and Z-score anomaly detection every 1.2 s.
      </div>

      <div className="detect-grid">
        {/* Left — video feed */}
        <div className="detect-feed" ref={feedRef}>
          {!modelReady && (
            <div className="feed-loading">Loading detection model…</div>
          )}
        </div>

        {/* Right — sidebar with live objects + analytics */}
        <div className="detect-sidebar">

          {/* Live tracked objects */}
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-header">
              <span>Live objects</span>
              <span className="pyodide-status ready">{tracked.length} tracked</span>
            </div>

            {sorted.length === 0 ? (
              <p className="empty">Nothing detected yet — point the camera at something.</p>
            ) : (
              <div className="obj-list">
                {sorted.map((obj) => {
                  const dwellSec = ((obj.lastSeen - obj.firstSeen) / 1000).toFixed(1);
                  const fresh = now - obj.lastSeen < 700;
                  const color = colorForClass(obj.class);
                  return (
                    <div key={obj.id} className={`obj-row${fresh ? "" : " obj-row--stale"}`}>
                      <span className="obj-dot" style={{ background: color }} />
                      <div className="obj-body">
                        <span className="obj-class">{obj.class}</span>
                        <span className="obj-id">#{obj.id}</span>
                      </div>
                      <div className="obj-stats">
                        <span className="obj-score" style={{ color }}>
                          {Math.round(obj.score * 100)}%
                        </span>
                        <span className="obj-dwell">{dwellSec}s</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Analytics — class breakdown */}
          <div className="panel" style={{ marginBottom: anomalies.length ? 14 : 0 }}>
            <div className="panel-header">
              <span>Analytics</span>
              <span className={pyodideReady ? "pyodide-status ready" : "pyodide-status"}>
                {pyodideReady ? "Python ready" : "Loading Python…"}
              </span>
            </div>

            {classes.length === 0 ? (
              <p className="empty">
                {pyodideReady ? "No data yet." : "Starting up…"}
              </p>
            ) : (
              classes.map((cls) => (
                <div key={cls} className="analytics-row">
                  <div className="analytics-label">
                    <span>{cls}</span>
                    <span>{counts[cls]} · {((dwell[cls] ?? 0) / 1000).toFixed(1)}s</span>
                  </div>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${(counts[cls] / maxCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Anomaly alerts */}
          {anomalies.length > 0 && (
            <div className="panel anomaly-panel">
              <div className="panel-header">
                <span>Anomalies</span>
                <span className="pyodide-status" style={{ color: "var(--red)" }}>
                  {anomalies.length} flagged
                </span>
              </div>
              {anomalies.map((a) => (
                <div key={a.class} className="anomaly-row">
                  <strong>{a.class}</strong> — {a.count} seen, ~{a.expected} expected, z={a.z.toFixed(2)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { AnalyticsResult } from "../hooks/usePyodideAnalytics";

interface Props {
  result: AnalyticsResult | null;
  pyodideReady: boolean;
}

export function AnalyticsPanel({ result, pyodideReady }: Props) {
  const counts = result?.counts ?? {};
  const dwell = result?.dwellMs ?? {};
  const classes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const maxCount = Math.max(1, ...Object.values(counts));

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Live analytics</span>
        <span className={pyodideReady ? "pyodide-status ready" : "pyodide-status"}>
          {pyodideReady ? "Python ready" : "Loading Python…"}
        </span>
      </div>

      {classes.length === 0 && (
        <p className="empty">
          {pyodideReady ? "No objects tracked yet — point the camera at something." : "Starting up…"}
        </p>
      )}

      {classes.map((cls) => (
        <div key={cls} className="analytics-row">
          <div className="analytics-label">
            <span>{cls}</span>
            <span>{counts[cls]}</span>
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(counts[cls] / maxCount) * 100}%` }} />
          </div>
          <div className="dwell">avg dwell {((dwell[cls] ?? 0) / 1000).toFixed(1)}s</div>
        </div>
      ))}
    </div>
  );
}

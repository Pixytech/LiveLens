import { AnalyticsResult } from "../hooks/usePyodideAnalytics";

export function AnomalyBanner({ result }: { result: AnalyticsResult | null }) {
  const anomalies = result?.anomalies ?? [];
  if (anomalies.length === 0) return null;

  return (
    <div className="anomaly-banner">
      {anomalies.map((a) => (
        <div key={a.class}>
          Unusual <strong>{a.class}</strong> count: {a.count} (recent average ~{a.expected}, z={a.z})
        </div>
      ))}
    </div>
  );
}

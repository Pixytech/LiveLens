import { useEffect, useRef, useState } from "react";
import { TrackedObject } from "../lib/tracker";

// Loaded via the <script> tag in index.html, not an npm import — see that
// file for why.
declare global {
  interface Window {
    loadPyodide: (config?: { indexURL?: string }) => Promise<PyodideInterface>;
  }
}

interface PyodideInterface {
  loadPackage: (packages: string[]) => Promise<void>;
  runPython: (code: string) => unknown;
  globals: { get: (name: string) => (arg: string) => string };
}

export interface AnalyticsResult {
  counts: Record<string, number>;
  dwellMs: Record<string, number>;
  anomalies: { class: string; count: number; expected: number; z: number }[];
}

export function usePyodideAnalytics(tracked: TrackedObject[], intervalMs = 1200) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyticsResult | null>(null);

  const analyzeRef = useRef<((json: string) => string) | null>(null);
  // Read the latest tracked list from inside the interval without having
  // to restart the interval every time `tracked` changes on every frame.
  const trackedRef = useRef(tracked);
  trackedRef.current = tracked;

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const pyodide = await window.loadPyodide({
          indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
        });
        await pyodide.loadPackage(["numpy", "pandas"]);

        const source = await fetch(`${import.meta.env.BASE_URL}python/analytics.py`).then((r) => {
          if (!r.ok) throw new Error(`Failed to fetch analytics.py: ${r.status}`);
          return r.text();
        });
        pyodide.runPython(source);

        const analyze = pyodide.globals.get("analyze");
        if (cancelled) return;
        analyzeRef.current = analyze;
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;

    const id = window.setInterval(() => {
      const analyze = analyzeRef.current;
      if (!analyze) return;

      const payload = trackedRef.current.map((t) => ({
        id: t.id,
        class: t.class,
        first_seen: t.firstSeen,
        last_seen: t.lastSeen,
        score: t.score,
      }));

      try {
        const raw = analyze(JSON.stringify(payload));
        const parsed = JSON.parse(raw) as {
          counts: Record<string, number>;
          dwell_ms: Record<string, number>;
          anomalies: AnalyticsResult["anomalies"];
        };
        setResult({
          counts: parsed.counts ?? {},
          dwellMs: parsed.dwell_ms ?? {},
          anomalies: parsed.anomalies ?? [],
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, intervalMs);

    return () => window.clearInterval(id);
  }, [ready, intervalMs]);

  return { ready, error, result };
}

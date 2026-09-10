import { useEffect, useRef, useState } from "react";
import { Header } from "./components/Header";
import { VideoCanvas } from "./components/VideoCanvas";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { AnomalyBanner } from "./components/AnomalyBanner";
import { useObjectDetection } from "./hooks/useObjectDetection";
import { usePyodideAnalytics } from "./hooks/usePyodideAnalytics";

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camReady, setCamReady] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | undefined;

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 960 }, height: { ideal: 720 } },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          setCamReady(true);
        }
      } catch {
        setCamError(
          "Camera access was denied or unavailable. LiveLens needs webcam permission to run — nothing is uploaded, the video never leaves this tab."
        );
      }
    }

    startCamera();
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const { ready: modelReady, error: modelError, tracked } = useObjectDetection(videoRef);
  const { ready: pyodideReady, error: pyodideError, result } = usePyodideAnalytics(tracked);

  return (
    <div className="app">
      <Header />

      {camError && <p className="error-banner">{camError}</p>}
      {modelError && <p className="error-banner">Detection model failed to load: {modelError}</p>}
      {pyodideError && <p className="error-banner">Python runtime error: {pyodideError}</p>}

      <div className="main-grid">
        <VideoCanvas videoRef={videoRef} tracked={tracked} />
        <AnalyticsPanel result={result} pyodideReady={pyodideReady} />
      </div>

      <AnomalyBanner result={result} />

      {camReady && !modelReady && <p className="status-line">Loading detection model…</p>}
    </div>
  );
}

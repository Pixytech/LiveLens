import { useEffect, useRef, useState } from "react";
import { Header } from "./components/Header";
import { AppTabs } from "./components/AppTabs";
import { useObjectDetection } from "./hooks/useObjectDetection";
import { usePyodideAnalytics } from "./hooks/usePyodideAnalytics";

type TabId = "detect" | "speech" | "chat";
const VALID_TABS = new Set<TabId>(["detect", "speech", "chat"]);

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const saved = localStorage.getItem("active_tab") as TabId | null;
    return saved && VALID_TABS.has(saved) ? saved : "detect";
  });

  useEffect(() => {
    let stream: MediaStream | undefined;

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 960 }, height: { ideal: 720 } },
          audio: false,
        });
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch {
        setCamError(
          "Camera access was denied or unavailable. LiveLens needs webcam permission — nothing is uploaded, the video never leaves this tab."
        );
      }
    }

    startCamera();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  const { ready: modelReady, error: modelError, tracked } = useObjectDetection(videoRef);
  const { ready: pyodideReady, error: pyodideError, result } = usePyodideAnalytics(tracked);

  return (
    <div className="app">
      <Header activeTab={activeTab} />

      {camError     && <p className="error-banner">{camError}</p>}
      {modelError   && <p className="error-banner">Detection model: {modelError}</p>}
      {pyodideError && <p className="error-banner">Python runtime: {pyodideError}</p>}

      <AppTabs
        videoRef={videoRef}
        tracked={tracked}
        result={result}
        pyodideReady={pyodideReady}
        modelReady={modelReady}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
    </div>
  );
}

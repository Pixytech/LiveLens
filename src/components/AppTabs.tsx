import { TrackedObject } from "../lib/tracker";
import { AnalyticsResult } from "../hooks/usePyodideAnalytics";
import { VideoCanvas } from "./VideoCanvas";
import { DetectView } from "../views/DetectView";
import { SpeechView } from "../views/SpeechView";
import { ChatView } from "../views/ChatView";
import { MonitorView } from "../views/MonitorView";
import { SnakeView } from "../views/SnakeView";

type TabId = "detect" | "speech" | "chat" | "monitor" | "snake";

const TABS: { id: TabId; label: string }[] = [
  { id: "snake",   label: "Snake" },
  { id: "detect",  label: "Detect" },
  { id: "speech",  label: "Speech" },
  { id: "chat",    label: "Chat" },
  { id: "monitor", label: "Monitor" },
];

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>;
  tracked: TrackedObject[];
  result: AnalyticsResult | null;
  pyodideReady: boolean;
  modelReady: boolean;
  activeTab: TabId;
  onTabChange: (id: TabId) => void;
}

export type { TabId };

export function AppTabs({ videoRef, tracked, result, pyodideReady, modelReady, activeTab, onTabChange }: Props) {
  const active = activeTab;

  const switchTab = (id: TabId) => {
    onTabChange(id);
    localStorage.setItem("active_tab", id);
  };

  return (
    <div className="app-tabs">
      <div className="tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            className={`tab-btn${t.id === active ? " tab-btn--active" : ""}`}
            onClick={() => switchTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* VideoCanvas always in the DOM so the detection loop never stops.
          Off the Detect tab it is fixed to a 1×1 invisible region — the
          <video> element keeps playing and useObjectDetection keeps reading
          frames; only the rendered output changes. */}
      {active === "detect" ? (
        <DetectView
          videoCanvas={<VideoCanvas videoRef={videoRef} tracked={tracked} />}
          tracked={tracked}
          modelReady={modelReady}
          result={result}
          pyodideReady={pyodideReady}
        />
      ) : (
        <>
          <div className="video-offscreen">
            <VideoCanvas videoRef={videoRef} tracked={tracked} />
          </div>
          {active === "speech"  && <SpeechView />}
          {active === "chat"    && <ChatView />}
          {active === "monitor" && <MonitorView />}
          {active === "snake"   && <SnakeView />}
        </>
      )}
    </div>
  );
}

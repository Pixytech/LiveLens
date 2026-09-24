import { useState } from "react";
import { createPortal } from "react-dom";
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

  // Where the persistent <video>/<canvas> pair currently lives: DetectView's
  // feed slot when Detect is active, or an invisible off-screen slot on every
  // other tab. Tracked as plain DOM nodes (via callback refs) rather than
  // conditionally rendering <VideoCanvas> itself in each branch below — see
  // the portal comment further down for why that distinction matters.
  const [feedAnchor, setFeedAnchor] = useState<HTMLDivElement | null>(null);
  const [offscreenAnchor, setOffscreenAnchor] = useState<HTMLDivElement | null>(null);
  const portalTarget = active === "detect" ? feedAnchor : offscreenAnchor;

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

      {/* <VideoCanvas> is rendered exactly once, at this fixed position in the
          tree, so the underlying <video> element (and the camera stream's
          srcObject attached to it) is created only once for the app's whole
          lifetime. It's then portalled into whichever anchor div is currently
          in the DOM below — DetectView's feed slot, or the off-screen slot —
          instead of being placed directly inside the tab-switching branches.
          Putting it directly in those branches would put it at a different
          tree position on every switch, which React treats as a full
          unmount/remount: a brand-new <video> element with no srcObject, i.e.
          a blank feed and a dead detection loop the moment you leave and
          return to the Detect tab. Portalling keeps the same DOM node alive
          and just moves it. */}
      {portalTarget && createPortal(<VideoCanvas videoRef={videoRef} tracked={tracked} />, portalTarget)}

      {active === "detect" ? (
        <DetectView
          feedRef={setFeedAnchor}
          tracked={tracked}
          modelReady={modelReady}
          result={result}
          pyodideReady={pyodideReady}
        />
      ) : (
        <>
          <div className="video-offscreen" ref={setOffscreenAnchor} />
          {active === "speech"  && <SpeechView />}
          {active === "chat"    && <ChatView />}
          {active === "monitor" && <MonitorView />}
          {active === "snake"   && <SnakeView />}
        </>
      )}
    </div>
  );
}

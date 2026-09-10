const TAB_SUBTITLES: Record<string, string> = {
  detect: 'Real-time object detection with live statistical analytics — nothing leaves this tab.',
  speech: 'Live speech-to-text transcription, running entirely in your browser.',
  chat:   'Chat with AI models offline in the browser, or via Claude, OpenAI, and Gemini — nothing leaves this tab.',
};

interface Props { activeTab: string; }

export function Header({ activeTab }: Props) {
  return (
    <header className="app-header">
      <div>
        <h1>LiveLens</h1>
        <p>{TAB_SUBTITLES[activeTab] ?? TAB_SUBTITLES.detect}</p>
      </div>
      <a href="https://github.com/Pixytech/LiveLens" target="_blank" rel="noopener noreferrer">
        GitHub
      </a>
    </header>
  );
}

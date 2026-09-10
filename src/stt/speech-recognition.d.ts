// Ambient declarations for the Web Speech API.
// TypeScript's DOM lib includes some SpeechRecognition* result types but
// omits the SpeechRecognition constructor and window.SpeechRecognition.

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart:  ((ev: Event) => void) | null;
  onend:    ((ev: Event) => void) | null;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror:  ((ev: SpeechRecognitionErrorEvent) => void) | null;
  start(): void;
  stop(): void;
}

declare var SpeechRecognition: { new(): SpeechRecognition };

interface Window {
  SpeechRecognition?: typeof SpeechRecognition;
  webkitSpeechRecognition?: typeof SpeechRecognition;
}

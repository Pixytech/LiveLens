import { useEffect, useState } from "react";

// Illustration for the Pixel Codec tab: two robots facing each other. The
// Encoder shows data as a pixel grid on its chest screen; the Decoder reads
// it with its camera eye and rebuilds the file on its own screen. Purely
// decorative — no real data flows through it.

const COLS = 8, ROWS = 6, CELL = 9, GAP = 1;
const SCREEN_X = 96, SCREEN_Y = 113;
const FINDER = new Set(["0,0", "1,0", "0,1", "1,1", "6,0", "7,0", "6,1", "7,1", "0,4", "1,4", "0,5", "1,5", "6,4", "7,4", "6,5", "7,5"]);

const randomBits = () => Array.from({ length: COLS * ROWS }, () => Math.random() < 0.5);

// Flight path from the encoder's screen to the decoder's lens.
const FLIGHT = "M 176 144 C 280 150, 380 70, 474 62";

export function RobotsScene({ active }: { active: "send" | "receive" }) {
  const [bits, setBits] = useState(randomBits);
  const [reduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setBits(randomBits()), 450);
    return () => clearInterval(t);
  }, [reduced]);

  return (
    <figure className={`xfer-robots xfer-robots--${active}`} aria-label="Two robots: one shows data as pixels, the other reads it with a camera and rebuilds the file">
      <svg viewBox="0 0 640 228" role="img">
        <defs>
          <linearGradient id="xfer-beam" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0" stopColor="var(--teal)" stopOpacity="0.45" />
            <stop offset="1" stopColor="var(--teal)" stopOpacity="0.04" />
          </linearGradient>
          <clipPath id="xfer-screen-clip">
            <rect x={SCREEN_X - 3} y={SCREEN_Y - 3} width={COLS * (CELL + GAP) + 5} height={ROWS * (CELL + GAP) + 5} rx="3" />
          </clipPath>
        </defs>

        {/* Vision beam: decoder's lens → encoder's screen */}
        <polygon className="xfer-beam" points={`474,62 178,110 178,178`} fill="url(#xfer-beam)" />

        {/* ── Encoder robot (left) ───────────────────────────── */}
        <g className="xfer-bot xfer-bot--enc">
          <line x1="135" y1="30" x2="135" y2="14" className="xfer-bot-line" />
          <circle cx="135" cy="11" r="4" className="xfer-antenna" />
          <rect x="92" y="30" width="86" height="60" rx="14" className="xfer-bot-shell" />
          {/* eyes looking right, toward the decoder */}
          <circle cx="140" cy="58" r="7" className="xfer-eye-white" />
          <circle cx="163" cy="58" r="7" className="xfer-eye-white" />
          <circle cx="143" cy="58" r="3.2" className="xfer-pupil" />
          <circle cx="166" cy="58" r="3.2" className="xfer-pupil" />
          <path d="M142 76 q10 6 20 0" className="xfer-bot-line" fill="none" />
          <rect x="84" y="98" width="102" height="92" rx="12" className="xfer-bot-shell" />
          <rect x={SCREEN_X - 4} y={SCREEN_Y - 4} width={COLS * (CELL + GAP) + 7} height={ROWS * (CELL + GAP) + 7} rx="4" fill="#fff" />
          <g clipPath="url(#xfer-screen-clip)">
            {bits.map((on, i) => {
              const c = i % COLS, r = Math.floor(i / COLS);
              const dark = FINDER.has(`${c},${r}`) || on;
              return dark ? (
                <rect key={i} x={SCREEN_X + c * (CELL + GAP)} y={SCREEN_Y + r * (CELL + GAP)} width={CELL} height={CELL} fill="#0b0f10" />
              ) : null;
            })}
            <rect x={SCREEN_X - 3} y={SCREEN_Y} width={COLS * (CELL + GAP) + 5} height="2" className="xfer-scanline" />
          </g>
          <rect x="70" y="112" width="12" height="44" rx="6" className="xfer-bot-shell" />
          <rect x="188" y="112" width="12" height="44" rx="6" className="xfer-bot-shell" />
          <rect x="104" y="192" width="18" height="16" rx="4" className="xfer-bot-shell" />
          <rect x="148" y="192" width="18" height="16" rx="4" className="xfer-bot-shell" />
        </g>

        {/* ── Decoder robot (right) ──────────────────────────── */}
        <g className="xfer-bot xfer-bot--dec">
          <line x1="505" y1="30" x2="505" y2="14" className="xfer-bot-line" />
          <circle cx="505" cy="11" r="4" className="xfer-antenna" />
          <rect x="462" y="30" width="86" height="60" rx="14" className="xfer-bot-shell" />
          {/* camera lens eye, looking left toward the encoder */}
          <circle cx="480" cy="60" r="15" className="xfer-lens-ring" />
          <circle cx="480" cy="60" r="9" className="xfer-lens" />
          <circle cx="476" cy="56" r="2.5" fill="#fff" opacity="0.8" />
          <circle cx="526" cy="52" r="3" className="xfer-rec" />
          <rect x="516" y="66" width="20" height="4" rx="2" className="xfer-bot-detail" />
          <rect x="454" y="98" width="102" height="92" rx="12" className="xfer-bot-shell" />
          {/* chest screen: the file being rebuilt */}
          <rect x="470" y="110" width="70" height="68" rx="4" className="xfer-dec-screen" />
          <path d="M488 118 h24 l10 10 v38 h-34 z" className="xfer-doc" />
          <path d="M512 118 v10 h10" className="xfer-doc-fold" fill="none" />
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x="493" y={134 + i * 7} width={i === 3 ? 14 : 24} height="3" rx="1.5"
              className="xfer-doc-line" style={{ animationDelay: `${i * 0.45}s` }} />
          ))}
          <rect x="440" y="112" width="12" height="44" rx="6" className="xfer-bot-shell" />
          <rect x="558" y="112" width="12" height="44" rx="6" className="xfer-bot-shell" />
          <rect x="474" y="192" width="18" height="16" rx="4" className="xfer-bot-shell" />
          <rect x="518" y="192" width="18" height="16" rx="4" className="xfer-bot-shell" />
        </g>

        {/* Pixels travelling along the line of sight */}
        {!reduced && [0, 1, 2, 3, 4, 5].map((i) => (
          <rect key={i} x="-3" y="-3" width="6" height="6" opacity="0" className={i % 2 ? "xfer-fly xfer-fly--dark" : "xfer-fly"}>
            <animateMotion dur="2.4s" begin={`${i * 0.4}s`} repeatCount="indefinite" path={FLIGHT} />
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur="2.4s" begin={`${i * 0.4}s`} repeatCount="indefinite" />
          </rect>
        ))}

        <text x="135" y="224" className="xfer-bot-label">ENCODER · file → pixels</text>
        <text x="505" y="224" className="xfer-bot-label">DECODER · pixels → file</text>
        <text x="320" y="36" className="xfer-bot-caption">computer vision</text>
      </svg>
    </figure>
  );
}

import { useEffect, useRef } from "react";
import { TrackedObject } from "../lib/tracker";

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>;
  tracked: TrackedObject[];
}

const BOX_COLORS = ["#00d4b4", "#ff8a5c", "#ffd166", "#4dabf7", "#c084fc", "#f472b6"];

function colorForClass(cls: string): string {
  let hash = 0;
  for (let i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) >>> 0;
  return BOX_COLORS[hash % BOX_COLORS.length];
}

export function VideoCanvas({ videoRef, tracked }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Overlay drawing runs on its own rAF loop, independent of the detection
  // loop's cadence, so boxes stay visually smooth even if detection is
  // running at a lower effective frame rate than the video itself.
  const trackedRef = useRef(tracked);
  trackedRef.current = tracked;

  useEffect(() => {
    let raf: number;

    function draw() {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && canvas && video.videoWidth) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          for (const t of trackedRef.current) {
            const [x, y, w, h] = t.bbox;
            const color = colorForClass(t.class);

            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);

            const label = `${t.class} #${t.id} · ${(t.score * 100).toFixed(0)}%`;
            ctx.font = "13px 'Fira Code', ui-monospace, monospace";
            const textWidth = ctx.measureText(label).width;

            ctx.fillStyle = color;
            ctx.fillRect(x, Math.max(0, y - 18), textWidth + 8, 18);
            ctx.fillStyle = "#0b0f10";
            ctx.fillText(label, x + 4, Math.max(13, y - 5));
          }
        }
      }
      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  return (
    <div className="video-stage">
      <video ref={videoRef} className="video-el" autoPlay playsInline muted />
      <canvas ref={canvasRef} className="overlay-canvas" />
    </div>
  );
}

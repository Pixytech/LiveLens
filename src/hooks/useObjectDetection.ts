import { useEffect, useRef, useState } from "react";
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import { Detection, ObjectTracker, TrackedObject } from "../lib/tracker";

const CONFIDENCE_THRESHOLD = 0.55;

export function useObjectDetection(videoRef: React.RefObject<HTMLVideoElement>) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<TrackedObject[]>([]);

  const modelRef = useRef<cocoSsd.ObjectDetection | null>(null);
  const trackerRef = useRef(new ObjectTracker());
  const rafRef = useRef<number>();

  // Load the model once. lite_mobilenet_v2 trades a little accuracy for
  // speed, which matters more here than benchmark precision — this needs
  // to keep up with a live video feed on ordinary laptop hardware.
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        try {
          await tf.setBackend("webgl");
        } catch {
          await tf.setBackend("wasm").catch(() => tf.setBackend("cpu"));
        }
        await tf.ready();
        const model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
        if (cancelled) return;
        modelRef.current = model;
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

  // Detection loop, driven by requestAnimationFrame so it naturally paces
  // itself to the browser's rendering cadence instead of a fixed timer.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    async function tick() {
      const video = videoRef.current;
      const model = modelRef.current;

      if (video && model && video.readyState === video.HAVE_ENOUGH_DATA) {
        try {
          const predictions = await model.detect(video);
          const detections: Detection[] = predictions
            .filter((p) => p.score >= CONFIDENCE_THRESHOLD)
            .map((p) => ({
              class: p.class,
              score: p.score,
              bbox: p.bbox as [number, number, number, number],
            }));
          const now = performance.now();
          const next = trackerRef.current.update(detections, now);
          if (!cancelled) setTracked(next);
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
      }

      if (!cancelled) rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [ready, videoRef]);

  return { ready, error, tracked };
}

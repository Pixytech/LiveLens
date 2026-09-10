// A minimal IoU-based tracker. coco-ssd gives us a fresh, unlabelled set of
// boxes on every frame — it has no concept of "the same cup as last frame".
// To compute dwell time or per-object history we need identity, so this
// matches each new detection to the closest previous track (by class +
// bounding-box overlap) and carries its id forward. It's a simplified
// version of the same greedy-matching idea behind SORT-style trackers,
// without the Kalman filter — accurate enough for a browser demo running
// at a handful of frames per second.

export interface Detection {
  class: string;
  score: number;
  bbox: [number, number, number, number]; // x, y, width, height in video pixels
}

export interface TrackedObject {
  id: number;
  class: string;
  score: number;
  bbox: [number, number, number, number];
  firstSeen: number; // ms, performance.now()
  lastSeen: number; // ms, performance.now()
}

function intersectionOverUnion(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;

  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);

  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const interArea = interW * interH;

  const unionArea = aw * ah + bw * bh - interArea;
  return unionArea <= 0 ? 0 : interArea / unionArea;
}

export class ObjectTracker {
  private nextId = 1;
  private tracked: TrackedObject[] = [];

  constructor(
    private readonly iouThreshold = 0.3,
    // How long a track survives after its last detection before it's
    // dropped — bridges brief occlusions/missed frames without inventing
    // new identities for the same physical object.
    private readonly staleAfterMs = 1500
  ) {}

  update(detections: Detection[], now: number): TrackedObject[] {
    const unmatched = new Set(this.tracked.map((_, i) => i));

    for (const det of detections) {
      let bestIdx = -1;
      let bestScore = this.iouThreshold;

      for (const i of unmatched) {
        const candidate = this.tracked[i];
        if (candidate.class !== det.class) continue;
        const overlap = intersectionOverUnion(candidate.bbox, det.bbox);
        if (overlap > bestScore) {
          bestScore = overlap;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        const track = this.tracked[bestIdx];
        track.bbox = det.bbox;
        track.score = det.score;
        track.lastSeen = now;
        unmatched.delete(bestIdx);
      } else {
        this.tracked.push({
          id: this.nextId++,
          class: det.class,
          score: det.score,
          bbox: det.bbox,
          firstSeen: now,
          lastSeen: now,
        });
      }
    }

    this.tracked = this.tracked.filter((t) => now - t.lastSeen < this.staleAfterMs);
    return this.tracked.slice();
  }
}

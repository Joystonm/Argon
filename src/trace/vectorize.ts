/**
 * Floor-plan vectoriser.
 *
 * This reads pixels and proposes geometry. It deliberately does NOT write to
 * the model: every detection comes back as a `TraceProposal` carrying its own
 * measured length in metres, its confidence, and — critically — whether its
 * scale is trustworthy. A proposal from an uncalibrated image has
 * `measured: null`, and the UI says so instead of inventing a dimension.
 *
 * That constraint is the whole design. An image tracer that quietly emits
 * numbers nobody measured is a machine for producing confidently wrong plans,
 * and the user cannot tell the difference after the fact.
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 *  1. Downsample the image to a working buffer and build a binary mask of
 *     "ink" (dark pixels), with a threshold the user can see and change.
 *  2. Find horizontal and vertical runs of ink longer than a minimum wall
 *     length. Architectural plans are overwhelmingly axis-aligned, so run
 *     detection recovers wall centrelines far more reliably than edge tracing.
 *  3. Merge collinear runs into single segments, then snap each to the
 *     nearest detected perpendicular wall to form corners.
 *  4. Convert pixel segments to plan metres through the calibration, keeping
 *     every segment's thickness as the run's measured width.
 *
 * Diagonal walls and curved walls are not detected. That is stated rather than
 * approximated: a wrong wall is worse than a missing one the user adds.
 */
import type { Calibration } from '../model/types.ts';

export interface Vec2px {
  x: number;
  y: number;
}

export type ProposalKind = 'wall' | 'room' | 'opening' | 'furniture';

export interface TraceProposal {
  id: string;
  kind: ProposalKind;
  /** Pixel-space geometry, for drawing the overlay where the user sees it. */
  pixel: { a: Vec2px; b: Vec2px; thickness: number };
  /** Plan-space geometry. Null when the image is not calibrated. */
  plan: { a: { x: number; y: number }; b: { x: number; y: number }; thickness: number } | null;
  /** Wall length in metres — null when it cannot be known honestly. */
  measured: number | null;
  /** 0..1. How sure the tracer is, from run length and ink density. */
  confidence: number;
  accepted: boolean;
  reason: string;
}

export interface TraceSettings {
  /** 0..255; pixels darker than this count as ink. */
  threshold: number;
  /** Ignore runs shorter than this many pixels. */
  minRunPixels: number;
  /** Working-buffer width; the image is downsampled to this before analysis. */
  workWidth: number;
}

export const DEFAULT_TRACE_SETTINGS: TraceSettings = {
  threshold: 140,
  minRunPixels: 18,
  workWidth: 900,
};

export interface GreyImage {
  width: number;
  height: number;
  /** Row-major luminance, 0 (black) .. 255 (white). */
  data: Uint8ClampedArray;
}

let counter = 0;
const nextId = (): string => `tp_${(counter++).toString(36)}`;

/** Downscale to a working buffer and read luminance out of it. */
export async function toGrey(source: HTMLImageElement | ImageBitmap, workWidth = DEFAULT_TRACE_SETTINGS.workWidth): Promise<GreyImage> {
  const scale = Math.min(1, workWidth / Math.max(1, source.width));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get a 2D context to analyse the image.');
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const grey = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 601 luma; plan images are near-neutral so this is plenty.
    grey[p] = (data[i]! * 299 + data[i + 1]! * 587 + data[i + 2]! * 114) / 1000;
  }
  return { width: w, height: h, data: grey };
}

const ink = (g: GreyImage, x: number, y: number, threshold: number): boolean =>
  x >= 0 && y >= 0 && x < g.width && y < g.height && g.data[y * g.width + x]! <= threshold;

interface Run {
  axis: 'h' | 'v';
  /** Row (h) or column (v) the run lies on. */
  at: number;
  start: number;
  end: number;
  /** Stroke width perpendicular to the run, sampled by ink depth. */
  thickness: number;
  density: number;
}

/** Horizontal and vertical runs of ink. */
function findRuns(g: GreyImage, settings: TraceSettings): Run[] {
  const runs: Run[] = [];
  const { threshold, minRunPixels } = settings;

  for (let y = 0; y < g.height; y++) {
    let start = -1;
    for (let x = 0; x <= g.width; x++) {
      const on = x < g.width && ink(g, x, y, threshold);
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        const len = x - start;
        if (len >= minRunPixels) {
          const mid = Math.floor((start + x - 1) / 2);
          runs.push({ axis: 'h', at: y, start, end: x - 1, thickness: measureThickness(g, mid, y, 'v', threshold), density: len / (x - start) });
        }
        start = -1;
      }
    }
  }

  for (let x = 0; x < g.width; x++) {
    let start = -1;
    for (let y = 0; y <= g.height; y++) {
      const on = y < g.height && ink(g, x, y, threshold);
      if (on && start < 0) start = y;
      else if (!on && start >= 0) {
        const len = y - start;
        if (len >= minRunPixels) {
          const mid = Math.floor((start + y - 1) / 2);
          runs.push({ axis: 'v', at: x, start, end: y - 1, thickness: measureThickness(g, x, mid, 'h', threshold), density: len / (y - start) });
        }
        start = -1;
      }
    }
  }

  return runs;
}

/** How many pixels deep the ink is at (x, y), sampling perpendicular. */
function measureThickness(g: GreyImage, x: number, y: number, axis: 'h' | 'v', threshold: number): number {
  const dx = axis === 'h' ? 0 : 1;
  const dy = axis === 'h' ? 1 : 0;
  let up = 0;
  while (up < 40 && ink(g, x - dx * (up + 1), y - dy * (up + 1), threshold)) up++;
  let down = 0;
  while (down < 40 && ink(g, x + dx * (down + 1), y + dy * (down + 1), threshold)) down++;
  return Math.max(1, up + down + 1);
}

/**
 * Merge collinear runs on the same row/column into one wall candidate.
 *
 * Adjacent rows of a thick wall all produce runs at nearly the same extent;
 * without this a single 200 mm wall would come back as fifteen separate
 * "detections" the user would have to accept individually.
 */
function mergeRuns(runs: Run[]): Run[] {
  const byAxis: Record<'h' | 'v', Map<number, Run[]>> = { h: new Map(), v: new Map() };
  for (const r of runs) {
    const bucket = byAxis[r.axis];
    if (!bucket.has(r.at)) bucket.set(r.at, []);
    bucket.get(r.at)!.push(r);
  }

  const out: Run[] = [];
  for (const axis of ['h', 'v'] as const) {
    // Cluster the perpendicular positions into a single stroke first.
    const positions = [...byAxis[axis].keys()].sort((a, b) => a - b);
    const clusters: Array<{ centre: number; members: Run[] }> = [];
    for (const pos of positions) {
      const last = clusters[clusters.length - 1];
      if (last && pos - last.centre <= 3) {
        last.members.push(...byAxis[axis].get(pos)!);
        last.centre = last.members.reduce((s, r) => s + r.at, 0) / last.members.length;
      } else {
        clusters.push({ centre: pos, members: [...byAxis[axis].get(pos)!] });
      }
    }

    for (const cluster of clusters) {
      const sorted = [...cluster.members].sort((a, b) => a.start - b.start);
      let cur: Run | null = null;
      for (const r of sorted) {
        if (cur && r.start <= cur.end + 6) {
          cur.end = Math.max(cur.end, r.end);
          cur.thickness = Math.max(cur.thickness, r.thickness);
          cur.density = Math.max(cur.density, r.density);
        } else {
          if (cur) out.push(cur);
          cur = { ...r, at: Math.round(cluster.centre) };
        }
      }
      if (cur) out.push(cur);
    }
  }
  return out;
}

/**
 * Detect wall candidates, in image pixels.
 *
 * Exported separately from `trace` so the detection can be unit-tested against
 * a synthetic image without a DOM or a calibration.
 */
export function detectRuns(g: GreyImage, settings: TraceSettings = DEFAULT_TRACE_SETTINGS): Run[] {
  return mergeRuns(findRuns(g, settings));
}

export interface TraceResult {
  proposals: TraceProposal[];
  settings: TraceSettings;
  /** True when proposals carry real metre dimensions. */
  calibrated: boolean;
  /** What the user must do before any dimension can be trusted. */
  blocker: string | null;
  elapsedMs: number;
}

export interface TraceInput {
  image: GreyImage;
  calibration: Calibration | null;
  /** Scale from the working buffer back to full-resolution pixels. */
  pixelScale: number;
  settings?: TraceSettings;
  now?: number;
}

/**
 * Analyse a plan image and return proposals. Pure and synchronous — the DOM
 * work (decoding) happens in `loadImage` before this is called.
 */
export function trace({ image, calibration, pixelScale, settings = DEFAULT_TRACE_SETTINGS, now = 0 }: TraceInput): TraceResult {
  const t0 = now || 0;
  const runs = detectRuns(image, settings);
  const usable = Boolean(calibration?.confirmed);
  const cal = calibration?.confirmed ? calibration : null;

  const proposals: TraceProposal[] = runs.map((r) => {
    const a = r.axis === 'h' ? { x: r.start, y: r.at } : { x: r.at, y: r.start };
    const b = r.axis === 'h' ? { x: r.end, y: r.at } : { x: r.at, y: r.end };

    // Back to full-resolution pixels so the overlay and the plan agree with
    // whatever the user clicked on the displayed image.
    const scalePx = pixelScale || 1;
    const fullA = { x: a.x * scalePx, y: a.y * scalePx };
    const fullB = { x: b.x * scalePx, y: b.y * scalePx };
    const thicknessPx = r.thickness * scalePx;

    const plan = cal
      ? {
          a: { x: fullA.x * cal.scale + cal.offX, y: fullA.y * cal.scale + cal.offY },
          b: { x: fullB.x * cal.scale + cal.offX, y: fullB.y * cal.scale + cal.offY },
          thickness: thicknessPx * cal.scale,
        }
      : null;

    const measured = plan ? Math.hypot(plan.b.x - plan.a.x, plan.b.y - plan.a.y) : null;
    const lengthPx = r.end - r.start;

    // Longer, denser runs are more likely to be real walls; a short faint run
    // is usually a dimension line or a note.
    const lengthScore = Math.min(1, lengthPx / (image.width * 0.25));
    const confidence = Math.max(0.05, Math.min(0.99, 0.45 * lengthScore + 0.35 * r.density + 0.2 * (1 - Math.min(1, thicknessPx / 24))));

    return {
      id: nextId(),
      kind: 'wall' as const,
      pixel: { a: fullA, b: fullB, thickness: thicknessPx },
      plan,
      measured,
      confidence,
      accepted: false,
      reason: usable
        ? `${measured!.toFixed(2)} m long, ${(thicknessPx * (cal?.scale ?? 0)).toFixed(2)} m thick`
        : 'Detected, but not yet scaled — measure one known length to give it a real size.',
    };
  });

  return {
    proposals: proposals.sort((p1, p2) => p2.confidence - p1.confidence),
    settings,
    calibrated: usable,
    blocker: usable
      ? null
      : calibration
        ? 'Calibration was reset. Measure one real-world length on the image to enable scaling.'
        : 'Not calibrated yet. Click two points on a wall you know the length of, then type that length.',
    elapsedMs: t0,
  };
}

/** Accept the accepted proposals into real model operations. */
export interface AcceptedWall {
  a: { x: number; y: number };
  b: { x: number; y: number };
  thickness: number;
  confidence: number;
}

/**
 * The subset the user ticked, with everything needed to create walls.
 *
 * Anything without a plan-space position is dropped rather than defaulted —
 * accepting an uncalibrated detection is not an action the tracer offers.
 */
export function collectAccepted(proposals: TraceProposal[]): AcceptedWall[] {
  const out: AcceptedWall[] = [];
  for (const p of proposals) {
    if (!p.accepted || !p.plan) continue;
    const length = Math.hypot(p.plan.b.x - p.plan.a.x, p.plan.b.y - p.plan.a.y);
    if (length < 0.15) continue;
    out.push({ a: p.plan.a, b: p.plan.b, thickness: Math.max(0.08, Math.min(0.6, p.plan.thickness)), confidence: p.confidence });
  }
  return out;
}

/** Load a user-supplied file into an ImageBitmap for analysis. */
export async function loadImage(file: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  // Safari < 15 fallback.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img as unknown as ImageBitmap;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Downsample factor from the original image to the analysis buffer. */
export const pixelScaleFor = (originalWidth: number, workWidth: number): number =>
  Math.max(1, originalWidth / Math.max(1, workWidth));
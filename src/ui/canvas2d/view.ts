/**
 * Plan-view transform: metres ⇄ screen pixels.
 *
 * The whole app shares ONE conversion, in both directions, defined once here.
 * Anything that needs to turn a click into a coordinate (the editor, the
 * tracer, the AI's pointer tools, dimension labels) uses `screenToPlan` and
 * therefore cannot drift from what the user sees. This is also the layer the
 * coordinate-conversion tests pin.
 *
 * Two coordinate spaces are in play:
 *
 *   plan space  — metres, X east, Y south, origin at the plot's north-west.
 *   screen space — CSS pixels relative to the SVG element's top-left corner.
 *
 * `scale` is pixels-per-metre, so it is a zoom factor in a meaningful unit:
 * 40 means "40 px per metre", which is roughly 1:25 at 96 dpi.
 */

export interface ViewTransform {
  /** CSS pixels per metre. */
  scale: number;
  /** Screen x of plan x = 0. */
  offsetX: number;
  /** Screen y of plan y = 0. */
  offsetY: number;
  /** Size of the drawing surface in CSS pixels. */
  width: number;
  height: number;
}

export const MIN_SCALE = 4;
export const MAX_SCALE = 400;

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function makeTransform(width: number, height: number, scale = 40, offsetX = 0, offsetY = 0): ViewTransform {
  return { scale: clampScale(scale), offsetX, offsetY, width, height };
}

/** Fit a plan-space rect into the viewport with a margin in pixels. */
export function fitTransform(
  width: number,
  height: number,
  plan: { x: number; y: number; width: number; depth: number },
  margin = 48,
): ViewTransform {
  const w = Math.max(0.001, plan.width);
  const h = Math.max(0.001, plan.depth);
  const scale = clampScale(Math.min((width - margin * 2) / w, (height - margin * 2) / h));
  return {
    scale,
    offsetX: margin + (width - margin * 2 - w * scale) / 2 - plan.x * scale,
    offsetY: margin + (height - margin * 2 - h * scale) / 2 - plan.y * scale,
    width,
    height,
  };
}

export interface PlanPoint {
  x: number;
  y: number;
}

/**
 * Inverse of `planToScreen*`, written plainly.
 *
 * The forward direction is the identity affine `screen = plan * scale + offset`,
 * so the inverse is a subtract-then-divide. Keeping it here (rather than
 * inlining arithmetic at each call site) is what guarantees the two never
 * disagree.
 */
export function planToScreen(v: ViewTransform, p: PlanPoint): PlanPoint {
  return { x: p.x * v.scale + v.offsetX, y: p.y * v.scale + v.offsetY };
}

export function screenToPlan(v: ViewTransform, p: PlanPoint): PlanPoint {
  return { x: (p.x - v.offsetX) / v.scale, y: (p.y - v.offsetY) / v.scale };
}

export const planToScreenLength = (v: ViewTransform, metres: number): number => metres * v.scale;

/** Pan by a screen-pixel delta (drag-to-pan). */
export function panBy(v: ViewTransform, dxPx: number, dyPx: number): ViewTransform {
  return { ...v, offsetX: v.offsetX + dxPx, offsetY: v.offsetY + dyPx };
}

/** Zoom about a fixed screen point, so the cursor stays put. */
export function zoomAt(v: ViewTransform, px: number, py: number, factor: number): ViewTransform {
  const next = clampScale(v.scale * factor);
  const k = next / v.scale;
  return {
    ...v,
    scale: next,
    offsetX: px - (px - v.offsetX) * k,
    offsetY: py - (py - v.offsetY) * k,
  };
}

/** Snap a plan coordinate to a grid step in metres (0 when snapping is off). */
export function snap(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

/**
 * Snap to a nearby wall or room edge when one is within `tolerance` metres.
 *
 * Snapping only to the grid makes precise alignment tedious; snapping to real
 * geometry is what makes adjacent rooms meet cleanly. This reads the model, it
 * does not write to it.
 */
export function snapToGeometry(
  value: number,
  candidates: number[],
  tolerance: number,
  axisStep: number,
  snapEnabled: boolean,
): { value: number; snappedTo: 'grid' | 'geometry' | null; guideValue: number | null } {
  if (!snapEnabled) return { value, snappedTo: null, guideValue: null };
  let best: number | null = null;
  let bestDist = tolerance;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (best !== null) return { value: best, snappedTo: 'geometry', guideValue: best };
  return { value: snap(value, axisStep), snappedTo: 'grid', guideValue: null };
}

/** Grid step in metres that keeps on-screen spacing readable at this zoom. */
export function gridStepFor(scale: number): number {
  const candidates = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  for (const c of candidates) {
    if (c * scale >= 28) return c;
  }
  return 10;
}

/** Convert metres to a display string in the project's units. */
export function formatMetres(metres: number, units: 'm' | 'ft'): string {
  if (units === 'm') return `${metres.toFixed(2)} m`;
  const ft = metres * 3.280839895;
  const wholeFeet = Math.floor(ft);
  const inches = Math.round((ft - wholeFeet) * 12);
  if (inches === 12) return `${wholeFeet + 1}′0″`;
  return `${wholeFeet}′${inches}″`;
}
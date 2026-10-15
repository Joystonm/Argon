/**
 * Image → world calibration.
 *
 * A floor-plan photo or scan has no scale. To trace it you must establish how
 * many metres an image pixel is worth, and Argon refuses to guess: calibration
 * is only ever derived from a length the user asserts is real ("this wall is
 * 4.20 m"), and until they do, `confirmed` is false and the tracer will not
 * convert any detection into a dimension.
 *
 * The transform is a uniform scale plus a translation:
 *
 *     plan.x = px * scale + offX
 *     plan.y = py * scale + offY
 *
 * A single known length determines `scale`. The placement of the image within
 * the plot comes from the user dragging it, so `offX/offY` are adjusted
 * separately from the scale — which means recalibrating with a different
 * length never silently moves the whole drawing.
 */
import type { Calibration } from '../model/types.ts';

export interface PixelPoint {
  px: number;
  py: number;
}

/** Metres between two image pixels, or null when the input is degenerate. */
export function pixelDistance(a: PixelPoint, b: PixelPoint): number | null {
  const d = Math.hypot(b.px - a.px, b.py - a.py);
  return Number.isFinite(d) && d > 1e-6 ? d : null;
}

/**
 * Derive metres-per-pixel from one user-measured length.
 *
 * Returns null — never a fallback number — when the two points coincide or the
 * stated length is not positive, because a calibration built on a division by
 * zero is worse than no calibration.
 */
export function scaleFromLength(
  a: PixelPoint,
  b: PixelPoint,
  realMetres: number,
  placement: { offX: number; offY: number } = { offX: 0, offY: 0 },
): Calibration | null {
  const pd = pixelDistance(a, b);
  if (pd === null) return null;
  if (!Number.isFinite(realMetres) || realMetres <= 0) return null;

  return {
    scale: realMetres / pd,
    offX: placement.offX,
    offY: placement.offY,
    source: { pixelDistance: pd, realDistance: realMetres, label: 'User-measured length' },
    confirmed: true,
  };
}

/**
 * Two-point calibration: solves for placement as well as scale, by declaring
 * that image point `a` sits at plan point `pa` and `b` at `pb`.
 *
 * This is how a user pins a scan to a plot: they click the end of a known
 * external wall and type where it is in the plan.
 *
 * What this actually guarantees — and it is worth being precise, because the
 * alternative is a drawing that is confidently in the wrong place:
 *
 *   - `a` lands exactly on `pa`, always.
 *   - `scale` is exactly `planLen / pixelLen`, always.
 *   - `b` lands on `pb` **only when the image run is parallel to the plan run**.
 *
 * A uniform scale plus a translation has two degrees of freedom; two point
 * correspondences ask for two more constraints, and they are over-determined
 * unless the runs are parallel. A photograph taken at an angle, or a scan where
 * the user picked the two ends of a slightly non-parallel wall, will not
 * satisfy both. Rather than silently choosing one and hoping, the leftover is
 * returned as `residual` in metres so the inspector can say so.
 */
export function calibrateFromTwoPoints(
  a: PixelPoint,
  b: PixelPoint,
  pa: { x: number; y: number },
  pb: { x: number; y: number },
  label = 'Two-point placement',
): Calibration | null {
  const pd = pixelDistance(a, b);
  if (pd === null) return null;
  const planLen = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  if (!Number.isFinite(planLen) || planLen <= 1e-6) return null;

  const scale = planLen / pd;
  const offX = pa.x - a.px * scale;
  const offY = pa.y - a.py * scale;

  const landed = { x: b.px * scale + offX, y: b.py * scale + offY };
  const residual = Math.hypot(landed.x - pb.x, landed.y - pb.y);

  return {
    scale,
    offX,
    offY,
    source: { pixelDistance: pd, realDistance: planLen, label },
    confirmed: true,
    residual,
  };
}

/** Image pixel → plan metres. Requires a confirmed calibration. */
export function pixelToPlan(c: Calibration, p: PixelPoint): { x: number; y: number } {
  return { x: p.px * c.scale + c.offX, y: p.py * c.scale + c.offY };
}

/** Plan metres → image pixel. The exact inverse. */
export function planToPixel(c: Calibration, p: { x: number; y: number }): PixelPoint {
  return { px: (p.x - c.offX) / c.scale, py: (p.y - c.offY) / c.scale };
}

/** Plan metres → normalised image fraction, for drawing without recalibrating. */
export function planToFraction(c: Calibration, p: { x: number; y: number }, image: { width: number; height: number }): { u: number; v: number } {
  return { u: planToPixel(c, p).px / Math.max(1, image.width), v: planToPixel(c, p).py / Math.max(1, image.height) };
}

/**
 * The plan-space rectangle an underlay image is placed in — the same four
 * numbers `Underlay` stores, extracted for callers that only have a
 * calibration.
 */
export interface Frame {
  x: number;
  y: number;
  /** World width of the image, metres. */
  width: number;
  /** World height of the image, metres. */
  depth: number;
}

/** Derive the placement rectangle from a calibration and the image's pixel size. */
export function frameFromCalibration(c: Calibration, image: { width: number; height: number }): Frame {
  return { x: c.offX, y: c.offY, width: image.width * c.scale, depth: image.height * c.scale };
}

/**
 * Fraction → plan metres, via the image's placement rectangle.
 *
 * This is the resize-invariant mapping, and the reason it is expressed this way
 * rather than as `fraction × imageSize × metresPerPixel`: a page that re-encodes
 * an upload at a different pixel size produces a *different* pixel→metre ratio,
 * so any conversion that routes through pixels silently disagrees between two
 * copies of the same drawing. A fraction is the same number on both, and this
 * function never mentions pixels at all.
 */
export function fractionToPlan(frame: Frame, f: { u: number; v: number }): { x: number; y: number } {
  return { x: frame.x + f.u * frame.width, y: frame.y + f.v * frame.depth };
}

/** The exact inverse of `fractionToPlan`. */
export function planToFrameFraction(frame: Frame, p: { x: number; y: number }): { u: number; v: number } {
  const w = frame.width === 0 ? 1 : frame.width;
  const d = frame.depth === 0 ? 1 : frame.depth;
  return { u: (p.x - frame.x) / w, v: (p.y - frame.y) / d };
}

/**
 * Metres between two image fractions.
 *
 * Depends only on where the image sits in the plan — not on the pixel size of
 * whichever copy the numbers were read off. Passing the same two fractions for
 * a 4000 px scan and a 1000 px thumbnail of it gives the same answer, which is
 * what makes a fraction safe to hand across a boundary where the image was
 * re-encoded.
 */
export function fractionDistance(a: { u: number; v: number }, b: { u: number; v: number }, frame: Frame): number {
  const pa = fractionToPlan(frame, a);
  const pb = fractionToPlan(frame, b);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

/** A length the user typed, parsed into metres from "4.2", "4.2m", or "14'1"". */
export function parseLengthToMetres(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  // Feet-and-inches: 14'1" / 14' 1" / 14ft1in
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)?\s*(?:"|in|inch|inches)?$/);
  if (ftIn) {
    const ft = Number(ftIn[1]);
    const inch = ftIn[2] ? Number(ftIn[2]) : 0;
    return (ft + inch / 12) * 0.3048;
  }

  const m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(m|metres?|meters?|cm|mm)?$/);
  if (!m) return null;
  const value = Number(m[1]!.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const unit = m[2] ?? 'm';
  if (unit.startsWith('cm')) return value / 100;
  if (unit.startsWith('mm')) return value / 1000;
  return value;
}

/**
 * Refit calibration to a new known length while keeping the image's anchor
 * pixel where it currently sits in the plan. Without this, changing the stated
 * length would walk the drawing across the plot.
 */
export function recalibrate(
  current: Calibration | null,
  a: PixelPoint,
  b: PixelPoint,
  realMetres: number,
): Calibration | null {
  if (!current) return scaleFromLength(a, b, realMetres);
  const anchor = pixelToPlan(current, a);
  const next = scaleFromLength(a, b, realMetres, { offX: 0, offY: 0 });
  if (!next) return null;
  return { ...next, offX: anchor.x - a.px * next.scale, offY: anchor.y - a.py * next.scale };
}
/**
 * Calibration and coordinate conversion.
 *
 * These tests exist because a wrong scale produces a plan that looks entirely
 * plausible and is silently wrong. Every assertion here is against a number
 * that can be checked by hand — 100 px between two points, "4.2 m", so
 * 0.042 m/px — rather than against a golden file produced by the code itself.
 */
import { describe, expect, it } from 'vitest';
import {
  calibrateFromTwoPoints,
  fractionDistance,
  fractionToPlan,
  frameFromCalibration,
  parseLengthToMetres,
  pixelDistance,
  pixelToPlan,
  planToFraction,
  planToFrameFraction,
  planToPixel,
  recalibrate,
  scaleFromLength,
} from './calibrate.ts';
import type { Calibration } from '../model/types.ts';

const NEAR = (expect_: number, actual: number, tol = 1e-9) =>
  expect(Math.abs(expect_ - actual)).toBeLessThan(tol);

describe('pixel distance', () => {
  it('measures a straight horizontal run', () => {
    expect(pixelDistance({ px: 10, py: 40 }, { px: 110, py: 40 })).toBe(100);
  });

  it('measures a diagonal by Pythagoras', () => {
    // 3-4-5 triangle: 30 px and 40 px apart is 50 px.
    expect(pixelDistance({ px: 0, py: 0 }, { px: 30, py: 40 })).toBe(50);
  });

  it('returns null for coincident points instead of zero', () => {
    expect(pixelDistance({ px: 5, py: 5 }, { px: 5, py: 5 })).toBeNull();
  });
});

describe('scaleFromLength — one known dimension is enough', () => {
  it('derives metres-per-pixel from a single asserted length', () => {
    // 100 px apart, user says 4.2 m.
    const c = scaleFromLength({ px: 0, py: 0 }, { px: 100, py: 0 }, 4.2);
    expect(c).not.toBeNull();
    NEAR(0.042, c!.scale);
    expect(c!.confirmed).toBe(true);
    expect(c!.source.realDistance).toBe(4.2);
    expect(c!.source.pixelDistance).toBe(100);
  });

  it('keeps the placement the caller supplied', () => {
    const c = scaleFromLength({ px: 0, py: 0 }, { px: 50, py: 0 }, 5, { offX: 3, offY: 7 });
    expect(c!.offX).toBe(3);
    expect(c!.offY).toBe(7);
  });

  it('refuses to calibrate from a zero-length pixel span', () => {
    expect(scaleFromLength({ px: 4, py: 4 }, { px: 4, py: 4 }, 3)).toBeNull();
  });

  it('refuses a non-positive or non-finite real length', () => {
    expect(scaleFromLength({ px: 0, py: 0 }, { px: 10, py: 0 }, 0)).toBeNull();
    expect(scaleFromLength({ px: 0, py: 0 }, { px: 10, py: 0 }, -3)).toBeNull();
    expect(scaleFromLength({ px: 0, py: 0 }, { px: 10, py: 0 }, NaN)).toBeNull();
    // Refusing is the whole point: a division by zero is worse than no scale.
  });

  it('works on a diagonal without distorting the scale', () => {
    // 50 px diagonal, asserted 5 m => 0.1 m/px, same as a 50 px horizontal run.
    const c = scaleFromLength({ px: 0, py: 0 }, { px: 30, py: 40 }, 5);
    NEAR(0.1, c!.scale);
  });
});

describe('calibrateFromTwoPoints — pin a scan to a plot', () => {
  it('solves for scale and offset together', () => {
    // Image (0,0)→plan (2,3); image (100,0)→plan (6,3). So 100 px = 4 m.
    const c = calibrateFromTwoPoints({ px: 0, py: 0 }, { px: 100, py: 0 }, { x: 2, y: 3 }, { x: 6, y: 3 });
    expect(c).not.toBeNull();
    NEAR(0.04, c!.scale);
    NEAR(2, c!.offX);
    NEAR(3, c!.offY);
  });

  it('reproduces both anchor points exactly when the two runs are parallel', () => {
    // The case that matters: the user measures along one known wall in both
    // copies, so image and plan runs point the same way.
    const a = { px: 12, py: 40 };
    const b = { px: 312, py: 40 };
    const pa = { x: 1.5, y: 0.5 };
    const pb = { x: 9.5, y: 0.5 };
    const c = calibrateFromTwoPoints(a, b, pa, pb)!;

    const backA = pixelToPlan(c, a);
    const backB = pixelToPlan(c, b);
    NEAR(pa.x, backA.x, 1e-9);
    NEAR(pa.y, backA.y, 1e-9);
    NEAR(pb.x, backB.x, 1e-9);
    NEAR(pb.y, backB.y, 1e-9);
    expect(c.residual).toBeCloseTo(0, 9);
  });

  it('reports the residual when the two runs are not parallel', () => {
    // A uniform scale cannot honour two point correspondences whose runs point
    // different ways. Rather than silently dropping one, say how far off it is:
    // image run at 26.7°, plan run at 34.1°.
    const a = { px: 12, py: 40 };
    const b = { px: 310, py: 190 };
    const pa = { x: 1.5, y: 0.5 };
    const pb = { x: 9.25, y: 5.75 };
    const c = calibrateFromTwoPoints(a, b, pa, pb)!;

    // The first anchor is still honoured exactly — that is the guarantee.
    const backA = pixelToPlan(c, a);
    NEAR(pa.x, backA.x, 1e-9);
    NEAR(pa.y, backA.y, 1e-9);

    // The scale is still exactly the ratio of the two lengths.
    NEAR(Math.hypot(pb.x - pa.x, pb.y - pa.y) / pixelDistance(a, b)!, c.scale);

    // And the shortfall is reported, not hidden.
    expect(c.residual).toBeGreaterThan(0.5);
    const backB = pixelToPlan(c, b);
    NEAR(c.residual!, Math.hypot(backB.x - pb.x, backB.y - pb.y), 1e-9);
  });

  it('refuses when the two plan points are coincident', () => {
    expect(calibrateFromTwoPoints({ px: 0, py: 0 }, { px: 50, py: 50 }, { x: 1, y: 1 }, { x: 1, y: 1 })).toBeNull();
  });
});

describe('pixel ↔ plan conversion', () => {
  const c: Calibration = {
    scale: 0.05,
    offX: 2,
    offY: 1,
    source: { pixelDistance: 100, realDistance: 5, label: 'test' },
    confirmed: true,
  };

  it('applies scale then offset', () => {
    const p = pixelToPlan(c, { px: 100, py: 200 });
    NEAR(7, p.x);
    NEAR(11, p.y);
  });

  it('round-trips exactly through its own inverse', () => {
    const px = planToPixel(c, { x: 7, y: 11 });
    NEAR(100, px.px, 1e-9);
    NEAR(200, px.py, 1e-9);
  });

  it('preserves distances: a scale change is uniform, not anisotropic', () => {
    const p1 = { x: 3, y: 4 };
    const p2 = { x: 9, y: 4 };
    const planLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const pxLen = pixelDistance(planToPixel(c, p1), planToPixel(c, p2))!;
    NEAR(planLen, pxLen * c.scale, 1e-9);
  });

  it('normalises to fractions of the image', () => {
    // plan (7, 11) with scale 0.05 and offsets (2, 1) is pixel (100, 200).
    const f = planToFraction(c, { x: 7, y: 11 }, { width: 1000, height: 2000 });
    NEAR(0.1, f.u);
    NEAR(0.1, f.v);
  });

  it('derives the image placement rectangle from a calibration', () => {
    const frame = frameFromCalibration(c, { width: 1000, height: 2000 });
    NEAR(2, frame.x);
    NEAR(1, frame.y);
    NEAR(50, frame.width); // 1000 px × 0.05 m/px
    NEAR(100, frame.depth); // 2000 px × 0.05 m/px
  });

  it('round-trips a plan point through a fraction', () => {
    const frame = frameFromCalibration(c, { width: 1000, height: 2000 });
    const p = { x: 27, y: 51 };
    const f = planToFrameFraction(frame, p);
    const back = fractionToPlan(frame, f);
    NEAR(p.x, back.x, 1e-9);
    NEAR(p.y, back.y, 1e-9);
  });

  it('fractionDistance never mentions pixels, so a resize cannot change it', () => {
    // The image is 50 m wide and 100 m deep in plan space.
    const frame = frameFromCalibration(c, { width: 1000, height: 2000 });
    const a = { u: 0.1, v: 0.2 };
    const b = { u: 0.6, v: 0.2 };

    // Half the image width is 25 m, and the fraction says 0.5 either way.
    NEAR(25, fractionDistance(a, b, frame));

    // The whole point: read the same fractions off a 400 px thumbnail of the
    // same scan and get the same metres. A pixel-based mapping would return
    // 10 m here, because 0.5 × 400 px × 0.05 m/px is not the same distance.
    const thumbnail = frameFromCalibration(
      { ...c, scale: c.scale * 4, offX: c.offX * 4, offY: c.offY * 4 },
      { width: 250, height: 500 },
    );
    NEAR(25, fractionDistance(a, b, thumbnail));
  });
});

describe('fractionDistance', () => {
  const image = { width: 1000, height: 1000 };
  const c: Calibration = {
    scale: 0.01, // 100 px per metre
    offX: 0,
    offY: 0,
    source: { pixelDistance: 100, realDistance: 1, label: 'test' },
    confirmed: true,
  };

  it('measures in metres across the placed image', () => {
    const frame = frameFromCalibration(c, image);
    // 0→0.5 across a 10 m wide image is 5 m.
    expect(fractionDistance({ u: 0, v: 0 }, { u: 0.5, v: 0 }, frame)).toBeCloseTo(5, 9);
  });

  it('measures vertically as well as horizontally', () => {
    const frame = frameFromCalibration(c, image);
    expect(fractionDistance({ u: 0, v: 0 }, { u: 0, v: 0.5 }, frame)).toBeCloseTo(5, 9);
  });

  it('measures a diagonal by Pythagoras', () => {
    const frame = frameFromCalibration(c, image);
    expect(fractionDistance({ u: 0, v: 0 }, { u: 0.3, v: 0.4 }, frame)).toBeCloseTo(5, 9);
  });
});

describe('parseLengthToMetres', () => {
  it('reads plain metres', () => {
    expect(parseLengthToMetres('4.2')).toBeCloseTo(4.2, 9);
    expect(parseLengthToMetres('4.2 m')).toBeCloseTo(4.2, 9);
    expect(parseLengthToMetres('  12.5 metres  ')).toBeCloseTo(12.5, 9);
  });

  it('reads centimetres and millimetres', () => {
    expect(parseLengthToMetres('85 cm')).toBeCloseTo(0.85, 9);
    expect(parseLengthToMetres('450mm')).toBeCloseTo(0.45, 9);
  });

  it('reads feet and inches', () => {
    // 14 ft 1 in = 14.0833 ft = 4.2926 m
    expect(parseLengthToMetres(`14'1"`)).toBeCloseTo((14 + 1 / 12) * 0.3048, 9);
    expect(parseLengthToMetres("14' 1\"")).toBeCloseTo((14 + 1 / 12) * 0.3048, 9);
    expect(parseLengthToMetres('12ft')).toBeCloseTo(3.6576, 9);
  });

  it('accepts a comma as the decimal separator', () => {
    expect(parseLengthToMetres('4,5')).toBeCloseTo(4.5, 9);
  });

  it('returns null rather than guessing at nonsense', () => {
    expect(parseLengthToMetres('')).toBeNull();
    expect(parseLengthToMetres('about four metres')).toBeNull();
    expect(parseLengthToMetres('4.2 furlongs')).toBeNull();
  });
});

describe('recalibrate — changing the stated length must not walk the drawing', () => {
  const a = { px: 100, py: 100 };
  const b = { px: 500, py: 100 };

  it('behaves like a first calibration when there is nothing yet', () => {
    const c = recalibrate(null, a, b, 8);
    NEAR(0.02, c!.scale);
  });

  it('pins the anchor pixel where it already sits in the plan', () => {
    const first = recalibrate(null, a, b, 8)!;
    const before = pixelToPlan(first, a);

    const second = recalibrate(first, a, b, 10)!; // user corrects themselves
    const after = pixelToPlan(second, a);

    NEAR(before.x, after.x, 1e-9);
    NEAR(before.y, after.y, 1e-9);
    // The scale really did change.
    NEAR(10 / 400, second.scale);
  });

  it('returns null when the new length cannot produce a calibration', () => {
    const first = recalibrate(null, a, b, 8)!;
    expect(recalibrate(first, a, a, 5)).toBeNull();
  });
});
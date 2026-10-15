/**
 * Geometry kernel.
 *
 * Pure functions only — no React, no Three.js, no store access. Everything here
 * is deterministic and unit-tested: the 2D editor, the 3D builder, the
 * validation engine, the measurement engine and the AI tool layer all call into
 * this same module so they can never disagree about where a wall is.
 *
 * All lengths are metres, all areas square metres.
 */
import type { Opening, Rect, Vec2, Wall } from './types.ts';

export const EPS = 1e-9;

/** Geometric tolerances, in metres. Kept in one place because they matter. */
export const TOL = {
  /** Below this, two coordinates are the same point. */
  point: 0.005,
  /** Below this, a wall has no length. */
  length: 0.02,
  /** Room dimensions must exceed this to be a room. */
  dimension: 0.15,
  /** Gap allowed between adjacent wall faces before we call it a defect. */
  join: 0.02,
  /** Furniture is allowed to touch a wall, not overlap it. */
  clearance: 0.01,
  /** 2D editor snap step when the user holds a modifier. */
  snap: 0.05,
};

// ────────────────────────────────────────────────────────────────── vectors ────

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
export const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Left-hand normal of a direction, in plan space (Y down). */
export function perp(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x };
}

export function rotate(p: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);
export const round = (n: number, dp = 3): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

// ──────────────────────────────────────────────────────────────────── rects ─────

export const rect = (x: number, y: number, width: number, depth: number): Rect => ({
  x,
  y,
  width,
  depth,
});

export const rectOf = (o: { x: number; y: number; width: number; depth: number }): Rect => ({
  x: o.x,
  y: o.y,
  width: o.width,
  depth: o.depth,
});

export const rectArea = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.depth);
export const rectPerimeter = (r: Rect): number => 2 * (Math.max(0, r.width) + Math.max(0, r.depth));
export const rectCenter = (r: Rect): Vec2 => ({ x: r.x + r.width / 2, y: r.y + r.depth / 2 });

export function rectCorners(r: Rect): [Vec2, Vec2, Vec2, Vec2] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.depth },
    { x: r.x, y: r.y + r.depth },
  ];
}

export const rectContains = (r: Rect, p: Vec2, tol = TOL.point): boolean =>
  p.x >= r.x - tol &&
  p.x <= r.x + r.width + tol &&
  p.y >= r.y - tol &&
  p.y <= r.y + r.depth + tol;

/** Strict interior test used for "is this point inside a room". */
export const rectContainsStrict = (r: Rect, p: Vec2, tol = TOL.point): boolean =>
  p.x > r.x + tol && p.x < r.x + r.width - tol && p.y > r.y + tol && p.y < r.y + r.depth - tol;

export function rectContainsRect(outer: Rect, inner: Rect, tol = TOL.point): boolean {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.width <= outer.x + outer.width + tol &&
    inner.y + inner.depth <= outer.y + outer.depth + tol
  );
}

export function rectIntersects(a: Rect, b: Rect, tol = TOL.clearance): boolean {
  return (
    a.x < b.x + b.width + tol &&
    a.x + a.width > b.x - tol &&
    a.y < b.y + b.depth + tol &&
    a.y + a.depth > b.y - tol
  );
}

/** Signed overlap area of two axis-aligned rects (0 when disjoint). */
export function rectOverlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.depth, b.y + b.depth) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Overlap region of two rects, or null. */
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.depth, b.y + b.depth);
  if (x2 <= x || y2 <= y) return null;
  return rect(x, y, x2 - x, y2 - y);
}

export const expandRect = (r: Rect, d: number): Rect =>
  rect(r.x - d, r.y - d, r.width + 2 * d, r.depth + 2 * d);

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return rect(x, y, Math.max(a.x + a.width, b.x + b.width) - x, Math.max(a.y + a.depth, b.y + b.depth) - y);
}

/**
 * Where does a ray from `origin` along `dir` first enter `r`?
 * Used for drawing and for snapping interactions.
 */
export function rayRectEntry(origin: Vec2, dir: Vec2, r: Rect): Vec2 | null {
  const c = rectCorners(r);
  let best: Vec2 | null = null;
  let bestT = Infinity;
  for (let i = 0; i < 4; i++) {
    const p1 = c[i]!;
    const p2 = c[(i + 1) % 4]!;
    const hit = raySegment(origin, dir, p1, p2);
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      best = hit.point;
    }
  }
  return best;
}

/** Ray/segment intersection in 2D. Returns the hit point and distance t. */
export function raySegment(
  origin: Vec2,
  dir: Vec2,
  s1: Vec2,
  s2: Vec2,
): { point: Vec2; t: number } | null {
  const s = sub(s2, s1);
  const denom = cross(dir, s);
  if (Math.abs(denom) < EPS) return null;
  const qp = sub(s1, origin);
  const t = cross(qp, s) / denom;
  const u = cross(qp, dir) / denom;
  if (t < 0 || u < 0 || u > 1) return null;
  return { point: add(origin, scale(dir, t)), t };
}

/** Distance from point `p` to segment `a`-`b`. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return dist(p, a);
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return dist(p, add(a, scale(ab, t)));
}

// ────────────────────────────────────────────────────────────── polygons ───────

/** Shoelace area; sign follows the winding order. */
export function polygonArea(pts: Vec2[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j]!.x + pts[i]!.x) * (pts[j]!.y - pts[i]!.y);
  }
  return a / 2;
}

export const polygonPerimeter = (pts: Vec2[]): number => {
  let p = 0;
  for (let i = 0; i < pts.length; i++) p += dist(pts[i]!, pts[(i + 1) % pts.length]!);
  return p;
};

export const pointInPolygon = (p: Vec2, pts: Vec2[]): boolean => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

export function convexHull(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return [...pts];
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const crossZ = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && crossZ(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ───────────────────────────────────────────────────────── oriented boxes ─────

/** An oriented rectangle: centre, half-extents, rotation in degrees. */
export interface OBB {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  deg: number;
}

export function obbOfRect(r: Rect): OBB {
  return { cx: r.x + r.width / 2, cy: r.y + r.depth / 2, hw: r.width / 2, hh: r.depth / 2, deg: 0 };
}

/** An OBB from a furniture-style item (centre position, rotation). */
export function obbOfItem(i: {
  x: number;
  y: number;
  width: number;
  depth: number;
  rotation: number;
}): OBB {
  return { cx: i.x, cy: i.y, hw: i.width / 2, hh: i.depth / 2, deg: i.rotation };
}

function obbAxes(o: OBB): [Vec2, Vec2] {
  const r = (o.deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [{ x: c, y: s }, { x: -s, y: c }];
}

export function obbCorners(o: OBB): Vec2[] {
  const [ax, ay] = obbAxes(o);
  const cx = ax.x * o.hw;
  const cy = ax.y * o.hw;
  const dx = ay.x * o.hh;
  const dy = ay.y * o.hh;
  return [
    { x: o.cx - cx - dx, y: o.cy - cy - dy },
    { x: o.cx + cx - dx, y: o.cy + cy - dy },
    { x: o.cx + cx + dx, y: o.cy + cy + dy },
    { x: o.cx - cx + dx, y: o.cy - cy + dy },
  ];
}

/**
 * Separating-Axis test for two oriented rectangles. The minimum-overlap axis
 * is returned so callers can distinguish "barely touching" from "deeply
 * overlapping" — useful for distinguishing a door brushing a wall from a
 * wardrobe sitting inside one.
 */
export function obbOverlap(
  a: OBB,
  b: OBB,
): { overlap: boolean; minOverlap: number; axis: Vec2 } {
  const axes = [...obbAxes(a), ...obbAxes(b)];
  const ca = obbCorners(a);
  const cb = obbCorners(b);
  let minOverlap = Infinity;
  let minAxis: Vec2 = { x: 1, y: 0 };

  for (const axis of axes) {
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const p of ca) {
      const pr = dot(p, axis);
      if (pr < a0) a0 = pr;
      if (pr > a1) a1 = pr;
    }
    for (const p of cb) {
      const pr = dot(p, axis);
      if (pr < b0) b0 = pr;
      if (pr > b1) b1 = pr;
    }
    const ov = Math.min(a1, b1) - Math.max(a0, b0);
    if (ov <= 0) return { overlap: false, minOverlap: 0, axis };
    if (ov < minOverlap) {
      minOverlap = ov;
      minAxis = axis;
    }
  }
  return { overlap: true, minOverlap, axis: minAxis };
}

/**
 * Exact axis-aligned bounding box of the intersection of two OBBs, or null.
 *
 * Cheap approximation of the true shared region — good enough for highlighting
 * and for bounding-box containment tests, and unlike a SAT slab it never
 * reports a region that does not actually touch.
 */
export function obbAabbIntersection(a: OBB, b: OBB): Rect | null {
  const aa = aabbOfObb(a);
  const ab = aabbOfObb(b);
  return rectIntersection(aa, ab);
}

/** The world-aligned bounding box of an oriented box. */
export function aabbOfObb(o: OBB): Rect {
  const c = obbCorners(o);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return rect(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
}

/**
 * The ground area a furniture item actually covers.
 *
 * An item stores its UNROTATED width and depth plus a rotation, so measuring
 * it as `x ± width/2, y ± depth/2` reports the wrong rectangle the moment it is
 * turned — a bathtub rotated to stand against a side wall would be checked as
 * 1.70 m wide when it is really 0.75 m across. Every collision and clearance
 * check must go through here.
 */
export function footprintOfItem(i: {
  x: number;
  y: number;
  width: number;
  depth: number;
  rotation: number;
}): Rect {
  return aabbOfObb(obbOfItem(i));
}

// ─────────────────────────────────────────────────────────────────── walls ─────

export interface WallFrame {
  /** Unit direction a -> b. */
  dir: Vec2;
  /** Unit normal, left of dir. */
  normal: Vec2;
  length: number;
  /** Start and end of the wall's rectangular footprint. */
  corners: [Vec2, Vec2, Vec2, Vec2];
}

export function wallFrame(wall: Wall): WallFrame {
  const d = sub(wall.b, wall.a);
  const length = len(d);
  const dir = length < EPS ? { x: 1, y: 0 } : scale(d, 1 / length);
  const normal = perp(dir);
  const h = wall.thickness / 2;
  return {
    dir,
    normal,
    length,
    corners: [
      add(wall.a, scale(normal, h)),
      add(wall.b, scale(normal, h)),
      add(wall.b, scale(normal, -h)),
      add(wall.a, scale(normal, -h)),
    ],
  };
}

export const wallMid = (w: Wall): Vec2 => mid(w.a, w.b);

/** Centreline length of a wall, in metres. */
export const wallLength = (w: Wall): number => len(sub(w.b, w.a));

/** The wall's rectangular footprint in plan coordinates. */
export function wallFootprint(w: Wall): Rect {
  const f = wallFrame(w);
  const xs = f.corners.map((c) => c.x);
  const ys = f.corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return rect(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
}

/** The wall as an OBB, for collision against furniture and other walls. */
export function wallOBB(w: Wall): OBB {
  const f = wallFrame(w);
  const deg = (Math.atan2(f.dir.y, f.dir.x) * 180) / Math.PI;
  return { cx: (w.a.x + w.b.x) / 2, cy: (w.a.y + w.b.y) / 2, hw: f.length / 2, hh: w.thickness / 2, deg };
}

/** Point at `t` metres along the wall centreline from point a. */
export function wallPointAt(w: Wall, t: number): Vec2 {
  const f = wallFrame(w);
  return add(w.a, scale(f.dir, clamp(t, 0, f.length)));
}

/** Footprint of a single opening, in plan coordinates. */
export function openingFootprint(w: Wall, o: Opening): Rect {
  const f = wallFrame(w);
  const half = o.width / 2;
  const c = add(w.a, scale(f.dir, o.offset));
  const pts = [
    add(add(c, scale(f.dir, -half)), scale(f.normal, w.thickness / 2)),
    add(add(c, scale(f.dir, half)), scale(f.normal, w.thickness / 2)),
    add(add(c, scale(f.dir, half)), scale(f.normal, -w.thickness / 2)),
    add(add(c, scale(f.dir, -half)), scale(f.normal, -w.thickness / 2)),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return rect(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
}

/** Do two wall centreline spans overlap along their shared direction? */
export function segmentsOverlap(a: Wall, b: Wall): boolean {
  const horizontalA = Math.abs(a.b.y - a.a.y) < Math.abs(a.b.x - a.a.x);
  const horizontalB = Math.abs(b.b.y - b.a.y) < Math.abs(b.b.x - b.a.x);
  if (horizontalA !== horizontalB) return false;
  const lo = (w: Wall) => Math.min(horizontalA ? w.a.x : w.a.y, horizontalA ? w.b.x : w.b.y);
  const hi = (w: Wall) => Math.max(horizontalA ? w.a.x : w.a.y, horizontalA ? w.b.x : w.b.y);
  return lo(a) < hi(b) - TOL.join && lo(b) < hi(a) - TOL.join;
}

/**
 * How much two rooms share an edge, in metres. Rooms are axis-aligned, so a
 * shared edge is a shared span on one of the four sides.
 */
export function sharedEdgeLength(
  a: { x: number; y: number; width: number; depth: number },
  b: { x: number; y: number; width: number; depth: number },
): number {
  const aRight = a.x + a.width;
  const bRight = b.x + b.width;
  const aBottom = a.y + a.depth;
  const bBottom = b.y + b.depth;
  const xOverlap = Math.min(aRight, bRight) - Math.max(a.x, b.x);
  const yOverlap = Math.min(aBottom, bBottom) - Math.max(a.y, b.y);
  const touchV = Math.abs(aRight - b.x) < TOL.join || Math.abs(bRight - a.x) < TOL.join;
  const touchH = Math.abs(aBottom - b.y) < TOL.join || Math.abs(bBottom - a.y) < TOL.join;
  if (touchV && yOverlap > TOL.join) return yOverlap;
  if (touchH && xOverlap > TOL.join) return xOverlap;
  return 0;
}

/** Which side of `wall` does a room sit on? +1 left, -1 right, 0 on the line. */
export function roomSideOfWall(
  room: { x: number; y: number; width: number; depth: number },
  w: Wall,
): -1 | 0 | 1 {
  const f = wallFrame(w);
  const c = rectCenter(rectOf(room));
  const d = dot(sub(c, w.a), f.normal);
  const h = w.thickness / 2;
  if (d > h + TOL.join) return 1;
  if (d < -h - TOL.join) return -1;
  return 0;
}

// ──────────────────────────────────────────────────────── door swing ──────────

/**
 * The three points that draw a door in plan, plus its arc radius.
 *
 * Split out of `doorSwingPolygon` because the two consumers want different
 * things from the same geometry: collision wants a convex hull, while the 2D
 * canvas wants to draw a leaf line and a quarter-circle sweep — and a hull
 * would throw both away, leaving the door as a filled blob on the drawing.
 */
export interface DoorLeaf {
  /** The jamb the leaf is fixed to. */
  hinge: Vec2;
  /** The other jamb: where the leaf's free end sits when closed. */
  far: Vec2;
  /** Where the free end sits when the door is open 90°. */
  openEnd: Vec2;
  /** Sweep midpoint at 45°, so an arc drawn through it bulges correctly. */
  arcMid: Vec2;
  /** Leaf length, which is also the sweep radius. */
  radius: number;
  /**
   * Which way round the sweep goes, as an SVG arc `sweep-flag`.
   *
   * The flag is derived rather than guessed: SVG y grows downwards, the same
   * way plan y does, so the sign of the cross product of (closed → open)
   * carries straight over. Getting this backwards draws the arc the long way
   * round, through the wall.
   */
  sweep: 0 | 1;
}

export function doorLeaf(wall: Wall, o: Opening): DoorLeaf {
  const f = wallFrame(wall);
  const side = o.swing === 'negative' ? -1 : 1;
  const hingeSign = o.hinge === 'end' ? 1 : -1;
  const half = o.width / 2;
  const centre = add(wall.a, scale(f.dir, o.offset));
  const hinge = add(centre, scale(f.dir, half * hingeSign));
  const leaf = o.width;
  // Closed leaf: hinge -> far jamb, lying in the wall plane.
  const far = add(hinge, scale(f.dir, -half * 2 * hingeSign));
  // Open leaf: hinge -> swung 90° into the room.
  const openDir = scale(scale(f.normal, side), -hingeSign);
  const openEnd = add(hinge, scale(openDir, leaf));
  const arcMid = add(hinge, scale(norm(add(scale(f.dir, -hingeSign), openDir)), leaf * Math.SQRT1_2));
  const turning = cross(sub(far, hinge), sub(openEnd, hinge));
  return { hinge, far, openEnd, arcMid, radius: leaf, sweep: turning < 0 ? 0 : 1 };
}

/**
 * Door swing geometry.
 *
 * A door sweeps a quarter-disc of radius = leaf width, hinged at one end of the
 * opening, opening into the room on the given side. The swept region is
 * approximated by the convex hull of (hinge, far jamb, arc midpoint at 45°,
 * fully-open jamb) — conservative by construction, so a door reported as
 * "may be blocked" is a prompt to look, never a false promise of clearance.
 */
export function doorSwingPolygon(w: Wall, o: Opening): Vec2[] {
  const leaf = doorLeaf(w, o);
  return convexHull([leaf.hinge, leaf.far, leaf.arcMid, leaf.openEnd]);
}

/** Separating-axis test between a convex polygon and an oriented rectangle. */
export function polygonObbOverlap(poly: Vec2[], o: OBB): boolean {
  if (poly.length < 3) return false;
  const boxPts = obbCorners(o);
  const axes: Vec2[] = [...obbAxes(o)];
  for (let i = 0; i < poly.length; i++) {
    axes.push(norm(sub(poly[(i + 1) % poly.length]!, poly[i]!)));
  }
  for (const axis of axes) {
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const p of poly) {
      const d = dot(p, axis);
      if (d < pMin) pMin = d;
      if (d > pMax) pMax = d;
    }
    let rMin = Infinity;
    let rMax = -Infinity;
    for (const p of boxPts) {
      const d = dot(p, axis);
      if (d < rMin) rMin = d;
      if (d > rMax) rMax = d;
    }
    if (Math.min(pMax, rMax) - Math.max(pMin, rMin) <= 0) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────── utilities ───────

/** Convert metres to the user's display unit. */
export function toDisplay(metres: number, units: 'm' | 'ft'): number {
  return units === 'ft' ? metres * 3.280839895 : metres;
}

export function formatLength(metres: number, units: 'm' | 'ft', dp = 2): string {
  if (units === 'm') return `${metres.toFixed(dp)} m`;
  const totalInches = metres * 39.3700787;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - feet * 12);
  if (inches === 12) return `${feet + 1}' 0"`;
  return `${feet}' ${inches}"`;
}

export function formatArea(sqm: number, units: 'm' | 'ft'): string {
  if (units === 'm') return `${sqm.toFixed(1)} m²`;
  return `${(sqm * 10.7639).toFixed(0)} ft²`;
}

/** Snap a coordinate to a grid step. */
export const snapTo = (n: number, step: number = TOL.snap): number => Math.round(n / step) * step;
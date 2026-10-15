/**
 * First-person camera collision.
 *
 * A walk-through where the camera passes through walls is worse than no
 * walk-through, so the camera is a circle of radius `CAMERA_RADIUS` that is
 * pushed out of every collider it overlaps. The test is circle-vs-rect on the
 * XZ plane, which is exact for axis-aligned boxes and cheap enough to run on
 * every frame.
 *
 * Resolution is per-axis rather than "push out along the shortest vector",
 * because per-axis is what makes sliding along a wall feel right: you approach
 * a wall at an angle, you do not stop dead, you travel along it.
 */
import type { Collider } from './sceneModel.ts';

/** Radius of the camera's "body" in metres — roughly shoulder width. */
export const CAMERA_RADIUS = 0.26;

/** Eye height above the floor the camera stands on, in metres. */
export const EYE_HEIGHT = 1.62;

export interface MoveResult {
  x: number;
  z: number;
  /** Colliders the camera is currently pressed against. */
  touching: boolean;
}

/** Closest point on a rect to (x, z), in the rect's local frame. */
function clampToRect(x: number, z: number, c: Collider): { x: number; z: number } {
  return {
    x: Math.max(c.x - c.w / 2, Math.min(c.x + c.w / 2, x)),
    z: Math.max(c.z - c.d / 2, Math.min(c.z + c.d / 2, z)),
  };
}

export function overlapsCollider(x: number, z: number, c: Collider, radius: number): boolean {
  const nearest = clampToRect(x, z, c);
  const dx = x - nearest.x;
  const dz = z - nearest.z;
  return dx * dx + dz * dz < radius * radius;
}

/**
 * The span along one axis that a camera of `radius` may not occupy, given where
 * it sits on the *other* axis.
 *
 * The forbidden set is a rectangle grown by a disc, which is not a rectangle.
 * Growing it by a square instead is simpler but wrong in the corners: it both
 * freezes the camera a few centimetres early when you hug a wall diagonally and
 * reports contact that does not exist. Since a move along x is a straight line
 * at a fixed z, slicing the true forbidden set at that z gives an exact
 * interval, so that is what is computed here — `h` is the disc radius reduced
 * by how far off-centre the camera already is on the other axis.
 */
function forbiddenSpan(
  centre: number,
  halfExtent: number,
  lateral: number,
  radius: number,
): { lo: number; hi: number } | null {
  if (Math.abs(lateral) >= radius) return null; // clear of the collider entirely
  const h = Math.sqrt(radius * radius - lateral * lateral);
  return { lo: centre - halfExtent - h, hi: centre + halfExtent + h };
}

/** A collider re-expressed along whichever axis the current pass resolves. */
interface AxisCollider {
  centre: number;
  halfExtent: number;
  /** Signed gap to the camera on the *other* axis; set before each pass. */
  lateral: number;
  /** The collider this was derived from, for the full 2-D circle test. */
  source: Collider;
}

interface AxisResult {
  value: number;
  touching: boolean;
}

/**
 * Signed gap between coordinate `v` and the collider's span
 * [`lo`, `hi`]: 0 inside, positive beyond the far end, negative before it.
 */
function gapFrom(v: number, lo: number, hi: number): number {
  return Math.max(lo - v, v - hi, 0);
}

/**
 * Resolve one axis against every collider, clamping to the nearest face.
 *
 * `other` is the camera's coordinate on the perpendicular axis — constant for
 * this pass — and is needed because the span alone cannot tell a camera that is
 * stuck *inside* a wall from one that is merely grazing a corner.
 */
function resolveAxis(
  from: number,
  delta: number,
  other: number,
  active: AxisCollider[],
  radius: number,
): AxisResult {
  if (delta === 0) return { value: from, touching: false };
  const target = from + delta;
  let allowed = target;
  let touching = false;

  for (const c of active) {
    const span = forbiddenSpan(c.centre, c.halfExtent, c.lateral, radius);
    if (!span) continue;
    const { lo, hi } = span;
    // A straight move either ends inside the interval or crosses it — there is
    // no third way, so this single test is also the swept test. Checking only
    // the destination would let any step longer than a wall tunnel straight
    // through it, which is exactly what this module exists to prevent.
    if (Math.min(from, target) >= hi || Math.max(from, target) <= lo) continue;
    touching = true;
    if (from >= lo && from <= hi && overlapsCollider(from, other, c.source, radius)) {
      // Genuinely penetrating, not just grazing the corner: carry on out the far
      // side rather than snapping back the way we came, which would fight a
      // wall the camera is pressed against. This cannot escape a solid thicker
      // than the step.
      allowed = delta > 0 ? Math.min(hi, target) : Math.max(lo, target);
    } else {
      allowed = delta > 0 ? lo : hi;
    }
  }
  return { value: allowed, touching };
}

/**
 * Move from (x, z) by (dx, dz), sliding along colliders.
 *
 * Each axis is resolved independently, which is what produces wall-sliding
 * instead of sticking. `filter` lets the caller ignore colliders on a floor the
 * camera is not on — otherwise you could not walk under a first-floor slab or
 * through a first-floor wall while standing on the ground floor.
 */
export function moveWithCollision(
  x: number,
  z: number,
  dx: number,
  dz: number,
  colliders: Collider[],
  radius: number = CAMERA_RADIUS,
  filter?: (c: Collider) => boolean,
): MoveResult {
  const active = filter ? colliders.filter(filter) : colliders;

  const alongX: AxisCollider[] = active.map((c) => ({
    centre: c.x,
    halfExtent: c.w / 2,
    lateral: gapFrom(z, c.z - c.d / 2, c.z + c.d / 2),
    source: c,
  }));
  const alongZ: AxisCollider[] = active.map((c) => ({
    centre: c.z,
    halfExtent: c.d / 2,
    lateral: 0, // filled in below, against the *resolved* x
    source: c,
  }));

  const rx = resolveAxis(x, dx, z, alongX, radius);
  const nx = rx.value;

  for (let i = 0; i < alongZ.length; i++) {
    const c = active[i]!;
    alongZ[i]!.lateral = gapFrom(nx, c.x - c.w / 2, c.x + c.w / 2);
  }
  const rz = resolveAxis(z, dz, nx, alongZ, radius);

  return { x: nx, z: rz.value, touching: rx.touching || rz.touching };
}

/**
 * Nudge a camera onto a walkable surface — upwards only.
 *
 * The rule is deliberately one-directional: a surface counts only if it is at
 * or just above the camera (within 25 cm), and the highest such surface wins.
 * The camera is never moved *down* to a surface. That asymmetry is the point —
 * pressing "down" on a landing must not drop the camera through the floor to
 * the storey below, and starting a walk must not shove the camera up onto a
 * slab a metre overhead. Returning `fromY` unchanged when nothing qualifies is
 * a valid and safe answer.
 */
export function snapToFloor(fromY: number, candidates: Array<{ y: number; x: number; z: number; w: number; d: number }>): number {
  let best = fromY;
  for (const c of candidates) {
    if (fromY < c.y - 0.25) continue;
    if (c.y < best - 0.25) continue;
    if (c.y > best) best = c.y;
  }
  return best;
}

/** Walkable surfaces: every room slab plus every stair tread. */
export function walkableSurfaces(
  boxes: Array<{ y: number; x: number; z: number; w: number; d: number; h: number; kind: string }>,
): Array<{ y: number; x: number; z: number; w: number; d: number }> {
  return boxes
    .filter((b) => b.kind === 'room-slab' || b.kind === 'slab' || b.kind === 'stair' || b.kind === 'deck')
    .map((b) => ({ y: b.y + b.h / 2, x: b.x, z: b.z, w: b.w, d: b.d }));
}

/**
 * Keep the camera inside the plot.
 *
 * Walking off the edge of the world is disorienting; clamping to the buildable
 * envelope means the user is always looking at something.
 *
 * `verge` widens that envelope by a margin outside the plot boundary. It exists
 * because the walk camera *starts* on the pavement outside the front door: with
 * no verge, the very first `useFrame` clamped that start position back inside
 * the plot — a 3 m teleport that landed the camera inside the front wall, which
 * is why walking in showed a wall at point-blank range.
 */
export function clampToPlot(
  x: number,
  z: number,
  plot: { width: number; depth: number },
  margin = 0.5,
  verge = 0,
): { x: number; z: number } {
  const halfW = plot.width / 2 - margin + verge;
  const halfD = plot.depth / 2 - margin + verge;
  return {
    x: Math.max(-halfW, Math.min(halfW, x)),
    z: Math.max(-halfD, Math.min(halfD, z)),
  };
}

/** How far outside the plot the walk camera may stand, in metres. */
export const WALK_VERGE = 11;

/**
 * How far back to stand to see something `width` wide in a viewport of the
 * given shape.
 *
 * The 3D viewport is taller than it is wide, so its *horizontal* field of view
 * is much the smaller of the two. Framing off a fixed distance — which is what
 * `plot.depth / 2 + 2.4` was — put the camera 3.5 m from an 11 m facade in a
 * viewport that can only see 3.4 m of it at that range, so "walk mode" opened
 * on one window at point-blank range.
 */
export function standBackDistance(width: number, height: number, aspect: number, fovDeg: number): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.2, aspect));
  // The wide axis governs, and the building is seen at three-quarters, so its
  // diagonal is what has to fit — not its width head-on.
  const span = Math.max(width, height * 1.6);
  return span / (2 * Math.tan(hFov / 2));
}

/**
 * Where the walk camera starts: on the pavement, back from the street elevation,
 * looking at the house.
 *
 * Computed from the geometry rather than from the plot, because "in front of
 * the building" and "halfway across the plot" are not the same place — on a
 * plot with a deep front setback the second is inside the house. The returned
 * position is then stepped back until it is provably clear of every collider,
 * because a start point that is *probably* outside a wall is the same bug one
 * wall-thickness away from happening again.
 *
 * `street` is the compass direction the front door faces, so "front" means the
 * side a visitor arrives from. Taking the largest z unconditionally — which is
 * what this used to do — put the camera at the *back* of the house whenever the
 * street ran the other way: staring at a blank rear wall, in shadow, since the
 * sun is placed over the street.
 */
export function walkStart(
  building: { minX: number; maxX: number; minZ: number; maxZ: number; width: number; height: number },
  plot: { width: number; depth: number },
  colliders: Collider[],
  radius = CAMERA_RADIUS,
  aspect = 1.6,
  fovDeg = 68,
  street: { x: number; z: number } = { x: 0, z: 1 },
): { x: number; z: number } {
  // The street bearing is a compass direction off an axis-aligned plan, so it
  // is one of ±x/±z and projecting a box onto it is exact rather than a bound.
  const ax = street.x;
  const az = street.z;

  let front = -Infinity;
  for (const c of colliders) {
    front = Math.max(front, ax * c.x + az * c.z + Math.abs(ax) * (c.w / 2) + Math.abs(az) * (c.d / 2));
  }
  if (!Number.isFinite(front)) {
    front = ax > 0 ? building.maxX : ax < 0 ? building.minX : az > 0 ? building.maxZ : building.minZ;
  }

  // Bounded so a wide plot does not push the camera to the horizon and a narrow
  // one does not jam it against the front door. The margin is what stops the
  // house from touching both edges of the frame — at the exact fit distance it
  // fills the viewport edge to edge and reads as a wall, not as a building.
  const back = Math.min(26, Math.max(3.5, standBackDistance(building.width, building.height, aspect, fovDeg) * 1.18));
  const cx = (building.minX + building.maxX) / 2;
  const cz = (building.minZ + building.maxZ) / 2;
  const offset = front - (ax * cx + az * cz) + back;

  let x = cx + ax * offset;
  let z = cz + az * offset;

  const clamped = clampToPlot(x, z, plot, 0.5, WALK_VERGE);
  x = clamped.x;
  z = clamped.z;

  // If that still lands inside something, retreat. Every step moves further out
  // along the street bearing and the frontmost collider's face is the last thing
  // on that side, so this terminates one radius clear of it at worst.
  for (let i = 0; i < 40 && colliders.some((c) => overlapsCollider(x, z, c, radius)); i++) {
    x += ax * 0.25;
    z += az * 0.25;
  }
  return { x, z };
}

/** Compass heading in radians from a yaw angle in degrees. */
export const headingFromYaw = (yawDeg: number): number => (yawDeg * Math.PI) / 180;

// ─────────────────────────────────────────────────────── interior viewpoint ────

/**
 * Plan→world mapping, as `frameFor` produces it. Declared structurally rather
 * than imported so the placement maths stays testable without the scene model.
 */
export interface PlanFrame {
  tx: (x: number) => number;
  tz: (y: number) => number;
}

/** The parts of a `Room` that placement needs. Structural, for the same reason. */
export interface RoomRect {
  id: string;
  label: string;
  floorId: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  height?: number;
  outdoor?: boolean;
}

/** Where to stand in a room, and where to point. */
export interface InteriorViewpoint {
  x: number;
  y: number;
  z: number;
  /** Yaw in degrees; 0 looks along −Z, which is also the walk camera's zero. */
  yaw: number;
  /** Pitch in degrees, positive looking up — this *is* `camera.rotation.x`. */
  pitch: number;
}

/** Room kinds never used as somewhere to stand and look. */
const NOT_A_VIEWPOINT = new Set(['balcony', 'terrace', 'garage']);

/**
 * Room kinds that make a good first view, best first.
 *
 * A viewer opening the inside of a house wants somewhere with furniture and
 * windows, so the choice is not "biggest room" — on a generated plan that is
 * reliably the living room, but on a hand-edited one it can be the garage or
 * the hall. Ranking by kind first and area second makes the default stable
 * without making it wrong.
 */
const PREFERRED_VIEWS = ['living', 'dining', 'kitchen', 'office', 'guest', 'bedroom', 'lobby'];

/** The footprint of a room in world space. */
export function roomFootprint(
  room: RoomRect,
  frame: PlanFrame,
): { minX: number; maxX: number; minZ: number; maxZ: number; cx: number; cz: number } {
  const minX = frame.tx(room.x);
  const maxX = frame.tx(room.x + room.width);
  const minZ = frame.tz(room.y);
  const maxZ = frame.tz(room.y + room.depth);
  return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

/**
 * Whether a room is one you can stand in.
 *
 * `outdoor` covers decks and terraces, which have a footprint and a label but
 * no walls — walking the viewpoint into one would put the camera on an open
 * slab looking at a wall that is not there.
 */
export function canViewFromInside(room: RoomRect): boolean {
  return !room.outdoor && !NOT_A_VIEWPOINT.has(room.kind) && room.width > 0.6 && room.depth > 0.6;
}

/**
 * The floors that can be stood on, lowest first.
 *
 * `order` is the storey number; without it the ids sort among themselves, which
 * keeps the answer deterministic but not physically meaningful.
 */
function standableFloors(rooms: RoomRect[], order?: Map<string, number>): string[] {
  const ids = [...new Set(rooms.filter(canViewFromInside).map((r) => r.floorId))];
  return ids.sort((a, b) => {
    const oa = order?.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ob = order?.get(b) ?? Number.MAX_SAFE_INTEGER;
    return oa - ob || a.localeCompare(b);
  });
}

/**
 * The lowest floor there is anywhere to stand on.
 *
 * Lowest, not largest. You walk into a house at ground level, so opening the
 * inside view three storeys up is the wrong answer even when the upper floor
 * has more floor area — which it can, on a house with a small open-plan ground
 * floor and a full set of bedrooms above.
 */
export function principalFloorId(rooms: RoomRect[], order?: Map<string, number>): string | null {
  return standableFloors(rooms, order)[0] ?? null;
}

/**
 * Which room to open the inside view on.
 *
 * The lowest floor that has a room worth opening on, and within it the
 * best-ranked kind — so a house whose ground floor is a garage and a hallway
 * opens upstairs, where the bedrooms are, instead of on an empty hall.
 *
 * Ranking by kind before area matters because "biggest room" is not "best
 * room": on a generated plan it is usually the living room, but on a
 * hand-edited one it is just as likely to be the store cupboard. If no floor
 * has a ranked kind at all, the largest room on the lowest standable floor is
 * still a defensible answer, and beats showing nothing.
 */
export function defaultInteriorRoom(rooms: RoomRect[], order?: Map<string, number>): RoomRect | null {
  const byFloor = new Map<string, RoomRect[]>();
  for (const r of rooms) {
    if (!canViewFromInside(r)) continue;
    const list = byFloor.get(r.floorId);
    if (list) list.push(r);
    else byFloor.set(r.floorId, [r]);
  }

  let fallback: RoomRect | null = null;
  for (const floorId of standableFloors(rooms, order)) {
    const onFloor = byFloor.get(floorId)!;
    if (!fallback) {
      fallback = onFloor.reduce((a, b) => (b.width * b.depth > a.width * a.depth ? b : a));
    }
    let best: RoomRect | null = null;
    let bestRank = PREFERRED_VIEWS.length;
    for (const r of onFloor) {
      const rank = PREFERRED_VIEWS.indexOf(r.kind);
      if (rank === -1) continue;
      const area = r.width * r.depth;
      if (!best || rank < bestRank || (rank === bestRank && area > best.width * best.depth)) {
        best = r;
        bestRank = rank;
      }
    }
    if (best) return best;
  }
  return fallback;
}

/**
 * Where the camera stands and looks, in a room.
 *
 * **In a corner, looking at the opposite one.** That is how a room is
 * photographed, and the reason is worth stating because the obvious
 * alternative is much worse: stand in the middle of the room and look at the
 * far wall, and in a room under about six metres the frame is filled edge to
 * edge by one flat plane — you learn the room's width and nothing else. From
 * the corner, both side walls sweep back to a vanishing point, the floor and
 * ceiling give the depth, and the furniture between is spread across the shot
 * rather than stacked in the middle of it.
 *
 * (Standing on the *long axis* of a narrow room is the other valid framing,
 * and it is what you would do in a corridor. For a room that is roughly as
 * wide as it is deep it is strictly worse, because the wall you face is flat
 * and close, so it is not what this does.)
 *
 * The corner chosen is the one furthest from the middle of the building, so
 * you look inward: an outside wall behind you, the heart of the house ahead.
 *
 * Candidates are tried in order and the first clear of every collider is taken,
 * because the spot you would like is frequently occupied — a sofa in the corner
 * is normal furniture, not a mistake in the plan. Falling back through the
 * other corners, then points part-way in, then the middle, means a tight or
 * cluttered room still gets a view instead of a camera inside a wall.
 *
 * The aim point is below eye height on purpose. Aiming level frames a band of
 * blank wall; aiming a little down puts the floor, the furniture standing on
 * it, and the bottom of the windows in the same shot.
 */
export function roomViewpoint(
  room: RoomRect,
  frame: PlanFrame,
  opts: {
    elevation?: number;
    buildingCentre?: { x: number; z: number };
    colliders?: Collider[];
    radius?: number;
    eyeHeight?: number;
  } = {},
): InteriorViewpoint {
  const radius = opts.radius ?? CAMERA_RADIUS;
  const eye = opts.eyeHeight ?? EYE_HEIGHT;
  const elevation = opts.elevation ?? 0;
  const { minX, maxX, minZ, maxZ, cx, cz } = roomFootprint(room, frame);
  const bc = opts.buildingCentre ?? { x: cx, z: cz };

  // Stand off each wall by the camera's own radius plus the wall's half
  // thickness — room rectangles are drawn to the wall *centreline*, so the
  // inner face is already a little way inside the rectangle.
  const inset = radius + 0.18;
  // Too small to hold the camera anywhere but the middle.
  const fits = maxX - minX > 2 * inset + 0.5 && maxZ - minZ > 2 * inset + 0.5;

  const corners: Array<[number, number]> = fits
    ? (
        [
          [maxX - inset, maxZ - inset],
          [maxX - inset, minZ + inset],
          [minX + inset, maxZ - inset],
          [minX + inset, minZ + inset],
        ] as Array<[number, number]>
      ).sort(
        (a, b) => Math.hypot(b[0] - bc.x, b[1] - bc.z) - Math.hypot(a[0] - bc.x, a[1] - bc.z),
      )
    : [];

  type Shot = { at: [number, number] };
  const shots: Shot[] = corners.map((at) => ({ at }));
  if (fits) {
    // Part-way in from each corner, for a room whose corners are all occupied.
    for (const [x, z] of corners) {
      shots.push({ at: [x + (cx - x) * 0.55, z + (cz - z) * 0.55] });
      shots.push({ at: [x + (cx - x) * 0.25, z + (cz - z) * 0.25] });
    }
  }
  shots.push({ at: [cx, cz] });

  const clear = (x: number, z: number) =>
    !opts.colliders?.some((c) => overlapsCollider(x, z, c, radius));
  const [x, z] = shots.find((s) => clear(s.at[0], s.at[1]))?.at ?? [cx, cz]!;

  const y = elevation + eye;
  const aimY = y - Math.max(0.12, Math.min(0.34, (room.height ?? 2.7) * 0.09));
  const dx = cx - x;
  const dy = aimY - y;
  const dz = cz - z;
  const len = Math.hypot(dx, dy, dz) || 1;

  return {
    x,
    y,
    z,
    // The camera looks down its local −Z, so yaw is `atan2(-dx, -dz)`, and
    // pitch is the rotation about X that puts `dy/len` into the forward vector.
    yaw: (Math.atan2(-dx, -dz) * 180) / Math.PI,
    pitch: (Math.asin(Math.max(-1, Math.min(1, dy / len))) * 180) / Math.PI,
  };
}

/**
 * Which room a world point is in.
 *
 * The smallest match wins: a plan may legitimately overlap rooms (the checks
 * report it when it happens, and a room placed over another still has to be
 * clickable), and the inner one is the one you are actually standing in.
 */
export function roomAt(
  x: number,
  z: number,
  rooms: RoomRect[],
  frame: PlanFrame,
  floorId?: string,
): RoomRect | null {
  let best: RoomRect | null = null;
  let bestArea = Infinity;
  for (const r of rooms) {
    if (floorId && r.floorId !== floorId) continue;
    const f = roomFootprint(r, frame);
    if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
    const area = r.width * r.depth;
    if (area < bestArea) {
      best = r;
      bestArea = area;
    }
  }
  return best;
}

/** Pitch beyond which the view is looking at the ceiling or the floor. */
export const PITCH_LIMIT = (86 * Math.PI) / 180;

/** Radians per pixel of pointer drag. */
export const LOOK_SENSITIVITY = 0.0032;

/** Look up or down, in radians per second, on Q and E. */
export const TURN_RATE = 1.9;

/**
 * Shortest signed difference between two angles, in degrees.
 *
 * Used to interpolate a flight's yaw: flying from 179° to −179° is a two-degree
 * turn, not a three-hundred-and-fifty-eight-degree one.
 */
export function shortestAngle(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}
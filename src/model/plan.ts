/**
 * The wall planner.
 *
 * Rooms are the authored facts. Walls, openings, stairs and furniture are
 * DERIVED from room adjacency by this module. That is the single architectural
 * idea that lets Argon stay consistent: there is no way for a plan to have a
 * room with no walls, or a wall that bounds nothing, because both are computed
 * from the same rectangle set every time the plan is replanned.
 *
 * Pipeline:
 *   1. rooms            → exterior boundary (union outline, notches preserved)
 *   2. room pairs       → interior partitions along every shared edge span
 *   3. entrance         → one exterior door, on the street-facing side
 *   4. boundary segments→ windows, spaced along each outside wall
 *   5. partitions       → interior doors and openings
 *   6. furniture        → one sensible starting piece per room
 *
 * Everything here is deterministic and side-effect free.
 */
import { DEFAULT_ROOM_AREA, FLOOR_MATERIAL_BY_KIND, KIND_LABEL, OPENING_DEFAULTS, WALL_THICKNESS, catalogById } from './catalog.ts';
import { newId } from './ids.ts';
import { GOING, RISER } from './ops.ts';
import { TOL, doorSwingPolygon, footprintOfItem, obbOfItem, polygonObbOverlap, rectOf, rectOverlapArea } from './geometry.ts';
import type {
  DesignBrief,
  Floor,
  FurnitureItem,
  Id,
  Opening,
  Orientation,
  Plot,
  Room,
  RoomKind,
  Staircase,
  Vec2,
  Wall,
  Rect,
} from './types.ts';

// ─────────────────────────────────────────────────── boundary tracing ────────

/** A straight run of the outer boundary of a set of axis-aligned rectangles. */
export interface BoundarySegment {
  a: { x: number; y: number };
  b: { x: number; y: number };
  /** Which plot side this faces: -1 left, 1 right, -2 top, 2 bottom. */
  facing: -1 | 1 | -2 | 2;
}

/**
 * Trace the outline of the union of axis-aligned rectangles.
 *
 * Method: every rectangle contributes four edges. An edge span that another
 * rectangle lies flush against is interior and is subtracted. What survives is
 * the union boundary — including notches and L-shapes, which a bounding box
 * would swallow.
 */
export function boundarySegments(rooms: Room[]): BoundarySegment[] {
  type Edge = {
    owner: Room;
    fixed: number;
    from: number;
    to: number;
    axis: 'x' | 'y';
    facing: -1 | 1 | -2 | 2;
  };
  const edges: Edge[] = [];

  for (const r of rooms) {
    edges.push({ owner: r, fixed: r.y, from: r.x, to: r.x + r.width, axis: 'y', facing: -2 });
    edges.push({ owner: r, fixed: r.y + r.depth, from: r.x, to: r.x + r.width, axis: 'y', facing: 2 });
    edges.push({ owner: r, fixed: r.x, from: r.y, to: r.y + r.depth, axis: 'x', facing: -1 });
    edges.push({ owner: r, fixed: r.x + r.width, from: r.y, to: r.y + r.depth, axis: 'x', facing: 1 });
  }

  const out: BoundarySegment[] = [];

  for (const e of edges) {
    // Spans of this edge cancelled by the facing side of ANOTHER room.
    const covers: Array<[number, number]> = [];
    for (const o of rooms) {
      if (o === e.owner) continue;
      const r = rectOf(o);
      if (e.axis === 'y') {
        const atTop = Math.abs(r.y - e.fixed) < TOL.join;
        const atBottom = Math.abs(r.y + r.depth - e.fixed) < TOL.join;
        if (!atTop && !atBottom) continue;
        // Only an opposite-facing, flush neighbour cancels this edge.
        const opposing = atTop ? r.y + r.depth - e.fixed : r.y - e.fixed;
        if (Math.abs(opposing) < TOL.join) continue;
        const overlap = [Math.max(r.x, e.from), Math.min(r.x + r.width, e.to)];
        if (overlap[1] - overlap[0] > TOL.join) covers.push(overlap as [number, number]);
      } else {
        const atLeft = Math.abs(r.x - e.fixed) < TOL.join;
        const atRight = Math.abs(r.x + r.width - e.fixed) < TOL.join;
        if (!atLeft && !atRight) continue;
        const opposing = atLeft ? r.x + r.width - e.fixed : r.x - e.fixed;
        if (Math.abs(opposing) < TOL.join) continue;
        const overlap = [Math.max(r.y, e.from), Math.min(r.y + r.depth, e.to)];
        if (overlap[1] - overlap[0] > TOL.join) covers.push(overlap as [number, number]);
      }
    }
    covers.sort((p, q) => p[0] - q[0]);

    let cursor = e.from;
    const emit = (from: number, to: number) => {
      if (to - from <= TOL.length) return;
      out.push(
        e.axis === 'y'
          ? { a: { x: from, y: e.fixed }, b: { x: to, y: e.fixed }, facing: e.facing }
          : { a: { x: e.fixed, y: from }, b: { x: e.fixed, y: to }, facing: e.facing },
      );
    };
    for (const [s, t] of covers) {
      if (s - cursor > TOL.length) emit(cursor, s);
      cursor = Math.max(cursor, t);
    }
    emit(cursor, e.to);
  }

  return out.filter((s) => Math.abs(s.a.x - s.b.x) > TOL.length || Math.abs(s.a.y - s.b.y) > TOL.length);
}

/** Total length of the union boundary. */
export const boundaryLength = (segs: BoundarySegment[]): number =>
  segs.reduce((s, seg) => s + Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y), 0);

// ────────────────────────────────────────────────────────────── orientation ────

/**
 * Which plot edge faces the street, given the plot orientation.
 * 0 → north (top edge), 90 → east (right), 180 → south (bottom), 270 → west (left).
 */
export function frontEdges(orientation: Orientation): Array<BoundarySegment['facing']> {
  switch (orientation) {
    case 0: return [-2];
    case 90: return [1];
    case 180: return [2];
    case 270: return [-1];
  }
}

export function sideName(facing: BoundarySegment['facing']): string {
  return facing === -2 ? 'front (north)' : facing === 2 ? 'rear (south)' : facing === -1 ? 'left (west)' : 'right (east)';
}

// ────────────────────────────────────────────────────────────── the planner ────

export interface PlanOptions {
  plot: Plot;
  floor: Floor;
  rooms: Room[];
  /** Which room gets the front door. Default: the living room, else the first. */
  entranceRoomId?: Id | null;
  /** Furnish each room with a starting arrangement. */
  furnish?: boolean;
}

export interface PlannedFloor {
  walls: Wall[];
  furniture: FurnitureItem[];
}

/**
 * How much exterior wall one window serves.
 *
 * Windows are spaced along a wall rather than budgeted across the floor: the
 * budget version handed every short wall a fraction of a window, which rounds
 * down to none — a whole plan can come out of it with no glazing at all and no
 * error to say so. A frequency is also what a house actually looks like.
 */
const WALL_PER_WINDOW = 3.0;

/** Which walls of a room an item prefers, best first. */
type Side = 'n' | 's' | 'e' | 'w';

/** Sofas and tables want the longest run, then whatever is left. */
const LIVING_WALLS: readonly Side[] = ['n', 'w', 'e', 's'];
/** Beds and tubs look for a wall that is not the door's. */
const BED_WALLS: readonly Side[] = ['n', 's', 'w', 'e'];

/** Rooms that read as part of the living space rather than as separate cells. */
const OPEN_PLAN: ReadonlySet<RoomKind> = new Set(['kitchen', 'dining', 'living', 'office', 'hall', 'lobby']);

function segmentLength(s: BoundarySegment): number {
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}

function doorForRooms(kindA: RoomKind, kindB: RoomKind): { kind: Opening['kind']; spec: { width: number; height: number } } | null {
  const servicePair =
    (kindA === 'bathroom' && ['bedroom', 'corridor', 'hall', 'guest'].includes(kindB)) ||
    (kindB === 'bathroom' && ['bedroom', 'corridor', 'hall', 'guest'].includes(kindA));
  if (servicePair) return { kind: 'door', spec: OPENING_DEFAULTS.bathroomDoor };

  const bothOpen = OPEN_PLAN.has(kindA) && OPEN_PLAN.has(kindB);
  if (bothOpen) return { kind: 'opening', spec: { width: 1.5, height: 2.2 } };

  return { kind: 'door', spec: OPENING_DEFAULTS.interiorDoor };
}

export function planFloor(opts: PlanOptions): PlannedFloor {
  const { plot, floor } = opts;
  const rooms = opts.rooms;
  const walls: Wall[] = [];
  const furniture: FurnitureItem[] = [];
  const wallHeight = floor.height;

  if (rooms.length === 0) return { walls, furniture };

  // ── 1. exterior boundary ────────────────────────────────────────────────
  const indoor = rooms.filter((r) => !r.outdoor);
  const boundary = boundarySegments(rooms);
  const front = frontEdges(plot.orientation);

  const exteriorWallBySegment = new Map<BoundarySegment, Wall>();

  for (const seg of boundary) {
    const wall: Wall = {
      id: newId('wl'),
      floorId: floor.id,
      type: 'exterior',
      a: { ...seg.a },
      b: { ...seg.b },
      thickness: WALL_THICKNESS.exterior,
      height: wallHeight,
      roomIds: [],
      openings: [],
      material: 'exterior.render',
    };
    walls.push(wall);
    exteriorWallBySegment.set(seg, wall);
  }

  // ── 2. interior partitions ──────────────────────────────────────────────
  interface Partition {
    wall: Wall;
    rooms: [Room, Room];
    span: number;
  }
  const partitions: Partition[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i]!;
      const b = rooms[j]!;
      if (a.floorId !== b.floorId) continue;
      const key = [a.id, b.id].sort().join('|');
      if (seenPairs.has(key)) continue;

      const ra = rectOf(a);
      const rb = rectOf(b);

      // Shared horizontal edge (a above b, or b above a).
      const horizTouch =
        Math.abs(ra.y + ra.depth - rb.y) < TOL.join || Math.abs(rb.y + rb.depth - ra.y) < TOL.join;
      if (horizTouch) {
        const x0 = Math.max(ra.x, rb.x);
        const x1 = Math.min(ra.x + ra.width, rb.x + rb.width);
        if (x1 - x0 > TOL.length) {
          seenPairs.add(key);
          const y = Math.abs(ra.y + ra.depth - rb.y) < TOL.join ? ra.y + ra.depth : rb.y + rb.depth;
          partitions.push({
            wall: makeWall(floor.id, 'interior', { x: x0, y }, { x: x1, y }, wallHeight),
            rooms: [a, b],
            span: x1 - x0,
          });
        }
        continue;
      }

      const vertTouch =
        Math.abs(ra.x + ra.width - rb.x) < TOL.join || Math.abs(rb.x + rb.width - ra.x) < TOL.join;
      if (vertTouch) {
        const y0 = Math.max(ra.y, rb.y);
        const y1 = Math.min(ra.y + ra.depth, rb.y + rb.depth);
        if (y1 - y0 > TOL.length) {
          seenPairs.add(key);
          const x = Math.abs(ra.x + ra.width - rb.x) < TOL.join ? ra.x + ra.width : rb.x + rb.width;
          partitions.push({
            wall: makeWall(floor.id, 'interior', { x, y: y0 }, { x, y: y1 }, wallHeight),
            rooms: [a, b],
            span: y1 - y0,
          });
        }
      }
    }
  }
  walls.push(...partitions.map((p) => p.wall));

  // ── 3. the entrance ────────────────────────────────────────────────────
  // Placed BEFORE the windows. The door is a given and the glazing is not: a
  // house with no way in is not a house, while a house with one fewer window
  // is only slightly darker. Windows are then laid out around it.
  //
  // The centre of the wall is preferred, because that is where a front door
  // wants to be; the validator flags the plan if nothing is free at all.
  const entranceRoom =
    (opts.entranceRoomId && rooms.find((r) => r.id === opts.entranceRoomId)) ||
    indoor.find((r) => r.isEntrance) ||
    indoor.find((r) => r.kind === 'lobby') ||
    indoor.find((r) => r.kind === 'hall') ||
    indoor.find((r) => r.kind === 'living') ||
    indoor[0];

  if (entranceRoom && floor.order === 0) {
    const frontSegs = boundary.filter((s) => front.includes(s.facing));
    const roomSegs = frontSegs.filter((s) => segmentTouchesRoom(s, entranceRoom));
    const ranked = (roomSegs.length ? roomSegs : frontSegs)
      .filter((s) => segmentLength(s) > 1.6)
      .sort((a, b) => segmentLength(b) - segmentLength(a));
    for (const seg of ranked) {
      const wall = exteriorWallBySegment.get(seg);
      if (!wall) continue;
      const L = segmentLength(seg);
      const width = Math.min(OPENING_DEFAULTS.entranceDoor.width, L - 0.4);
      if (width <= 0.8) continue;

      const taken = openingsOn(wall, L);
      const free = freeCentres(L, width, taken);
      const mid = free.find((c) => Math.abs(c - L / 2) < width / 2) ?? free[0];
      if (mid === undefined) continue;

      wall.openings.push({
        id: newId('op'),
        kind: 'door',
        offset: mid,
        width,
        height: OPENING_DEFAULTS.entranceDoor.height,
        sill: 0,
        hinge: 'start',
        material: 'door.timber',
      });
      break;
    }
  }

  // ── 4. windows on the boundary ──────────────────────────────────────────
  // Each boundary wall is bounded by exactly one room (reindex computes this).
  for (const seg of boundary) {
    const wall = exteriorWallBySegment.get(seg);
    if (!wall) continue;
    const L = segmentLength(seg);
    if (L < 1.2) continue;

    // One window per stretch of wall, never zero.
    let count = Math.min(4, Math.max(1, Math.round(L / WALL_PER_WINDOW)));
    // A service room gets a smaller opening; a living room gets more.
    const bounded = indoor.find(
      (r) =>
        Math.abs(r.y - seg.a.y) < TOL.join ||
        Math.abs(r.y + r.depth - seg.a.y) < TOL.join ||
        Math.abs(r.x - seg.a.x) < TOL.join ||
        Math.abs(r.x + r.width - seg.a.x) < TOL.join,
    );
    if (bounded && ['bathroom', 'utility', 'storage', 'pantry', 'garage'].includes(bounded.kind)) {
      count = Math.min(count, 1);
    }

    const width = Math.min(1.9, Math.max(0.9, (L - 0.5) / count - 0.3));
    // Take the first free runs along the wall rather than fixed stations, so a
    // window can never land on top of an opening placed earlier (the front
    // door, most often).
    const taken = openingsOn(wall, L);
    const slots = freeCentres(L, width, taken).slice(0, count);
    for (const offset of slots) {
      wall.openings.push({
        id: newId('op'),
        kind: 'window',
        offset,
        width,
        height: 1.4,
        sill: 0.9,
        material: 'glass.clear',
      });
    }
  }

  // ── 5. interior doors and openings ──────────────────────────────────────
  for (const p of partitions) {
    const [a, b] = p.rooms;
    const rule = doorForRooms(a.kind, b.kind);
    if (!rule) continue;
    const L = p.span;
    const width = Math.min(rule.spec.width, L - 0.4);
    if (width < 0.6) continue;
    p.wall.openings.push({
      id: newId('op'),
      kind: rule.kind,
      offset: L / 2,
      width,
      height: rule.spec.height,
      sill: 0,
      hinge: 'start',
      // Swing into the corridor / circulation side where there is one.
      swing: a.kind === 'corridor' || b.kind === 'corridor' ? 'negative' : 'positive',
    });
  }

  // ── 6. a sensible starting arrangement ──────────────────────────────────
  if (opts.furnish !== false) {
    furniture.push(...furnishFloor(rooms, floor.id, walls));
  }

  return { walls, furniture };
}

// ────────────────────────────────────────────────────── opening placement ────

/** The spans already occupied on a wall, as [start, end] along its centreline. */
function openingsOn(wall: Wall, length: number): Array<[number, number]> {
  return wall.openings
    .map((o): [number, number] => [
      Math.max(0, o.offset - o.width / 2),
      Math.min(length, o.offset + o.width / 2),
    ])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Centres at which an opening of `width` fits on a wall of length `length`
 * without touching `taken` and without running off either end.
 *
 * Real openings need a jamb, so every gap is trimmed by `pad` on each side.
 * Returning the centre of each surviving gap means callers can prefer the
 * middle of a wall and fall back to whatever room is left.
 */
function freeCentres(length: number, width: number, taken: Array<[number, number]>): number[] {
  const pad = 0.15;
  const spans: Array<[number, number]> = [];
  let cursor = pad;
  for (const [s, e] of taken) {
    if (s - cursor >= width) spans.push([cursor, s - pad]);
    cursor = Math.max(cursor, e + pad);
  }
  if (length - pad - cursor >= width) spans.push([cursor, length - pad]);
  return spans.map(([a, b]) => (a + b) / 2);
}

function makeWall(floorId: Id, type: Wall['type'], a: { x: number; y: number }, b: { x: number; y: number }, height: number): Wall {
  return {
    id: newId('wl'),
    floorId,
    type,
    a,
    b,
    thickness: WALL_THICKNESS[type] ?? WALL_THICKNESS.interior,
    height,
    roomIds: [],
    openings: [],
    material: type === 'exterior' ? 'exterior.render' : 'interior.partition',
  };
}

function segmentTouchesRoom(s: BoundarySegment, r: Room): boolean {
  const rr = rectOf(r);
  const x0 = Math.min(s.a.x, s.b.x);
  const x1 = Math.max(s.a.x, s.b.x);
  const y0 = Math.min(s.a.y, s.b.y);
  const y1 = Math.max(s.a.y, s.b.y);
  const touches =
    (Math.abs(s.a.y - s.b.y) < TOL.length && Math.abs(s.a.y - rr.y) < TOL.join) ||
    (Math.abs(s.a.y - s.b.y) < TOL.length && Math.abs(s.a.y - (rr.y + rr.depth)) < TOL.join) ||
    (Math.abs(s.a.x - s.b.x) < TOL.length && Math.abs(s.a.x - rr.x) < TOL.join) ||
    (Math.abs(s.a.x - s.b.x) < TOL.length && Math.abs(s.a.x - (rr.x + rr.width)) < TOL.join);
  if (!touches) return false;
  return x1 > rr.x - TOL.join && x0 < rr.x + rr.width + TOL.join && y1 > rr.y - TOL.join && y0 < rr.y + rr.depth + TOL.join;
}

// ──────────────────────────────────────────────────────────── furnishing ─────

/**
 * Place one or two sensible items per room, pushed against a wall with their
 * back to it. This is a starting point for the user to change, not a claim
 * about design quality.
 */
export function furnishFloor(rooms: Room[], floorId: Id, walls: Wall[] = []): FurnitureItem[] {
  const out: FurnitureItem[] = [];

  /**
   * The floor area each door sweeps, keyed by the room it opens into.
   *
   * A door is not a hole in a wall, it is a quarter-disc of floor nobody may
   * put a sofa in. The validator already reports furniture blocking a swing,
   * but a warning the app generates on its own first load is a warning the
   * user has to clear before they have touched anything — so the furnisher
   * keeps clear of the swings it is given rather than parking a bathtub in
   * one and calling it a starting arrangement.
   *
   * The swing belongs to the room on its open side, found by testing the
   * polygon's centroid: it is inside the hull by construction and always on
   * the same side of the wall as the leaf.
   */
  const swingsByRoom = new Map<Id, Vec2[][]>();
  for (const w of walls) {
    for (const o of w.openings) {
      if (o.kind !== 'door' && o.kind !== 'doorway') continue;
      const poly = doorSwingPolygon(w, o);
      if (poly.length < 3) continue;
      const mid = poly.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
      const cx = mid.x / poly.length;
      const cy = mid.y / poly.length;
      const room = rooms.find((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.depth);
      if (!room) continue;
      const list = swingsByRoom.get(room.id);
      if (list) list.push(poly);
      else swingsByRoom.set(room.id, [poly]);
    }
  }

  /**
   * The usable rectangle inside a room.
   *
   * A wall's centreline lies ON the room's edge, not on its inner face, so a
   * room rectangle is the *structural* outline: half of each bounding wall's
   * thickness projects into the space. Furniture has to be kept out of that
   * band or the validator — correctly — reports it as embedded in a wall.
   */
  const insetCache = new Map<Id, Rect>();
  const innerRect = (room: Room): Rect => {
    const cached = insetCache.get(room.id);
    if (cached) return cached;
    const ins = { n: 0, s: 0, w: 0, e: 0 };
    for (const w of walls) {
      const horiz = Math.abs(w.b.y - w.a.y) < Math.abs(w.b.x - w.a.x);
      const lo = horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
      const hi = horiz ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y);
      // Does this wall actually run along any part of the room's edge?
      const edgeLo = horiz ? room.x : room.y;
      const edgeHi = horiz ? room.x + room.width : room.y + room.depth;
      if (hi <= edgeLo + TOL.join || lo >= edgeHi - TOL.join) continue;
      const pos = horiz ? (w.a.y + w.b.y) / 2 : (w.a.x + w.b.x) / 2;
      const half = w.thickness / 2 + 0.02;
      if (horiz) {
        if (Math.abs(pos - room.y) <= TOL.join) ins.n = Math.max(ins.n, half);
        if (Math.abs(pos - (room.y + room.depth)) <= TOL.join) ins.s = Math.max(ins.s, half);
      } else {
        if (Math.abs(pos - room.x) <= TOL.join) ins.w = Math.max(ins.w, half);
        if (Math.abs(pos - (room.x + room.width)) <= TOL.join) ins.e = Math.max(ins.e, half);
      }
    }
    const box: Rect = {
      x: room.x + ins.w,
      y: room.y + ins.n,
      width: Math.max(0, room.width - ins.w - ins.e),
      depth: Math.max(0, room.depth - ins.n - ins.s),
    };
    insetCache.set(room.id, box);
    return box;
  };

  /**
   * Place an item by its CENTRE point, refusing to place it when the result
   * would be wrong. Two guards, both non-negotiable:
   *
   *  - it must sit entirely inside the room's USABLE rectangle;
   *  - it must not overlap something already placed in that room.
   *
   * Anything that fails is dropped rather than clamped into a wall, because a
   * validator that flags our own furniture would make the generated plan look
   * broken on first load — and the user would be right.
   */
  const push = (room: Room, catalogId: string, x: number, y: number, rotation = 0): boolean => {
    const c = catalogById.get(catalogId);
    if (!c) return false;
    // A quarter turn swaps the footprint's axes.
    const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    const fw = quarter ? c.depth : c.width;
    const fd = quarter ? c.width : c.depth;

    const inner = innerRect(room);
    const minX = inner.x + fw / 2;
    const maxX = inner.x + inner.width - fw / 2;
    const minY = inner.y + fd / 2;
    const maxY = inner.y + inner.depth - fd / 2;
    if (minX > maxX || minY > maxY) return false; // does not fit at all

    const px = Math.min(maxX, Math.max(minX, x));
    const py = Math.min(maxY, Math.max(minY, y));
    const box = { x: px - fw / 2, y: py - fd / 2, width: fw, depth: fd };

    for (const other of out) {
      if (other.roomId !== room.id) continue;
      const ob = footprintOfItem(other);
      if (rectOverlapArea(box, ob) > 0.0005) return false;
    }

    // And the door swings that open into this room.
    const swings = swingsByRoom.get(room.id);
    if (swings) {
      // The item's own width/depth with the rotation, exactly as it is stored
      // and as the validator will read it back. Passing the already-swapped
      // footprint here would apply the quarter turn twice, and a sofa would be
      // tested against a mirror image of itself.
      const obb = obbOfItem({ x: px, y: py, width: c.width, depth: c.depth, rotation });
      for (const swing of swings) if (polygonObbOverlap(swing, obb)) return false;
    }

    out.push({
      id: newId('fu'),
      floorId,
      roomId: room.id,
      catalogId: c.id,
      label: c.label,
      x: px,
      y: py,
      width: c.width,
      depth: c.depth,
      height: c.height,
      rotation,
      color: c.color,
    });
    return true;
  };

  /**
   * Place an item with its back to a wall, trying each wall in turn.
   *
   * The first wall is the preferred one — the bed goes to the north wall, the
   * sofa wherever it has the longest run. The rest are the fallbacks, and they
   * exist because a living room in a generated plan can have four doors opening
   * into it: once a wall is claimed by a swing, the piece slides along it, and
   * once the whole wall is claimed, the piece moves to the next one. Giving up
   * on the room entirely is the one outcome worth avoiding.
   */
  const against = (room: Room, catalogId: string, sides: Side | readonly Side[]) => {
    for (const side of typeof sides === 'string' ? [sides] : sides) {
      const c = catalogById.get(catalogId);
      if (!c) return;
      const cx = room.x + room.width / 2;
      const cy = room.y + room.depth / 2;
      // Rotate so the item's back (its -Z face) points at the wall.
      const rot = side === 'n' ? 180 : side === 's' ? 0 : side === 'w' ? 90 : 270;
      const inner = innerRect(room);
      // Position for "back to the wall": the item's depth runs inward from it.
      const backGap = 0.06;
      const x =
        side === 'w'
          ? inner.x + backGap + c.depth / 2
          : side === 'e'
            ? inner.x + inner.width - backGap - c.depth / 2
            : cx;
      const y =
        side === 'n'
          ? inner.y + backGap + c.depth / 2
          : side === 's'
            ? inner.y + inner.depth - backGap - c.depth / 2
            : cy;

      const vertical = side === 'w' || side === 'e';
      for (const slide of [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65, 2.2, -2.2]) {
        if (push(room, catalogId, vertical ? x : x + slide, vertical ? y + slide : y, rot)) return;
      }
    }
  };

  for (const room of rooms) {
    switch (room.kind) {
      case 'living': {
        if (room.width >= 3.4 && room.depth >= 3.4) against(room, 'sofa-3', LIVING_WALLS);
        else if (room.width >= 2.2) against(room, 'sofa-2', LIVING_WALLS);
        else if (room.depth >= 2.4) against(room, 'sofa-2', LIVING_WALLS);
        const sofa = out.find((f) => f.roomId === room.id);
        if (sofa) push(room, 'coffee-table', sofa.x, sofa.y + sofa.depth / 2 + 0.6);
        break;
      }
      case 'dining':
        if (room.width >= 1.5 && room.depth >= 1.5) against(room, 'dining-table', LIVING_WALLS);
        break;
      case 'kitchen': {
        const wide = room.width >= room.depth;
        against(room, 'kitchen-run', wide ? ['n', 'w', 's', 'e'] : ['w', 'n', 's', 'e']);
        if (room.width >= 2.6 && room.depth >= 2.6) against(room, 'fridge', ['w', 'e', 'n', 's']);
        break;
      }
      case 'bedroom': {
        const big = room.width >= 3.3 && room.depth >= 3.3;
        against(room, big ? 'bed-queen' : 'bed-double', BED_WALLS);
        const bed = out.filter((f) => f.roomId === room.id).pop();
        if (bed) {
          const night = catalogById.get('nightstand')!;
          push(room, 'nightstand', bed.x - bed.width / 2 - night.width / 2 - 0.1, bed.y);
        }
        if (room.width >= 3.0) against(room, 'wardrobe', ['w', 'e', 'n', 's']);
        break;
      }
      case 'guest':
        against(room, 'bed-single', BED_WALLS);
        break;
      case 'bathroom': {
        if (room.width >= 1.7 && room.depth >= 1.9) {
          against(room, 'bathtub', room.width >= room.depth ? BED_WALLS : ['w', 'n', 'e', 's']);
        }
        against(room, 'wc', ['e', 'w', 'n', 's']);
        against(room, 'basin', ['s', 'n', 'e', 'w']);
        break;
      }
      case 'office':
        if (room.width >= 1.8) against(room, 'desk', ['w', 'n', 'e', 's']);
        break;
      case 'utility':
        if (room.width >= 1.2 && room.depth >= 1.2) against(room, 'washing-machine', BED_WALLS);
        break;
      default:
        break;
    }
  }

  return out;
}

// ────────────────────────────────────────────────────────────── stairs ───────

/**
 * Place a staircase in a free rectangular gap on a floor, sized to the storey
 * height. Returns null when there is nowhere sensible to put it, which the
 * validation engine then reports rather than guessing.
 *
 * `targetRooms` are the rooms on the floor being arrived at. A gap whose landing
 * falls inside one of them puts the stair into that room; without the preference
 * the largest gap wins, which on a typical plan drops the stair head into a
 * bathroom and leaves the corridor to be reached the long way round.
 */
export function placeStair(
  rooms: Room[],
  freeSpace: Array<{ x: number; y: number; width: number; depth: number }>,
  floor: Floor,
  target: Floor,
  targetRooms: Room[] = [],
): Staircase | null {
  void rooms;
  const rise = Math.abs(target.elevation - floor.elevation);
  if (rise <= 0.2) return null;
  const riserCount = Math.max(8, Math.round(rise / RISER));
  const run = riserCount * GOING;

  const landsIn = (f: { x: number; y: number; width: number; depth: number }) =>
    targetRooms.find(
      (r) => f.x + f.width / 2 >= r.x && f.x + f.width / 2 <= r.x + r.width && f.y + f.depth / 2 >= r.y && f.y + f.depth / 2 <= r.y + r.depth,
    );

  // Prefer a gap in a private (upper-floor) context, big enough for the run,
  // and among those prefer one that arrives somewhere usable upstairs.
  const usable = freeSpace.filter((f) => f.width >= 1.1 && f.depth >= run - 0.4);
  const candidates = [...usable].sort((a, b) => {
    const la = landsIn(a) ? 0 : 1;
    const lb = landsIn(b) ? 0 : 1;
    if (la !== lb) return la - lb;
    return b.width * b.depth - a.width * a.depth;
  });

  const spot = candidates[0];
  if (!spot) return null;

  const vertical = spot.depth >= spot.width;
  return {
    id: newId('st'),
    floorId: floor.id,
    name: `${floor.name} → ${target.name}`,
    x: spot.x + spot.width / 2,
    y: spot.y + (vertical ? run / 2 : spot.depth / 2),
    width: Math.min(1.4, spot.width - 0.2),
    run,
    riserCount,
    direction: 1,
    connectsToFloorId: target.id,
    voidWidth: Math.min(1.4, spot.width - 0.2),
    voidDepth: Math.min(run, spot.depth - 0.2),
    topAtStart: true,
  };
}

// ───────────────────────────────────────────────────── brief → room list ─────

export interface BriefRoomSpec {
  kind: RoomKind;
  count: number;
  targetArea: number;
}

/** Expand a brief into a concrete list of rooms with target areas. */
export function expandBrief(brief: DesignBrief): BriefRoomSpec[] {
  const specs: BriefRoomSpec[] = [];

  for (const entry of brief.rooms) {
    const per = entry.targetArea ?? brief.preferredAreas[entry.kind] ?? DEFAULT_ROOM_AREA[entry.kind];
    if (per <= 0) continue;
    for (let i = 0; i < entry.count; i++) {
      specs.push({ kind: entry.kind, count: 1, targetArea: per });
    }
  }

  // A house always needs a way in.
  if (!specs.some((s) => s.kind === 'living')) specs.unshift({ kind: 'living', count: 1, targetArea: DEFAULT_ROOM_AREA.living });

  return specs;
}

export { KIND_LABEL, FLOOR_MATERIAL_BY_KIND };
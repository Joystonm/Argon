/**
 * Circulation analysis.
 *
 * Answers the question a floor plan really has to answer: *can a person get
 * from the front door to every room?*
 *
 * The model is a small directed graph:
 *   - one node per room, plus one "OUTSIDE" node
 *   - an edge between two rooms when a door/doorway opening in a shared wall
 *     joins them
 *   - an edge between the entrance room and OUTSIDE when an exterior wall
 *     carries a door
 *
 * Reachability is a breadth-first search from OUTSIDE. Rooms that are not
 * reached are disconnected; rooms reached only through another unreachable
 * room are still disconnected. That is the whole algorithm — no geometry
 * heuristics, so the answer is reproducible and explainable.
 */
import { TOL, openingFootprint, rectIntersects, rectOf, wallFootprint } from './geometry.ts';
import type { Id, Project, Room, Wall } from './types.ts';

export const OUTSIDE = '__outside__';

export interface CirculationEdge {
  from: string;
  to: string;
  openingId: Id;
  kind: 'door' | 'doorway' | 'opening' | 'exterior';
}

export interface CirculationGraph {
  nodes: string[];
  edges: CirculationEdge[];
  /** Room ids reachable from OUTSIDE. */
  reachable: Set<Id>;
  /** Room ids with no path from OUTSIDE. */
  unreachable: Set<Id>;
  /** Room ids with no door at all on any of their walls. */
  doorless: Set<Id>;
  /** True when at least one exterior door exists. */
  hasEntrance: boolean;
  /**
   * Rooms that start the reachability search on this floor: OUTSIDE's first
   * room on the ground floor, or the rooms a staircase arrives in above it.
   * Empty on a floor nothing reaches — `floor_disconnected` reports that.
   */
  entries: Set<Id>;
}

/** Rooms that do not need a door (open decks) are excluded from reachability. */
const NEEDS_ACCESS: ReadonlySet<string> = new Set([
  'living',
  'dining',
  'kitchen',
  'bedroom',
  'bathroom',
  'utility',
  'office',
  'guest',
  'prayer',
  'storage',
  'pantry',
  'garage',
]);

/**
 * Which rooms an opening joins.
 *
 * `roomIds` says a wall *bounds* those rooms; it does not say which side of the
 * wall each one sits on. Deciding by count instead is not hypothetical: an
 * exterior wall drawn straight across a row of rooms bounds every one of them,
 * so counting turns the front door into an interior door and leaves the building
 * with no way in at all.
 *
 * The real geometry is lateral. A wall is a line; rooms lie on one side of it or
 * the other, and stepping through a gap in it takes you from one side to the
 * other. So each room's centre is signed off the wall's centreline, and the
 * opening joins the nearest room on the positive side to the nearest room on the
 * negative one. Whichever side has no room is the outside — which is exactly
 * what a door in an exterior wall means.
 *
 * Where several rooms lie on the same side — a row of rooms along one long
 * exterior wall — the one whose extent along the wall actually contains the
 * opening is the one you pass through, so that is what decides.
 */
function sidesOfOpening(wall: Wall, opening: { offset: number; width: number }, rooms: Room[]): { left: Id; right: Id } {
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { left: OUTSIDE, right: OUTSIDE };
  const ux = dx / len;
  const uy = dy / len;

  const start = opening.offset - opening.width / 2;
  const end = opening.offset + opening.width / 2;

  let pos: { id: Id; score: number } | null = null;
  let neg: { id: Id; score: number } | null = null;

  for (const r of rooms) {
    if (!wall.roomIds.includes(r.id)) continue;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.depth / 2;
    const along = (cx - wall.a.x) * ux + (cy - wall.a.y) * uy;
    const lateral = -(cx - wall.a.x) * uy + (cy - wall.a.y) * ux;

    // Only rooms actually touching this wall participate; a room that shares the
    // id list through some other wall must not be placed on this one.
    if (Math.abs(lateral) > Math.max(r.width, r.depth) / 2 + wall.thickness) continue;
    if (Math.abs(lateral) < 1e-6) continue; // centre on the wall: not a side

    // How far this room falls from the opening along the wall. Zero when the
    // opening lies within the room's own extent, which is the common case.
    const extent = Math.max(r.width, r.depth) / 2;
    const score = along < start ? start - along : along > end ? along - end : 0;
    // Guard against a room far along the wall but sharing the id list.
    if (score > extent + wall.thickness) continue;

    const slot = lateral > 0 ? 'pos' : 'neg';
    const current = slot === 'pos' ? pos : neg;
    if (!current || score < current.score) {
      const next = { id: r.id, score };
      if (slot === 'pos') pos = next;
      else neg = next;
    }
  }

  return { left: neg?.id ?? OUTSIDE, right: pos?.id ?? OUTSIDE };
}

export function buildCirculation(project: Project, floorId: Id): CirculationGraph {
  const nodes: string[] = [OUTSIDE];
  const edges: CirculationEdge[] = [];
  const rooms = project.rooms.filter((r) => r.floorId === floorId);
  const walls = project.walls.filter((w) => w.floorId === floorId);

  for (const r of rooms) nodes.push(r.id);

  let hasEntrance = false;

  for (const wall of walls) {
    for (const opening of wall.openings) {
      const passable = opening.kind === 'door' || opening.kind === 'doorway' || opening.kind === 'opening';
      if (!passable) continue;

      const { left, right } = sidesOfOpening(wall, opening, rooms);
      // An opening with nothing on either side connects nothing.
      if (left === OUTSIDE && right === OUTSIDE) continue;

      const k: CirculationEdge['kind'] =
        opening.kind === 'window' ? 'opening' : left === OUTSIDE || right === OUTSIDE ? 'exterior' : opening.kind;
      edges.push({ from: left, to: right, openingId: opening.id, kind: k });
      edges.push({ from: right, to: left, openingId: opening.id, kind: k });

      // A door you could walk in through is an entrance. That is true whether
      // it is the only room on the wall or one of a row of rooms.
      if (opening.kind === 'door' || opening.kind === 'doorway') {
        if ((left === OUTSIDE && right !== OUTSIDE) || (right === OUTSIDE && left !== OUTSIDE)) hasEntrance = true;
      }
    }
  }

  // Rooms with no way in. This asks the graph rather than the walls: "does
  // some wall bounding this room carry a non-window opening" is true of every
  // room along a shared frontage once the neighbour's front door is in, which
  // would clear all of them at once. A cased `opening` counts as a way in — it
  // is a real walk-through gap, only without a leaf.
  const connected = new Set<Id>();
  for (const e of edges) {
    if (e.to !== OUTSIDE) connected.add(e.to);
    if (e.from !== OUTSIDE) connected.add(e.from);
  }
  const doorless = new Set<Id>(rooms.filter((r) => NEEDS_ACCESS.has(r.kind) && !connected.has(r.id)).map((r) => r.id));

  // ── where you can arrive on this floor ──────────────────────────────────
  // Ground floor: in through the front door. Upper floor: up the stairs. A
  // stair lands in whichever room its footprint falls inside; if the void
  // happens to fall between rooms, the nearest room takes it, because a
  // half-landing still has to open into something.
  const entries = new Set<Id>();
  for (const room of rooms) {
    if (edges.some((e) => e.from === OUTSIDE && e.to === room.id)) entries.add(room.id);
  }
  for (const s of project.stairs) {
    if (s.connectsToFloorId !== floorId) continue;
    const host =
      rooms.find((r) => s.x >= r.x && s.x <= r.x + r.width && s.y >= r.y && s.y <= r.y + r.depth) ??
      rooms
        .map((r) => ({ r, d: Math.hypot(s.x - (r.x + r.width / 2), s.y - (r.y + r.depth / 2)) }))
        .sort((a, b) => a.d - b.d)[0]?.r;
    if (host) {
      entries.add(host.id);
      edges.push({ from: OUTSIDE, to: host.id, openingId: s.id, kind: 'exterior' });
      edges.push({ from: host.id, to: OUTSIDE, openingId: s.id, kind: 'exterior' });
    }
  }

  // BFS from every arrival point at once. The entry rooms are themselves
  // reachable — being where the door lands counts — so seed them too.
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }
  const reachable = new Set<Id>(entries);
  const seen = new Set<string>([OUTSIDE, ...entries]);
  const queue = [OUTSIDE, ...entries];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of adjacency.get(n) ?? []) {
      if (seen.has(m)) continue;
      seen.add(m);
      queue.push(m);
      if (m !== OUTSIDE) reachable.add(m);
    }
  }

  // With nothing arriving here, "unreachable" says nothing useful — every room
  // is unreachable and the real problem is the missing stair, which the
  // multi-floor checks report instead.
  const unreachable = new Set<Id>(
    entries.size === 0
      ? []
      : rooms.filter((r) => NEEDS_ACCESS.has(r.kind) && !reachable.has(r.id)).map((r) => r.id),
  );

  return { nodes, edges, reachable, unreachable, doorless, hasEntrance, entries };
}

/** The shortest door path from OUTSIDE to a room, as a list of room labels. */
export function pathToRoom(project: Project, floorId: Id, roomId: Id): string[] {
  const g = buildCirculation(project, floorId);
  const adjacency = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }
  const prev = new Map<string, string>();
  const queue = [OUTSIDE, ...g.entries];
  const seen = new Set<string>([OUTSIDE, ...g.entries]);
  while (queue.length) {
    const n = queue.shift()!;
    if (n === roomId) break;
    for (const m of adjacency.get(n) ?? []) {
      if (seen.has(m)) continue;
      seen.add(m);
      prev.set(m, n);
      queue.push(m);
    }
  }
  if (!seen.has(roomId)) return [];
  const path: string[] = [];
  let cur: string | undefined = roomId;
  while (cur && cur !== OUTSIDE) {
    const room = project.rooms.find((r: Room) => r.id === cur);
    path.unshift(room ? room.label : cur);
    cur = prev.get(cur);
  }
  return ['Outside', ...path];
}

// ─────────────────────────────────────────────────── furniture blocking ───────

/**
 * Does a rectangle overlap a wall's footprint by more than a clearance?
 * Used for both furniture and door swings.
 */
export function overlapsWall(project: Project, floorId: Id, r: Parameters<typeof rectIntersects>[0]): Id | null {
  for (const wall of project.walls) {
    if (wall.floorId !== floorId) continue;
    if (wall.type === 'railing') continue;
    if (rectIntersects(rectOf(r), wallFootprint(wall), TOL.clearance)) return wall.id;
  }
  return null;
}

/** All walls whose footprint a rectangle touches, for highlight rendering. */
export function wallsOverlapping(project: Project, floorId: Id, r: Parameters<typeof rectIntersects>[0]): Id[] {
  return project.walls
    .filter((w) => w.floorId === floorId && w.type !== 'railing' && rectIntersects(rectOf(r), wallFootprint(w), TOL.clearance))
    .map((w) => w.id);
}

/** The opening rectangles of a floor, for hit-testing and for the 3D builder. */
export function openingRects(project: Project, floorId: Id) {
  return project.walls
    .filter((w) => w.floorId === floorId)
    .flatMap((w) => w.openings.map((o) => ({ wall: w, opening: o, rect: openingFootprint(w, o) })));
}
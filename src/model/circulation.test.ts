/**
 * Circulation analysis.
 *
 * The question this module answers is blunt: can a person get from the front
 * door to every room? It answers it as a graph — one node per room plus an
 * `OUTSIDE` sentinel, an edge wherever a door or cased opening pierces a shared
 * wall — and then runs a breadth-first search, so the result is reproducible and
 * can be explained to a user room by room.
 *
 * These tests defend the properties that make that answer trustworthy: an edge
 * appears only because a real opening joins two real neighbours (a window is
 * never an edge), reachability is transitive through chained doors, a room
 * sealed off from the entrance is reported rather than silently dropped, and
 * the furniture helpers agree with the geometry kernel about what "overlapping
 * a wall" means — including the fact that a railing is not a wall.
 */
import { describe, expect, it } from 'vitest';
import { addFloor, addStaircase, blankProject, createRoom, createWall, addOpening, setPlot } from './ops.ts';
import { OUTSIDE, buildCirculation, openingRects, overlapsWall, pathToRoom, wallsOverlapping } from './circulation.ts';
import { OPENING_DEFAULTS, WALL_THICKNESS } from './catalog.ts';
import { rect } from './geometry.ts';
import type { Id, Project } from './types.ts';

/** 24 × 18 m plot, 3 m setbacks all round, one ground floor. */
function site(): Project {
  const res = setPlot(blankProject('Test site'), {
    width: 24,
    depth: 18,
    orientation: 0,
    setbacks: { front: 3, rear: 3, left: 3, right: 3 },
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

/** A wall between two rooms: vertical at x, spanning y0..y1. */
function partition(p: Project, floorId: Id, x: number, y0: number, y1: number) {
  const res = createWall(p, { floorId, type: 'interior', a: { x, y: y0 }, b: { x, y: y1 } });
  if (!res.ok) throw new Error(res.error);
  return { p: res.project, id: res.createdIds[0]! };
}

/** An exterior wall on the left face of a room: vertical at x = room.x. */
function facade(p: Project, floorId: Id, x: number, y0: number, y1: number) {
  const res = createWall(p, {
    floorId,
    type: 'exterior',
    a: { x, y: y0 },
    b: { x, y: y1 },
    thickness: WALL_THICKNESS.exterior,
  });
  if (!res.ok) throw new Error(res.error);
  return { p: res.project, id: res.createdIds[0]! };
}

function doorway(p: Project, wallId: Id, offset: number) {
  const res = addOpening(p, {
    wallId,
    kind: 'doorway',
    offset,
    width: OPENING_DEFAULTS.interiorDoor.width,
    height: OPENING_DEFAULTS.interiorDoor.height,
  });
  if (!res.ok) throw new Error(res.error);
  return { p: res.project, id: res.createdIds[0]! };
}

function frontDoor(p: Project, wallId: Id, offset: number) {
  const res = addOpening(p, {
    wallId,
    kind: 'door',
    offset,
    width: OPENING_DEFAULTS.entranceDoor.width,
    height: OPENING_DEFAULTS.entranceDoor.height,
  });
  if (!res.ok) throw new Error(res.error);
  return { p: res.project, id: res.createdIds[0]! };
}

/**
 * A hall-and-two-rooms plan with a door from outside into the hall, a doorway
 * from the hall into the bedroom, and a sealed bathroom:
 *
 *   hall 6×4 (3,3) ──doorway── bedroom 6×4 (9,3)
 *    │                            │
 *  front door                  sealed (no wall)
 *    │                            │
 *   bathroom 6×4 (3,7)  ← shares an edge with the hall but has no opening
 */
function house() {
  let p = site();
  const ground = p.floors[0]!.id;

  const hall = createRoom(p, { floorId: ground, kind: 'hall', x: 3, y: 3, width: 6, depth: 4 });
  if (!hall.ok) throw new Error(hall.error);
  p = hall.project;
  const hallId = hall.createdIds[0]!;

  const bed = createRoom(p, { floorId: ground, kind: 'bedroom', x: 9, y: 3, width: 6, depth: 4 });
  if (!bed.ok) throw new Error(bed.error);
  p = bed.project;
  const bedId = bed.createdIds[0]!;

  const bath = createRoom(p, { floorId: ground, kind: 'bathroom', x: 3, y: 7, width: 6, depth: 4 });
  if (!bath.ok) throw new Error(bath.error);
  p = bath.project;
  const bathId = bath.createdIds[0]!;

  // The hall's left face carries the way in. Only the hall touches it, because
  // the bathroom sits below, not beside.
  const west = facade(p, ground, 3, 3, 7);
  p = west.p;
  const entrance = frontDoor(p, west.id, 2);
  p = entrance.p;

  // The shared edge between hall and bedroom.
  const spine = partition(p, ground, 9, 3, 7);
  p = spine.p;
  const link = doorway(p, spine.id, 2);
  p = link.p;

  return { p, ground, hallId, bedId, bathId, westId: west.id, spineId: spine.id, entranceId: entrance.id, linkId: link.id };
}

describe('OUTSIDE', () => {
  it('is a sentinel id that no operation will ever mint', () => {
    // Every generated id is prefixed (`rm_`, `wl_`, …); `__outside__` cannot
    // collide with one, so the graph node can never be confused for a room.
    expect(OUTSIDE).toBe('__outside__');
    for (const p of [blankProject(), site()]) {
      const ids = [...p.rooms, ...p.walls, ...p.floors, ...p.stairs, ...p.outdoor].map((e) => e.id);
      expect(ids).not.toContain(OUTSIDE);
    }
  });
});

describe('buildCirculation', () => {
  it('lists one node per room on the floor plus the outside sentinel', () => {
    const { p, ground, hallId, bedId, bathId } = house();
    const g = buildCirculation(p, ground);
    expect(new Set(g.nodes)).toEqual(new Set([OUTSIDE, hallId, bedId, bathId]));
    expect(g.nodes[0]).toBe(OUTSIDE);
  });

  it('edges the entrance room to OUTSIDE, both ways, and calls it an entrance', () => {
    const { p, ground, hallId, entranceId } = house();
    const g = buildCirculation(p, ground);

    expect(g.edges.filter((e) => e.from === OUTSIDE && e.to === hallId)).toEqual([
      { from: OUTSIDE, to: hallId, openingId: entranceId, kind: 'exterior' },
    ]);
    // Circulation is undirected in practice: you can back out of the door.
    expect(g.edges.filter((e) => e.from === hallId && e.to === OUTSIDE)).toHaveLength(1);
    expect(g.hasEntrance).toBe(true);
  });

  it('edges two rooms together when a doorway pierces the wall between them', () => {
    const { p, ground, hallId, bedId, linkId } = house();
    const g = buildCirculation(p, ground);

    const between = g.edges.filter((e) => e.from === hallId && e.to === bedId);
    expect(between).toEqual([{ from: hallId, to: bedId, openingId: linkId, kind: 'doorway' }]);
    expect(g.edges.some((e) => e.from === bedId && e.to === hallId)).toBe(true);
  });

  it('does not treat a window as a way through', () => {
    let p = site();
    const ground = p.floors[0]!.id;
    const hall = createRoom(p, { floorId: ground, kind: 'hall', x: 3, y: 3, width: 6, depth: 4 });
    if (!hall.ok) throw new Error(hall.error);
    p = hall.project;

    // A window in the only wall the room has. A window lets light in; it does
    // not let a person in.
    const west = facade(p, ground, 3, 3, 7);
    const win = addOpening(west.p, { wallId: west.id, kind: 'window', offset: 2 });
    if (!win.ok) throw new Error(win.error);

    const g = buildCirculation(win.project, ground);
    expect(g.edges).toEqual([]);
    expect(g.hasEntrance).toBe(false);
  });

  it('reaches a room through a chain of doors, not just directly', () => {
    // hall → corridor → bedroom. The bedroom never touches an exterior wall,
    // so it can only be reachable if reachability is transitive.
    let p = site();
    const ground = p.floors[0]!.id;
    const hall = createRoom(p, { floorId: ground, kind: 'hall', x: 3, y: 3, width: 6, depth: 4 });
    if (!hall.ok) throw new Error(hall.error);
    p = hall.project;
    const hallId = hall.createdIds[0]!;

    const corr = createRoom(p, { floorId: ground, kind: 'corridor', x: 9, y: 3, width: 6, depth: 4 });
    if (!corr.ok) throw new Error(corr.error);
    p = corr.project;
    const corrId = corr.createdIds[0]!;

    const bed = createRoom(p, { floorId: ground, kind: 'bedroom', x: 15, y: 3, width: 6, depth: 4 });
    if (!bed.ok) throw new Error(bed.error);
    p = bed.project;
    const bedId = bed.createdIds[0]!;

    const west = facade(p, ground, 3, 3, 7);
    const first = frontDoor(west.p, west.id, 2);
    const spine = partition(first.p, ground, 9, 3, 7);
    const toCorr = doorway(spine.p, spine.id, 2);
    const second = partition(toCorr.p, ground, 15, 3, 7);
    const toBed = doorway(second.p, second.id, 2);

    const g = buildCirculation(toBed.p, ground);
    expect(g.reachable).toEqual(new Set([hallId, corrId, bedId]));
    expect(g.unreachable.size).toBe(0);
  });

  it('reports a sealed room as unreachable rather than pretending it is fine', () => {
    const { p, ground, bathId } = house();
    const g = buildCirculation(p, ground);
    expect(g.reachable.has(bathId)).toBe(false);
    expect(g.unreachable.has(bathId)).toBe(true);
    expect(g.doorless.has(bathId)).toBe(true);
  });

  it('reports the sealed room and reaches the ones that are wired up', () => {
    const { p, ground, hallId, bedId, bathId } = house();
    const g = buildCirculation(p, ground);
    expect(g.reachable).toEqual(new Set([hallId, bedId]));
    expect([...g.unreachable]).toEqual([bathId]);
    expect([...g.doorless]).toEqual([bathId]);
  });

  it('accepts a cased opening as a door, since a walk-through gap is one', () => {
    let p = site();
    const ground = p.floors[0]!.id;
    const hall = createRoom(p, { floorId: ground, kind: 'hall', x: 3, y: 3, width: 6, depth: 4 });
    if (!hall.ok) throw new Error(hall.error);
    p = hall.project;
    const hallId = hall.createdIds[0]!;

    const bed = createRoom(p, { floorId: ground, kind: 'bedroom', x: 9, y: 3, width: 6, depth: 4 });
    if (!bed.ok) throw new Error(bed.error);
    p = bed.project;
    const bedId = bed.createdIds[0]!;

    const spine = partition(p, ground, 9, 3, 7);
    const op = addOpening(spine.p, { wallId: spine.id, kind: 'opening', offset: 2 });
    if (!op.ok) throw new Error(op.error);

    const g = buildCirculation(op.project, ground);
    // A cased opening is passable, so it is both an edge and a door.
    expect(g.edges.some((e) => e.from === hallId && e.to === bedId)).toBe(true);
    expect(g.doorless.size).toBe(0);
  });

  it('ignores rooms and walls belonging to another floor', () => {
    const { p, ground, hallId, bedId, bathId } = house();
    const up = addFloor(p);
    if (!up.ok) throw new Error(up.error);
    let two = up.project;
    const upper = two.floors[1]!.id;
    // An upper bedroom stacked directly on top of the ground bedroom, with a
    // doorway — but it belongs to a different floor's graph.
    const attic = createRoom(two, { floorId: upper, kind: 'bedroom', x: 9, y: 3, width: 6, depth: 4 });
    if (!attic.ok) throw new Error(attic.error);
    two = attic.project;
    const spine = partition(two, upper, 9, 3, 7);
    doorway(spine.p, spine.id, 2);

    const groundGraph = buildCirculation(spine.p, ground);
    // The upper bedroom's doorway does not leak into the ground graph, which
    // still sees exactly the rooms it always did — hall and bedroom reached,
    // bathroom still sealed.
    expect(groundGraph.reachable).toEqual(new Set([hallId, bedId]));
    expect([...groundGraph.unreachable]).toEqual([bathId]);

    // And the upper floor's own graph knows nothing about the ground floor's
    // front door — it has no entrance at all.
    const upperGraph = buildCirculation(spine.p, upper);
    expect(upperGraph.hasEntrance).toBe(false);
  });

  it('treats the floor a staircase arrives on as reachable', () => {
    // The upper floor has no door of its own; the stair is the only way up,
    // and it lands inside the landing room.
    let p = site();
    const ground = p.floors[0]!.id;
    const hall = createRoom(p, { floorId: ground, kind: 'hall', x: 3, y: 3, width: 6, depth: 4 });
    if (!hall.ok) throw new Error(hall.error);
    p = hall.project;

    const up = addFloor(p);
    if (!up.ok) throw new Error(up.error);
    p = up.project;
    const upper = p.floors[1]!.id;
    const landing = createRoom(p, { floorId: upper, kind: 'bedroom', x: 3, y: 3, width: 6, depth: 4 });
    if (!landing.ok) throw new Error(landing.error);
    p = landing.project;
    const landingId = landing.createdIds[0]!;

    // The stair's centre sits inside the landing room, so that is where it
    // "arrives".
    const stair = addStaircase(p, { floorId: ground, x: 6, y: 5, width: 1.1 });
    if (!stair.ok) throw new Error(stair.error);
    p = stair.project;

    const g = buildCirculation(p, upper);
    expect(g.entries).toEqual(new Set([landingId]));
    expect(g.reachable).toEqual(new Set([landingId]));
    // No door and no staircase host with an opening: the room is reachable,
    // but it has no door in any wall.
    expect(g.hasEntrance).toBe(false);
    expect(g.doorless.has(landingId)).toBe(true);
    // The stair edge is attributed to the stair's own id.
    expect(g.edges.some((e) => e.openingId === stair.createdIds[0])).toBe(true);
  });

  it('reports nothing unreachable when a floor has no way onto it at all', () => {
    // With no entrance and no stair, every room is "unreachable" and the set
    // would be noise; the missing-stair problem is reported elsewhere, so the
    // graph stays quiet rather than crying wolf.
    let p = site();
    const ground = p.floors[0]!.id;
    const hall = createRoom(p, { floorId: ground, kind: 'hall', x: 3, y: 3, width: 6, depth: 4 });
    if (!hall.ok) throw new Error(hall.error);
    p = hall.project;
    const hallId = hall.createdIds[0]!;

    const bed = createRoom(p, { floorId: ground, kind: 'bedroom', x: 9, y: 3, width: 6, depth: 4 });
    if (!bed.ok) throw new Error(bed.error);
    p = bed.project;
    const bedId = bed.createdIds[0]!;

    const g = buildCirculation(p, ground);
    expect(g.entries.size).toBe(0);
    expect(g.unreachable.size).toBe(0);
    // The bedroom still has no door, which is the actionable half of the story.
    expect(g.doorless).toEqual(new Set([bedId]));
    // A hall is circulation, not a destination: it is deliberately exempt from
    // the "needs a door" list, so being doorless is not a fault for it.
    expect(g.doorless.has(hallId)).toBe(false);
  });
});

describe('pathToRoom', () => {
  it('starts every route at the outside sentinel', () => {
    const { p, ground, hallId } = house();
    expect(pathToRoom(p, ground, hallId)[0]).toBe('Outside');
  });

  it('walks the doors in order to the entrance room', () => {
    const { p, ground, hallId } = house();
    expect(pathToRoom(p, ground, hallId)).toEqual(['Outside', 'Hall']);
  });

  it('threads a chained route through the rooms in between', () => {
    const { p, ground, bedId } = house();
    expect(pathToRoom(p, ground, bedId)).toEqual(['Outside', 'Hall', 'Bedroom']);
  });

  it('returns an empty path for a room the entrance cannot reach', () => {
    const { p, ground, bathId } = house();
    expect(pathToRoom(p, ground, bathId)).toEqual([]);
  });

  it('returns an empty path for a room id that does not exist', () => {
    const { p, ground } = house();
    expect(pathToRoom(p, ground, 'rm_ghost')).toEqual([]);
  });

  it('returns the labels, not the ids, so the path can be shown to a person', () => {
    const { p, ground, bedId } = house();
    const path = pathToRoom(p, ground, bedId);
    expect(path).not.toContain(OUTSIDE);
    expect(path).not.toContain(bedId);
  });
});

describe('overlapsWall', () => {
  it('names the wall a rectangle runs into', () => {
    const { p, ground, spineId } = house();
    // The spine sits on x = 9 between the hall and the bedroom, 0.1 m thick,
    // so it occupies x ∈ [8.95, 9.05] over y ∈ [3, 7].
    const crossing = overlapsWall(p, ground, rect(8.9, 4, 0.2, 1));
    expect(crossing).toBe(spineId);
  });

  it('returns null for a rectangle clear of every wall', () => {
    const { p, ground } = house();
    // Dead centre of the hall, well away from x = 3, x = 9 and y = 7.
    expect(overlapsWall(p, ground, rect(5, 4.5, 1, 1))).toBeNull();
  });

  it('sees a wall within the clearance band as an overlap, not just a crossing', () => {
    const { p, ground, spineId } = house();
    // The furniture is allowed to TOUCH a wall (TOL.clearance = 0.01 m), so a
    // rectangle whose edge stops 5 mm short of the wall face is clear…
    expect(overlapsWall(p, ground, rect(8.5, 4, 0.44, 1))).toBeNull();
    // …but 5 mm past it is a collision.
    expect(overlapsWall(p, ground, rect(8.5, 4, 0.46, 1))).toBe(spineId);
  });

  it('ignores walls on other floors', () => {
    const { p, ground } = house();
    const up = addFloor(p);
    if (!up.ok) throw new Error(up.error);
    const upper = up.project.floors[1]!.id;

    // The very same rectangle. On the ground floor it crosses the spine; on
    // the empty upper floor there is nothing at all to cross.
    expect(overlapsWall(up.project, ground, rect(8.9, 4, 0.2, 1))).not.toBeNull();
    expect(overlapsWall(up.project, upper, rect(8.9, 4, 0.2, 1))).toBeNull();
  });

  it('ignores railings — a balcony guard is not a wall to bump into', () => {
    let p = site();
    const ground = p.floors[0]!.id;
    const rail = createWall(p, { floorId: ground, type: 'railing', a: { x: 3, y: 8 }, b: { x: 9, y: 8 } });
    if (!rail.ok) throw new Error(rail.error);
    p = rail.project;

    expect(overlapsWall(p, ground, rect(4, 7.8, 1, 0.4))).toBeNull();
    expect(wallsOverlapping(p, ground, rect(4, 7.8, 1, 0.4))).toEqual([]);
  });
});

describe('wallsOverlapping', () => {
  it('returns every wall a rectangle touches, not just the first', () => {
    const { p, ground, westId, spineId } = house();
    // A wide rectangle spanning the hall from its left wall to the spine.
    const found = wallsOverlapping(p, ground, rect(2.9, 4, 6.2, 1));
    expect(found.sort()).toEqual([westId, spineId].sort());
  });

  it('agrees with overlapsWall about which walls are involved', () => {
    const { p, ground } = house();
    const r = rect(8.9, 4, 0.2, 1);
    expect(wallsOverlapping(p, ground, r)).toEqual([overlapsWall(p, ground, r)]);
  });

  it('returns an empty list rather than null for a clear rectangle', () => {
    const { p, ground } = house();
    expect(wallsOverlapping(p, ground, rect(5, 4.5, 1, 1))).toEqual([]);
  });
});

describe('openingRects', () => {
  it('returns one rectangle per opening, tagged with the wall it belongs to', () => {
    const { p, ground, entranceId, linkId } = house();
    const rects = openingRects(p, ground);
    expect(rects).toHaveLength(2);
    expect(rects.map((r) => r.opening.id).sort()).toEqual([entranceId, linkId].sort());
    for (const r of rects) expect(r.wall.openings).toContain(r.opening);
  });

  it('sizes each rectangle to the opening and its wall thickness', () => {
    const { p, ground, entranceId } = house();
    const front = openingRects(p, ground).find((r) => r.opening.id === entranceId)!;

    // The exterior wall runs from (3,3) to (3,7); the door is centred 2 m along
    // it, so its centre sits at y = 5 and spans y ∈ [5 − 1.1/2, 5 + 1.1/2].
    // Across the wall it spans the full 0.23 m thickness.
    expect(front.rect.depth).toBeCloseTo(OPENING_DEFAULTS.entranceDoor.width, 10);
    expect(front.rect.width).toBeCloseTo(WALL_THICKNESS.exterior, 10);
    expect(front.rect.y + front.rect.depth / 2).toBeCloseTo(5, 10);
    expect(front.rect.x + front.rect.width / 2).toBeCloseTo(3, 10);
  });

  it('includes windows, which the editor hit-tests against', () => {
    const { p, westId, ground } = house();
    const win = addOpening(p, { wallId: westId, kind: 'window', offset: 5, width: 1.2, height: 1.4, sill: 0.9 });
    if (!win.ok) throw new Error(win.error);
    const rects = openingRects(win.project, ground);
    expect(rects).toHaveLength(3);
    expect(rects.some((r) => r.opening.kind === 'window')).toBe(true);
  });

  it('returns nothing for a floor with no openings', () => {
    const { p, ground, spineId } = house();
    const up = addFloor(p);
    if (!up.ok) throw new Error(up.error);
    const upper = up.project.floors[1]!.id;
    expect(openingRects(p, upper)).toEqual([]);
    // And the ground floor still has its two.
    expect(openingRects(p, ground)).toHaveLength(2);
    expect(spineId).toBeTruthy();
  });
});
describe('regression: one exterior wall drawn across a row of rooms', () => {
  /**
   * Two rooms side by side under a single 12 m frontage, with the front door
   * in front of the left-hand one.
   *
   *   living 6×4 (3,3)   bedroom 6×4 (9,3)
   *   └────────── exterior wall (3,3) → (15,3), door at offset 1.5 ──────────┘
   *
   * This is the natural way a person draws a frontage, and it is reachable from
   * the canvas wall tool, the AI's `create_wall`, and the tracer.
   */
  function terrace(): { p: Project; ground: Id; livingId: Id; bedId: Id; doorId: Id } {
    let p = site();
    const ground = p.floors[0]!.id;

    const living = createRoom(p, { floorId: ground, kind: 'living', x: 3, y: 3, width: 6, depth: 4 });
    if (!living.ok) throw new Error(living.error);
    p = living.project;

    const bed = createRoom(p, { floorId: ground, kind: 'bedroom', x: 9, y: 3, width: 6, depth: 4 });
    if (!bed.ok) throw new Error(bed.error);
    p = bed.project;

    const front = facadeH(p, ground, 3, 3, 15);
    p = front.p;
    const door = frontDoor(p, front.id, 1.5);
    p = door.p;

    return { p, ground, livingId: living.createdIds[0]!, bedId: bed.createdIds[0]!, doorId: door.id };
  }

  /** A horizontal exterior wall from x0 to x1 at y. */
  function facadeH(p: Project, floorId: Id, x0: number, y: number, x1: number) {
    const res = createWall(p, {
      floorId,
      type: 'exterior',
      a: { x: x0, y },
      b: { x: x1, y },
      thickness: WALL_THICKNESS.exterior,
    });
    if (!res.ok) throw new Error(res.error);
    return { p: res.project, id: res.createdIds[0]! };
  }

  it('still finds the front door, even though the wall bounds two rooms', () => {
    // The bug this guards: deciding by how many rooms a wall bounds turned the
    // front door into an interior door between the two rooms. The house had no
    // way in, so every room read as unreachable and `hasEntrance` was false.
    const { p, ground, livingId, bedId, doorId } = terrace();
    const g = buildCirculation(p, ground);

    expect(g.hasEntrance).toBe(true);
    expect(g.edges).toContainEqual({ from: OUTSIDE, to: livingId, openingId: doorId, kind: 'exterior' });
    // The door is in front of the living room, so it is not the bedroom's.
    expect(g.edges.some((e) => e.to === bedId && e.from === OUTSIDE)).toBe(false);
    // And because the front door is no longer swallowed by a bogus living↔bed
    // link, the bedroom's real problem surfaces: it has no door at all. Before
    // the fix this read as "the whole house is unreachable", which told the
    // user nothing they could act on.
    expect(g.reachable).toEqual(new Set([livingId]));
    expect(g.unreachable).toEqual(new Set([bedId]));
    expect(g.doorless).toEqual(new Set([bedId]));
  });

  it('does not invent a door between two rooms that share only that wall', () => {
    // The door pierces an exterior wall: it is not a link into the bedroom.
    const { p, ground, livingId, bedId } = terrace();
    const g = buildCirculation(p, ground);
    expect(g.edges.some((e) => e.from === livingId && e.to === bedId)).toBe(false);
  });

  it('keeps every room past the second, rather than dropping them', () => {
    // The old code destructured `const [a, b] = inside`, silently discarding
    // any room past the second on the same wall.
    let p = site();
    const ground = p.floors[0]!.id;
    const ids: Id[] = [];
    for (let i = 0; i < 3; i++) {
      const r = createRoom(p, { floorId: ground, kind: 'bedroom', x: 3 + i * 4, y: 3, width: 4, depth: 4 });
      if (!r.ok) throw new Error(r.error);
      p = r.project;
      ids.push(r.createdIds[0]!);
    }
    const front = facadeH(p, ground, 3, 3, 15);
    p = front.p;
    // A door in front of the middle room only.
    const door = frontDoor(p, front.id, 6.5);
    p = door.p;

    const g = buildCirculation(p, ground);
    expect(g.hasEntrance).toBe(true);
    expect(g.edges.some((e) => e.from === OUTSIDE && e.to === ids[1])).toBe(true);
    // All three rooms are known; none is lost from the graph.
    expect(new Set(g.nodes)).toEqual(new Set([OUTSIDE, ...ids]));
  });
});

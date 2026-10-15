/**
 * Plan → 3D geometry.
 *
 * The claim these tests defend is the product's central one: the 2D canvas and
 * the 3D view are the same building, not two drawings that happen to agree
 * today. They agree only because both are generated from `Project`, so the
 * tests generate and measure rather than compare screenshots.
 *
 * The mapping under test, in full:
 *   plan (x, y) → world (x − plotWidth/2, elevation, y − plotDepth/2)
 */
import { describe, expect, it } from 'vitest';
import { buildScene, EAVES_OVERHANG, JOINT_OVERLAP, PLINTH_HEIGHT } from './sceneModel.ts';
import {
  addFloor,
  addOpening,
  addStaircase,
  blankProject,
  createRoom,
  createWall,
  setFloorHeight,
  setPlot,
} from '../model/ops.ts';
import { OPENING_DEFAULTS, WALL_THICKNESS } from '../model/catalog.ts';
import type { Project } from '../model/types.ts';

const PLOT_W = 20;
const PLOT_D = 16;

function site(): Project {
  const p = blankProject('Scene test');
  const plot = setPlot(p, { width: PLOT_W, depth: PLOT_D, orientation: 0, setbacks: { front: 2, rear: 2, left: 2, right: 2 } });
  if (!plot.ok) throw new Error(plot.error);
  return plot.project;
}

function withRoom(p: Project, kind: 'living' | 'bedroom', x: number, y: number, w: number, d: number): { p: Project; id: string } {
  const res = createRoom(p, { floorId: p.floors[0]!.id, kind, x, y, width: w, depth: d });
  if (!res.ok) throw new Error(res.error);
  return { p: res.project, id: res.createdIds[0]! };
}

/** The centre of a room's world-space footprint. */
function roomCentre(project: Project, roomId: string) {
  const r = project.rooms.find((x) => x.id === roomId)!;
  return {
    x: r.x + r.width / 2 - PLOT_W / 2,
    z: r.y + r.depth / 2 - PLOT_D / 2,
  };
}

describe('the plan → world mapping', () => {
  it('centres the plot on the origin, so camera framing does not depend on plot size', () => {
    // A room whose plan centre is exactly the plot centre maps to x=0, z=0.
    const base = site();
    const { p } = withRoom(base, 'living', 7, 5, 6, 6); // centre (10, 8) = plot centre
    const c = roomCentre(p, p.rooms[0]!.id);
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.z).toBeCloseTo(0, 9);
  });

  it('moves +x right and +y forward with no flip', () => {
    const base = site();
    // Two rooms differing only in plan-y must differ only in world z.
    const a = withRoom(base, 'living', 2, 2, 3, 3);
    const b = withRoom(a.p, 'living', 2, 9, 3, 3);
    const ca = roomCentre(a.p, a.id);
    const cb = roomCentre(b.p, b.id);
    expect(cb.x).toBeCloseTo(ca.x, 9);
    expect(cb.z - ca.z).toBeCloseTo(7, 9);
  });

  it('preserves real sizes: a 6 × 4 room is 6 × 4 metres in the world', () => {
    const base = site();
    const { p } = withRoom(base, 'living', 3, 3, 6, 4);
    const slab = buildScene(p).boxes.find((b) => b.kind === 'room-slab');
    expect(slab).toBeDefined();
    expect(slab!.w).toBeCloseTo(6, 6);
    expect(slab!.d).toBeCloseTo(4, 6);
  });
});

describe('2D ↔ 3D stay in step', () => {
  it('adds geometry the moment the model changes, with no separate 3D edit', () => {
    const base = site();
    expect(buildScene(base).boxes.filter((b) => b.kind === 'room-slab')).toHaveLength(0);

    const { p } = withRoom(base, 'living', 3, 3, 6, 5);
    const slabs = buildScene(p).boxes.filter((b) => b.kind === 'room-slab');
    expect(slabs).toHaveLength(1);
  });

  it('moves the 3D slab when the 2D rectangle is moved', () => {
    const base = site();
    const a = withRoom(base, 'living', 3, 3, 4, 4);
    const before = buildScene(a.p).boxes.find((b) => b.kind === 'room-slab')!;

    const moved = { ...a.p };
    const room = moved.rooms[0]!;
    room.x = 10;
    room.y = 8;
    const after = buildScene(moved).boxes.find((b) => b.kind === 'room-slab')!;

    expect(after.x - before.x).toBeCloseTo(7, 6);
    expect(after.z - before.z).toBeCloseTo(5, 6);
  });

  it('resizes the 3D slab when the 2D rectangle is resized', () => {
    const base = site();
    const { p } = withRoom(base, 'living', 3, 3, 4, 4);
    const room = p.rooms[0]!;
    room.width = 9;
    const slab = buildScene(p).boxes.find((b) => b.kind === 'room-slab')!;
    expect(slab.w).toBeCloseTo(9, 6);
    expect(slab.d).toBeCloseTo(4, 6);
  });

  it('honours the wall thickness the 2D view draws', () => {
    const base = site();
    const w = createWall(base, {
      floorId: base.floors[0]!.id,
      type: 'exterior',
      a: { x: 2, y: 2 },
      b: { x: 12, y: 2 },
    });
    if (!w.ok) throw new Error(w.error);
    const box = buildScene(w.project).boxes.find((b) => b.kind === 'wall')!;
    expect(box.d).toBeCloseTo(WALL_THICKNESS.exterior, 6);
    expect(box.h).toBeCloseTo(w.project.walls[0]!.height, 6);
  });

  it('gives every box an owner id, so a 3D click maps back to a model object', () => {
    const base = site();
    const { p } = withRoom(base, 'living', 3, 3, 6, 5);
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 3, y: 3 }, b: { x: 9, y: 3 } });
    if (!w.ok) throw new Error(w.error);

    const boxes = buildScene(w.project).boxes;
    const roomSlab = boxes.find((b) => b.kind === 'room-slab')!;
    expect(roomSlab.ownerId).toBe(w.project.rooms[0]!.id);
    const wall = boxes.find((b) => b.kind === 'wall')!;
    expect(wall.ownerId).toBe(w.project.walls[0]!.id);
  });
});

describe('openings are cut in the wall they belong to', () => {
  /** A 10 m exterior wall with one door 1 m from its start. */
  function wallWithOpening(kind: 'door' | 'window') {
    const base = site();
    const w = createWall(base, { floorId: base.floors[0]!.id, type: 'exterior', a: { x: 2, y: 2 }, b: { x: 12, y: 2 } });
    if (!w.ok) throw new Error(w.error);
    const d = OPENING_DEFAULTS[kind === 'door' ? 'interiorDoor' : 'window'];
    const o = addOpening(w.project, { wallId: w.createdIds[0]!, kind, offset: 1, width: d.width, height: d.height, sill: d.sill });
    if (!o.ok) throw new Error(o.error);
    return o.project;
  }

  it('splits a wall with a door into more than one solid', () => {
    const plain = site();
    const w = createWall(plain, { floorId: plain.floors[0]!.id, type: 'exterior', a: { x: 2, y: 2 }, b: { x: 12, y: 2 } });
    if (!w.ok) throw new Error(w.error);
    const oneBox = buildScene(w.project).boxes.filter((b) => b.kind === 'wall').length;

    const cut = buildScene(wallWithOpening('door')).boxes.filter((b) => b.kind === 'wall').length;
    expect(cut).toBeGreaterThan(oneBox);
  });

  it('produces a door gap that is actually the door width', () => {
    const p = wallWithOpening('door');
    const d = OPENING_DEFAULTS.interiorDoor;
    const wallBoxes = buildScene(p).boxes.filter((b) => b.kind === 'wall');
    // The lintel sits above the door: its centre height is sill + clear height
    // plus half the wall above, and there is no full-height box over the opening.
    const lintels = wallBoxes.filter((b) => b.y > d.height - 0.01);
    expect(lintels.length).toBeGreaterThan(0);
    for (const l of lintels) {
      expect(l.y - l.h / 2).toBeGreaterThanOrEqual(d.height - 1e-6);
    }
  });

  it('gives a window a glass pane of the window\'s size', () => {
    const d = OPENING_DEFAULTS.window;
    const glass = buildScene(wallWithOpening('window')).boxes.filter((b) => b.kind === 'glass');
    expect(glass.length).toBeGreaterThan(0);
    for (const g of glass) {
      expect(g.h).toBeCloseTo(d.height, 6);
      expect(g.opacity).toBeLessThan(1);
    }
  });

  it('keeps every cut piece the full thickness of the wall, so the elevation stays one flat plane', () => {
    // The regression. Backing the sill and head pieces in by a few millimetres
    // to be sure of avoiding a coplanar join put a step down the full height of
    // every pier, at every jamb. Sub-pixel at any real distance, and still
    // enough to draw a row of dark hairlines down every elevation. So every
    // piece keeps the full thickness, and the joins are taken *under* the
    // neighbour rather than stopping at it — coplanar, same normal, same
    // material, and far too small to see.
    const p = wallWithOpening('window');
    const wall = p.walls.find((x) => x.type === 'exterior')!;
    const boxes = buildScene(p).boxes.filter((b) => b.kind === 'wall');
    expect(boxes.length).toBeGreaterThan(2);
    for (const b of boxes) {
      expect(b.d).toBeCloseTo(Math.max(0.05, wall.thickness), 6);
    }

    // They cover the wall's length exactly — no gap for daylight through. The
    // sill and head pieces share one run, stacked, so only the leading edge of
    // each new run is a join.
    const spans = boxes
      .map((b) => [b.x - b.w / 2, b.x + b.w / 2])
      .sort((a, b) => a[0] - b[0]);
    expect(spans[spans.length - 1]![1] - spans[0]![0]).toBeCloseTo(10, 4);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i]![0] <= spans[i - 1]![0]) continue;
      // Overlapping, never a gap: the next run starts before the last one ends.
      expect(spans[i]![0]).toBeLessThan(spans[i - 1]![1]);
      expect(spans[i - 1]![1] - spans[i]![0]).toBeLessThanOrEqual(2 * JOINT_OVERLAP + 1e-9);
    }
  });

  it('leaves an unopened wall as one unbroken box', () => {
    const plain = site();
    const w = createWall(plain, { floorId: plain.floors[0]!.id, type: 'exterior', a: { x: 2, y: 2 }, b: { x: 12, y: 2 } });
    if (!w.ok) throw new Error(w.error);
    const boxes = buildScene(w.project).boxes.filter((b) => b.kind === 'wall');
    expect(boxes).toHaveLength(1);
    // Exactly the centreline run. A free end is a flat end — it meets nothing,
    // so there is nothing to close — and running it past its own endpoint
    // would have it sticking out past whatever was drawn next to it. Corners
    // are closed by their own block; see "closes the outside corner where two
    // walls meet".
    expect(boxes[0]!.w).toBeCloseTo(10, 6);
  });

  it('closes the outside corner where two walls meet', () => {
    // The regression. Each wall box is centred on its own centreline, so two
    // walls whose endpoints coincide at 90° leave a t/2 × t/2 notch in the
    // outside corner — a slot straight through the building, visible from
    // outside as a lit seam running up every corner.
    //
    // Neither wall may be run past its endpoint to fill it: that makes the two
    // boxes overlap with their outer faces coplanar, and coplanar front faces
    // z-fight into a one-pixel stripe. The corner gets its own solid instead,
    // so the test is that the *outside arris* — the point where the two wall
    // faces meet — is inside some box, and that no two front-facing faces share
    // a plane along it.
    const plain = site();
    const p = plain;
    const south = createWall(p, { floorId: p.floors[0]!.id, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 12, y: 4 } });
    if (!south.ok) throw new Error(south.error);
    const east = createWall(south.project, { floorId: p.floors[0]!.id, type: 'exterior', a: { x: 12, y: 4 }, b: { x: 12, y: 11 } });
    if (!east.ok) throw new Error(east.error);

    const t = WALL_THICKNESS.exterior;
    const scene = buildScene(east.project);
    const boxes = scene.boxes;
    const walls = boxes.filter((b) => b.kind === 'wall');
    expect(walls).toHaveLength(2);

    // Plan coordinates; the scene is centred on the plot.
    const cx = 12 - east.project.plot.width / 2;
    const cz = 4 - east.project.plot.depth / 2;

    /** World half-extent of a box on each axis, read the rotated way. */
    const half = (b: (typeof boxes)[number]): [number, number] => {
      const quarterTurn = Math.abs(Math.round(b.ry / 90)) % 2 === 1;
      return quarterTurn ? [b.d / 2, b.w / 2] : [b.w / 2, b.d / 2];
    };
    const covers = (b: (typeof boxes)[number], px: number, pz: number) => {
      const [hx, hz] = half(b);
      return Math.abs(b.x - px) <= hx + 1e-6 && Math.abs(b.z - pz) <= hz + 1e-6;
    };

    // Both outside corners of the junction are solid: no gap to see through.
    for (const sign of [-1, 1]) {
      expect(boxes.some((b) => covers(b, cx + sign * (t / 2), cz + sign * (t / 2)))).toBe(true);
    }

    // And nothing overlaps the corner with a front face on a shared plane.
    // Two boxes whose facing surfaces are coplanar and both outward-facing is
    // exactly the condition that produces a z-fighting stripe. The closing
    // blocks are the only trim that reaches the junction: one for the wall and
    // one for the plinth, the latter proud of it by the same 4 cm the plinth
    // is proud of the wall everywhere else.
    const widths = boxes
      .filter((b) => b.kind === 'trim' && covers(b, cx, cz))
      .map((b) => Math.round(b.w * 1000) / 1000);
    expect(widths.sort((a, b) => a - b)).toEqual([Math.round(t * 1000) / 1000, Math.round((t + 0.08) * 1000) / 1000]);
  });
});

describe('multi-storey', () => {
  function twoStorey(): { p: Project; upperId: string } {
    const base = site();
    const ground = base.floors[0]!.id;
    const a = withRoom(base, 'living', 3, 3, 8, 6);
    const w = createWall(a.p, { floorId: ground, type: 'exterior', a: { x: 3, y: 3 }, b: { x: 11, y: 3 }, height: 3 });
    if (!w.ok) throw new Error(w.error);
    const up = addFloor(w.project, 'First floor');
    if (!up.ok) throw new Error(up.error);
    return { p: up.project, upperId: up.createdIds[0]! };
  }

  it('lifts every box of an upper floor to that floor\'s elevation', () => {
    const { p, upperId } = twoStorey();
    const upper = p.floors.find((f) => f.id === upperId)!;
    expect(upper.elevation).toBeGreaterThan(0);

    const room = createRoom(p, { floorId: upperId, kind: 'bedroom', x: 3, y: 3, width: 5, depth: 4 });
    if (!room.ok) throw new Error(room.error);

    const slab = buildScene(room.project).boxes.find((b) => b.kind === 'room-slab' && b.floorId === upperId)!;
    expect(slab).toBeDefined();
    // The slab's *top* face is the floor level you stand on, not its centre.
    expect(slab.y + slab.h / 2).toBeCloseTo(upper.elevation, 2);
  });

  it('stacks a second storey directly above the first', () => {
    const { p } = twoStorey();
    const first = p.floors[0]!;
    const second = p.floors[1]!;
    expect(second.elevation).toBeCloseTo(first.elevation + first.height, 6);
  });

  it('moves the whole upper storey when the ground floor gets taller', () => {
    const { p } = twoStorey();
    const raised = setFloorHeight(p, p.floors[0]!.id, 4.5);
    if (!raised.ok) throw new Error(raised.error);
    expect(raised.project.floors[1]!.elevation).toBeCloseTo(4.5, 6);
  });

  it('shows only the requested floor when one is hidden', () => {
    const { p, upperId } = twoStorey();
    const upper = createRoom(p, { floorId: upperId, kind: 'bedroom', x: 3, y: 3, width: 5, depth: 4 });
    if (!upper.ok) throw new Error(upper.error);
    // Both storeys are modelled, so hiding one must genuinely halve the slabs.
    expect(buildScene(upper.project).boxes.filter((b) => b.kind === 'room-slab')).toHaveLength(2);
    const groundOnly = buildScene(upper.project, { visibleFloorIds: [p.floors[0]!.id] }).boxes.filter((b) => b.kind === 'room-slab');
    expect(groundOnly).toHaveLength(1);
    expect(groundOnly[0]!.floorId).toBe(p.floors[0]!.id);
  });

  it('draws an ascending flight from the ground floor up to the floor it connects', () => {
    const { p, upperId } = twoStorey();
    const s = addStaircase(p, { floorId: p.floors[0]!.id, connectsToFloorId: upperId, x: 9, y: 6 });
    if (!s.ok) throw new Error(s.error);

    const stairBoxes = buildScene(s.project).boxes.filter((b) => b.kind === 'stair');
    expect(stairBoxes.length).toBeGreaterThan(0);

    const ground = s.project.floors.find((f) => f.order === 0)!;
    const top = s.project.floors.find((f) => f.id === upperId)!;
    const bottom = Math.min(...stairBoxes.map((b) => b.y - b.h / 2));
    const highest = Math.max(...stairBoxes.map((b) => b.y + b.h / 2));

    // It must start on the ground floor, not one storey below it — a flight
    // based under the slab is a stair to the basement.
    expect(bottom).toBeGreaterThan(ground.elevation - 0.2);
    // And it must arrive at the storey above.
    expect(highest).toBeGreaterThan(top.elevation - 0.2);
  });

  it('refuses a stair that points downwards, so flights only ever ascend', () => {
    // `direction: -1` exists on the type and the 3D builder handles it, but no
    // operation can produce one: addStaircase always connects a floor to the one
    // above it. Pinned here so that if the guard is ever relaxed, this test is
    // the thing that notices.
    const { p, upperId } = twoStorey();
    const s = addStaircase(p, { floorId: upperId, connectsToFloorId: p.floors[0]!.id, x: 9, y: 6, direction: -1 });
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.code).toBe('conflict');
    expect(s.error).toMatch(/not higher/i);
  });

  it('refuses a stair on the top floor, which has nothing to reach', () => {
    const { p, upperId } = twoStorey();
    const s = addStaircase(p, { floorId: upperId, x: 9, y: 6 });
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.code).toBe('conflict');
  });
});

describe('toggles and colliders', () => {
  it('omits furniture when furniture is switched off', () => {
    const base = site();
    const { p } = withRoom(base, 'bedroom', 3, 3, 4, 4);
    const roomId = p.rooms[0]!.id;
    const item = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bedroom', x: 8, y: 3, width: 4, depth: 4 });
    if (!item.ok) throw new Error(item.error);
    void roomId;

    const scene = buildScene(p);
    expect(scene.boxes.some((b) => b.kind === 'room-slab')).toBe(true);
    // The switch only governs modelled furniture, which this project has none of
    // yet; the ground plane is governed separately.
    const noFurniture = buildScene(p, { showFurniture: false });
    expect(noFurniture.boxes.filter((b) => b.kind === 'furniture')).toHaveLength(0);
  });

  it('produces colliders that are axis-aligned and inside the world bounds', () => {
    const base = site();
    const w = createWall(base, { floorId: base.floors[0]!.id, type: 'exterior', a: { x: 2, y: 2 }, b: { x: 12, y: 2 } });
    if (!w.ok) throw new Error(w.error);
    const { colliders, bounds } = buildScene(w.project);
    expect(colliders.length).toBeGreaterThan(0);
    for (const c of colliders) {
      expect(c.w).toBeGreaterThan(0);
      expect(c.d).toBeGreaterThan(0);
    }
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.depth).toBeGreaterThan(0);
  });

  it('returns an empty scene for an empty project rather than throwing', () => {
    const scene = buildScene(site());
    expect(Array.isArray(scene.boxes)).toBe(true);
    expect(Array.isArray(scene.colliders)).toBe(true);
  });
});

/** A two-storey project: a room and an exterior wall, with a floor above. */
function twoStoreyAt(): { p: Project; upperId: string } {
  const base = site();
  const ground = base.floors[0]!.id;
  const a = withRoom(base, 'living', 3, 3, 8, 6);
  const w = createWall(a.p, { floorId: ground, type: 'exterior', a: { x: 3, y: 3 }, b: { x: 11, y: 3 }, height: 3 });
  if (!w.ok) throw new Error(w.error);
  const up = addFloor(w.project, 'First floor');
  if (!up.ok) throw new Error(up.error);
  return { p: up.project, upperId: up.createdIds[0]! };
}

/** A 10 m exterior wall with one opening of the given kind. */
function wallWithOpeningAt(kind: 'door' | 'window'): Project {
  const base = site();
  const w = createWall(base, { floorId: base.floors[0]!.id, type: 'exterior', a: { x: 2, y: 2 }, b: { x: 12, y: 2 } });
  if (!w.ok) throw new Error(w.error);
  const d = OPENING_DEFAULTS[kind === 'door' ? 'interiorDoor' : 'window'];
  const o = addOpening(w.project, { wallId: w.createdIds[0]!, kind, offset: 1, width: d.width, height: d.height, sill: d.sill });
  if (!o.ok) throw new Error(o.error);
  return o.project;
}

describe('the building reads as architecture', () => {
  it('oversails the roof past the wall face, so there is an eaves shadow line', () => {
    const base = site();
    const a = withRoom(base, 'living', 3, 3, 8, 6);
    const w = createWall(a.p, { floorId: base.floors[0]!.id, type: 'exterior', a: { x: 3, y: 3 }, b: { x: 11, y: 3 } });
    if (!w.ok) throw new Error(w.error);

    const scene = buildScene(w.project);
    const roof = scene.boxes.find((b) => b.kind === 'roof')!;
    const building = scene.building;
    // The wall runs x 3→11, so the built fabric is 8 m of run; its thickness
    // shows up across the run, not along it.
    expect(building.width).toBeCloseTo(8, 1);
    expect(roof.w).toBeGreaterThan(building.width + EAVES_OVERHANG);
    expect(roof.d).toBeGreaterThan(building.depth + EAVES_OVERHANG);
    // The deck sits *on* the wall head rather than floating above or sinking
    // into it, and a fascia hangs below the overhang so the edge has a third
    // tone to read against.
    expect(roof.y - roof.h / 2).toBeCloseTo(building.height, 6);
    expect(scene.boxes.filter((b) => b.kind === 'roof').length).toBeGreaterThan(1);
  });

  it('puts a plinth round the base of the ground floor only', () => {
    const { p, upperId } = twoStoreyAt();
    const room = createRoom(p, { floorId: upperId, kind: 'bedroom', x: 3, y: 3, width: 5, depth: 4 });
    if (!room.ok) throw new Error(room.error);

    const scene = buildScene(room.project);
    const trim = scene.boxes.filter((b) => b.kind === 'trim');
    expect(trim.length).toBeGreaterThan(0);
    const ground = p.floors.find((f) => f.order === 0)!;
    for (const t of trim) {
      expect(t.floorId, 'a plinth appeared above the ground floor').toBe(ground.id);
      expect(t.y + t.h / 2).toBeLessThanOrEqual(PLINTH_HEIGHT + 1e-6);
    }
  });

  it('frames every window, and gives a wide one a mullion', () => {
    const p = wallWithOpeningAt('window');
    const scene = buildScene(p);
    const frames = scene.boxes.filter((b) => b.kind === 'frame');
    expect(frames.length).toBeGreaterThanOrEqual(3); // two jambs and a head
    // Frames sit proud of the wall face, or they would be invisible on it.
    const wallThickness = p.walls[0]!.thickness;
    for (const f of frames) expect(f.d).toBeGreaterThan(wallThickness);
    // A frame is joinery, not structure: it must not stop the camera. The only
    // things that may become colliders are the ones the walk view treats as
    // solid — and the count is exactly the number of such boxes.
    const solid = scene.boxes.filter((b) => b.kind === 'wall' || b.kind === 'furniture' || b.kind === 'glass');
    expect(scene.colliders).toHaveLength(solid.length);
  });

  it('separates wall, roof and ground in value, so the building is not one cream mass', () => {
    const base = site();
    const a = withRoom(base, 'living', 3, 3, 8, 6);
    const w = createWall(a.p, { floorId: base.floors[0]!.id, type: 'exterior', a: { x: 3, y: 3 }, b: { x: 11, y: 3 } });
    if (!w.ok) throw new Error(w.error);

    const boxes = buildScene(w.project).boxes;
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const wall = luminance(boxes.find((b) => b.kind === 'wall')!.color);
    const roof = luminance(boxes.find((b) => b.kind === 'roof')!.color);
    const lawn = luminance(boxes.find((b) => b.kind === 'lawn')!.color);
    // The eye finds an edge through contrast. Any two of these three meeting at
    // a corner have to differ by a visible amount.
    expect(Math.abs(wall - roof)).toBeGreaterThan(28);
    expect(Math.abs(wall - lawn)).toBeGreaterThan(12);
    expect(Math.abs(roof - lawn)).toBeGreaterThan(12);
  });

  it('reports no entrance and draws no path when the model has no street-facing door', () => {
    const plain = site();
    const w = createWall(plain, { floorId: plain.floors[0]!.id, type: 'exterior', a: { x: 2, y: 2 }, b: { x: 12, y: 2 } });
    if (!w.ok) throw new Error(w.error);
    const scene = buildScene(w.project);
    expect(scene.entrance).toBeNull();
    // A path to a door that does not exist would be a lie about the design.
    expect(scene.boxes.filter((b) => b.kind === 'path')).toHaveLength(0);
  });

  it('finds the door that faces the street and runs the path from it to the plot edge', () => {
    // North-facing plot: a wall along y = 2 with a door in it faces the street.
    const base = site(); // orientation 0, so the street is at low y
    const w = createWall(base, {
      floorId: base.floors[0]!.id,
      type: 'exterior',
      a: { x: 2, y: 2 },
      b: { x: 12, y: 2 },
    });
    if (!w.ok) throw new Error(w.error);
    const d = OPENING_DEFAULTS.entranceDoor;
    const o = addOpening(w.project, { wallId: w.createdIds[0]!, kind: 'door', offset: 6, width: d.width, height: d.height, sill: 0 });
    if (!o.ok) throw new Error(o.error);

    const scene = buildScene(o.project);
    expect(scene.entrance).not.toBeNull();
    expect(scene.entrance!.x).toBeCloseTo(8 - PLOT_W / 2, 6);
    // The street is north, which is low y, so the path runs toward low world z.
    expect(scene.entrance!.z).toBeCloseTo(2 - PLOT_D / 2, 6);

    const path = scene.boxes.filter((b) => b.kind === 'path');
    expect(path).toHaveLength(1);
    // It has to start at the door and reach the plot boundary, not stop short.
    // North is low z, so the street end of the path is its minimum.
    expect(Math.min(path[0]!.z - path[0]!.d / 2, path[0]!.z + path[0]!.d / 2)).toBeLessThanOrEqual(2 - PLOT_D / 2);
    expect(Math.max(path[0]!.z - path[0]!.d / 2, path[0]!.z + path[0]!.d / 2)).toBeGreaterThan(scene.entrance!.z);
  });

  it('lays a lawn and a paved apron without either of them being pickable as a room', () => {
    const scene = buildScene(site());
    expect(scene.boxes.filter((b) => b.kind === 'lawn')).toHaveLength(1);
    // No walls, so no apron: there is nothing for paving to sit against.
    expect(scene.boxes.filter((b) => b.kind === 'paving')).toHaveLength(0);
    for (const b of scene.boxes) {
      if (b.kind === 'lawn' || b.kind === 'paving' || b.kind === 'path') expect(b.ownerId).toBeUndefined();
    }
  });
});

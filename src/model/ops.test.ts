import { describe, expect, it } from 'vitest';
import {
  addFloor,
  addOpening,
  addFurniture,
  blankProject,
  createRoom,
  createWall,
  moveRoom,
  removeRoom,
  removeWall,
  renameFloor,
  resizeRoom,
  moveWall,
  setFloorHeight,
  setPlot,
  setRoomLabel,
} from './ops.ts';
import { OPENING_DEFAULTS, WALL_THICKNESS } from './catalog.ts';
import { measureBuilding, measureRoom } from './measure.ts';
import { rectOf } from './geometry.ts';
import type { Project } from './types.ts';

/** A project with one ground floor and a generous plot. */
function site(): Project {
  const p = blankProject('Test site');
  const plot = setPlot(p, { width: 24, depth: 18, orientation: 0, setbacks: { front: 3, rear: 3, left: 3, right: 3 } });
  if (!plot.ok) throw new Error(plot.error);
  return plot.project;
}

describe('createRoom', () => {
  it('creates a room with a stable id on the requested floor', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const res = createRoom(p, { floorId, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.project.rooms).toHaveLength(1);
    const r = res.project.rooms[0]!;
    expect(res.createdIds).toContain(r.id);
    expect(r.label).toBe('Bedroom');
    expect(res.project.floors[0]!.roomIds).toContain(r.id);
  });

  it('refuses a room with no usable size', () => {
    const p = site();
    const res = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bedroom', x: 4, y: 4, width: 0, depth: 3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('too_small');
    expect(res.error).toMatch(/too small/i);
    // A failed operation must not change anything.
    expect(p.rooms).toHaveLength(0);
  });

  it('refuses an unknown floor rather than creating a room in limbo', () => {
    const res = createRoom(site(), { floorId: 'fl_nope', kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_found');
  });

  it('gives two rooms the same input different ids', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'bedroom', x: 10, y: 4, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);
    expect(a.project.rooms[0]!.id).not.toBe(b.project.rooms[1]!.id);
  });
});

describe('resizeRoom', () => {
  const withRoom = () => {
    const p = site();
    const res = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!res.ok) throw new Error(res.error);
    return { p: res.project, id: res.createdIds[0]! };
  };

  it('changes the rectangle and the measured area together', () => {
    const { p, id } = withRoom();
    const res = resizeRoom(p, { roomId: id, width: 6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.project.rooms[0]!;
    expect(r.width).toBe(6);
    expect(measureRoom(res.project, id)!.area).toBeCloseTo(6 * 3, 10);
  });

  it('rejects a resize that would make the room a sliver', () => {
    const { p, id } = withRoom();
    const res = resizeRoom(p, { roomId: id, width: 0.05 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('too_small');
  });

  it('rejects a resize of a room that does not exist', () => {
    const { p } = withRoom();
    const res = resizeRoom(p, { roomId: 'rm_ghost', width: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_found');
  });

  it('recomputes wall membership when the room grows past a wall', () => {
    const { p, id } = withRoom();
    const floorId = p.floors[0]!.id;
    // A wall along the room's right edge, well clear of it to begin with.
    const wall = createWall(p, { floorId, type: 'interior', a: { x: 9, y: 4 }, b: { x: 9, y: 7 } });
    if (!wall.ok) throw new Error(wall.error);

    const before = wall.project.walls.find((w) => w.id === wall.createdIds[0])!.roomIds;
    expect(before).toHaveLength(0);

    const grown = resizeRoom(wall.project, { roomId: id, width: 5, anchor: 'top-left' });
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    const after = grown.project.walls.find((w) => w.id === wall.createdIds[0])!.roomIds;
    expect(after).toEqual([id]);
  });

  it('keeps the anchored corner fixed while the other one moves', () => {
    const { p, id } = withRoom();
    // The default anchor is bottom-right, so widening a room grows it to the
    // left and upward. The editor relies on this when dragging a handle; the
    // assistant passes explicit x/y instead.
    const res = resizeRoom(p, { roomId: id, width: 6 });
    if (!res.ok) throw new Error(res.error);
    const r = res.project.rooms[0]!;
    expect(r.x + r.width).toBeCloseTo(8, 10);
    expect(r.y + r.depth).toBeCloseTo(7, 10);
    expect(r.width).toBe(6);
  });
});

describe('moveRoom', () => {
  it('moves the rectangle without changing its size', () => {
    const p = site();
    const made = createRoom(p, { floorId: p.floors[0]!.id, kind: 'kitchen', x: 4, y: 4, width: 3, depth: 2.5 });
    if (!made.ok) throw new Error(made.error);
    const res = moveRoom(made.project, made.createdIds[0]!, 9, 7);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.project.rooms[0]!;
    expect([r.x, r.y]).toEqual([9, 7]);
    expect([r.width, r.depth]).toEqual([3, 2.5]);
  });

  it('rejects non-finite coordinates instead of storing NaN', () => {
    const p = site();
    const made = createRoom(p, { floorId: p.floors[0]!.id, kind: 'kitchen', x: 4, y: 4, width: 3, depth: 2.5 });
    if (!made.ok) throw new Error(made.error);
    const res = moveRoom(made.project, made.createdIds[0]!, Number.NaN, 7);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('invalid_input');
  });
});

describe('walls and openings', () => {
  it('binds a wall to the rooms it runs along', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 8, y: 4, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    const wall = createWall(b.project, {
      floorId,
      type: 'interior',
      a: { x: 8, y: 4 },
      b: { x: 8, y: 7 },
      thickness: WALL_THICKNESS.interior,
    });
    expect(wall.ok).toBe(true);
    if (!wall.ok) return;
    expect(wall.project.walls[0]!.roomIds.sort()).toEqual([a.createdIds[0]!, b.createdIds[0]!].sort());
  });

  it('gives a wall the default thickness for its type', () => {
    const p = site();
    const res = createWall(p, {
      floorId: p.floors[0]!.id,
      type: 'exterior',
      a: { x: 4, y: 4 },
      b: { x: 10, y: 4 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.project.walls[0]!.thickness).toBe(WALL_THICKNESS.exterior);
  });

  it('refuses a zero-length wall', () => {
    const p = site();
    const res = createWall(p, {
      floorId: p.floors[0]!.id,
      type: 'interior',
      a: { x: 4, y: 4 },
      b: { x: 4, y: 4 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('too_small');
  });

  it('clamps an opening that would hang off the end of its wall', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const wall = createWall(p, { floorId, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!wall.ok) throw new Error(wall.error);
    const wallId = wall.createdIds[0]!;

    const op = addOpening(wall.project, { wallId, kind: 'window', offset: 99, width: 1.5, height: 1.4, sill: 0.9 });
    expect(op.ok).toBe(true);
    if (!op.ok) return;
    const o = op.project.walls[0]!.openings[0]!;
    // 6 m wall, 1.5 m opening: the centre can be at most 5.25 m along.
    expect(o.offset).toBeLessThanOrEqual(6 - 0.75 + 1e-9);
    expect(o.offset).toBeGreaterThanOrEqual(0.75 - 1e-9);
  });

  it('rejects an opening on a wall that does not exist', () => {
    const res = addOpening(site(), {
      wallId: 'wl_ghost',
      kind: 'window',
      offset: 1,
      width: 1,
      height: 1,
      sill: 0.9,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_found');
  });

  it('takes its openings with it when the wall is deleted', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const wall = createWall(p, { floorId, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!wall.ok) throw new Error(wall.error);
    const wallId = wall.createdIds[0]!;
    const withDoor = addOpening(wall.project, {
      wallId,
      kind: 'door',
      offset: 3,
      width: OPENING_DEFAULTS.entranceDoor.width,
      height: OPENING_DEFAULTS.entranceDoor.height,
    });
    if (!withDoor.ok) throw new Error(withDoor.error);

    const gone = removeWall(withDoor.project, wallId);
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(gone.project.walls).toHaveLength(0);
    expect(gone.removedIds).toContain(wallId);
  });

  it('moves a wall endpoint and updates the rooms it binds', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const made = createRoom(p, { floorId, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!made.ok) throw new Error(made.error);
    const wall = createWall(made.project, { floorId, type: 'interior', a: { x: 8, y: 4 }, b: { x: 8, y: 7 } });
    if (!wall.ok) throw new Error(wall.error);

    const moved = moveWall(wall.project, { wallId: wall.createdIds[0]!, b: { x: 11, y: 7 } });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.project.walls[0]!.roomIds).toHaveLength(0);
  });
});

describe('furniture', () => {
  const withBathroom = () => {
    const p = site();
    const made = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bathroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!made.ok) throw new Error(made.error);
    return { p: made.project, roomId: made.createdIds[0]! };
  };

  it('places furniture inside the room it is assigned to', () => {
    const { p, roomId } = withBathroom();
    const res = addFurniture(p, { roomId, catalogId: 'bathtub', x: 6, y: 5.5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const f = res.project.furniture[0]!;
    const r = res.project.rooms[0]!;
    const b = rectOf(r);
    expect(f.x - f.width / 2).toBeGreaterThanOrEqual(b.x - 1e-6);
    expect(f.x + f.width / 2).toBeLessThanOrEqual(b.x + b.width + 1e-6);
  });

  it('rejects an unknown catalogue id instead of inventing furniture', () => {
    const { p, roomId } = withBathroom();
    const res = addFurniture(p, { roomId, catalogId: 'hovercraft', x: 6, y: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_found');
  });

  it('rejects furniture larger than the room holding it', () => {
    const p = site();
    const made = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bedroom', x: 4, y: 4, width: 1.6, depth: 1.6 });
    if (!made.ok) throw new Error(made.error);
    const res = addFurniture(made.project, { roomId: made.createdIds[0]!, catalogId: 'sofa-3', x: 4.8, y: 4.8 });
    expect(res.ok).toBe(false);
  });
});

describe('floors', () => {
  it('adds a floor above the previous one and links it', () => {
    const p = site();
    const res = addFloor(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const floors = res.project.floors;
    expect(floors).toHaveLength(2);
    expect(floors[1]!.elevation).toBeCloseTo(floors[0]!.height, 10);
    expect(floors[1]!.order).toBe(1);
  });

  it('renames a floor', () => {
    const p = site();
    const res = renameFloor(p, p.floors[0]!.id, 'Ground');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.project.floors[0]!.name).toBe('Ground');
  });

  it('moves every upper floor up when the ground floor gets taller', () => {
    let p = site();
    const added = addFloor(p);
    if (!added.ok) throw new Error(added.error);
    p = added.project;

    const taller = setFloorHeight(p, p.floors[0]!.id, 4);
    expect(taller.ok).toBe(true);
    if (!taller.ok) return;
    expect(taller.project.floors[1]!.elevation).toBeCloseTo(4, 10);
  });
});

describe('measurements follow the model', () => {
  it('sums room areas into the net indoor area', () => {
    let p = site();
    const floorId = p.floors[0]!.id;
    for (const [x, y, w, d] of [
      [4, 4, 4, 3],
      [8, 4, 4, 3],
      [4, 7, 4, 3],
    ] as const) {
      const r = createRoom(p, { floorId, kind: 'bedroom', x, y, width: w, depth: d });
      if (!r.ok) throw new Error(r.error);
      p = r.project;
    }
    const m = measureBuilding(p);
    expect(m.netIndoorArea).toBeCloseTo(3 * 12, 6);
    expect(m.plotArea).toBeCloseTo(24 * 18, 6);
    expect(m.plotCoverage).toBeCloseTo(36 / 432, 10);
  });

  it('reports open site area as what the building does not cover', () => {
    let p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'office', x: 4, y: 4, width: 6, depth: 5 });
    if (!r.ok) throw new Error(r.error);
    p = r.project;
    const m = measureBuilding(p);
    expect(m.openSiteArea).toBeCloseTo(m.plotArea - m.footprintArea, 6);
  });
});

describe('removal', () => {
  it('drops a room and everything derived from it', () => {
    let p = site();
    const floorId = p.floors[0]!.id;
    const made = createRoom(p, { floorId, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!made.ok) throw new Error(made.error);
    const roomId = made.createdIds[0]!;
    const fu = addFurniture(made.project, { roomId, catalogId: 'bed-double', x: 6, y: 5.5 });
    if (!fu.ok) throw new Error(fu.error);
    const furnId = fu.createdIds[0]!;

    const gone = removeRoom(fu.project, roomId);
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(gone.project.rooms).toHaveLength(0);
    expect(gone.project.furniture.map((f) => f.id)).not.toContain(furnId);
    expect(gone.removedIds).toContain(roomId);
  });

  it('reports which walls an orphaned opening belonged to', () => {
    const p = site();
    const res = removeRoom(p, 'rm_ghost');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/rm_ghost/);
  });
});

describe('labels and plot edits', () => {
  it('renames a room', () => {
    let p = site();
    const made = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!made.ok) throw new Error(made.error);
    const res = setRoomLabel(made.project, made.createdIds[0]!, 'Blue room');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.project.rooms[0]!.label).toBe('Blue room');
  });

  it('rejects a plot whose setbacks leave nothing to build on', () => {
    const res = setPlot(site(), { width: 2, depth: 2, setbacks: { front: 1, rear: 1, left: 1, right: 1 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('conflict');
    expect(res.error).toMatch(/not enough to build/i);
  });

  it('rejects negative setbacks rather than silently accepting them', () => {
    const res = setPlot(site(), { setbacks: { front: -1, rear: 3, left: 3, right: 3 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('invalid_input');
  });
});
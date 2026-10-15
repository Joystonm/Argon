/**
 * First-person camera collision.
 *
 * A walk-through where the camera passes through walls is worse than no
 * walk-through, so this is the module that decides whether the 3D view is
 * usable or embarrassing. Two properties matter and are tested separately:
 *
 *   1. the camera cannot end a move inside a solid, and
 *   2. approaching a wall at an angle *slides* along it rather than sticking.
 *
 * The second is the one that separates a walk-through from a shove.
 */
import { describe, expect, it } from 'vitest';
import {
  CAMERA_RADIUS,
  EYE_HEIGHT,
  canViewFromInside,
  clampToPlot,
  defaultInteriorRoom,
  headingFromYaw,
  moveWithCollision,
  overlapsCollider,
  principalFloorId,
  roomAt,
  roomFootprint,
  roomViewpoint,
  shortestAngle,
  snapToFloor,
  standBackDistance,
  walkableSurfaces,
  walkStart,
  WALK_VERGE,
  type RoomRect,
} from './collision.ts';
import type { Collider } from './sceneModel.ts';

/** A 10 m long wall of zero thickness, running east–west at z = 0. */
const wall: Collider = { x: 0, z: 0, w: 10, d: 0.2 };
/** A solid block, for testing corners. */
const block: Collider = { x: 3, z: 3, w: 2, d: 2 };

describe('overlapsCollider', () => {
  it('detects a point well inside a rect', () => {
    expect(overlapsCollider(0, 0, wall, CAMERA_RADIUS)).toBe(true);
  });

  it('clears a point comfortably outside', () => {
    expect(overlapsCollider(0, 2, wall, CAMERA_RADIUS)).toBe(false);
  });

  it('detects a circle that overlaps a rect corner', () => {
    // The corner of the wall is at (5, 0.1). A camera at (5.2, 0.2) is 0.22
    // away — just inside the 0.26 radius.
    expect(overlapsCollider(5.2, 0.2, wall, CAMERA_RADIUS)).toBe(true);
    expect(overlapsCollider(5.4, 0.3, wall, CAMERA_RADIUS)).toBe(false);
  });

  it('measures from the rect edge, not the centre', () => {
    // 0.3 m from the wall's long face: inside the radius.
    expect(overlapsCollider(0, 0.2, wall, CAMERA_RADIUS)).toBe(true);
  });
});

describe('moveWithCollision', () => {
  it('moves freely through open space', () => {
    const r = moveWithCollision(0, 5, 0, -1, [wall]);
    expect(r.x).toBe(0);
    expect(r.z).toBe(4);
    expect(r.touching).toBe(false);
  });

  it('cannot walk through a wall', () => {
    // Starting 1 m north of the wall, walking 3 m south would end inside it.
    const r = moveWithCollision(0, 1, 0, -3, [wall]);
    expect(r.z).toBeGreaterThan(0.1);
    expect(overlapsCollider(r.x, r.z, wall, CAMERA_RADIUS)).toBe(false);
    expect(r.touching).toBe(true);
  });

  it('stops the camera a radius clear of the surface, not overlapping it', () => {
    const r = moveWithCollision(0, 1, 0, -3, [wall]);
    expect(r.z).toBeCloseTo(0.1 + CAMERA_RADIUS, 6);
  });

  it('slides along a wall instead of sticking to it', () => {
    // Approach the wall diagonally: south-east. The camera should end up pressed
    // against the wall but well along its length, not stopped short of it.
    const r = moveWithCollision(-2, 0.6, 2, -1, [wall]);
    expect(r.touching).toBe(true);
    expect(r.z).toBeCloseTo(0.1 + CAMERA_RADIUS, 6);
    // The eastward component must not have been cancelled by the collision.
    expect(r.x).toBeCloseTo(0, 6);
  });

  it('blocks one axis while still allowing the other', () => {
    // Straight into the wall: x is blocked, and there is no z to recover.
    const r = moveWithCollision(0, 0.5, 0, -1, [wall]);
    expect(r.x).toBe(0);
    expect(r.z).toBeCloseTo(0.1 + CAMERA_RADIUS, 6);
  });

  it('lets the camera slide along the length of a long wall', () => {
    // Running parallel to the wall should be unimpeded.
    const r = moveWithCollision(-4, 0.5, 4, 0, [wall]);
    expect(r.x).toBe(0);
    expect(r.z).toBeCloseTo(0.5, 9);
  });

  it('is a no-op for a zero-length move', () => {
    const r = moveWithCollision(1, 2, 0, 0, [wall, block]);
    expect(r.x).toBe(1);
    expect(r.z).toBe(2);
  });

  it('never lets a legal position end up inside a solid', () => {
    // The invariant that matters, checked over a grid of starts and step
    // directions rather than a handful of hand-picked cases. Only starts that
    // are *not* already penetrating count: moveWithCollision guarantees the
    // camera never enters a solid, which is not the same claim as being able to
    // escape one it is already inside — a single step cannot clear an obstacle
    // thicker than itself.
    const steps: Array<[number, number]> = [[1, 0], [0, 1], [1, 1], [-1, 0.7], [0.1, 0.1], [-3, 2]];
    let checked = 0;
    for (let sx = -2; sx <= 2; sx += 0.25) {
      for (let sz = -2; sz <= 2; sz += 0.25) {
        const legal = !overlapsCollider(sx, sz, wall, CAMERA_RADIUS) && !overlapsCollider(sx, sz, block, CAMERA_RADIUS);
        if (!legal) continue;
        for (const [dx, dz] of steps) {
          const r = moveWithCollision(sx, sz, dx, dz, [wall, block]);
          expect(overlapsCollider(r.x, r.z, wall, CAMERA_RADIUS)).toBe(false);
          expect(overlapsCollider(r.x, r.z, block, CAMERA_RADIUS)).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('does not tunnel through a wall no matter how long the step', () => {
    // The bug this guards: an endpoint-only test lets a 3 m step pass clean
    // through a 0.2 m wall, because the destination happens to be clear again.
    // Only the southbound steps actually threaten the wall; the northbound ones
    // walk away from it and must stay free.
    for (const step of [-2, -3, -10]) {
      const r = moveWithCollision(0, 2, 0, step, [wall]);
      expect(r.z).toBeCloseTo(0.1 + CAMERA_RADIUS, 6);
    }
    // A step that stops short of the wall must not be dragged to it.
    expect(moveWithCollision(0, 2, 0, -1, [wall]).z).toBeCloseTo(1, 6);
    for (const step of [0.5, 1, 3, 10]) {
      const r = moveWithCollision(0, 2, 0, step, [wall]);
      expect(r.z).toBeCloseTo(2 + step, 6);
      expect(r.touching).toBe(false);
    }
  });

  it('does not tunnel sideways through a wall either', () => {
    // The wall runs east–west, so a long east–west step runs *along* it and a
    // long north–south step crosses it. Crossing at an offset end exercises the
    // same swept test without the wall's own extent interfering.
    const post: Collider = { x: 0, z: 0, w: 0.2, d: 0.2 };
    for (const step of [-3, -10]) {
      const r = moveWithCollision(2, 0, step, 0, [post]);
      expect(r.x).toBeCloseTo(0.1 + CAMERA_RADIUS, 6);
      expect(overlapsCollider(r.x, r.z, post, CAMERA_RADIUS)).toBe(false);
    }
  });

  it('honours a filter so a floor the camera is not on cannot block it', () => {
    const upperOnly: Collider = { x: 0, z: 0, w: 10, d: 0.2 };
    const onGround = moveWithCollision(0, 1, 0, -3, [upperOnly], CAMERA_RADIUS, () => false);
    expect(onGround.z).toBe(-2);
    expect(onGround.touching).toBe(false);
  });

  it('respects a custom radius', () => {
    // Start clear of the wall, then walk into it with a wide body.
    const fat = moveWithCollision(0, 2, 0, -3, [wall], 1.0);
    expect(fat.z).toBeCloseTo(0.1 + 1.0, 6);
    expect(overlapsCollider(fat.x, fat.z, wall, 1.0)).toBe(false);
  });
});

describe('snapToFloor — upwards only', () => {
  const candidates = [
    { y: 0, x: 0, z: 0, w: 10, d: 10 },
    { y: 3, x: 0, z: 0, w: 10, d: 10 },
    { y: 6, x: 0, z: 0, w: 10, d: 10 },
  ];

  it('stays where it is when already on a surface', () => {
    expect(snapToFloor(3, candidates)).toBe(3);
  });

  it('rises to a surface just above the camera', () => {
    expect(snapToFloor(5.9, candidates)).toBe(6);
    expect(snapToFloor(2.8, candidates)).toBe(3);
  });

  it('refuses to drop the camera onto a lower storey', () => {
    // Pressing "down" on a landing must not fall through to the floor below.
    expect(snapToFloor(4, candidates)).toBe(4);
    expect(snapToFloor(10, candidates)).toBe(10);
  });

  it('refuses to shove the camera up onto a slab more than a step away', () => {
    expect(snapToFloor(0, candidates)).toBe(0);
    expect(snapToFloor(5, candidates)).toBe(5);
  });

  it('returns the input height when there are no surfaces', () => {
    expect(snapToFloor(2, [])).toBe(2);
  });
});

describe('walkableSurfaces', () => {
  it('keeps slabs and stairs, and drops walls and furniture', () => {
    const boxes = [
      { kind: 'room-slab', y: 0, x: 0, z: 0, w: 4, d: 4, h: 0.2 },
      { kind: 'stair', y: 0.5, x: 2, z: 2, w: 1, d: 2, h: 0.05 },
      { kind: 'wall', y: 1, x: 0, z: 3, w: 4, d: 0.2, h: 3 },
      { kind: 'furniture', y: 0.5, x: 1, z: 1, w: 1, d: 1, h: 0.8 },
    ];
    const s = walkableSurfaces(boxes);
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.y >= 0)).toBe(true);
  });

  it('reports the surface height as the top of the box', () => {
    const s = walkableSurfaces([{ kind: 'room-slab', y: 0, x: 0, z: 0, w: 4, d: 4, h: 0.2 }]);
    expect(s[0]!.y).toBeCloseTo(0.1, 9);
  });
});

describe('clampToPlot', () => {
  it('leaves a point inside the envelope alone', () => {
    expect(clampToPlot(3, 4, { width: 20, depth: 16 })).toEqual({ x: 3, z: 4 });
  });

  it('pulls a point outside back to the edge', () => {
    const r = clampToPlot(50, -50, { width: 20, depth: 16 });
    expect(r.x).toBeCloseTo(10 - 0.5, 9);
    expect(r.z).toBeCloseTo(-8 + 0.5, 9);
  });

  it('honours the margin', () => {
    expect(clampToPlot(99, 0, { width: 20, depth: 16 }, 2).x).toBe(8);
  });
});

describe('headingFromYaw', () => {
  it('converts degrees to radians', () => {
    expect(headingFromYaw(0)).toBe(0);
    expect(headingFromYaw(180)).toBeCloseTo(Math.PI, 12);
    expect(headingFromYaw(90)).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('where the walk camera starts', () => {
  /** A house 11 m wide × 5 m deep, centred on the origin, walls 0.2 m thick. */
  function house(): { building: Parameters<typeof walkStart>[0]; plot: { width: number; depth: number }; colliders: Collider[] } {
    const t = 0.1;
    return {
      building: { minX: -5.5, maxX: 5.5, minZ: -2.5, maxZ: 2.5, width: 11, height: 3 },
      plot: { width: 18, depth: 14 },
      colliders: [
        { x: 0, z: -2.5, w: 11, d: t * 2 },
        { x: 0, z: 2.5, w: 11, d: t * 2 },
        { x: -5.5, z: 0, w: t * 2, d: 5 },
        { x: 5.5, z: 0, w: t * 2, d: 5 },
      ],
    };
  }

  it('does not start inside the building', () => {
    const h = house();
    const start = walkStart(h.building, h.plot, h.colliders);
    for (const c of h.colliders) {
      expect(overlapsCollider(start.x, start.z, c, CAMERA_RADIUS), 'started inside a wall').toBe(false);
    }
  });

  it('starts in front of the front wall, not on top of it', () => {
    const h = house();
    const start = walkStart(h.building, h.plot, h.colliders);
    expect(start.z).toBeGreaterThan(h.building.maxZ + 2);
  });

  it('stays within the plot plus the verge', () => {
    const h = house();
    const start = walkStart(h.building, h.plot, h.colliders);
    expect(start.z).toBeLessThanOrEqual(h.plot.depth / 2 - 0.5 + WALK_VERGE);
  });

  it('backs off further for a narrower viewport, because the horizontal field of view is the binding one', () => {
    const h = house();
    const wide = walkStart(h.building, h.plot, h.colliders, CAMERA_RADIUS, 2.2, 68);
    const tall = walkStart(h.building, h.plot, h.colliders, CAMERA_RADIUS, 0.55, 68);
    expect(tall.z).toBeGreaterThan(wide.z);
  });

  it('reproduces the old bug if the start position is clamped back inside the plot', () => {
    // This is the regression itself. The camera used to be placed at
    // plot.depth / 2 + 2.4 and then clamped inside the plot on the next frame,
    // which put it inside the front wall. The clamp must no longer do that.
    const h = house();
    const start = walkStart(h.building, h.plot, h.colliders);
    const afterOneFrame = clampToPlot(start.x, start.z, h.plot, 0.6, WALK_VERGE);
    expect(afterOneFrame.z).toBeCloseTo(start.z, 6);
    expect(afterOneFrame.z).toBeGreaterThan(h.building.maxZ);
  });

  it('stands on the side the street is on, whichever side that is', () => {
    // The regression: taking the largest z unconditionally put the camera at
    // the back of the house on every plot whose street ran the other way —
    // facing a blank wall, in shadow, with the front door behind the viewer.
    const h = house();
    for (const street of [{ x: 0, z: 1 }, { x: 0, z: -1 }, { x: 1, z: 0 }, { x: -1, z: 0 }]) {
      const start = walkStart(h.building, h.plot, h.colliders, CAMERA_RADIUS, 0.72, 68, street);
      const outward = start.x * street.x + start.z * street.z;
      // Beyond the building's far face on the street side, not short of it.
      const face = street.x !== 0 ? (street.x > 0 ? h.building.maxX : h.building.minX) : street.z > 0 ? h.building.maxZ : h.building.minZ;
      expect(outward, `street ${street.x},${street.z}`).toBeGreaterThan(face + 2);
      for (const c of h.colliders) {
        expect(overlapsCollider(start.x, start.z, c, CAMERA_RADIUS)).toBe(false);
      }
    }
  });
});

describe('standBackDistance', () => {
  it('grows with the thing it has to fit', () => {
    expect(standBackDistance(20, 3, 1.6, 60)).toBeGreaterThan(standBackDistance(8, 3, 1.6, 60));
  });

  it('grows as the viewport narrows', () => {
    expect(standBackDistance(10, 3, 0.6, 68)).toBeGreaterThan(standBackDistance(10, 3, 2.4, 68));
  });

  it('never returns a distance the camera could not actually see from', () => {
    const d = standBackDistance(12, 3, 0.72, 68);
    const hFov = 2 * Math.atan(Math.tan((68 * Math.PI) / 360) * 0.72);
    // The building's diagonal must fit inside the horizontal field of view.
    expect(d * 2 * Math.tan(hFov / 2)).toBeGreaterThanOrEqual(12);
  });
});

// ──────────────────────────────────────────────────── the inside camera ────

/** Plan → world, as `frameFor` produces it: the plot's centre is the origin. */
const frame = { tx: (x: number) => x - 10, tz: (y: number) => y - 8 };

const room = (over: Partial<RoomRect> = {}): RoomRect => ({
  id: 'r1',
  label: 'Living room',
  floorId: 'f0',
  kind: 'living',
  x: 2,
  y: 2,
  width: 6,
  depth: 5,
  height: 2.7,
  ...over,
});

/** The 6 × 5 living room, in plan coordinates. World footprint is −8..−2 × −6..−1. */
const big = room();

describe('roomFootprint', () => {
  it('moves the room rectangle into world space', () => {
    // Plan 2..8 by 2..7, on a 20 × 16 plot centred on the origin.
    expect(roomFootprint(room(), frame)).toMatchObject({
      minX: -8,
      maxX: -2,
      minZ: -6,
      maxZ: -1,
      cx: -5,
      cz: -3.5,
    });
  });
});

describe('canViewFromInside', () => {
  it('refuses outdoor spaces, garages and anything too small to stand in', () => {
    expect(canViewFromInside(room({ outdoor: true }))).toBe(false);
    expect(canViewFromInside(room({ kind: 'garage' }))).toBe(false);
    expect(canViewFromInside(room({ kind: 'balcony' }))).toBe(false);
    expect(canViewFromInside(room({ width: 0.4, depth: 4 }))).toBe(false);
    expect(canViewFromInside(room({ kind: 'bathroom', width: 2, depth: 2.4 }))).toBe(true);
  });
});

describe('defaultInteriorRoom', () => {
  it('opens on a living room rather than a larger hall', () => {
    const rooms = [
      room({ id: 'hall', label: 'Hall', kind: 'hall', width: 4, depth: 6 }),
      room({ id: 'living', label: 'Living room', kind: 'living' }),
    ];
    expect(defaultInteriorRoom(rooms)?.id).toBe('living');
  });

  it('opens on the ground floor, not on a larger storey above it', () => {
    // A big upstairs landing against a small ground-floor kitchen. Lowest wins:
    // you walk into a house at ground level.
    const rooms = [
      room({ id: 'k', floorId: 'f0', kind: 'kitchen', width: 3, depth: 3 }),
      room({ id: 'landing', floorId: 'f1', kind: 'hall', width: 8, depth: 6 }),
    ];
    const order = new Map([['f0', 0], ['f1', 1]]);
    expect(defaultInteriorRoom(rooms, order)?.id).toBe('k');
    expect(principalFloorId(rooms, order)).toBe('f0');
  });

  it('goes upstairs when the ground floor has nothing worth standing in', () => {
    const rooms = [
      room({ id: 'store', floorId: 'f0', kind: 'storage', width: 3, depth: 3 }),
      room({ id: 'bed', floorId: 'f1', kind: 'bedroom', width: 4, depth: 4 }),
    ];
    const order = new Map([['f0', 0], ['f1', 1]]);
    expect(defaultInteriorRoom(rooms, order)?.id).toBe('bed');
  });

  it('falls back to the biggest room when none is on the preferred list', () => {
    const rooms = [
      room({ id: 'small', label: 'Store', kind: 'storage', width: 2, depth: 2 }),
      room({ id: 'big', label: 'Workshop', kind: 'utility', width: 5, depth: 5 }),
    ];
    expect(defaultInteriorRoom(rooms)?.id).toBe('big');
  });

  it('returns nothing when there is nowhere to stand', () => {
    expect(defaultInteriorRoom([room({ outdoor: true })])).toBeNull();
    expect(defaultInteriorRoom([])).toBeNull();
  });
});

describe('roomViewpoint', () => {
  it('stands inside the room, clear of every wall', () => {
    const v = roomViewpoint(big, frame);
    const f = roomFootprint(big, frame);
    expect(v.x).toBeGreaterThan(f.minX + CAMERA_RADIUS);
    expect(v.x).toBeLessThan(f.maxX - CAMERA_RADIUS);
    expect(v.z).toBeGreaterThan(f.minZ + CAMERA_RADIUS);
    expect(v.z).toBeLessThan(f.maxZ - CAMERA_RADIUS);
    expect(v.y).toBeCloseTo(EYE_HEIGHT, 6);
  });

  it('stands in a corner, not on the centre line', () => {
    const f = roomFootprint(big, frame);
    const v = roomViewpoint(big, frame);
    const inset = CAMERA_RADIUS + 0.18;
    // Every corner is the same distance from the middle of a rectangle, so the
    // "furthest from the building's middle" sort cannot break the tie — it is
    // the first corner of the list, at +x +z.
    expect(v.x).toBeCloseTo(f.maxX - inset, 6);
    expect(v.z).toBeCloseTo(f.maxZ - inset, 6);
    // Standing in the middle and facing the far wall is the framing this
    // exists to avoid: in a room this size it fills the frame with one plane.
    expect(v.x).not.toBeCloseTo(f.cx, 2);
    expect(v.z).not.toBeCloseTo(f.cz, 2);
  });

  it('stands in the corner furthest from the middle of the building', () => {
    const f = roomFootprint(big, frame);
    const bc = { x: f.maxX + 6, z: f.maxZ + 6 };
    const v = roomViewpoint(big, frame, { buildingCentre: bc });
    // The building's middle is off past +x +z, so the camera is in the far
    // −x −z corner, looking back across the room toward it.
    const inset = CAMERA_RADIUS + 0.18;
    expect(v.x).toBeCloseTo(f.minX + inset, 6);
    expect(v.z).toBeCloseTo(f.minZ + inset, 6);
  });

  it('uses a corner in a room deeper than it is wide, too', () => {
    const tall = room({ width: 4, depth: 7 });
    const f = roomFootprint(tall, frame);
    const v = roomViewpoint(tall, frame);
    const inset = CAMERA_RADIUS + 0.18;
    expect([f.minX + inset, f.maxX - inset]).toContain(Number(v.x.toFixed(6)));
    expect([f.minZ + inset, f.maxZ - inset]).toContain(Number(v.z.toFixed(6)));
  });

  it('looks at the middle of the room', () => {
    const f = roomFootprint(big, frame);
    const v = roomViewpoint(big, frame);
    const d = Math.hypot(f.cx - v.x, f.cz - v.z);
    expect(d).toBeGreaterThan(0);
    // The camera looks down its local −Z, so with yaw 0 its forward vector in
    // world (x, z) is (−sin yaw, −cos yaw).
    expect(Math.sin((v.yaw * Math.PI) / 180)).toBeCloseTo(-(f.cx - v.x) / d, 6);
    expect(Math.cos((v.yaw * Math.PI) / 180)).toBeCloseTo(-(f.cz - v.z) / d, 6);
  });

  it('aims a little below eye level, so the floor is in shot', () => {
    const v = roomViewpoint(big, frame);
    expect(v.pitch).toBeLessThan(0);
    expect(v.pitch).toBeGreaterThan(-12);
  });

  it('stands on the storey it was told to', () => {
    expect(roomViewpoint(big, frame, { elevation: 3 }).y).toBeCloseTo(3 + EYE_HEIGHT, 6);
  });

  it('steps in off the corners when all four are occupied', () => {
    const f = roomFootprint(big, frame);
    const bc = { x: f.maxX + 6, z: f.maxZ + 6 };
    const inset = CAMERA_RADIUS + 0.18;
    const corners = (
      [
        [f.minX + inset, f.minZ + inset],
        [f.minX + inset, f.maxZ - inset],
        [f.maxX - inset, f.minZ + inset],
        [f.maxX - inset, f.maxZ - inset],
      ] as Array<[number, number]>
    ).map(([x, z]) => ({ x, z, w: 0.9, d: 0.9 }));
    const v = roomViewpoint(big, frame, { buildingCentre: bc, colliders: corners });
    for (const c of corners) expect(overlapsCollider(v.x, v.z, c, CAMERA_RADIUS)).toBe(false);
    // Moved off the wall and in towards the middle rather than standing in one.
    expect(Math.hypot(v.x - f.cx, v.z - f.cz)).toBeLessThan(
      Math.hypot(f.minX + inset - f.cx, f.minZ + inset - f.cz),
    );
  });

  it('still answers when the room is completely full', () => {
    const f = roomFootprint(big, frame);
    // Every candidate blocked: there is no legal answer to give.
    const solid = { x: f.cx, z: f.cz, w: f.maxX - f.minX, d: f.maxZ - f.minZ };
    const v = roomViewpoint(big, frame, { colliders: [solid] });
    // So it falls back to the middle rather than throwing — and returns a
    // real viewpoint either way.
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.z)).toBe(true);
    expect(Number.isFinite(v.yaw)).toBe(true);
  });

  it('views a room too small for corners from its middle', () => {
    const tiny = room({ width: 1, depth: 1 });
    const f = roomFootprint(tiny, frame);
    const v = roomViewpoint(tiny, frame);
    expect(v.x).toBeCloseTo(f.cx, 6);
    expect(v.z).toBeCloseTo(f.cz, 6);
  });
});

describe('roomAt', () => {
  it('names the room the camera is standing in', () => {
    const bed = room({ id: 'bed', label: 'Bedroom', x: 8, y: 2, width: 4, depth: 4 });
    const f = roomFootprint(big, frame);
    expect(roomAt(f.cx, f.cz, [big, bed], frame)?.label).toBe('Living room');
    const bf = roomFootprint(bed, frame);
    expect(roomAt(bf.cx, bf.cz, [big, bed], frame)?.label).toBe('Bedroom');
  });

  it('returns the smallest match, so a room placed over another is still named', () => {
    const inner = room({ id: 'inner', label: 'Alcove', x: 3, y: 3, width: 2, depth: 2 });
    const f = roomFootprint(inner, frame);
    expect(roomAt(f.cx, f.cz, [big, inner], frame)?.id).toBe('inner');
  });

  it('ignores rooms on other storeys when a floor is given', () => {
    const upstairs = room({ id: 'up', label: 'Bedroom', floorId: 'f1' });
    const f = roomFootprint(upstairs, frame);
    expect(roomAt(f.cx, f.cz, [upstairs], frame, 'f1')?.id).toBe('up');
    expect(roomAt(f.cx, f.cz, [upstairs], frame, 'f0')).toBeNull();
  });

  it('returns nothing outdoors', () => {
    const f = roomFootprint(big, frame);
    expect(roomAt(f.cx + 40, f.cz, [big], frame)).toBeNull();
  });
});

describe('shortestAngle', () => {
  it('takes the short way round the ±180° seam', () => {
    expect(shortestAngle(179, -179)).toBeCloseTo(2, 6);
    expect(shortestAngle(-179, 179)).toBeCloseTo(-2, 6);
  });

  it('leaves an ordinary turn alone', () => {
    expect(shortestAngle(0, 90)).toBeCloseTo(90, 6);
    expect(shortestAngle(90, 0)).toBeCloseTo(-90, 6);
    expect(shortestAngle(-10, 10)).toBeCloseTo(20, 6);
  });
});

import { describe, expect, it } from 'vitest';
import { blankProject, createRoom } from './ops.ts';
import { emptyFromBrief, generateFromBrief, gridFromBrief, rebuildWallsFromRooms } from './layout.ts';
import { validate } from './validate.ts';
import { measureBuilding } from './measure.ts';
import { buildCirculation } from './circulation.ts';
import { boundarySegments } from './plan.ts';
import { rectArea, rectOf } from './geometry.ts';
import type { DesignBrief, Room } from './types.ts';

const baseBrief = (over: Partial<DesignBrief> = {}): DesignBrief => ({
  plot: { width: 15, depth: 20, orientation: 0, setbacks: { front: 4.5, rear: 4.5, left: 3, right: 3 } },
  floorCount: 1,
  rooms: [
    { kind: 'living', count: 1 },
    { kind: 'dining', count: 1 },
    { kind: 'kitchen', count: 1 },
    { kind: 'bedroom', count: 3 },
    { kind: 'bathroom', count: 2 },
    { kind: 'utility', count: 1 },
  ],
  preferredAreas: {},
  style: 'modern',
  preferences: { accessibility: false, ventilation: false, privacy: false, daylight: true },
  ...over,
});

function generate(brief: DesignBrief) {
  const project = blankProject('Test');
  const res = generateFromBrief(project, brief);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

describe('brief → layout generator', () => {
  it('produces rooms, walls and furniture for a standard 3-bed brief', () => {
    const p = generate(baseBrief());
    expect(p.rooms.length).toBeGreaterThanOrEqual(7);
    expect(p.walls.length).toBeGreaterThan(8);
    expect(p.furniture.length).toBeGreaterThan(0);
  });

  it('fits every room inside the buildable envelope', () => {
    const brief = baseBrief();
    const p = generate(brief);
    const env = {
      x: brief.plot.setbacks.left,
      y: brief.plot.setbacks.front,
      w: brief.plot.width - brief.plot.setbacks.left - brief.plot.setbacks.right,
      d: brief.plot.depth - brief.plot.setbacks.front - brief.plot.setbacks.rear,
    };
    for (const r of p.rooms) {
      expect(r.x).toBeGreaterThanOrEqual(env.x - 0.02);
      expect(r.y).toBeGreaterThanOrEqual(env.y - 0.02);
      expect(r.x + r.width).toBeLessThanOrEqual(env.x + env.w + 0.02);
      expect(r.y + r.depth).toBeLessThanOrEqual(env.y + env.d + 0.02);
    }
  });

  it('never produces overlapping rooms on a floor', () => {
    const p = generate(baseBrief());
    const issues = validate(p).filter((i) => i.code === 'room_overlap');
    expect(issues.map((i) => i.message)).toEqual([]);
  });

  it('gives every room a door and a reachable path from outside', () => {
    const p = generate(baseBrief());
    const ground = p.floors[0]!;
    const g = buildCirculation(p, ground.id);
    expect(g.hasEntrance).toBe(true);
    for (const r of p.rooms.filter((x) => x.floorId === ground.id && x.kind !== 'corridor')) {
      expect(g.reachable.has(r.id)).toBe(true);
    }
  });

  it('emits no error-severity issues on a clean generated plan', () => {
    const p = generate(baseBrief());
    const errors = validate(p).filter((i) => i.severity === 'error');
    expect(errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
  });

  it('reports areas that add up and a sane plot coverage', () => {
    const p = generate(baseBrief());
    const m = measureBuilding(p);
    expect(m.plotArea).toBeCloseTo(300, 5);
    expect(m.netIndoorArea).toBeGreaterThan(60);
    expect(m.plotCoverage).toBeGreaterThan(0.2);
    expect(m.plotCoverage).toBeLessThan(0.65);
    // Rooms should tile most of the buildable envelope.
    const env = m.buildableArea;
    expect(m.netIndoorArea / env).toBeGreaterThan(0.85);
  });

  it('handles a two-storey brief and connects the floors with a stair', () => {
    const brief = baseBrief({
      floorCount: 2,
      rooms: [
        { kind: 'living', count: 1 },
        { kind: 'dining', count: 1 },
        { kind: 'kitchen', count: 1 },
        { kind: 'bedroom', count: 4 },
        { kind: 'bathroom', count: 2 },
        { kind: 'office', count: 1 },
      ],
    });
    const p = generate(brief);
    expect(p.floors.length).toBe(2);
    expect(p.stairs.length).toBeGreaterThanOrEqual(1);
    const issues = validate(p).filter((i) => i.severity === 'error');
    expect(issues.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
  });

  it('glazes every outside wall instead of rounding a shared budget down to none', () => {
    // The bug this guards: windows were funded from one budget spread over the
    // perimeter, so every short wall got a fraction of a window, rounded to
    // zero, and whole plans came out with no glazing and no error saying so.
    const p = generate(baseBrief());
    const windows = p.walls.flatMap((w) => w.openings).filter((o) => o.kind === 'window');
    expect(windows.length).toBeGreaterThan(0);
    const glazing = windows.reduce((s, o) => s + o.width * o.height, 0);
    const indoor = p.rooms.filter((r) => !r.outdoor).reduce((s, r) => s + r.width * r.depth, 0);
    expect(glazing / indoor).toBeGreaterThan(0.12);
  });

  it('never parks furniture in a door swing', () => {
    // The furnisher keeps clear of the sweeps it is given, so a plan does not
    // open with warnings the user has not earned.
    for (const brief of [baseBrief(), baseBrief({ floorCount: 2 })]) {
      const p = generate(brief);
      const blocked = validate(p).filter((i) => i.code === 'door_swing_blocked').map((i) => i.message);
      expect(blocked).toEqual([]);
    }
  });

  it('refuses a plot whose setbacks leave nothing to build on', () => {
    const brief = baseBrief({
      plot: { width: 8, depth: 8, orientation: 0, setbacks: { front: 3, rear: 3, left: 2, right: 2 } },
    });
    const res = generateFromBrief(blankProject(), brief);
    expect(res.ok).toBe(false);
  });

  it('warns when the brief asks for more area than the plot allows', () => {
    const brief = baseBrief({
      plot: { width: 10, depth: 10, orientation: 0, setbacks: { front: 2, rear: 2, left: 2, right: 2 } },
      rooms: [
        { kind: 'living', count: 1, targetArea: 40 },
        { kind: 'bedroom', count: 5, targetArea: 20 },
        { kind: 'bathroom', count: 3, targetArea: 8 },
      ],
    });
    const project = blankProject();
    const res = generateFromBrief(project, brief);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.report.warnings.join(' ')).toMatch(/scaled/i);
    }
  });
});

describe('boundary tracing', () => {
  const room = (x: number, y: number, width: number, depth: number): Room => ({
    id: `rm_${x}_${y}`,
    floorId: 'fl_1',
    kind: 'bedroom',
    label: 'r',
    x,
    y,
    width,
    depth,
    height: 2.7,
  });

  it('traces a single rectangle as four edges', () => {
    const segs = boundarySegments([room(0, 0, 4, 3)]);
    expect(segs).toHaveLength(4);
  });

  it('removes the shared edge of two flush rooms', () => {
    const segs = boundarySegments([room(0, 0, 4, 3), room(4, 0, 4, 3)]);
    // 4 + 4 edges minus the shared vertical edge = 6
    expect(segs).toHaveLength(6);
  });

  it('preserves a notch instead of filling it with a bounding box', () => {
    // An L shape: a 6×6 square with a 3×3 bite out of the bottom-right.
    const segs = boundarySegments([room(0, 0, 6, 3), room(0, 3, 3, 3)]);
    const xs = segs.flatMap((s) => [s.a.x, s.b.x]);
    const ys = segs.flatMap((s) => [s.a.y, s.b.y]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(6);
    expect(Math.max(...ys)).toBe(6);
    // The concave corner at (3,3) must appear, which a bounding box cannot do.
    expect(segs.some((s) => s.a.x === 3 && s.a.y === 3) || segs.some((s) => s.b.x === 3 && s.b.y === 3)).toBe(true);
  });

  it('does not cancel edges of rooms stacked in the same direction', () => {
    // Room A on top of room B: their touching edges are NOT coplanar, so both
    // survive — the shared line is interior to the union and should not appear.
    const segs = boundarySegments([room(0, 0, 4, 3), room(0, 3, 4, 3)]);
    const interior = segs.filter((s) => s.a.y === 3 && s.b.y === 3);
    expect(interior).toHaveLength(0);
  });
});

describe('measurement formulas', () => {
  it('computes coverage and FAR from the documented formulas', () => {
    const brief = baseBrief();
    const p = generate(brief);
    const m = measureBuilding(p);
    expect(m.openSiteArea).toBeCloseTo(m.plotArea - m.footprintArea, 6);
    expect(m.plotCoverage).toBeCloseTo(m.footprintArea / m.plotArea, 10);
    expect(m.floorAreaRatio).toBeCloseTo(m.grossCoveredArea / m.plotArea, 10);
  });

  it('reports per-floor areas that sum to the total', () => {
    const brief = baseBrief({ floorCount: 2 });
    const p = generate(brief);
    const m = measureBuilding(p);
    const summed = m.perFloor.reduce((s, f) => s + f.netArea, 0);
    expect(summed).toBeCloseTo(m.netIndoorArea, 6);
  });

  it('uses real areas for each room rectangle', () => {
    const p = generate(baseBrief());
    for (const m of measureBuilding(p).rooms) {
      const room = p.rooms.find((r) => r.id === m.roomId)!;
      expect(m.area).toBeCloseTo(rectArea(rectOf(room)), 10);
    }
  });
});

describe('emptyFromBrief', () => {
  it('keeps the plot and the storeys, and nothing else', () => {
    const brief = baseBrief({ floorCount: 2 });
    const res = emptyFromBrief(blankProject(), brief);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.floorCount).toBe(2);
    expect(res.data.project.floors).toHaveLength(2);
    expect(res.data.project.plot.width).toBe(brief.plot.width);
    expect(res.data.project.plot.setbacks.front).toBe(brief.plot.setbacks.front);
    expect(res.data.project.rooms).toHaveLength(0);
    expect(res.data.project.walls).toHaveLength(0);
    expect(res.data.project.furniture).toHaveLength(0);
    expect(res.data.project.brief).toEqual(brief);
  });

  it('stacks the second floor above the first', () => {
    const res = emptyFromBrief(blankProject(), baseBrief({ floorCount: 2 }));
    if (!res.ok) return;
    const [ground, first] = res.data.project.floors;
    expect(ground!.elevation).toBe(0);
    expect(first!.elevation).toBeCloseTo(ground!.height, 9);
    expect(first!.elevation).toBeGreaterThan(0);
  });

  it('gives a fresh project a floor, so the room palette works straight away', () => {
    // The bug this guards: a project built from emptyProject() has zero floors,
    // and every createRoom against it fails with "no floors yet".
    const res = emptyFromBrief(blankProject('Untitled home'), baseBrief());
    if (!res.ok) return;
    const room = createRoom(res.data.project, { floorId: res.data.project.floors[0]!.id, kind: 'kitchen', x: 3, y: 3, width: 4, depth: 3.5 });
    expect(room.ok).toBe(true);
  });
});

describe('gridFromBrief', () => {
  const grid = (over: Partial<DesignBrief> = {}) => {
    const brief = baseBrief(over);
    const res = gridFromBrief(blankProject(), brief);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    return { brief, project: res.data.project, report: res.data.report };
  };

  it('tiles the buildable envelope exactly, with no gaps and no overlaps', () => {
    const { brief, project } = grid();
    const envW = brief.plot.width - brief.plot.setbacks.left - brief.plot.setbacks.right;
    const envD = brief.plot.depth - brief.plot.setbacks.front - brief.plot.setbacks.rear;
    const covered = project.rooms.reduce((s, r) => s + r.width * r.depth, 0);
    expect(covered).toBeCloseTo(envW * envD, 6);
    for (const r of project.rooms) {
      expect(r.x).toBeGreaterThanOrEqual(brief.plot.setbacks.left - 0.01);
      expect(r.y).toBeGreaterThanOrEqual(brief.plot.setbacks.front - 0.01);
      expect(r.x + r.width).toBeLessThanOrEqual(brief.plot.setbacks.left + envW + 0.01);
      expect(r.y + r.depth).toBeLessThanOrEqual(brief.plot.setbacks.front + envD + 0.01);
    }
    expect(validate(project).filter((i) => i.code === 'room_overlap').map((i) => i.message)).toEqual([]);
  });

  it('gives the brief’s rooms, once each', () => {
    const { brief, project } = grid();
    const wanted = brief.rooms.flatMap((r) => Array.from({ length: r.count }, () => r.kind));
    expect(project.rooms.length).toBe(wanted.length);
    for (const kind of wanted) {
      expect(project.rooms.filter((r) => r.kind === kind).length).toBe(wanted.filter((k) => k === kind).length);
    }
  });

  it('makes a cell no narrower than a room can be, and reports the lattice it chose', () => {
    const { report, project } = grid();
    expect(report.cellWidth).toBeGreaterThanOrEqual(2.4);
    expect(report.cellDepth).toBeGreaterThanOrEqual(2.4);
    expect(report.columns * report.rows).toBeGreaterThanOrEqual(project.rooms.length);
    for (const r of project.rooms) {
      expect(r.width).toBeGreaterThanOrEqual(2.4);
      expect(r.depth).toBeGreaterThanOrEqual(2.4);
    }
  });

  it('produces a real plan: walls around the rooms, doors between them, no errors', () => {
    const { project } = grid();
    expect(project.floors).toHaveLength(1);
    expect(project.walls.length).toBeGreaterThan(4);
    const openings = project.walls.flatMap((w) => w.openings);
    expect(openings.length).toBeGreaterThan(0);
    expect(openings.some((o) => o.kind === 'door')).toBe(true);
    expect(openings.some((o) => o.kind === 'window')).toBe(true);
    expect(validate(project).filter((i) => i.severity === 'error').map((i) => `${i.code}: ${i.message}`)).toEqual([]);
  });

  it('opens with no furniture in a door swing, even in cramped cells', () => {
    // The grid is where this bites: a 2.5 m cell is barely wider than a door.
    const { project } = grid();
    const blocked = validate(project).filter((i) => i.code === 'door_swing_blocked').map((i) => i.message);
    expect(blocked).toEqual([]);
  });

  it('stretches a short last row across the full width rather than leaving a gap', () => {
    // 7 rooms will not make a full rectangle on the default envelope, so the
    // lattice has a partial row. It must still tile.
    const { project } = grid();
    const widths = new Set(project.rooms.map((r) => Math.round(r.width * 1000)));
    // Only two distinct widths is the signature of a stretched final row.
    expect(widths.size).toBeLessThanOrEqual(2);
  });

  it('says so when the grid cannot honour the room sizes, instead of pretending', () => {
    const { report } = grid({
      rooms: [
        { kind: 'living', count: 1, targetArea: 80 },
        { kind: 'bedroom', count: 6, targetArea: 30 },
      ],
    });
    expect(report.warnings.join(' ')).toMatch(/grid gives every room the same shape/i);
  });

  it('refuses a plot whose setbacks leave no room-sized space', () => {
    const res = gridFromBrief(blankProject(), baseBrief({
      plot: { width: 8, depth: 8, orientation: 0, setbacks: { front: 3.2, rear: 3.2, left: 2, right: 2 } },
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('conflict');
    expect(res.hint).toMatch(/empty plot/i);
  });

  it('gives a brief with nothing ticked a living room, because a house needs a way in', () => {
    // expandBrief is what does this, for the generator too: an empty room list
    // would produce a plan with no entrance at all.
    const { project } = grid({ rooms: [] });
    expect(project.rooms.length).toBe(1);
    expect(project.rooms[0]!.kind).toBe('living');
  });

  it('warns that it laid out one floor when the brief asked for more', () => {
    const { report, project } = grid({ floorCount: 3 });
    expect(project.floors).toHaveLength(1);
    expect(report.warnings.join(' ')).toMatch(/single-floor/i);
  });
});

describe('rebuildWallsFromRooms', () => {
  const floorOf = (p: ReturnType<typeof generate>) => p.floors[0]!.id;

  it('keeps every piece of furniture exactly where the user put it', () => {
    const p = generate(baseBrief());
    const floorId = floorOf(p);
    const before = p.furniture.map((f) => ({ id: f.id, x: f.x, y: f.y }));

    const { project, report } = rebuildWallsFromRooms(p, floorId);

    expect(report.furnitureKept).toBe(before.length);
    const after = project.furniture.filter((f) => f.floorId === floorId);
    expect(after.length).toBe(before.length);
    for (const b of before) {
      const a = after.find((f) => f.id === b.id);
      expect(a, `furniture ${b.id} survived`).toBeTruthy();
      expect(a!.x).toBeCloseTo(b.x, 9);
      expect(a!.y).toBeCloseTo(b.y, 9);
    }
  });

  it('does not re-run the furnisher', () => {
    // A rebuild of an unfurnished plan must leave it unfurnished, or every press
    // of the button would quietly add another sofa.
    const p = generate(baseBrief());
    const stripped = { ...p, furniture: [] };
    const { project, report } = rebuildWallsFromRooms(stripped, floorOf(stripped));
    expect(report.furnitureKept).toBe(0);
    expect(project.furniture.filter((f) => f.floorId === floorOf(stripped))).toHaveLength(0);
  });

  it('carries doors and windows onto the rebuilt walls', () => {
    const p = generate(baseBrief());
    const floorId = floorOf(p);
    const before = p.walls.filter((w) => w.floorId === floorId).flatMap((w) => w.openings);
    expect(before.length).toBeGreaterThan(0);

    const { project, report } = rebuildWallsFromRooms(p, floorId);
    const after = project.walls.filter((w) => w.floorId === floorId).flatMap((w) => w.openings);

    expect(report.openingsKept + report.openingsDropped).toBe(before.length);
    expect(after.length).toBe(before.length);
    for (const o of before) {
      const m = after.find((x) => x.id === o.id);
      expect(m, `opening ${o.id} survived`).toBeTruthy();
      expect(m!.kind).toBe(o.kind);
      expect(m!.width).toBeCloseTo(o.width, 9);
    }
  });

  it('rebuilds walls around the rooms rather than leaving the old geometry', () => {
    const p = generate(baseBrief());
    const floorId = floorOf(p);
    const { project } = rebuildWallsFromRooms(p, floorId);
    const walls = project.walls.filter((w) => w.floorId === floorId);
    expect(walls.length).toBeGreaterThan(0);
    for (const r of project.rooms.filter((r) => r.floorId === floorId)) {
      const touching = walls.filter(
        (w) =>
          Math.min(w.a.x, w.b.x) <= r.x + r.width + 0.35 &&
          Math.max(w.a.x, w.b.x) >= r.x - 0.35 &&
          Math.min(w.a.y, w.b.y) <= r.y + r.depth + 0.35 &&
          Math.max(w.a.y, w.b.y) >= r.y - 0.35,
      );
      expect(touching.length, `room ${r.id} has walls`).toBeGreaterThan(0);
    }
  });

  it('reports rather than inventing a home for an opening with no wall', () => {
    const p = generate(baseBrief());
    const floorId = floorOf(p);
    // An opening on a wall nowhere near the built envelope cannot be carried
    // anywhere, and must be reported rather than quietly relocated.
    const withStray = {
      ...p,
      walls: [
        ...p.walls,
        {
          id: 'w_stray',
          floorId,
          type: 'exterior' as const,
          thickness: 0.2,
          a: { x: 0.4, y: 0.4 },
          b: { x: 1.4, y: 0.4 },
          height: 2.7,
          roomIds: [],
          openings: [{ id: 'op_stray', kind: 'door' as const, offset: 0.5, width: 0.9, height: 2.1, sill: 0, material: 'door.timber' }],
        },
      ],
    };
    const { report } = rebuildWallsFromRooms(withStray, floorId);
    expect(report.openingsDropped).toBe(1);
  });
});
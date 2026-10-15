/**
 * Tests for the validation engine.
 *
 * Every assertion below is derived from the arithmetic in `validate.ts`,
 * `geometry.ts`, `circulation.ts` and `measure.ts`, and the arithmetic is
 * written out in a comment next to the test that depends on it.
 *
 * Where a defect cannot be produced through `ops.ts` — because the operation
 * layer refuses to build it (a zero-length wall, an opening that hangs off the
 * end of its wall, a stair narrower than `addStaircase` allows) — the model is
 * built directly and marked with a `hand-built` comment. Those states are
 * exactly the states the operation layer exists to prevent, and the validator
 * still has to survive them: a project can arrive from a save file, an import
 * or an older schema.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  errorsOnly,
  issuesFor,
  openingRectsFor,
  validate,
  wallFootprint,
} from './validate.ts';
import {
  addFloor,
  addFurniture,
  addOpening,
  addStaircase,
  blankProject,
  createRoom,
  createWall,
  resizeRoom,
  setBrief,
  setPlot,
} from './ops.ts';
import { OPENING_DEFAULTS, WALL_THICKNESS } from './catalog.ts';
import { TOL } from './geometry.ts';
import type { ConstraintRules } from './validate.ts';
import type {
  DesignBrief,
  Opening,
  Project,
  Rect,
  Room,
  RoomKind,
  Staircase,
  Wall,
} from './types.ts';

/** Axis-aligned overlap, for checking a suggested placement does not collide. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.depth && b.y < a.y + a.depth;
}

// ─────────────────────────────────────────────────────────────── helpers ────

/**
 * A project with one ground floor on a 24 m × 18 m plot with 3 m setbacks all
 * round, so the buildable envelope is x 3..21, y 3..15 and the plot area is
 * 24 × 18 = 432 m².
 */
function site(): Project {
  const p = blankProject('Test site');
  const res = setPlot(p, {
    width: 24,
    depth: 18,
    orientation: 0,
    setbacks: { front: 3, rear: 3, left: 3, right: 3 },
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

/** Shallow-override a project without going through `ops.ts`. */
const patch = (p: Project, part: Partial<Project>): Project => ({ ...p, ...part });

const room = (
  id: string,
  floorId: string,
  kind: RoomKind,
  x: number,
  y: number,
  width: number,
  depth: number,
): Room => ({ id, floorId, kind, label: kind, x, y, width, depth, height: 3 });

const wall = (
  id: string,
  floorId: string,
  a: { x: number; y: number },
  b: { x: number; y: number },
  over: Partial<Wall> = {},
): Wall => ({
  id,
  floorId,
  type: 'interior',
  a,
  b,
  thickness: WALL_THICKNESS.interior,
  height: 3,
  roomIds: [],
  openings: [],
  ...over,
});

const opening = (
  id: string,
  kind: Opening['kind'],
  offset: number,
  width: number,
  over: Partial<Opening> = {},
): Opening => ({
  id,
  kind,
  offset,
  width,
  height: kind === 'window' ? 1.4 : 2.1,
  sill: kind === 'window' ? 0.9 : 0,
  swing: 'positive',
  hinge: 'start',
  ...over,
});

const stair = (
  id: string,
  floorId: string,
  connectsToFloorId: string | null,
  over: Partial<Staircase> = {},
): Staircase => ({
  id,
  floorId,
  name: 'Stair',
  x: 6,
  y: 6,
  width: 1.1,
  run: 4.42,
  riserCount: 17,
  direction: 1,
  connectsToFloorId,
  ...over,
});

const codes = (p: Project, rules?: ConstraintRules): string[] => validate(p, rules).map((i) => i.code);
const withCode = (p: Project, code: string, rules?: ConstraintRules) =>
  validate(p, rules).filter((i) => i.code === code);

// ────────────────────────────────────────────────────────── room geometry ────

describe('room geometry', () => {
  it('reports the true overlap area of two rooms on the same floor', () => {
    const p = site();
    const floorId = p.floors[0]!.id;

    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    // b spans x 6..10, y 5..8 against a's x 4..8, y 4..7.
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 6, y: 5, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    // Shared x span: min(8, 10) − max(4, 6) = 2 m.
    // Shared y span: min(7, 8) − max(4, 5) = 2 m.
    // Overlap area: 2 × 2 = 4 m².
    const issues = withCode(b.project, 'room_overlap');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual([a.createdIds[0], b.createdIds[0]]);
    expect(issues[0]!.message).toContain('overlap by 4.00 m²');
    expect(issues[0]!.fixes?.map((f) => f.tool)).toEqual(['resize_room', 'remove_element']);
  });

  it('does not report an overlap between rooms that merely touch', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    // a occupies x 4..8; b starts exactly at x 8, so the shared x span is 8 − 8 = 0.
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 8, y: 4, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);
    expect(codes(b.project)).not.toContain('room_overlap');
  });

  it('does not report an overlap between rooms on different floors', () => {
    let p = site();
    const ground = p.floors[0]!.id;
    const a = createRoom(p, { floorId: ground, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const upper = addFloor(a.project, 'First floor');
    if (!upper.ok) throw new Error(upper.error);
    // Deliberately the same rectangle, one floor up.
    const b = createRoom(upper.project, { floorId: upper.project.floors[1]!.id, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);
    expect(codes(b.project)).not.toContain('room_overlap');
    p = b.project;
    expect(p.rooms).toHaveLength(2);
  });

  it('reports a room that runs off the plot', () => {
    const p = site();
    // x 20..26 on a 24 m plot: 26 > 24 + TOL.join (0.02).
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'office', x: 20, y: 4, width: 6, depth: 3 });
    if (!r.ok) throw new Error(r.error);

    const issues = withCode(r.project, 'room_out_of_plot');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual([r.createdIds[0]]);
    expect(issues[0]!.message).toContain('24.00 m × 18.00 m');
  });

  it('leaves a room that ends exactly on the plot boundary alone', () => {
    const p = site();
    // x 20..24 and y 15..18 sit exactly on the 24 × 18 plot edges.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'office', x: 20, y: 15, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    expect(codes(r.project)).not.toContain('room_out_of_plot');
  });

  it('reports a degenerate room that the operation layer would have refused', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    // createRoom/resizeRoom refuse anything below TOL.dimension (0.15 m), so
    // this state can only be reached from a file or an older schema.
    const broken = patch(p, {
      rooms: [room('rm_slit', floorId, 'bedroom', 6, 6, 0.1, 3)],
    });

    const issues = withCode(broken, 'room_degenerate');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual(['rm_slit']);
    expect(issues[0]!.message).toContain(`0.10 m × 3.00 m`);
    expect(issues[0]!.message).toContain(`${TOL.dimension} m minimum`);
    expect(issues[0]!.fixes).toEqual([
      { label: 'Remove the room', tool: 'remove_element', input: { kind: 'room', id: 'rm_slit' } },
    ]);
  });

  it('accepts a room exactly on the TOL.dimension threshold', () => {
    const p = site();
    // width === TOL.dimension (0.15): the check is `<`, not `<=`.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'storage', x: 6, y: 6, width: TOL.dimension, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    expect(codes(r.project)).not.toContain('room_degenerate');
  });

  it('flags a corridor narrower than the rule allows and offers the widening fix', () => {
    const p = site();
    // A 0.70 m × 4.00 m corridor: min(0.70, 4.00) = 0.70 < 0.90 (DEFAULT_RULES.minCorridorWidth).
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'corridor', x: 12, y: 4, width: 0.7, depth: 4 });
    if (!r.ok) throw new Error(r.error);

    const issues = withCode(r.project, 'dimension_implausible');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([r.createdIds[0]]);
    expect(issues[0]!.message).toContain('0.70 m across');
    // The sentence interpolates the raw rule number (0.9), while the fix label
    // below is formatted to 2 dp (0.90 m).
    expect(issues[0]!.message).toContain('narrower than the 0.9 m');
    // width (0.7) <= depth (4.0), so the fix widens the width.
    expect(issues[0]!.fixes).toEqual([
      {
        label: 'Widen to 0.90 m',
        tool: 'resize_room',
        input: { roomId: r.createdIds[0], width: 0.9, anchor: 'top-left' },
      },
    ]);
  });

  it('widens the depth instead when the depth is the narrow side', () => {
    const p = site();
    // min(4.00, 0.70) = 0.70 < 0.90; width > depth so the fix targets depth.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'corridor', x: 12, y: 4, width: 4, depth: 0.7 });
    if (!r.ok) throw new Error(r.error);
    const issues = withCode(r.project, 'dimension_implausible');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.fixes?.[0]!.input).toMatchObject({ depth: 0.9 });
    expect(issues[0]!.fixes?.[0]!.input).not.toHaveProperty('width');
  });

  it('leaves a wide-enough corridor alone', () => {
    const p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'corridor', x: 12, y: 4, width: 0.9, depth: 4 });
    if (!r.ok) throw new Error(r.error);
    expect(codes(r.project)).not.toContain('dimension_implausible');
  });

  it('flags a room too small for its kind and offers to grow it', () => {
    const p = site();
    // 2.20 m² of bathroom, against the 3 m² a bathroom needs to hold a bath,
    // a basin and a door. 1.20 × 1.90 = 2.28 m².
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bathroom', x: 12, y: 4, width: 1.2, depth: 1.9 });
    if (!r.ok) throw new Error(r.error);

    const issues = withCode(r.project, 'dimension_implausible');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.message).toContain('2.3 m²');
    expect(issues[0]!.message).toContain('under the 3 m²');
    // Both sides scale by sqrt(3 / 2.28) = 1.147, keeping the room's shape:
    // 1.20 × 1.147 = 1.38, 1.90 × 1.147 = 2.18, and 1.38 × 2.18 = 3.0 m².
    const fix = issues[0]!.fixes![0]!;
    expect(fix.label).toBe('Grow it to 3 m²');
    expect(fix.tool).toBe('resize_room');
    expect(fix.input).toMatchObject({ roomId: r.createdIds[0], width: 1.38, depth: 2.18, anchor: 'top-left' });
    const grown = resizeRoom(r.project, {
      roomId: r.createdIds[0]!,
      width: fix.input.width as number,
      depth: fix.input.depth as number,
      anchor: 'top-left',
    });
    if (!grown.ok) throw new Error(grown.error);
    expect(withCode(grown.project, 'dimension_implausible')).toHaveLength(0);
  });

  it('leaves a room of the right size alone, and a small balcony alone', () => {
    const p = site();
    // 3.00 × 3.00 = 9 m² of bathroom, over the 3 m² minimum.
    const big = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bathroom', x: 12, y: 4, width: 3, depth: 3 });
    if (!big.ok) throw new Error(big.error);
    expect(codes(big.project)).not.toContain('dimension_implausible');

    // A balcony is meant to be small, so it has no minimum to fall under.
    const balcony = createRoom(p, { floorId: p.floors[0]!.id, kind: 'balcony', x: 12, y: 4, width: 1.5, depth: 1.5 });
    if (!balcony.ok) throw new Error(balcony.error);
    expect(codes(balcony.project)).not.toContain('dimension_implausible');
  });
});

// ─────────────────────────────────────────────────────────────── walls ──────

describe('walls', () => {
  it('reports a zero-length wall and stops there', () => {
    const p = site();
    // hand-built: createWall refuses a wall shorter than TOL.length (0.02 m).
    const dot = patch(p, { walls: [wall('wl_dot', p.floors[0]!.id, { x: 5, y: 5 }, { x: 5, y: 5 })] });

    const issues = withCode(dot, 'wall_zero_length');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual(['wl_dot']);
    expect(issues[0]!.fixes).toEqual([
      { label: 'Delete the wall', tool: 'remove_element', input: { kind: 'wall', id: 'wl_dot' } },
    ]);
    // The zero-length branch `continue`s, so the same wall must not also be
    // reported as unbounded or outside the plot.
    expect(codes(dot)).not.toContain('wall_unbounded');
    expect(codes(dot)).not.toContain('wall_out_of_plot');
  });

  it('flags an interior wall that is not on any room edge', () => {
    const p = site();
    // A wall in open ground: no room has an edge within thickness/2 + 0.05 of y = 1.
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 4, y: 1 }, b: { x: 10, y: 1 } });
    if (!w.ok) throw new Error(w.error);

    const issues = withCode(w.project, 'wall_unbounded');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([w.createdIds[0]]);
  });

  it('does not flag an interior wall that runs along a room edge', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const r = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    // Sits exactly on the room's top edge (y = 4), so reindex binds it.
    const w = createWall(r.project, { floorId, type: 'interior', a: { x: 4, y: 4 }, b: { x: 8, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    expect(codes(w.project)).not.toContain('wall_unbounded');
  });

  it('flags an interior wall that runs off the plot', () => {
    const p = site();
    // b.x = 28 > 24 + TOL.join (0.02) on a 24 m plot.
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 23, y: 4 }, b: { x: 28, y: 4 } });
    if (!w.ok) throw new Error(w.error);

    const issues = withCode(w.project, 'wall_out_of_plot');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([w.createdIds[0]]);
  });

  it('never flags a boundary wall for running off the plot', () => {
    const p = site();
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'boundary', a: { x: 23, y: 4 }, b: { x: 28, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    expect(codes(w.project)).not.toContain('wall_out_of_plot');
  });
});

// ──────────────────────────────────────────────────────────── openings ──────

describe('openings', () => {
  const wallWithOpening = (o: Opening) => {
    const p = site();
    const w = patch(p, {
      // A 6 m interior wall: frame.length = 6, height = 3.
      walls: [wall('wl_w', p.floors[0]!.id, { x: 4, y: 4 }, { x: 10, y: 4 }, { openings: [o] })],
    });
    return w;
  };

  it('reports an opening that hangs off the end of its wall', () => {
    // width 1.2 at offset 5.6: start 5.00, end 6.20 > 6 + TOL.join (0.02).
    const p = wallWithOpening(opening('op_long', 'window', 5.6, 1.2));

    const issues = withCode(p, 'opening_overflows_wall');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual(['wl_w', 'op_long']);
    expect(issues[0]!.message).toContain('5.00 m to 6.20 m');
    expect(issues[0]!.message).toContain('6.00 m long');
    expect(issues[0]!.message).toContain('does not fit');
    // The suggested fix centres it: frame.length / 2 = 6 / 2 = 3.
    expect(issues[0]!.fixes).toEqual([
      { label: 'Centre it on the wall', tool: 'move_opening', input: { wallId: 'wl_w', openingId: 'op_long', offset: 3 } },
    ]);
  });

  it('reports an opening whose head is above the wall', () => {
    // sill 1.00 + height 2.20 = 3.20 > wall height 3.00 + 0.02.
    const p = wallWithOpening(opening('op_tall', 'window', 3, 1.2, { sill: 1, height: 2.2 }));

    const issues = withCode(p, 'opening_overflows_wall');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('head at 3.20 m');
    expect(issues[0]!.message).toContain('3.00 m wall');
    // Suggested height: max(0.4, 3.00 − 1.00 − 0.05) = 1.95.
    expect(issues[0]!.fixes).toEqual([
      {
        label: 'Resize to fit',
        tool: 'move_opening',
        input: { wallId: 'wl_w', openingId: 'op_tall', height: 1.95 },
      },
    ]);
  });

  it('accepts an opening that exactly fills the wall', () => {
    const p = wallWithOpening(opening('op_edge', 'window', 0.6, 1.2));
    // start = 0.00, end = 1.20 — both inside [-0.02, 6.02].
    expect(codes(p)).not.toContain('opening_overflows_wall');
  });

  it('reports two openings that overlap along the wall', () => {
    // offsets 2.90 and 3.10, widths 1.20 and 1.20:
    // gap = |3.10 − 2.90| − (1.20 + 1.20) / 2 = 0.20 − 1.20 = −1.00 < −TOL.join.
    const p = site();
    const withPair = patch(p, {
      walls: [
        wall('wl_w', p.floors[0]!.id, { x: 4, y: 4 }, { x: 10, y: 4 }, {
          openings: [opening('op_1', 'window', 2.9, 1.2), opening('op_2', 'window', 3.1, 1.2)],
        }),
      ],
    });

    // The pair is only visited from the lower id ('op_1' < 'op_2'), so the
    // comparison is reported exactly once.
    const issues = withCode(withPair, 'opening_overlap');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual(['wl_w', 'op_1', 'op_2']);
    expect(issues[0]!.message).toContain('overlap by 1.00 m');
  });

  it('accepts two windows that just clear each other', () => {
    const p = site();
    // offsets 2.90 and 4.30, widths 1.20 each:
    // gap = |4.30 − 2.90| − (1.20 + 1.20) / 2 = 1.40 − 1.20 = 0.20,
    // which is greater than −TOL.join (−0.02) and so not an overlap.
    const spaced = patch(p, {
      walls: [
        wall('wl_w', p.floors[0]!.id, { x: 4, y: 4 }, { x: 10, y: 4 }, {
          openings: [opening('op_1', 'window', 2.9, 1.2), opening('op_2', 'window', 4.3, 1.2)],
        }),
      ],
    });
    expect(codes(spaced)).not.toContain('opening_overlap');
  });

  it('clamps an overhanging opening instead of reporting it', () => {
    const p = site();
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const res = addOpening(w.project, { wallId: w.createdIds[0]!, kind: 'window', offset: 99, width: 1.2, height: 1.4, sill: 0.9 });
    if (!res.ok) throw new Error(res.error);
    // reindex clamps the centre into [half, length − half] = [0.60, 5.40].
    const o = res.project.walls[0]!.openings[0]!;
    expect(o.offset).toBeLessThanOrEqual(6 - 0.6 + 1e-9);
    expect(codes(res.project)).not.toContain('opening_overflows_wall');
  });
});

// ───────────────────────────────────────────────────────── door swings ──────

describe('door swings', () => {
  /**
   * A door in a 6 m wall from (4,4) to (10,4), centred at (7,4).
   *
   * dir = (1,0), normal = perp(dir) = (0,1). swing 'positive' and hinge 'start'
   * give side = +1 and hingeSign = −1, so the leaf opens towards +Y, into the
   * room. With the 0.90 m default interior door:
   *   hinge  = (7,4) − (1,0)·0.45 = (6.55, 4)
   *   far    = (6.55,4) + (1,0)·0.90 = (7.45, 4)
   *   openEnd= (6.55, 4) + (0,1)·0.90 = (6.55, 4.90)
   *   arcMid = (6.55,4) + (0.7071,0.7071)·(0.90/√2) = (7.00, 4.45)
   * The hull spans x 6.55..7.45 and y 4.00..4.90.
   */
  const doorway = () => {
    const p = site();
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const withDoor = addOpening(w.project, {
      wallId: w.createdIds[0]!,
      kind: 'door',
      offset: 3,
      width: OPENING_DEFAULTS.interiorDoor.width,
      height: OPENING_DEFAULTS.interiorDoor.height,
      swing: 'positive',
      hinge: 'start',
    });
    if (!withDoor.ok) throw new Error(withDoor.error);
    return {
      project: withDoor.project,
      wallId: w.createdIds[0]!,
      openingId: withDoor.createdIds[0]!,
    };
  };

  it('reports a door that swings into another wall', () => {
    const { project, wallId, openingId } = doorway();
    // A vertical wall at x = 6.9, i.e. footprint x 6.85..6.95, y 4.50..7.00.
    // At x = 6.9 the swing hull runs y 4.00..4.80, so it overlaps y 4.50..4.80.
    // Neither wall bounds a room, so the "leaf in its own wall" exemption
    // (which needs a shared roomId) cannot apply.
    const blocked = createWall(project, {
      floorId: project.floors[0]!.id,
      type: 'interior',
      a: { x: 6.9, y: 4.5 },
      b: { x: 6.9, y: 7 },
    });
    if (!blocked.ok) throw new Error(blocked.error);

    const issues = withCode(blocked.project, 'door_swing_blocked');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([wallId, openingId, blocked.createdIds[0]]);
    expect(issues[0]!.message).toContain('swings into');
    // The offered fix flips the swing: 'positive' → 'negative'.
    expect(issues[0]!.fixes).toEqual([
      {
        label: 'Swing the other way',
        tool: 'move_opening',
        input: { wallId, openingId, swing: 'negative' },
      },
    ]);
  });

  it('clears the report once the door swings the other way', () => {
    const { project, wallId, openingId } = doorway();
    const blocked = createWall(project, {
      floorId: project.floors[0]!.id,
      type: 'interior',
      a: { x: 6.9, y: 4.5 },
      b: { x: 6.9, y: 7 },
    });
    if (!blocked.ok) throw new Error(blocked.error);
    // side = −1 puts the hull at y 3.10..4.00, clear of the blocker at y ≥ 4.50.
    const flipped = addOpening(blocked.project, {
      wallId,
      kind: 'door',
      offset: 3,
      width: OPENING_DEFAULTS.interiorDoor.width,
      height: OPENING_DEFAULTS.interiorDoor.height,
      swing: 'negative',
      hinge: 'start',
    });
    expect(flipped.ok).toBe(false); // the operation layer refuses the duplicate
    expect(flipped.ok ? '' : flipped.code).toBe('conflict');

    const patched = patch(blocked.project, {
      walls: blocked.project.walls.map((w) =>
        w.id === wallId
          ? { ...w, openings: w.openings.map((o) => (o.id === openingId ? { ...o, swing: 'negative' } : o)) }
          : w,
      ),
    });
    expect(codes(patched)).not.toContain('door_swing_blocked');
  });

  it('reports a door that swings into furniture', () => {
    const { project, wallId, openingId } = doorway();
    // A room to host the chair. `moveFurniture` re-homes an item to whichever
    // room contains it and refuses one that is in none, so a plan with no
    // rooms has no honest correction to offer — see the next test.
    const withRoom = createRoom(project, { floorId: project.floors[0]!.id, kind: 'living', x: 3, y: 4, width: 12, depth: 5 });
    if (!withRoom.ok) throw new Error(withRoom.error);
    // An armchair centred at (7, 4.60): footprint x 6.575..7.425, y 4.175..5.025,
    // squarely inside the swing hull (x 6.55..7.45, y 4.00..4.90).
    const chair = addFurniture(withRoom.project, { catalogId: 'armchair', x: 7, y: 4.6 });
    if (!chair.ok) throw new Error(chair.error);

    const issues = withCode(chair.project, 'door_swing_blocked');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([wallId, openingId, chair.createdIds[0]]);
    expect(issues[0]!.message).toContain('swing path');
    expect(issues[0]!.fixes).toHaveLength(1);
    expect(issues[0]!.fixes![0]).toMatchObject({
      tool: 'move_furniture',
      // `itemId` is the name the tool's schema asks for — `furnitureId` was
      // silently ignored, so the item never moved and the warning never went.
      input: { itemId: chair.createdIds[0] },
    });
    expect(typeof issues[0]!.fixes![0]!.input.x).toBe('number');
    expect(typeof issues[0]!.fixes![0]!.input.y).toBe('number');
    // The chair is 4.175 m down the wall, clear of its 3.95..4.05 footprint.
    expect(codes(chair.project)).not.toContain('furniture_crosses_wall');
  });

  it('offers no furniture correction for an item that belongs to no room', () => {
    const { project } = doorway();
    const chair = addFurniture(project, { catalogId: 'armchair', x: 7, y: 4.6 });
    if (!chair.ok) throw new Error(chair.error);

    const issue = withCode(chair.project, 'door_swing_blocked')[0]!;
    expect(issue.message).toContain('swing path');
    // Reported, but with nothing to click: any position the engine could name
    // would be refused by `moveFurniture`, so offering a button here would be
    // offering one that cannot work.
    expect(issue.fixes ?? []).toEqual([]);
  });

  it('ignores a window — only doors and doorways have swings', () => {
    const p = site();
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const withWindow = addOpening(w.project, { wallId: w.createdIds[0]!, kind: 'window', offset: 3, width: 1.2, height: 1.4, sill: 0.9 });
    if (!withWindow.ok) throw new Error(withWindow.error);
    const blocker = createWall(withWindow.project, {
      floorId: withWindow.project.floors[0]!.id,
      type: 'interior',
      a: { x: 6.9, y: 4.5 },
      b: { x: 6.9, y: 7 },
    });
    if (!blocker.ok) throw new Error(blocker.error);
    expect(codes(blocker.project)).not.toContain('door_swing_blocked');
  });
});

// ──────────────────────────────────────────────────────────── furniture ──────

describe('furniture', () => {
  const roomWith = (kind: RoomKind, x: number, y: number, width: number, depth: number) => {
    const p = site();
    const res = createRoom(p, { floorId: p.floors[0]!.id, kind, x, y, width, depth });
    if (!res.ok) throw new Error(res.error);
    return { project: res.project, roomId: res.createdIds[0]! };
  };

  it('reports furniture that crosses a wall', () => {
    // Room x 4..10, y 4..8; vertical wall centreline at x = 7, thickness 0.10,
    // so its footprint is x 6.95..7.05. An armchair centred at (7,6) spans
    // x 6.575..7.425 and therefore runs 0.375 m into the wall on each side.
    const { project, roomId } = roomWith('office', 4, 4, 6, 4);
    const w = createWall(project, { floorId: project.floors[0]!.id, type: 'interior', a: { x: 7, y: 4 }, b: { x: 7, y: 8 } });
    if (!w.ok) throw new Error(w.error);
    const chair = addFurniture(w.project, { roomId, catalogId: 'armchair', x: 7, y: 6 });
    if (!chair.ok) throw new Error(chair.error);

    const issues = withCode(chair.project, 'furniture_crosses_wall');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual([chair.createdIds[0], w.createdIds[0]]);
    expect(issues[0]!.message).toContain('0.85 m × 0.85 m');
    expect(issues[0]!.message).toContain('0.10 m thick');
    // Its centre is still inside the room, so the host check passes.
    expect(codes(chair.project)).not.toContain('furniture_out_of_room');
  });

  it('leaves furniture clear of a wall alone', () => {
    // Chair centre (7, 6): footprint y 5.575..6.425; the wall's footprint is
    // y 4.00..8.00 — they meet in x but rectIntersects is false in y.
    const { project } = roomWith('office', 4, 4, 6, 4);
    const chair = addFurniture(project, { catalogId: 'armchair', x: 5, y: 6 });
    if (!chair.ok) throw new Error(chair.error);
    expect(codes(chair.project)).not.toContain('furniture_crosses_wall');
  });

  it('reports furniture that is assigned to a room it has been dragged out of', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    // b occupies x 8..12; the item is placed inside b but assigned to a.
    const b = createRoom(a.project, { floorId, kind: 'bedroom', x: 8, y: 4, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);
    const chair = addFurniture(b.project, { roomId: a.createdIds[0], catalogId: 'armchair', x: 10, y: 5.5 });
    if (!chair.ok) throw new Error(chair.error);

    const issues = withCode(chair.project, 'furniture_out_of_room');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([chair.createdIds[0], a.createdIds[0]]);
    expect(issues[0]!.message).toContain('no longer inside it');
  });

  it('reports two pieces of furniture overlapping', () => {
    // Armchairs 0.85 × 0.85 at (5.5,6) and (6.0,6): their x spans are
    // 5.075..5.925 and 5.575..6.425, overlapping by 6.575−… = 0.35 m on x.
    const { project, roomId } = roomWith('living', 4, 4, 6, 5);
    const a = addFurniture(project, { roomId, catalogId: 'armchair', x: 5.5, y: 6 });
    if (!a.ok) throw new Error(a.error);
    const b = addFurniture(a.project, { roomId, catalogId: 'armchair', x: 6, y: 6 });
    if (!b.ok) throw new Error(b.error);

    const issues = withCode(b.project, 'furniture_overlap');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([a.createdIds[0], b.createdIds[0]]);
    expect(issues[0]!.fixes).toEqual([
      { label: 'Remove Armchair', tool: 'remove_element', input: { kind: 'furniture', id: b.createdIds[0] } },
    ]);
  });

  it('lets a rug sit under a sofa', () => {
    // The rug is 0.02 m tall, under the 0.05 m flat threshold, so the pair is
    // skipped however deeply it overlaps.
    const { project, roomId } = roomWith('living', 4, 4, 6, 5);
    const rug = addFurniture(project, { roomId, catalogId: 'rug', x: 6, y: 6 });
    if (!rug.ok) throw new Error(rug.error);
    const sofa = addFurniture(rug.project, { roomId, catalogId: 'sofa-3', x: 6, y: 6 });
    if (!sofa.ok) throw new Error(sofa.error);

    expect(sofa.project.furniture[0]!.height).toBe(0.02);
    expect(codes(sofa.project)).not.toContain('furniture_overlap');
  });

  it('ignores furniture on a different floor', () => {
    let p = site();
    const ground = p.floors[0]!.id;
    const r = createRoom(p, { floorId: ground, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const chair = addFurniture(r.project, { roomId: r.createdIds[0], catalogId: 'armchair', x: 6, y: 5.5 });
    if (!chair.ok) throw new Error(chair.error);
    const upper = addFloor(chair.project, 'First floor');
    if (!upper.ok) throw new Error(upper.error);
    // Same coordinates, one floor up — the floor-pair check must not fire.
    const twin = addFurniture(upper.project, { floorId: upper.project.floors[1]!.id, catalogId: 'armchair', x: 6, y: 5.5 });
    if (!twin.ok) throw new Error(twin.error);
    expect(twin.project.furniture).toHaveLength(2);
    expect(codes(twin.project)).not.toContain('furniture_overlap');
  });
});

// ───────────────────────────────────────────── circulation, access, entrance ────

describe('circulation and access', () => {
  /** A living room with an entrance door in an exterior wall along its top edge. */
  const withEntrance = () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const r = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const w = createWall(r.project, { floorId, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 8, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const d = addOpening(w.project, {
      wallId: w.createdIds[0],
      kind: 'door',
      offset: 2,
      width: OPENING_DEFAULTS.entranceDoor.width,
      height: OPENING_DEFAULTS.entranceDoor.height,
    });
    if (!d.ok) throw new Error(d.error);
    return { project: d.project, roomId: r.createdIds[0], wallId: w.createdIds[0] };
  };

  it('reports a floor with no way in', () => {
    const p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const w = createWall(r.project, { floorId: p.floors[0]!.id, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 8, y: 4 } });
    if (!w.ok) throw new Error(w.error);

    const issues = withCode(w.project, 'no_entrance');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual([p.floors[0]!.id]);
    expect(issues[0]!.message).toContain('no way into the house');
    expect(issues[0]!.fixes).toEqual([
      {
        label: 'Add a door on the front wall',
        tool: 'add_door',
        // `add_door` names its kind in the tool, not the input; the old
        // `kind: 'door'` was dead weight the handler ignored.
        input: { wallId: w.createdIds[0], width: OPENING_DEFAULTS.entranceDoor.width },
      },
    ]);
  });

  it('clears the entrance report once an exterior door exists', () => {
    const { project } = withEntrance();
    expect(codes(project)).not.toContain('no_entrance');
  });

  it('reports a room with no door at all', () => {
    const { project, roomId } = withEntrance();
    // A bedroom standing alone at x 12..16 with no wall on any of its edges.
    const far = createRoom(project, { floorId: project.floors[0]!.id, kind: 'bedroom', x: 12, y: 4, width: 4, depth: 3 });
    if (!far.ok) throw new Error(far.error);

    const issues = withCode(far.project, 'room_no_access');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual([far.createdIds[0], project.floors[0]!.id]);
    expect(issues[0]!.message).toContain('has no door on any of its walls');
    // The room the entrance actually reaches is fine.
    expect(issuesFor(validate(far.project), roomId)).toHaveLength(0);
  });

  it('reports a room whose door leads only into another unreachable room', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    // living x 4..8 (the entrance) | hall x 8..10 | bedroom x 10..14.
    // A door joins hall and bedroom, so both have a door and neither is
    // doorless — but nothing reaches either from outside.
    const living = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!living.ok) throw new Error(living.error);
    const hall = createRoom(living.project, { floorId, kind: 'hall', x: 8, y: 4, width: 2, depth: 3 });
    if (!hall.ok) throw new Error(hall.error);
    const bedroom = createRoom(hall.project, { floorId, kind: 'bedroom', x: 10, y: 4, width: 4, depth: 3 });
    if (!bedroom.ok) throw new Error(bedroom.error);

    const ext = createWall(bedroom.project, { floorId, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 8, y: 4 } });
    if (!ext.ok) throw new Error(ext.error);
    const withDoor = addOpening(ext.project, {
      wallId: ext.createdIds[0],
      kind: 'door',
      offset: 2,
      width: OPENING_DEFAULTS.entranceDoor.width,
      height: OPENING_DEFAULTS.entranceDoor.height,
    });
    if (!withDoor.ok) throw new Error(withDoor.error);

    // A wall on x = 10 with two rooms on it becomes an interior edge hall↔bedroom
    // rather than an edge to OUTSIDE, which is what strands the bedroom.
    const party = createWall(withDoor.project, { floorId, type: 'interior', a: { x: 10, y: 4 }, b: { x: 10, y: 7 } });
    if (!party.ok) throw new Error(party.error);
    expect(party.project.walls.find((w) => w.id === party.createdIds[0])!.roomIds).toHaveLength(2);
    const inner = addOpening(party.project, {
      wallId: party.createdIds[0],
      kind: 'door',
      offset: 1.5,
      width: OPENING_DEFAULTS.interiorDoor.width,
      height: OPENING_DEFAULTS.interiorDoor.height,
    });
    if (!inner.ok) throw new Error(inner.error);

    const issues = withCode(inner.project, 'room_no_access');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.elements).toEqual([bedroom.createdIds[0], floorId]);
    expect(issues[0]!.message).toContain('cannot be reached from the entrance');
    expect(issues[0]!.message).not.toContain('no door on any of its walls');
  });

  it('says nothing about access on a room kind that needs no door', () => {
    const { project } = withEntrance();
    // `balcony` is not in the NEEDS_ACCESS set, so an unconnected one is fine.
    const deck = createRoom(project, { floorId: project.floors[0]!.id, kind: 'balcony', x: 12, y: 4, width: 4, depth: 3 });
    if (!deck.ok) throw new Error(deck.error);
    expect(codes(deck.project)).not.toContain('room_no_access');
  });
});

// ───────────────────────────────────────────────────────────────── stairs ────

describe('stairs and floors', () => {
  /** A two-floor project: ground at elevation 0 (height 3), first at elevation 3. */
  const twoFloors = () => {
    const p = site();
    const res = addFloor(p, 'First floor');
    if (!res.ok) throw new Error(res.error);
    return res.project;
  };

  it('reports an upper floor with no stair arriving from below', () => {
    const p = twoFloors();
    const [ground, first] = p.floors;
    const issues = withCode(p, 'floor_disconnected');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual([first!.id, ground!.id]);
    expect(issues[0]!.message).toBe('First floor has no staircase arriving from Ground floor.');
  });

  it('clears the report once a stair connects the two floors', () => {
    const p = twoFloors();
    const [ground, first] = p.floors;
    const res = addStaircase(p, { floorId: ground!.id, x: 6, y: 6 });
    if (!res.ok) throw new Error(res.error);

    expect(res.data.connectsToFloorId).toBe(first!.id);
    // Ground elevation 0, first elevation 3: rise 3, 17 risers × 0.26 m going.
    expect(res.data.run).toBeCloseTo(17 * 0.26, 10);
    const list = codes(res.project);
    expect(list).not.toContain('floor_disconnected');
    expect(list).not.toContain('stair_not_connected');
    expect(list).not.toContain('stair_geometry_invalid');
  });

  it('reports a stair that reaches no floor', () => {
    const p = twoFloors();
    // hand-built: reindex clears a dangling connectsToFloorId, and
    // addStaircase refuses to make one, but a saved file can carry it.
    // Width 0.65 also trips stair_geometry_invalid — which the `continue`
    // above must skip, so exactly one stair issue is expected.
    const ghosted = patch(p, {
      stairs: [stair('st_ghost', p.floors[0]!.id, null, { name: 'Ghost stair', width: 0.65 })],
    });

    const issues = withCode(ghosted, 'stair_not_connected');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual(['st_ghost']);
    expect(issues[0]!.message).toBe('Staircase "Ghost stair" does not reach any floor.');
    expect(codes(ghosted)).not.toContain('stair_geometry_invalid');
  });

  it('reports a stair that points at a floor which is not above it', () => {
    const p = twoFloors();
    const [ground, first] = p.floors;
    // The stair sits on the first floor but connects to the ground floor, so
    // target.order (0) <= from.order (1).
    const downwards = patch(p, {
      stairs: [stair('st_down', first!.id, ground!.id, { name: 'Down stair', direction: -1 })],
    });

    const issues = withCode(downwards, 'stair_not_connected');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.elements).toEqual(['st_down', first!.id, ground!.id]);
    expect(issues[0]!.message).toBe('Staircase "Down stair" goes from First floor to Ground floor, but Ground floor is not above it.');
  });

  it('ignores a stair whose target floor no longer exists', () => {
    const p = twoFloors();
    // floorById.get() misses, so the check `continue`s with no issue at all.
    const dangling = patch(p, { stairs: [stair('st_x', p.floors[0]!.id, 'fl_gone')] });
    expect(codes(dangling)).not.toContain('stair_not_connected');
  });

  it('reports a stair too narrow to use', () => {
    const p = twoFloors();
    const [ground, first] = p.floors;
    // 0.65 m < the 0.70 m floor in the check.
    const narrow = patch(p, { stairs: [stair('st_slim', ground!.id, first!.id, { name: 'Slim stair', width: 0.65 })] });

    const issues = withCode(narrow, 'stair_geometry_invalid');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual(['st_slim']);
    expect(issues[0]!.message).toBe('Staircase "Slim stair" is only 0.65 m wide; 0.90 m is a practical minimum.');
    // A valid connection, so none of the connection errors fire.
    expect(codes(narrow)).not.toContain('stair_not_connected');
    expect(codes(narrow)).not.toContain('floor_disconnected');
  });

  it('accepts a stair exactly 0.70 m wide', () => {
    const p = twoFloors();
    const [ground, first] = p.floors;
    // The check is `width < 0.7`, so 0.70 clears it.
    const ok = patch(p, { stairs: [stair('st_ok', ground!.id, first!.id, { width: 0.7 })] });
    expect(codes(ok)).not.toContain('stair_geometry_invalid');
  });
});

// ─────────────────────────────────────────────────────── plot rules, FAR ────

describe('setbacks', () => {
  it('reports the side a room breaks the envelope on', () => {
    const p = site();
    // Envelope: x 3..21, y 3..15. A room starting at x = 2 is 1.00 m too far left.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);

    const issues = withCode(r.project, 'setback_violation');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([r.createdIds[0]]);
    expect(issues[0]!.message).toContain('left by 1.00 m');
  });

  it('names both edges when a room overhangs two of them', () => {
    const p = site();
    // Right edge 20 + 4 = 24, i.e. 3.00 m past 21; bottom 14 + 3 = 17, i.e.
    // 2.00 m past 15.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 20, y: 14, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);

    const issues = withCode(r.project, 'setback_violation');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('right by 3.00 m and rear by 2.00 m');
  });

  it('leaves a room exactly on the envelope alone', () => {
    const p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 3, y: 3, width: 18, depth: 12 });
    if (!r.ok) throw new Error(r.error);
    expect(codes(r.project)).not.toContain('setback_violation');
  });

  it('does not apply setbacks to upper floors', () => {
    let p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const upper = addFloor(r.project, 'First floor');
    if (!upper.ok) throw new Error(upper.error);
    // Same 1 m overhang as the ground-floor case above, but on floor order 1.
    const over = createRoom(upper.project, { floorId: upper.project.floors[1]!.id, kind: 'bedroom', x: 2, y: 4, width: 4, depth: 3 });
    if (!over.ok) throw new Error(over.error);
    expect(codes(over.project)).not.toContain('setback_violation');
  });
});

describe('coverage and floor-area ratio', () => {
  /** A 20 m × 20 m plot (400 m²) with no setbacks, so the envelope is the plot. */
  const openSite = () => {
    const p = blankProject('Open site');
    const res = setPlot(p, { width: 20, depth: 20, setbacks: { front: 0, rear: 0, left: 0, right: 0 } });
    if (!res.ok) throw new Error(res.error);
    return res.project;
  };

  it('reports plot coverage above the project target', () => {
    let p = openSite();
    const floorId = p.floors[0]!.id;
    // Two ground-floor rooms of 14 × 10 = 140 m² each, stacked y 0..10 and
    // y 10..20. Footprint 280 m² on a 400 m² plot = 0.70 > 0.60.
    const a = createRoom(p, { floorId, kind: 'living', x: 0, y: 0, width: 14, depth: 10 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'garage', x: 0, y: 10, width: 14, depth: 10 });
    if (!b.ok) throw new Error(b.error);

    const issues = withCode(b.project, 'coverage_exceeded');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([]);
    expect(issues[0]!.message).toContain('Plot coverage is 70%');
    expect(issues[0]!.message).toContain('above the 60% target');
    // 280 / 400 = 0.70, well under the 1.80 FAR target.
    expect(codes(b.project)).not.toContain('far_exceeded');
  });

  it('reports a floor-area ratio above the project target', () => {
    let p = openSite();
    const ground = p.floors[0]!.id;
    // Ground: 4 × 4 = 16 m² → coverage 16 / 400 = 0.04, far below 0.60.
    const g = createRoom(p, { floorId: ground, kind: 'hall', x: 0, y: 0, width: 4, depth: 4 });
    if (!g.ok) throw new Error(g.error);
    const one = addFloor(g.project, 'First floor');
    if (!one.ok) throw new Error(one.error);
    const two = addFloor(one.project, 'Second floor');
    if (!two.ok) throw new Error(two.error);

    // Two more storeys of 20 × 20 = 400 m² each: gross 816 m² on 400 m² = 2.04.
    const r1 = createRoom(two.project, { floorId: one.project.floors[1]!.id, kind: 'bedroom', x: 0, y: 0, width: 20, depth: 20 });
    if (!r1.ok) throw new Error(r1.error);
    const r2 = createRoom(r1.project, { floorId: two.project.floors[2]!.id, kind: 'bedroom', x: 0, y: 0, width: 20, depth: 20 });
    if (!r2.ok) throw new Error(r2.error);

    const issues = withCode(r2.project, 'far_exceeded');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.elements).toEqual([]);
    expect(issues[0]!.message).toContain('Floor-area ratio is 2.04');
    expect(issues[0]!.message).toContain('816 m² built on 400 m² of plot');
    expect(issues[0]!.message).toContain('above the 1.80 target');
    expect(codes(r2.project)).not.toContain('coverage_exceeded');
  });

  it('does not count outdoor rooms toward covered area', () => {
    let p = openSite();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 0, y: 0, width: 14, depth: 10 });
    if (!a.ok) throw new Error(a.error);
    // Flagged outdoor after the fact: measureBuilding skips `outdoor` rooms
    // for net, footprint and gross area alike.
    const deck = patch(a.project, {
      rooms: [...a.project.rooms, { ...room('rm_deck', floorId, 'terrace', 0, 10, 14, 10), outdoor: true }],
    });
    // Footprint stays 140 m² → 140 / 400 = 0.35, under the 0.60 target.
    expect(codes(deck)).not.toContain('coverage_exceeded');
    expect(codes(deck)).not.toContain('far_exceeded');
  });
});

// ────────────────────────────────────────────────── brief and daylight ──────

describe('brief and daylight heuristics', () => {
  const brief = (rooms: DesignBrief['rooms']): DesignBrief => ({
    plot: { width: 24, depth: 18, orientation: 0, setbacks: { front: 3, rear: 3, left: 3, right: 3 } },
    floorCount: 1,
    rooms,
    preferredAreas: {},
    style: 'modern',
    preferences: { accessibility: false, ventilation: false, privacy: false, daylight: false },
  });

  it('reports a room the brief asked for that does not exist', () => {
    let p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const withBrief = setBrief(r.project, brief([{ kind: 'bedroom', count: 2 }, { kind: 'bathroom', count: 1 }]));
    if (!withBrief.ok) throw new Error(withBrief.error);

    const issues = withCode(withBrief.project, 'brief_room_missing');
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.severity === 'info')).toBe(true);
    // Global issues: nothing to focus, so `elements` is empty on purpose.
    expect(issues.every((i) => i.elements.length === 0)).toBe(true);
    const bedroom = issues.find((i) => i.message.includes('Bedroom'))!;
    expect(bedroom.message).toBe('The brief asked for 2 × Bedroom, but only 1 exist.');
    // The fix carries a rectangle to put the room in, not just a kind: the
    // `create_room` tool requires x, y, width and depth, so a fix that named
    // only the kind was a button that could not work.
    expect(bedroom.fixes).toHaveLength(1);
    const fix = bedroom.fixes![0]!;
    expect(fix.tool).toBe('create_room');
    expect(fix.label).toMatch(/^Add Bedroom on /);
    expect(fix.input).toMatchObject({ kind: 'bedroom', floorId: withBrief.project.floors[0]!.id });
    expect(fix.input.x).toBeGreaterThanOrEqual(0);
    expect(fix.input.width).toBeGreaterThan(2);
    expect(fix.input.depth).toBeGreaterThan(2);
    // And it must not land on the bedroom that is already there.
    const existing = withBrief.project.rooms.find((r) => r.kind === 'bedroom')!;
    expect(rectsOverlap(existing, fix.input as unknown as Rect)).toBe(false);
    const bath = issues.find((i) => i.message.includes('Bathroom'))!;
    expect(bath.message).toBe('The brief asked for 1 × Bathroom, but only 0 exist.');
  });

  it('says nothing once the brief is satisfied', () => {
    let p = site();
    const floorId = p.floors[0]!.id;
    const bedroom = createRoom(p, { floorId, kind: 'bedroom', x: 4, y: 4, width: 4, depth: 3 });
    if (!bedroom.ok) throw new Error(bedroom.error);
    const withBrief = setBrief(bedroom.project, brief([{ kind: 'bedroom', count: 1 }]));
    if (!withBrief.ok) throw new Error(withBrief.error);
    expect(codes(withBrief.project)).not.toContain('brief_room_missing');
  });

  it('reports glazing below the daylight target', () => {
    const p = site();
    // One 4 × 3 = 12 m² living room with no windows at all: ratio 0.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);

    const issues = withCode(r.project, 'window_into_service_space');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.elements).toEqual([p.floors[0]!.id]);
    expect(issues[0]!.message).toContain('Glazing on Ground floor is 0%');
    expect(issues[0]!.message).toContain('below the 12% daylight target');
  });

  it('clears the daylight report once glazing covers enough floor area', () => {
    let p = site();
    const floorId = p.floors[0]!.id;
    const r = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const w = createWall(r.project, { floorId, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 8, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    // A 2.00 × 1.50 m window: 3.00 m² of glazing over 12 m² of room = 0.25.
    const glazed = addOpening(w.project, { wallId: w.createdIds[0], kind: 'window', offset: 2, width: 2, height: 1.5, sill: 0.9 });
    if (!glazed.ok) throw new Error(glazed.error);

    expect(codes(glazed.project)).not.toContain('window_into_service_space');
  });

  it('excludes service kinds from the daylight calculation', () => {
    const p = site();
    // A 0.7 m corridor is excluded by kind, so there is nothing left to judge.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'corridor', x: 12, y: 4, width: 4, depth: 0.7 });
    if (!r.ok) throw new Error(r.error);
    expect(codes(r.project)).not.toContain('window_into_service_space');
  });
});

// ───────────────────────────────────────────────── configurable rules ──────

describe('ConstraintRules are configurable', () => {
  it('ships the documented defaults', () => {
    expect(DEFAULT_RULES).toEqual({
      maxPlotCoverage: 0.6,
      maxFloorAreaRatio: 1.8,
      minCorridorWidth: 0.9,
      minWindowRatio: 0.12,
      minBathroomClearance: 0.6,
      enforcePlotRules: true,
    });
  });

  it('widens the corridor rule on demand', () => {
    const p = site();
    // 1.00 m corridor: fine at the 0.90 m default, too narrow at 1.20 m.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'corridor', x: 12, y: 4, width: 1, depth: 4 });
    if (!r.ok) throw new Error(r.error);

    expect(codes(r.project)).not.toContain('dimension_implausible');
    expect(codes(r.project, { ...DEFAULT_RULES, minCorridorWidth: 1.2 })).toContain('dimension_implausible');
    // …and the opposite direction: 0.50 m passes a rule nobody would set by
    // accident, which proves the number is read from the argument.
    expect(codes(r.project, { ...DEFAULT_RULES, minCorridorWidth: 0.5 })).not.toContain('dimension_implausible');
  });

  it('raises the daylight target on demand', () => {
    let p = site();
    const floorId = p.floors[0]!.id;
    const r = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const w = createWall(r.project, { floorId, type: 'exterior', a: { x: 4, y: 4 }, b: { x: 8, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    // Glazing ratio 3.00 / 12.00 = 0.25.
    const glazed = addOpening(w.project, { wallId: w.createdIds[0], kind: 'window', offset: 2, width: 2, height: 1.5, sill: 0.9 });
    if (!glazed.ok) throw new Error(glazed.error);

    expect(codes(glazed.project)).not.toContain('window_into_service_space');
    expect(codes(glazed.project, { ...DEFAULT_RULES, minWindowRatio: 0.3 })).toContain('window_into_service_space');
  });

  it('relaxes the coverage target on demand', () => {
    const p = blankProject('Open site');
    const plotted = setPlot(p, { width: 20, depth: 20, setbacks: { front: 0, rear: 0, left: 0, right: 0 } });
    if (!plotted.ok) throw new Error(plotted.error);
    const floorId = plotted.project.floors[0]!.id;
    const a = createRoom(plotted.project, { floorId, kind: 'living', x: 0, y: 0, width: 14, depth: 10 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'garage', x: 0, y: 10, width: 14, depth: 10 });
    if (!b.ok) throw new Error(b.error);

    // Coverage 0.70: over the 0.60 default, under a 0.75 project target.
    expect(codes(b.project)).toContain('coverage_exceeded');
    expect(codes(b.project, { ...DEFAULT_RULES, maxPlotCoverage: 0.75 })).not.toContain('coverage_exceeded');
  });

  it('relaxes the FAR target on demand', () => {
    let p = blankProject('Open site');
    const plotted = setPlot(p, { width: 20, depth: 20, setbacks: { front: 0, rear: 0, left: 0, right: 0 } });
    if (!plotted.ok) throw new Error(plotted.error);
    const ground = plotted.project.floors[0]!.id;
    const g = createRoom(plotted.project, { floorId: ground, kind: 'hall', x: 0, y: 0, width: 4, depth: 4 });
    if (!g.ok) throw new Error(g.error);
    const one = addFloor(g.project, 'First floor');
    if (!one.ok) throw new Error(one.error);
    const two = addFloor(one.project, 'Second floor');
    if (!two.ok) throw new Error(two.error);
    const r1 = createRoom(two.project, { floorId: one.project.floors[1]!.id, kind: 'bedroom', x: 0, y: 0, width: 20, depth: 20 });
    if (!r1.ok) throw new Error(r1.error);
    const r2 = createRoom(r1.project, { floorId: two.project.floors[2]!.id, kind: 'bedroom', x: 0, y: 0, width: 20, depth: 20 });
    if (!r2.ok) throw new Error(r2.error);

    // FAR 2.04: over the 1.80 default, under a 3.00 project target.
    expect(codes(r2.project)).toContain('far_exceeded');
    expect(codes(r2.project, { ...DEFAULT_RULES, maxFloorAreaRatio: 3 })).not.toContain('far_exceeded');
  });

  it('relaxes setbacks by changing the plot, and switches the whole family off', () => {
    let p = site();
    // Envelope x starts at 3; a room at x = 2 overhangs it by 1.00 m.
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    expect(codes(r.project)).toContain('setback_violation');

    // Shrinking the left setback from 3 m to 1 m moves the envelope to x = 1,
    // which the room at x = 2 now sits inside. (`setPlot` merges the patch at
    // runtime but types `setbacks` as a whole, so all four sides are restated.)
    const relaxed = setPlot(r.project, { setbacks: { front: 3, rear: 3, left: 1, right: 3 } });
    if (!relaxed.ok) throw new Error(relaxed.error);
    expect(codes(relaxed.project)).not.toContain('setback_violation');

    // And the master switch removes the check family entirely, even for a
    // project that is badly over-covered.
    const covered = patch(relaxed.project, {
      rooms: [...relaxed.project.rooms, room('rm_big', relaxed.project.floors[0]!.id, 'bedroom', 1, 3, 20, 13)],
    });
    expect(codes(covered, { ...DEFAULT_RULES, enforcePlotRules: false })).not.toContain('setback_violation');
    expect(codes(covered, { ...DEFAULT_RULES, enforcePlotRules: false })).not.toContain('coverage_exceeded');
    expect(codes(covered, { ...DEFAULT_RULES, enforcePlotRules: false })).not.toContain('far_exceeded');
  });

  it('does not mutate the rules object it is given', () => {
    const p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const rules = { ...DEFAULT_RULES };
    validate(r.project, rules);
    expect(rules).toEqual(DEFAULT_RULES);
    expect(DEFAULT_RULES.enforcePlotRules).toBe(true);
  });
});

// ──────────────────────────────────────────────── issue helpers and output ────

describe('errorsOnly', () => {
  /** A project carrying one of each severity: overlap (error), corridor (warning), brief (info). */
  const mixed = () => {
    let p = site();
    const floorId = p.floors[0]!.id;
    // living x 4..8 / y 4..7 and dining x 6..10 / y 5..8 overlap by 2 × 2 = 4 m².
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 6, y: 5, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);
    // 0.70 m corridor → warning.
    const c = createRoom(b.project, { floorId, kind: 'corridor', x: 12, y: 4, width: 0.7, depth: 4 });
    if (!c.ok) throw new Error(c.error);
    const withBrief = setBrief(c.project, {
      plot: { width: 24, depth: 18, orientation: 0, setbacks: { front: 3, rear: 3, left: 3, right: 3 } },
      floorCount: 1,
      rooms: [{ kind: 'bedroom', count: 2 }],
      preferredAreas: {},
      style: 'modern',
      preferences: { accessibility: false, ventilation: false, privacy: false, daylight: false },
    });
    if (!withBrief.ok) throw new Error(withBrief.error);
    return withBrief.project;
  };

  it('keeps only the errors', () => {
    const all = validate(mixed());
    const errs = errorsOnly(all);

    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((i) => i.severity === 'error')).toBe(true);
    expect(errs.map((i) => i.code)).toContain('room_overlap');
    expect(errs.map((i) => i.code)).toContain('no_entrance');
    expect(errs.map((i) => i.code)).not.toContain('dimension_implausible');
    expect(errs.map((i) => i.code)).not.toContain('brief_room_missing');
    expect(errs).toHaveLength(all.filter((i) => i.severity === 'error').length);
  });

  it('is empty when nothing is wrong at that severity', () => {
    const p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    const onlyInfo = errorsOnly(validate(r.project));
    // The room is fine; the only reports are the entrance and daylight hints.
    expect(onlyInfo.map((i) => i.severity)).toEqual(['error']); // no_entrance
    expect(onlyInfo.map((i) => i.code)).toEqual(['no_entrance']);
  });
});

describe('issuesFor', () => {
  it('returns every issue that names an element', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 6, y: 5, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    const all = validate(b.project);
    for (const roomId of [a.createdIds[0]!, b.createdIds[0]!]) {
      const mine = issuesFor(all, roomId);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((i) => i.elements.includes(roomId))).toBe(true);
      // Both rooms appear in the same single overlap issue.
      expect(mine.filter((i) => i.code === 'room_overlap')).toHaveLength(1);
    }
  });

  it('returns nothing for an id that is not in the model', () => {
    const p = site();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    expect(issuesFor(validate(r.project), 'rm_ghost')).toEqual([]);
  });

  it('never surfaces a global issue, because those name no element', () => {
    const p = site();
    const withBrief = setBrief(p, {
      plot: { width: 24, depth: 18, orientation: 0, setbacks: { front: 3, rear: 3, left: 3, right: 3 } },
      floorCount: 1,
      rooms: [{ kind: 'bedroom', count: 2 }],
      preferredAreas: {},
      style: 'modern',
      preferences: { accessibility: false, ventilation: false, privacy: false, daylight: false },
    });
    if (!withBrief.ok) throw new Error(withBrief.error);

    const all = validate(withBrief.project);
    const global = all.filter((i) => i.code === 'brief_room_missing');
    expect(global).toHaveLength(1);
    expect(global[0]!.elements).toEqual([]);

    // No id anywhere in the project can select it.
    for (const id of [
      withBrief.project.id,
      withBrief.project.floors[0]!.id,
      ...withBrief.project.rooms.map((r) => r.id),
    ]) {
      expect(issuesFor(all, id).map((i) => i.code)).not.toContain('brief_room_missing');
    }
  });
});

describe('issue output', () => {
  it('sorts errors first, then warnings, then info, then by code', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 6, y: 5, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);
    const c = createRoom(b.project, { floorId, kind: 'corridor', x: 12, y: 4, width: 0.7, depth: 4 });
    if (!c.ok) throw new Error(c.error);
    const w = createWall(c.project, { floorId, type: 'interior', a: { x: 4, y: 12 }, b: { x: 8, y: 12 } });
    if (!w.ok) throw new Error(w.error);

    const order = { error: 0, warning: 1, info: 2 } as const;
    const issues = validate(w.project);
    expect(issues.length).toBeGreaterThan(3);
    for (let i = 1; i < issues.length; i++) {
      const prev = issues[i - 1]!;
      const cur = issues[i]!;
      const delta = order[prev.severity] - order[cur.severity];
      if (delta > 0) throw new Error('severity order broken');
      if (delta === 0 && prev.code.localeCompare(cur.code) > 0) throw new Error('code order broken');
    }
    expect(issues[0]!.severity).toBe('error');
  });

  it('gives every issue a unique id and a non-empty sentence', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 6, y: 5, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    const issues = validate(b.project);
    expect(issues.length).toBeGreaterThan(0);
    expect(new Set(issues.map((i) => i.id)).size).toBe(issues.length);
    for (const i of issues) {
      expect(i.id.startsWith('is_')).toBe(true);
      expect(i.message.length).toBeGreaterThan(10);
      expect(Array.isArray(i.elements)).toBe(true);
    }
  });

  it('is deterministic — the same project validates identically twice', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 4, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 6, y: 5, width: 4, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    // Issue ids come from a counter, so compare everything except the id.
    const strip = (list: ReturnType<typeof validate>) => list.map(({ id: _id, ...rest }) => rest);
    expect(strip(validate(b.project))).toEqual(strip(validate(b.project)));
  });
});

describe('openingRectsFor', () => {
  it('returns one footprint rect per opening, in wall order', () => {
    const p = site();
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const door = addOpening(w.project, {
      wallId: w.createdIds[0],
      kind: 'door',
      offset: 3,
      width: OPENING_DEFAULTS.interiorDoor.width,
      height: OPENING_DEFAULTS.interiorDoor.height,
    });
    if (!door.ok) throw new Error(door.error);
    const wallInProject = door.project.walls[0]!;

    const rects = openingRectsFor(wallInProject);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.opening).toBe(wallInProject.openings[0]);
    // dir = (1,0), normal = (0,1), so the footprint is the 0.90 × 0.10 slab
    // spanning x 7 ± 0.45 = 6.55..7.45 and y 4 ± 0.05 = 3.95..4.05.
    expect(rects[0]!.rect.x).toBeCloseTo(6.55, 10);
    expect(rects[0]!.rect.y).toBeCloseTo(3.95, 10);
    expect(rects[0]!.rect.width).toBeCloseTo(0.9, 10);
    expect(rects[0]!.rect.depth).toBeCloseTo(0.1, 10);
  });

  it('is empty for a wall with no openings', () => {
    const p = site();
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    expect(openingRectsFor(w.project.walls[0]!)).toEqual([]);
  });

  it('re-exports the wall footprint helper', () => {
    const p = site();
    // A 6 m horizontal wall of thickness 0.10 centred on y = 4.
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const fp = wallFootprint(w.project.walls[0]!);
    expect(fp.x).toBeCloseTo(4, 10);
    expect(fp.y).toBeCloseTo(3.95, 10);
    expect(fp.width).toBeCloseTo(6, 10);
    expect(fp.depth).toBeCloseTo(0.1, 10);
  });
});
// ─────────────────────────────────────── corrections the engine offers ──────

describe('the corrections it offers actually work', () => {
  /**
   * A suggested correction the user clicks has to clear the problem it names.
   * "Shrink A to `b.y - a.y` deep" only does that when B is below A; for two
   * rooms side by side at the same y it asks for a depth of 0, which
   * `resizeRoom` refuses — so the panel offered a button that could not work.
   */
  function applyFirstFix(p: Project): Project {
    const issue = withCode(p, 'room_overlap')[0];
    const fix = issue?.fixes?.find((f) => f.tool === 'resize_room');
    if (!fix) throw new Error('no resize correction was offered');
    const res = resizeRoom(p, fix.input as { roomId: string; width?: number; depth?: number; x?: number; y?: number });
    if (!res.ok) throw new Error(`the offered correction was rejected: ${res.error}`);
    return res.project;
  }

  it('clears a side-by-side overlap, the way an assistant usually places a room', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    // a: x 4..9, y 4..7.  b: x 7..10.2, y 4..7 — the same row, overlapping 2 m.
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 5, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'office', x: 7, y: 4, width: 3.2, depth: 3 });
    if (!b.ok) throw new Error(b.error);
    expect(withCode(b.project, 'room_overlap')).toHaveLength(1);

    const fixed = applyFirstFix(b.project);
    expect(codes(fixed), 'applying the offered correction must clear the overlap').not.toContain('room_overlap');
    // It shrank a room rather than deleting one.
    expect(fixed.rooms).toHaveLength(2);
  });

  it('clears a stacked overlap', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    // a: x 4..9, y 4..7.  b: x 4..9, y 6..10 — directly below, overlapping 1 m deep.
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 5, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'dining', x: 4, y: 6, width: 5, depth: 4 });
    if (!b.ok) throw new Error(b.error);

    const fixed = applyFirstFix(b.project);
    expect(codes(fixed)).not.toContain('room_overlap');
    expect(fixed.rooms).toHaveLength(2);
  });

  it('keeps the room it shrinks anchored where it was', () => {
    const p = site();
    const floorId = p.floors[0]!.id;
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 5, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'office', x: 7, y: 4, width: 3.2, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    const before = b.project.rooms.find((r) => r.id === a.createdIds[0])!;
    const after = applyFirstFix(b.project).rooms.find((r) => r.id === a.createdIds[0])!;
    // A bottom-right anchor would have moved x from 4 to 6 and left the
    // overlap in place; the correction must hold the top-left corner.
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.x + after.width).toBeCloseTo(7, 6);
  });

  it('offers nothing rather than offering a correction that cannot apply', () => {
    // Two rooms whose top-left corners are almost the same point: neither can
    // be shortened to clear the other without dropping under the 0.15 m
    // minimum, so `resizeRoom` would reject it. The engine must not advertise
    // a button that is guaranteed to fail.
    const p = site();
    const floorId = p.floors[0]!.id;
    // a: x 4.00..9.00, y 4.00..7.00.  b: x 4.05..9.05, y 4.05..7.05.
    // Trimming a to b's left edge gives 0.05 m, and to b's top edge 0.05 m.
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 5, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'office', x: 4.05, y: 4.05, width: 5, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    expect(withCode(b.project, 'room_overlap')).toHaveLength(1);
    const fixes = withCode(b.project, 'room_overlap')[0]!.fixes ?? [];
    expect(fixes.map((f) => f.tool)).not.toContain('resize_room');
    // Removal is still offered, because that one is always possible.
    expect(fixes.map((f) => f.tool)).toContain('remove_element');
  });
});

/**
 * The measurement engine.
 *
 * Every area the studio quotes is computed here from the canonical model with
 * an explicit formula, and several of them — plot coverage, floor area ratio,
 * occupancy — are the numbers a design is judged on. These tests defend the
 * arithmetic rather than the plumbing: a known rectangle's area is checked by
 * hand, the setbacks are subtracted by hand, and each distinction the formulas
 * draw (indoor vs outdoor, ground floor vs upper storey, covered deck vs open
 * deck) is pinned down one at a time so a change to one cannot quietly move
 * another.
 */
import { describe, expect, it } from 'vitest';
import { addFloor, addOutdoorSpace, blankProject, createRoom, renameFloor, setPlot } from './ops.ts';
import { buildableRect, freeSpace, measureBuilding, measureRoom, occupancy, roomArea } from './measure.ts';
import type { Project } from './types.ts';

/**
 * A 24 × 18 m plot with a 3 m setback all round. That leaves a buildable
 * envelope of (24 − 3 − 3) × (18 − 3 − 3) = 18 × 12 = 216 m² at (3, 3).
 */
const PLOT = {
  width: 24,
  depth: 18,
  orientation: 0 as const,
  setbacks: { front: 3, rear: 3, left: 3, right: 3 },
};

function site(): Project {
  const res = setPlot(blankProject('Test site'), PLOT);
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

/**
 * A ground floor of three 6 × 4 m rooms, plus one 6 × 4 m room on an upper
 * floor, all indoors. Every room is 24 m², so the totals are easy to state.
 *
 *   (3,3) living 6×4   (9,3) bedroom 6×4
 *                     (9,7) bathroom 6×4        ← the upper bedroom repeats
 *                                                    the ground bedroom's box
 */
function house() {
  let p = site();
  const ground = p.floors[0]!.id;
  const ids: Record<string, string> = {};

  for (const [key, kind, x, y, width, depth] of [
    ['living', 'living', 3, 3, 6, 4],
    ['bedroom', 'bedroom', 9, 3, 6, 4],
    ['bathroom', 'bathroom', 9, 7, 6, 4],
  ] as const) {
    const res = createRoom(p, { floorId: ground, kind, x, y, width, depth });
    if (!res.ok) throw new Error(res.error);
    p = res.project;
    ids[key] = res.createdIds[0]!;
  }

  const up = addFloor(p);
  if (!up.ok) throw new Error(up.error);
  p = up.project;
  // `addFloor` derives elevation from the storey below: 0 + 3 m = 3 m.
  const upper = p.floors[1]!.id;
  const renamed = renameFloor(p, upper, 'First floor');
  if (!renamed.ok) throw new Error(renamed.error);
  p = renamed.project;

  const upstairs = createRoom(p, { floorId: upper, kind: 'bedroom', x: 9, y: 3, width: 6, depth: 4 });
  if (!upstairs.ok) throw new Error(upstairs.error);
  p = upstairs.project;

  return {
    p,
    ground,
    upper,
    living: ids.living!,
    bedroom: ids.bedroom!,
    bathroom: ids.bathroom!,
    upstairs: upstairs.createdIds[0]!,
  };
}

/** Ground floor only, with just the two rooms at the front of the envelope. */
function twoRooms() {
  let p = site();
  const ground = p.floors[0]!.id;
  const a = createRoom(p, { floorId: ground, kind: 'living', x: 3, y: 3, width: 6, depth: 4 });
  if (!a.ok) throw new Error(a.error);
  p = a.project;
  const b = createRoom(a.project, { floorId: ground, kind: 'bedroom', x: 9, y: 3, width: 6, depth: 4 });
  if (!b.ok) throw new Error(b.error);
  return { p: b.project, ground, living: a.createdIds[0]!, bedroom: b.createdIds[0]! };
}

/** Mark a room outdoor without going through an operation, to isolate the flag. */
function withOutdoor(p: Project, roomId: string): Project {
  return { ...p, rooms: p.rooms.map((r) => (r.id === roomId ? { ...r, outdoor: true } : r)) };
}

describe('roomArea', () => {
  it('returns the rectangle area of a known room exactly', () => {
    const { p, living } = house();
    // 6 m × 4 m = 24 m², and it is exactly representable, so no tolerance is
    // needed to state the headline claim of the module.
    expect(roomArea(p, living)).toBe(24);
  });

  it('follows the rectangle when the room is resized', () => {
    const { p, living } = house();
    const grown = { ...p, rooms: p.rooms.map((r) => (r.id === living ? { ...r, width: 6, depth: 7.5 } : r)) };
    // 6 × 7.5 = 45 m²
    expect(roomArea(grown, living)).toBe(45);
  });

  it('is zero for a room that does not exist rather than NaN', () => {
    const { p } = house();
    expect(roomArea(p, 'rm_ghost')).toBe(0);
  });

  it('clamps an inverted rectangle to zero instead of reporting a negative area', () => {
    // rectArea multiplies max(0, width) × max(0, depth), so a room dragged
    // inside-out can never make the building's total area go negative.
    const { p, living } = house();
    const inverted = { ...p, rooms: p.rooms.map((r) => (r.id === living ? { ...r, width: -6 } : r)) };
    expect(roomArea(inverted, living)).toBe(0);
  });
});

describe('measureRoom', () => {
  it('reports area and perimeter for a known rectangle', () => {
    const { p, living } = house();
    const m = measureRoom(p, living)!;
    // Area 6 × 4 = 24 m². Perimeter 2 × (6 + 4) = 20 m.
    expect(m.area).toBe(24);
    expect(m.perimeter).toBe(20);
    expect(m.width).toBe(6);
    expect(m.depth).toBe(4);
  });

  it('perimeter is 2 × (width + depth), not the sum of the sides once', () => {
    const { p, bedroom } = house();
    // 6 + 4 + 6 + 4 = 20 m, the same figure as 2 × (6 + 4).
    expect(measureRoom(p, bedroom)!.perimeter).toBe(6 + 4 + 6 + 4);
  });

  it('carries the room identity through so a caller needs no second lookup', () => {
    const { p, bathroom } = house();
    const m = measureRoom(p, bathroom)!;
    expect(m.roomId).toBe(bathroom);
    expect(m.kind).toBe('bathroom');
    expect(m.label).toBe('Bathroom');
  });

  it('is null for an unknown room', () => {
    const { p } = house();
    expect(measureRoom(p, 'rm_ghost')).toBeNull();
  });
});

describe('measureBuilding', () => {
  it('adds up plot, buildable and room areas from the documented formulas', () => {
    const { p } = house();
    const m = measureBuilding(p);

    // plot area = 24 × 18 = 432 m²
    expect(m.plotArea).toBe(432);
    // buildable area = (24 − 3 − 3) × (18 − 3 − 3) = 18 × 12 = 216 m²
    expect(m.buildableArea).toBe(216);
    // net indoor = four indoor rooms × 24 m², across both storeys
    expect(m.netIndoorArea).toBe(96);
    // footprint = the three ground-floor indoor rooms × 24 m²
    expect(m.footprintArea).toBe(72);
    // gross covered = every indoor room × 24 m² (no decks in this fixture)
    expect(m.grossCoveredArea).toBe(96);
    // open site = 432 − 72 = 360 m²
    expect(m.openSiteArea).toBe(360);
  });

  it('derives coverage and FAR as the two ratios the codes are judged against', () => {
    const { p } = house();
    const m = measureBuilding(p);
    // coverage = footprint ÷ plot = 72 ÷ 432 = 1/6
    expect(m.plotCoverage).toBeCloseTo(1 / 6, 12);
    // FAR = gross covered ÷ plot = 96 ÷ 432 = 2/9
    expect(m.floorAreaRatio).toBeCloseTo(2 / 9, 12);
  });

  it('reports each floor with its elevation and its own net area', () => {
    const { p } = house();
    const [g, f] = measureBuilding(p).perFloor;

    expect(g).toMatchObject({ label: 'Ground floor', elevation: 0, netArea: 72, coveredArea: 72, roomCount: 3 });
    // The upper storey sits one storey height up: 0 + 3 m = 3 m.
    expect(f).toMatchObject({ label: 'First floor', elevation: 3, netArea: 24, coveredArea: 24, roomCount: 1 });
  });

  it('sums the per-floor net areas back to the building total', () => {
    const { p } = house();
    const m = measureBuilding(p);
    const summed = m.perFloor.reduce((s, f) => s + f.netArea, 0);
    // 72 + 24 = 96 m², which is netIndoorArea.
    expect(summed).toBe(m.netIndoorArea);
  });

  it('orders the per-floor report by storey order, not by array order', () => {
    const { p } = house();
    // measureBuilding only reads the model, so reversing the array is enough
    // to prove the report sorts by `order` rather than trusting the array.
    const reversed = { ...p, floors: [...p.floors].reverse() };
    const floors = measureBuilding(reversed).perFloor;
    expect(floors.map((f) => f.elevation)).toEqual([0, 3]);
  });

  it('lists every room, and its measured area matches the model rectangle', () => {
    const { p } = house();
    const m = measureBuilding(p);
    expect(m.rooms).toHaveLength(4);
    for (const room of m.rooms) {
      expect(room.area).toBe(24);
    }
    expect(m.rooms.map((r) => r.roomId).sort()).toEqual([...p.rooms.map((r) => r.id)].sort());
  });

  it('keeps an outdoor room in the report but out of every indoor total', () => {
    const { p, bedroom } = house();
    const m = measureBuilding(withOutdoor(p, bedroom));

    // The bedroom is still listed…
    expect(m.rooms).toHaveLength(4);
    expect(m.rooms.find((r) => r.roomId === bedroom)!.area).toBe(24);
    // …but no longer counted as indoor area, on any storey or in total.
    // 24 (living) + 24 (bathroom) + 24 (upstairs) = 72 m²
    expect(m.netIndoorArea).toBe(72);
    // Ground footprint drops to the living and bathroom rooms: 24 + 24 = 48.
    expect(m.footprintArea).toBe(48);
    expect(m.grossCoveredArea).toBe(72);
    // The floor's net area excludes it too, while the room count — which counts
    // rooms, not indoor rooms — still sees it.
    expect(m.perFloor[0]!.netArea).toBe(48);
    expect(m.perFloor[0]!.roomCount).toBe(3);
  });

  it('counts a ground-floor balcony as covered but a ground-floor terrace as open', () => {
    let p = site();
    const ground = p.floors[0]!.id;
    const room = createRoom(p, { floorId: ground, kind: 'living', x: 3, y: 3, width: 6, depth: 4 });
    if (!room.ok) throw new Error(room.error);
    p = room.project;

    // Both decks are 4 × 3 = 12 m² and both sit on the ground floor at
    // elevation 0. A balcony is covered whatever its elevation; a terrace is
    // only covered once it is above the ground.
    const balcony = addOutdoorSpace(p, { floorId: ground, kind: 'balcony', x: 3, y: 8, width: 4, depth: 3 });
    if (!balcony.ok) throw new Error(balcony.error);
    p = balcony.project;
    const terrace = addOutdoorSpace(p, { floorId: ground, kind: 'terrace', x: 10, y: 8, width: 4, depth: 3 });
    if (!terrace.ok) throw new Error(terrace.error);
    p = terrace.project;

    const m = measureBuilding(p);
    // 24 m² of room + 12 m² of balcony. The 12 m² terrace is open ground.
    expect(m.grossCoveredArea).toBe(36);
    expect(m.netIndoorArea).toBe(24);
    expect(m.footprintArea).toBe(24);
    // per-floor covered area = 24 m² of rooms + the 12 m² balcony.
    expect(m.perFloor[0]!.coveredArea).toBe(36);
    expect(m.perFloor[0]!.netArea).toBe(24);
  });

  it('counts every deck on an upper floor as covered, balcony or terrace alike', () => {
    let p = house().p;
    const upper = p.floors[1]!.id;
    const balcony = addOutdoorSpace(p, { floorId: upper, kind: 'balcony', x: 16, y: 3, width: 2, depth: 2 });
    if (!balcony.ok) throw new Error(balcony.error);
    p = balcony.project;
    const terrace = addOutdoorSpace(p, { floorId: upper, kind: 'terrace', x: 16, y: 6, width: 3, depth: 2 });
    if (!terrace.ok) throw new Error(terrace.error);
    p = terrace.project;

    const m = measureBuilding(p);
    // 96 m² of indoor rooms + 2×2 = 4 (balcony) + 3×2 = 6 (terrace) = 106 m².
    // Both sit at elevation 3 m, well above the 0.05 m ground test.
    expect(m.grossCoveredArea).toBe(106);
    // Neither is on the ground floor, so the footprint is untouched.
    expect(m.footprintArea).toBe(72);
    // FAR rises with the decks: (96 + 10) ÷ 432 = 106/432
    expect(m.floorAreaRatio).toBeCloseTo(106 / 432, 12);
    // Upper floor covered = 24 m² of rooms + 4 + 6 of deck.
    expect(m.perFloor[1]!.coveredArea).toBe(34);
    expect(m.perFloor[1]!.netArea).toBe(24);
  });

  it('counts a ground-level porch as covered, but not as building footprint', () => {
    // A porch is covered by definition — that is what separates it from a
    // terrace. It is not enclosed space, so it raises the covered area (and so
    // FAR) without inflating the footprint or the plot coverage.
    //
    // Regression guard: `isCoveredOutdoor` rejects every deck at ground
    // elevation, and a porch only ever sits at ground level. Handling the porch
    // after that test made it unreachable, so the porch contributed to nothing
    // at all. Handled before it, 4 × 3 = 12 m² lands in the covered area.
    let p = site();
    const ground = p.floors[0]!.id;
    const room = createRoom(p, { floorId: ground, kind: 'living', x: 3, y: 3, width: 6, depth: 4 });
    if (!room.ok) throw new Error(room.error);
    p = room.project;
    const porch = addOutdoorSpace(p, { floorId: ground, kind: 'porch', x: 3, y: 8, width: 4, depth: 3 });
    if (!porch.ok) throw new Error(porch.error);
    p = porch.project;

    const m = measureBuilding(p);
    // Footprint stays 6 × 4 = 24 m²: the porch is not enclosed.
    expect(m.footprintArea).toBe(24);
    // Covered area is the room plus the 4 × 3 = 12 m² porch.
    expect(m.grossCoveredArea).toBe(36);
    expect(m.perFloor[0]!.coveredArea).toBe(36);
    // And the porch does not eat into the open site either.
    expect(m.openSiteArea).toBe(m.plotArea - 24);
  });

  it('reports ratios as zero rather than dividing by a zero-area plot', () => {
    const { p } = house();
    const flat = { ...p, plot: { ...p.plot, width: 0 } };
    const m = measureBuilding(flat);
    expect(m.plotCoverage).toBe(0);
    expect(m.floorAreaRatio).toBe(0);
  });
});

describe('buildableRect', () => {
  it('is the plot inset by each setback, measured from the plot origin', () => {
    const { p } = house();
    // The envelope starts one left setback and one front setback in.
    expect(buildableRect(p)).toEqual({ x: 3, y: 3, width: 18, depth: 12 });
    // 18 × 12 = 216 m², the same buildable area measureBuilding reports.
    expect(buildableRect(p).width * buildableRect(p).depth).toBe(measureBuilding(p).buildableArea);
  });

  it('honours asymmetric setbacks', () => {
    const base = blankProject('Asymmetric');
    const res = setPlot(base, { width: 20, depth: 20, setbacks: { front: 2, rear: 4, left: 1.5, right: 5 } });
    if (!res.ok) throw new Error(res.error);
    // width  = 20 − 1.5 − 5  = 13.5
    // depth  = 20 − 2   − 4  = 14
    expect(buildableRect(res.project)).toEqual({ x: 1.5, y: 2, width: 13.5, depth: 14 });
  });

  it('clamps to zero when the setbacks would leave a negative envelope', () => {
    // setPlot refuses to author such a plot, but a hand-edited or imported file
    // can still hold one; buildableRect must not hand back a negative width.
    const { p } = house();
    const over = { ...p, plot: { ...p.plot, setbacks: { front: 20, rear: 20, left: 20, right: 20 } } };
    expect(buildableRect(over)).toEqual({ x: 20, y: 20, width: 0, depth: 0 });
  });
});

describe('occupancy', () => {
  it('reports the used area as a fraction of the buildable envelope', () => {
    const { p } = house();
    const o = occupancy(p);
    // total = 18 × 12 = 216 m² of envelope.
    expect(o.total).toBe(216);
    // used = the three ground-floor indoor rooms × 24 m² = 72 m². The upper
    // floor's room is stacked over the plot and does not compete for the
    // ground, so it is deliberately excluded.
    expect(o.used).toBe(72);
    // ratio = 72 ÷ 216 = 1/3
    expect(o.ratio).toBeCloseTo(1 / 3, 12);
  });

  it('counts outdoor rooms as free space, because they can be built on', () => {
    const { p, bedroom } = house();
    const o = occupancy(withOutdoor(p, bedroom));
    // Ground-floor indoor rooms are now the living room and the bathroom.
    expect(o.used).toBe(48);
    expect(o.ratio).toBeCloseTo(48 / 216, 12);
  });

  it('is a zero ratio when the envelope has collapsed', () => {
    const { p } = house();
    const over = { ...p, plot: { ...p.plot, setbacks: { front: 20, rear: 20, left: 20, right: 20 } } };
    // The rooms are still counted — 3 × 24 m² on the ground — but there is no
    // envelope left to divide them by, so the ratio is reported as 0.
    expect(occupancy(over)).toEqual({ used: 72, total: 0, ratio: 0 });
  });
});

describe('freeSpace', () => {
  it('returns the whole envelope when nothing is built on the ground', () => {
    const p = site();
    // No rooms at all, so the single grid cell is the envelope itself.
    expect(freeSpace(p)).toEqual([{ x: 3, y: 3, width: 18, depth: 12 }]);
  });

  it('reports the leftover strips around two front rooms', () => {
    const { p } = twoRooms();
    // The envelope is x ∈ [3,21], y ∈ [3,15]. Two 6×4 rooms fill the top-left
    // 12 × 4 corner block, so the grid lines are x = 3, 9, 15, 21 and
    // y = 3, 7, 15 — three columns of cells, of which only the two under the
    // rooms are occupied.
    //
    //   column x ∈ [3,9]   → free y ∈ [7,15]  → 6 × 8
    //   column x ∈ [9,15]  → free y ∈ [7,15]  → 6 × 8
    //   column x ∈ [15,21] → free y ∈ [3,15]  → 6 × 12
    expect(freeSpace(p)).toEqual([
      { x: 3, y: 7, width: 6, depth: 8 },
      { x: 9, y: 7, width: 6, depth: 8 },
      { x: 15, y: 3, width: 6, depth: 12 },
    ]);
  });

  it('accounts for the whole envelope minus the ground-floor rooms', () => {
    const { p } = twoRooms();
    const free = freeSpace(p).reduce((s, r) => s + r.width * r.depth, 0);
    // 48 + 48 + 72 = 168 m², which is 216 − 2 × 24. Nothing is double-counted
    // and nothing is lost to the merge.
    expect(free).toBe(168);
    expect(free + occupancy(p).used).toBe(occupancy(p).total);
  });

  it('treats an outdoor room as free, since it is not a building', () => {
    const { p, bedroom } = twoRooms();
    // With the bedroom demoted to outdoor only the living room blocks ground:
    //   column x ∈ [3,9]   → free y ∈ [7,15]   → 6 × 8   = 48
    //   column x ∈ [9,21]  → free y ∈ [3,15]   → 12 × 12 = 144
    expect(freeSpace(withOutdoor(p, bedroom))).toEqual([
      { x: 3, y: 7, width: 6, depth: 8 },
      { x: 9, y: 3, width: 12, depth: 12 },
    ]);
  });

  it('ignores rooms on an upper floor', () => {
    const { p } = twoRooms();
    const up = addFloor(p);
    if (!up.ok) throw new Error(up.error);
    let two = up.project;
    const stacked = createRoom(two, { floorId: two.floors[1]!.id, kind: 'bedroom', x: 15, y: 10, width: 6, depth: 4 });
    if (!stacked.ok) throw new Error(stacked.error);
    two = stacked.project;

    // The new room sits squarely inside the right-hand column and changes
    // nothing: a corridor is placed on one floor at a time.
    expect(freeSpace(two)).toEqual(freeSpace(p));
  });

  it('returns nothing when the rooms tile the envelope completely', () => {
    let p = site();
    const ground = p.floors[0]!.id;
    const a = createRoom(p, { floorId: ground, kind: 'living', x: 3, y: 3, width: 18, depth: 6 });
    if (!a.ok) throw new Error(a.error);
    p = a.project;
    const b = createRoom(p, { floorId: ground, kind: 'bedroom', x: 3, y: 9, width: 18, depth: 6 });
    if (!b.ok) throw new Error(b.error);
    p = b.project;

    expect(freeSpace(p)).toEqual([]);
  });
});
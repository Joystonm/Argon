/**
 * Deterministic brief → floor plan generator.
 *
 * This is what turns "a 15 × 20 plot with 3 bedrooms" into an actual plan
 * without asking the model to invent coordinates. The model reasons about the
 * BRIEF; this file does the arithmetic. That division is deliberate: geometry
 * the model produced by eye would be unreproducible and unvalidatable, whereas
 * geometry produced here can be re-derived, diffed, and checked.
 *
 * Layout strategy — a circulation spine with public and private bands:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │  front band: living + dining + kitchen      │   ← public, faces the street
 *   ├─────────────────────────────────────────────┤
 *   │  corridor spine, full width                 │   ← everything connects here
 *   ├─────────────────────────────────────────────┤
 *   │  rear band: bedrooms, bathrooms, service    │   ← private wing
 *   └─────────────────────────────────────────────┘
 *
 * Each band is filled by a recursive binary split that respects target areas
 * and alternates the split axis to keep rooms from becoming slivers. The bands
 * together tile the buildable envelope exactly, so coverage is known before a
 * single wall is drawn.
 */
import { DEFAULT_ROOM_AREA, KIND_LABEL } from './catalog.ts';
import { newId } from './ids.ts';
import { TOL, add, cross, dot, scale, sub, wallFrame } from './geometry.ts';
import { GOING, RISER, reindex, type OpResult } from './ops.ts';
import { expandBrief, planFloor, placeStair, type BriefRoomSpec } from './plan.ts';
import { freeSpace } from './measure.ts';
import type {
  DesignBrief,
  Floor,
  Id,
  Project,
  Room,
  RoomKind,
  Vec2,
  Wall,
} from './types.ts';

/** Clear width of a domestic stair flight. */
const STAIR_WIDTH = 1.4;
const CORRIDOR_WIDTH = 1.1;

// ─────────────────────────────────────────────────────────── band packing ─────

export interface Box {
  x: number;
  y: number;
  width: number;
  depth: number;
}

interface Weighted {
  kind: RoomKind;
  area: number;
}

/**
 * Fill `box` exactly with `items`, preserving their area proportions.
 *
 * Binary space partition: split the item list into two groups of roughly equal
 * area, split the box along its LONGER axis, recurse. Alternating on the
 * container's own aspect (rather than a fixed pattern) is what stops rooms
 * degenerating into long ribbons.
 */
function pack(box: Box, items: Weighted[]): Array<{ kind: RoomKind; box: Box; area: number }> {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ kind: items[0]!.kind, box, area: items[0]!.area }];

  // Split the list into two halves of near-equal total area.
  const total = items.reduce((s, i) => s + i.area, 0);
  const running = items.map((i) => i.area);
  const target = total / 2;
  let acc = 0;
  let splitAt = 1;
  for (let i = 0; i < items.length - 1; i++) {
    acc += running[i]!;
    splitAt = i + 1;
    if (acc >= target) break;
  }
  const leftItems = items.slice(0, splitAt);
  const rightItems = items.slice(splitAt);
  const leftArea = leftItems.reduce((s, i) => s + i.area, 0);

  // Split the box along its longer axis so children stay close to square.
  const horizontal = box.width >= box.depth;
  const ratio = total > 0 ? leftArea / total : 0.5;

  const [a, b] = horizontal
    ? [
        { ...box, width: box.width * ratio },
        { ...box, x: box.x + box.width * ratio, width: box.width * (1 - ratio) },
      ]
    : [
        { ...box, depth: box.depth * ratio },
        { ...box, y: box.y + box.depth * ratio, depth: box.depth * (1 - ratio) },
      ];

  return [...pack(a, leftItems), ...pack(b, rightItems)];
}

// ──────────────────────────────────────────────────────── floor allocation ────

const PUBLIC: ReadonlySet<RoomKind> = new Set(['living', 'dining', 'kitchen', 'lobby', 'hall', 'office', 'prayer']);
const SERVICE: ReadonlySet<RoomKind> = new Set(['utility', 'pantry', 'storage', 'garage']);
const PRIVATE: ReadonlySet<RoomKind> = new Set(['bedroom', 'guest', 'bathroom']);

function bathroomCount(bedrooms: number, floors: number): number {
  return Math.max(1, Math.min(4, Math.ceil(bedrooms / 2) + (floors > 1 ? 1 : 0)));
}

/** Decide which rooms land on which floor. */
export function allocateFloors(specs: BriefRoomSpec[], floorCount: number): BriefRoomSpec[][] {
  const floors: BriefRoomSpec[][] = Array.from({ length: floorCount }, () => []);

  // Bathrooms are derived, not asked for: one per two bedrooms, one more if
  // the house is split over floors so each storey can serve itself.
  const bedrooms = specs.filter((s) => s.kind === 'bedroom' || s.kind === 'guest').reduce((n, s) => n + s.count, 0);
  const neededBaths = bathroomCount(bedrooms, floorCount);
  const haveBaths = specs.filter((s) => s.kind === 'bathroom').reduce((n, s) => n + s.count, 0);
  const extraBaths = specs.filter((s) => s.kind === 'bathroom').slice(0, 0);
  void extraBaths;

  const queue: BriefRoomSpec[] = [...specs];
  for (let i = 0; i < neededBaths - haveBaths; i++) {
    queue.push({ kind: 'bathroom', count: 1, targetArea: DEFAULT_ROOM_AREA.bathroom });
  }

  // Ground floor takes public + service + the entrance. Private rooms fill up.
  const ground = floors[0]!;
  const rest = queue.filter((s) => PUBLIC.has(s.kind) || SERVICE.has(s.kind));
  for (const s of rest) for (let i = 0; i < s.count; i++) ground.push({ kind: s.kind, count: 1, targetArea: s.targetArea });

  const privateSpecs = queue.filter((s) => !PUBLIC.has(s.kind) && !SERVICE.has(s.kind));

  // Fill floors round-robin from the top down, so the ground floor keeps the
  // rooms people walk through.
  const upper = floors.slice(1);
  if (upper.length === 0) {
    for (const s of privateSpecs) for (let i = 0; i < s.count; i++) ground.push({ kind: s.kind, count: 1, targetArea: s.targetArea });
  } else {
    // Distribute private rooms evenly across the upper floors, with the ground
    // floor taking the overflow only if there are more than 5 of them.
    const upperCount = upper.length;
    privateSpecs.forEach((s, idx) => {
      const copies = Math.max(1, Math.round(s.count / Math.max(1, Math.ceil(upperCount))));
      for (let i = 0; i < s.count; i++) {
        const target = upper[Math.min(upperCount - 1, Math.floor((i / s.count) * upperCount))]!;
        void copies;
        void idx;
        target.push({ kind: s.kind, count: 1, targetArea: s.targetArea });
      }
    });
  }

  return floors.filter((f) => f.length > 0).length ? floors : [ground];
}

// ───────────────────────────────────────────────────────────────── voids ───────

/**
 * `box` with `hole` removed, as up to four boxes.
 *
 * Used to keep rooms out of a reserved rectangle — the stairwell. Splitting
 * rather than shrinking keeps the remaining floor area intact, so coverage
 * still adds up to the buildable envelope minus the void.
 *
 * Exported because the validator needs the same "what is left over" question
 * answered the same way when it offers to place a missing room.
 */
export function subtractRect(box: Box, hole: Box): Box[] {
  const x0 = Math.max(box.x, hole.x);
  const y0 = Math.max(box.y, hole.y);
  const x1 = Math.min(box.x + box.width, hole.x + hole.width);
  const y1 = Math.min(box.y + box.depth, hole.y + hole.depth);
  const slack = 0.05;
  if (x1 <= x0 + slack || y1 <= y0 + slack) return [box];

  const out: Box[] = [];
  if (y0 > box.y + slack) out.push({ x: box.x, y: box.y, width: box.width, depth: y0 - box.y });
  if (y1 < box.y + box.depth - slack) {
    out.push({ x: box.x, y: y1, width: box.width, depth: box.y + box.depth - y1 });
  }
  if (x0 > box.x + slack) out.push({ x: box.x, y: y0, width: x0 - box.x, depth: y1 - y0 });
  if (x1 < box.x + box.width - slack) out.push({ x: x1, y: y0, width: box.x + box.width - x1, depth: y1 - y0 });
  return out;
}

// ───────────────────────────────────────────────────────────── the generator ───

export interface GenerateOptions {
  /** Replace the project's floors with this many storeys. */
  floorCount?: number;
  /** Add starting furniture. Default true. */
  furnish?: boolean;
}

export interface GenerateReport {
  warnings: string[];
  /** Target vs delivered area, per room kind. */
  scale: number;
  floorCount: number;
}

export function generateFromBrief(
  project: Project,
  brief: DesignBrief,
  options: GenerateOptions = {},
): OpResult<{ report: GenerateReport; project: Project }> {
  const plot = brief.plot;
  const floorCount = Math.max(1, Math.min(4, options.floorCount ?? brief.floorCount));

  const envX = plot.setbacks.left;
  const envY = plot.setbacks.front;
  const envW = plot.width - plot.setbacks.left - plot.setbacks.right;
  const envD = plot.depth - plot.setbacks.front - plot.setbacks.rear;

  if (envW < 4 || envD < 4) {
    return {
      ok: false,
      code: 'conflict',
      error: `The setbacks leave only ${envW.toFixed(2)} m × ${envD.toFixed(2)} m to build on — that is too small for a house.`,
      hint: 'Reduce the setbacks or increase the plot size in the plot settings.',
    };
  }

  const warnings: string[] = [];
  const specs = expandBrief(brief);
  const perFloor = allocateFloors(specs, floorCount);
  const actualFloors = Math.max(1, perFloor.length);
  if (actualFloors < floorCount) {
    warnings.push(`Only ${actualFloors} floor${actualFloors === 1 ? '' : 's'} were needed for this brief, so the design is ${actualFloors === 1 ? 'single-storey' : `${actualFloors} storeys`}.`);
  }

  // ── build the floor shells ──────────────────────────────────────────────
  let next: Project = {
    ...project,
    plot,
    brief,
    floors: [],
    rooms: [],
    walls: [],
    stairs: [],
    outdoor: [],
    furniture: [],
  };

  for (let i = 0; i < actualFloors; i++) {
    const floor: Floor = {
      id: newId('fl'),
      name: i === 0 ? 'Ground floor' : `First floor`,
      elevation: 0,
      height: i === 0 ? 3.0 : 2.9,
      order: i,
      roomIds: [],
      wallIds: [],
      stairIds: [],
      outdoorIds: [],
    };
    if (i > 0) {
      const below = next.floors[i - 1]!;
      floor.elevation = below.elevation + below.height;
    }
    next.floors.push(floor);
  }

  // ── the shared band structure ─────────────────────────────────────────
  // Every storey uses the same split, so the stairwell lines up floor to floor
  // and the corridors sit one above the other.
  const frontDepth = Math.min(envD - CORRIDOR_WIDTH, Math.max(3.2, envD * 0.46));
  const corridorY = envY + frontDepth;
  const corridorDepth = CORRIDOR_WIDTH;
  const rearY = corridorY + corridorDepth;
  const rearDepth = envD - (rearY - envY);
  const useSpine = frontDepth >= 3 && rearDepth >= 2.2;

  // The stairwell is reserved BEFORE any room is placed. Hunting for leftover
  // space afterwards means the flight lands wherever the packing happened to
  // leave a gap — on a typical brief, at the back of an upstairs bathroom, with
  // the ground floor's rear band sitting empty. Reserving it also gives the
  // floor above a real void, which is what makes the flight walkable in 3D.
  //
  // It runs down the full depth of the front band against one flank, so
  // subtracting it leaves a single clean rectangle rather than slivers.
  const stairRun = actualFloors > 1
    ? Math.max(8, Math.round((next.floors[1]!.elevation - next.floors[0]!.elevation) / RISER)) * GOING
    : 0;
  const shaft: Box | null =
    actualFloors > 1 && useSpine && stairRun <= frontDepth
      ? { x: envX + envW - STAIR_WIDTH, y: envY, width: STAIR_WIDTH, depth: frontDepth }
      : null;
  if (actualFloors > 1 && !shaft) {
    warnings.push(
      `The plot is too shallow for a staircase beside the front rooms (a flight needs ${stairRun.toFixed(1)} m). One will be placed in whatever space is left, and the layout check will report where it lands.`,
    );
  }

  // ── lay out each floor ──────────────────────────────────────────────────
  let minScale = Infinity;

  perFloor.slice(0, actualFloors).forEach((floorSpecs, floorIndex) => {
    const floor = next.floors[floorIndex]!;
    const isGround = floorIndex === 0;

    // Public band (front) and private band (rear).
    let frontSpecs = floorSpecs.filter((s) => PUBLIC.has(s.kind));
    let rearSpecs = floorSpecs.filter((s) => !PUBLIC.has(s.kind));

    const totalRequested = floorSpecs.reduce((s, r) => s + r.targetArea, 0);
    const scale = envW * envD > 0 ? (envW * envD) / Math.max(1, totalRequested) : 1;
    minScale = Math.min(minScale, scale);

    const rooms: Room[] = [];

    const makeRoom = (kind: RoomKind, box: Box, isEntrance: boolean): Room => ({
      id: newId('rm'),
      floorId: floor.id,
      kind,
      label: KIND_LABEL[kind],
      x: box.x,
      y: box.y,
      width: Math.max(TOL.dimension, box.width),
      depth: Math.max(TOL.dimension, box.depth),
      height: 0,
      outdoor: kind === 'balcony' || kind === 'terrace',
      floorMaterial: undefined,
      isEntrance,
    });
    const spine = useSpine && floorSpecs.length > 1;

    /** Pack a set of specs into a box, preserving their area proportions. */
    const fill = (box: Box, specs: BriefRoomSpec[], isEntranceBand: boolean) => {
      if (specs.length === 0) return;

      // The stairwell is off limits; packing happens around it, not through it.
      // Slivers are dropped here rather than later: a 0.1 m strip is not a room,
      // and letting one through turns into a room that overlaps the corridor.
      const boxes = (shaft ? subtractRect(box, shaft) : [box]).filter((b) => b.width >= 1.2 && b.depth >= 1.2);
      if (boxes.length === 0) return;

      // The entrance band pins the living room to the street corner, so the
      // front door lands on the part of the house people actually approach.
      const living = isEntranceBand ? specs.find((s) => s.kind === 'living') : undefined;
      const [first, ...rest] = boxes;

      if (living && first) {
        const others = specs.filter((s) => s !== living);
        const clampedW = Math.min(Math.max(living.targetArea / first.depth, 2.6), first.width * 0.75);
        rooms.push(makeRoom('living', { x: first.x, y: first.y, width: clampedW, depth: first.depth }, isGround));

        const restBox: Box = { ...first, x: first.x + clampedW, width: first.width - clampedW };
        const targets = restBox.width >= 1.2 ? [restBox] : [];
        const groupArea = others.reduce((s, r) => s + r.targetArea, 0);
        for (const t of [...targets, ...rest]) {
          if (groupArea <= 0) break;
          for (const p of pack(t, others.map((o) => ({ kind: o.kind, area: (o.targetArea / groupArea) * t.width * t.depth })))) {
            rooms.push(makeRoom(p.kind, p.box, false));
          }
        }
        return;
      }

      // Otherwise spread the specs across the sub-boxes in proportion to how
      // many there are, so neither side of the stairwell is left bare.
      const remaining = specs.slice();
      boxes.forEach((b, i) => {
        const share =
          remaining.length > boxes.length - i
            ? remaining.splice(0, Math.max(1, Math.round(remaining.length / (boxes.length - i))))
            : remaining.splice(0);
        const groupArea = share.reduce((s, r) => s + r.targetArea, 0);
        if (groupArea <= 0) return;
        for (const p of pack(b, share.map((o) => ({ kind: o.kind, area: (o.targetArea / groupArea) * b.width * b.depth })))) {
          rooms.push(makeRoom(p.kind, p.box, isGround && isEntranceBand && rooms.length === 0));
        }
      });
    };

    if (spine) {
      // An upper floor is all private rooms. Split them across both bands
      // rather than leaving the whole frontage empty.
      if (frontSpecs.length === 0 && rearSpecs.length > 1) {
        const half = Math.ceil(rearSpecs.length / 2);
        frontSpecs = rearSpecs.slice(0, half);
        rearSpecs = rearSpecs.slice(half);
      }

      fill({ x: envX, y: envY, width: envW, depth: frontDepth }, frontSpecs, true);
      fill({ x: envX, y: rearY, width: envW, depth: rearDepth }, rearSpecs, false);
      rooms.push(makeRoom('corridor', { x: envX, y: corridorY, width: envW, depth: corridorDepth }, false));
    } else {
      if (floorSpecs.length > 1) {
        warnings.push(
          `${floor.name} is only ${envW.toFixed(1)} × ${envD.toFixed(1)} m, which is too shallow for a corridor and two bands — its ${floorSpecs.length} rooms were laid out as one block, so they open into each other.`,
        );
      }
      fill({ x: envX, y: envY, width: envW, depth: envD }, floorSpecs, true);
    }

    next.rooms.push(...rooms);
  });

  next = reindex(next);

  // ── walls, doors and windows ────────────────────────────────────────────
  const walls = [];
  const furniture = [];
  for (const floor of next.floors) {
    const floorRooms = next.rooms.filter((r) => r.floorId === floor.id);
    if (!floorRooms.length) continue;
    const planned = planFloor({
      plot,
      floor,
      rooms: floorRooms,
      furnish: options.furnish !== false,
    });
    walls.push(...planned.walls);
    furniture.push(...planned.furniture);
  }
  next = reindex({ ...next, walls, furniture });

  // ── stairs ──────────────────────────────────────────────────────────────
  for (let i = 0; i < next.floors.length - 1; i++) {
    const lower = next.floors[i]!;
    const upper = next.floors[i + 1]!;
    const gaps = shaft
      ? [shaft]
      : freeSpace({ ...next, rooms: next.rooms.filter((r) => r.floorId === lower.id) });
    const stair = placeStair(
      next.rooms.filter((r) => r.floorId === lower.id),
      gaps,
      lower,
      upper,
      next.rooms.filter((r) => r.floorId === upper.id),
    );
    if (stair) next.stairs.push(stair);
    else warnings.push(`No room was found for a staircase between ${lower.name} and ${upper.name}. Place one manually — the layout check will report it until you do.`);
  }
  next = reindex(next);

  // ── report ──────────────────────────────────────────────────────────────
  if (minScale < 0.7) {
    warnings.push(
      `The brief asks for more floor area than the ${plot.width.toFixed(1)} × ${plot.depth.toFixed(1)} m plot allows after setbacks. Rooms were scaled to about ${(minScale * 100).toFixed(0)}% of their requested size — consider fewer rooms, a bigger plot, or a second storey.`,
    );
  } else if (minScale > 1.5) {
    warnings.push(
      `This plot has room to spare: the generated rooms use only about ${(100 / minScale).toFixed(0)}% of the buildable area. Consider adding a room, a bigger kitchen, or a garden room.`,
    );
  }

  const result = reindex(next);
  return {
    ok: true,
    project: result,
    data: { report: { warnings, scale: minScale, floorCount: next.floors.length }, project: result },
    createdIds: [],
    removedIds: [],
  };
}

// ────────────────────────────────────────────────────────── blank starts ─────

/**
 * The smallest cell a grid room may be. Anything narrower is a cupboard.
 */
const MIN_GRID_CELL = 2.4;

/**
 * The blank-plot start: the plot, the storeys and the brief, and nothing else.
 *
 * A person who wants to draw their own house does not want a generator's idea
 * of a house — they want a sheet with the plot drawn on it. This returns
 * exactly that: the plot the wizard was just asked about, one floor per storey
 * requested, and no rooms, walls or furniture to argue with.
 */
export function emptyFromBrief(project: Project, brief: DesignBrief): OpResult<{ project: Project; floorCount: number }> {
  const floorCount = Math.max(1, Math.min(4, brief.floorCount));
  const floors: Floor[] = [];
  for (let i = 0; i < floorCount; i++) {
    floors.push({
      id: newId('fl'),
      name: i === 0 ? 'Ground floor' : `First floor`,
      elevation: 0,
      height: i === 0 ? 3.0 : 2.9,
      order: i,
      roomIds: [],
      wallIds: [],
      stairIds: [],
      outdoorIds: [],
    });
  }
  for (let i = 1; i < floors.length; i++) {
    const below = floors[i - 1]!;
    floors[i]!.elevation = below.elevation + below.height;
  }

  const result = reindex({
    ...project,
    plot: brief.plot,
    brief,
    floors,
    rooms: [],
    walls: [],
    stairs: [],
    outdoor: [],
    furniture: [],
  });
  return { ok: true, project: result, data: { project: result, floorCount }, createdIds: [], removedIds: [] };
}

export interface GridReport {
  warnings: string[];
  /** Cells across and down. The last row may be short, and is stretched to fit. */
  columns: number;
  rows: number;
  cellWidth: number;
  cellDepth: number;
  floorCount: number;
}

/**
 * The room-grid start: the brief's rooms tiled edge to edge across the
 * buildable envelope, ready to be dragged around.
 *
 * This is deliberately the crudest layout there is. It has no circulation
 * spine and no band structure — it is a lattice, which is a starting point to
 * rearrange rather than a plan to live in. That is the point of offering it:
 * the generator gives you a house, this gives you a floor you can argue with.
 *
 * The lattice is chosen, not fixed. Every cell is as square as the envelope
 * allows and none is narrower than MIN_GRID_CELL. A last row that cannot be
 * filled is stretched across the full width, because leaving a gap or padding
 * it with an invented room would both be lies about the brief.
 */
export function gridFromBrief(
  project: Project,
  brief: DesignBrief,
  options: { furnish?: boolean } = {},
): OpResult<{ report: GridReport; project: Project }> {
  const plot = brief.plot;
  const warnings: string[] = [];

  const envX = plot.setbacks.left;
  const envY = plot.setbacks.front;
  const envW = plot.width - plot.setbacks.left - plot.setbacks.right;
  const envD = plot.depth - plot.setbacks.front - plot.setbacks.rear;

  const specs = expandBrief(brief);

  if (envW < MIN_GRID_CELL || envD < MIN_GRID_CELL) {
    return {
      ok: false,
      code: 'conflict',
      error: `The setbacks leave only ${envW.toFixed(2)} m × ${envD.toFixed(2)} m to build on — not enough for a grid of rooms.`,
      hint: 'Reduce the setbacks on the Plot step, or start from an empty plot instead.',
    };
  }

  // Pick the lattice: square-ish cells, no cell below the minimum, fewest rows
  // that satisfy both. Ties go to the shallower grid, which reads more like a
  // plan than a tower.
  let best: { columns: number; rows: number; score: number } | null = null;
  for (let cols = 1; cols <= specs.length; cols++) {
    const rows = Math.ceil(specs.length / cols);
    const columns = Math.ceil(specs.length / rows);
    const cellW = envW / columns;
    const cellD = envD / rows;
    if (cellW < MIN_GRID_CELL || cellD < MIN_GRID_CELL) continue;
    const score = Math.abs(Math.log(cellW / cellD)) + rows * 0.02;
    if (!best || score < best.score) best = { columns, rows, score };
  }
  if (!best) {
    return {
      ok: false,
      code: 'conflict',
      error: `${specs.length} rooms will not fit as a grid on a ${envW.toFixed(1)} × ${envD.toFixed(1)} m envelope with every room at least ${MIN_GRID_CELL} m across.`,
      hint: 'Tick fewer rooms, enlarge the plot, or start from an empty plot and draw the rooms yourself.',
    };
  }

  const floor: Floor = {
    id: newId('fl'),
    name: 'Ground floor',
    elevation: 0,
    height: 3.0,
    order: 0,
    roomIds: [],
    wallIds: [],
    stairIds: [],
    outdoorIds: [],
  };

  const rowDepth = envD / best.rows;
  const rooms: Room[] = [];
  let placed = 0;
  for (let row = 0; row < best.rows; row++) {
    const inRow = specs.slice(row * best.columns, (row + 1) * best.columns);
    const cellWidth = envW / inRow.length;
    // Column position restarts in every row: the short last row has wider
    // cells, so a running total across rows would push it off the plot.
    inRow.forEach((s, col) => {
      rooms.push({
        id: newId('rm'),
        floorId: floor.id,
        kind: s.kind,
        label: KIND_LABEL[s.kind],
        x: envX + col * cellWidth,
        y: envY + row * rowDepth,
        width: cellWidth,
        depth: rowDepth,
        height: 0,
        outdoor: s.kind === 'balcony' || s.kind === 'terrace',
        floorMaterial: undefined,
        isEntrance: placed === 0,
      });
      placed++;
    });
  }

  const shortest = rooms.reduce((min, r) => Math.min(min, r.width * r.depth), Infinity);
  const wanted = specs.reduce((s, r) => s + r.targetArea, 0);
  if (wanted > 0 && shortest / (wanted / specs.length) < 0.75) {
    warnings.push(
      'A grid gives every room the same shape, so the small rooms are cramped and the large ones are short of the area you asked for. Drag them to whatever proportions you want.',
    );
  }
  if (brief.floorCount > 1) {
    warnings.push(
      'A grid is a single-floor starting point. Add the storeys you need and lay them out the same way.',
    );
  }

  const planned = planFloor({ plot, floor, rooms, furnish: options.furnish !== false });
  const result = reindex({
    ...project,
    plot,
    brief,
    floors: [floor],
    rooms,
    walls: planned.walls,
    stairs: [],
    outdoor: [],
    furniture: planned.furniture,
  });

  return {
    ok: true,
    project: result,
    data: {
      report: {
        warnings,
        columns: best.columns,
        rows: best.rows,
        cellWidth: envW / best.columns,
        cellDepth: rowDepth,
        floorCount: 1,
      },
      project: result,
    },
    createdIds: [],
    removedIds: [],
  };
}

/** Rooms on a floor that still need a wall, used by the re-planner. */
export function replanFloor(project: Project, floorId: Id): Project {
  const floor = project.floors.find((f) => f.id === floorId);
  if (!floor) return project;
  const rooms = project.rooms.filter((r) => r.floorId === floorId);
  const planned = planFloor({ plot: project.plot, floor, rooms });
  const next = reindex({
    ...project,
    rooms,
    walls: [...project.walls.filter((w) => w.floorId !== floorId), ...planned.walls],
    furniture: [...project.furniture.filter((f) => f.floorId !== floorId), ...planned.furniture],
  });
  return next;
}

export interface RebuildReport {
  floorId: Id;
  wallsCreated: number;
  wallsRemoved: number;
  /** Doors and windows that found a home on the new walls. */
  openingsKept: number;
  /** Openings whose wall no longer exists after the rebuild. */
  openingsDropped: number;
  furnitureKept: number;
}

/**
 * Rebuild a floor's walls from its rooms, without throwing the floor away.
 *
 * `replanFloor` is the generator's own re-run: it re-furnishes and replaces
 * every wall, which is right immediately after generation and wrong the moment
 * you have touched anything. This is the version a person uses after they have
 * moved a wall or dragged a room — it keeps the furniture exactly where they put
 * it and carries every door and window onto the wall that took its place.
 *
 * An opening is carried when a new wall runs along the same line and is long
 * enough to hold it. One that cannot be placed is reported rather than
 * silently relocated somewhere the user did not ask for: a door that has moved
 * a metre is a door you would not open that way.
 */
export function rebuildWallsFromRooms(project: Project, floorId: Id): { project: Project; report: RebuildReport } {
  const floor = project.floors.find((f) => f.id === floorId);
  if (!floor) {
    return {
      project,
      report: { floorId, wallsCreated: 0, wallsRemoved: 0, openingsKept: 0, openingsDropped: 0, furnitureKept: 0 },
    };
  }

  const rooms = project.rooms.filter((r) => r.floorId === floorId);
  const oldWalls = project.walls.filter((w) => w.floorId === floorId);
  const furniture = project.furniture.filter((f) => f.floorId === floorId);

  // No furniture: the rooms already have it, and re-running the furnisher would
  // duplicate every piece.
  const planned = planFloor({ plot: project.plot, floor, rooms, furnish: false });
  const newWalls = planned.walls;

  // The planner places its own doors and windows. They are thrown away before
  // the old ones are carried across: the previous openings ARE the design —
  // for a freshly generated floor they are the planner's own, and for a floor
  // you have edited they are yours. Keeping both sets gives every wall two
  // doors in the same place.
  for (const w of newWalls) w.openings = [];

  let kept = 0;
  let dropped = 0;
  const claimed = new Set<string>();

  for (const old of oldWalls) {
    const f = wallFrame(old);
    for (const o of old.openings) {
      const centre = add(old.a, scale(f.dir, o.offset));
      const host = pickHostWall(newWalls, centre, f.dir, o.width, claimed);
      if (!host) {
        dropped += 1;
        continue;
      }
      const hf = wallFrame(host);
      // Leave a hand's breadth at each end so a door is never flush with a
      // corner, which the planner would refuse on the next pass anyway.
      const offset = dot(sub(centre, host.a), hf.dir);
      const lo = o.width / 2 + 0.1;
      host.openings.push({ ...o, offset: Math.min(Math.max(offset, lo), hf.length - lo) });
      claimed.add(host.id);
      kept += 1;
    }
  }

  const next = reindex({
    ...project,
    rooms,
    walls: [...project.walls.filter((w) => w.floorId !== floorId), ...newWalls],
    // Furniture is left exactly where the user put it. If a wall now runs
    // through a wardrobe that is a fact about the design, and `validate` will
    // say so — which is more use than the furniture quietly disappearing.
    furniture: [...project.furniture.filter((f) => f.floorId !== floorId), ...furniture],
  });

  return {
    project: next,
    report: {
      floorId,
      wallsCreated: newWalls.length,
      wallsRemoved: oldWalls.length,
      openingsKept: kept,
      openingsDropped: dropped,
      furnitureKept: furniture.length,
    },
  };
}

/**
 * The new wall that best carries an opening: parallel, overlapping it, and long
 * enough. Returns null when the rebuild removed the wall the opening was in.
 *
 * `claimed` lists walls already given an opening this pass. They stay eligible
 * — two doors in one wall is normal — but a wall nobody has claimed is
 * preferred, so carrying the front door does not land it on top of the window
 * the planner put in the same wall.
 */
function pickHostWall(walls: Wall[], centre: Vec2, dir: Vec2, width: number, claimed: Set<string>): Wall | null {
  let best: Wall | null = null;
  let bestScore = Infinity;
  for (const w of walls) {
    const f = wallFrame(w);
    if (f.length < width + 0.2) continue;
    // Parallel: the opening's wall direction and the candidate must agree.
    if (Math.abs(cross(dir, f.dir)) > 0.2) continue;
    const along = dot(sub(centre, w.a), f.dir);
    if (along < -0.3 || along > f.length + 0.3) continue;
    const across = Math.abs(dot(sub(centre, w.a), f.normal));
    if (across > w.thickness + 0.35) continue;

    const offset = Math.min(Math.max(dot(sub(centre, w.a), f.dir), width / 2 + 0.1), f.length - width / 2 - 0.1);
    const clash = w.openings.some((x) => Math.abs(x.offset - offset) < (x.width + width) / 2 + 0.05);
    // Distance from the opening to the wall line decides first; a clash with an
    // opening already there is what decides between otherwise equal candidates.
    const score = across + (clash ? 1 : 0) + (claimed.has(w.id) ? 0.25 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return best;
}

export { SERVICE, PRIVATE, PUBLIC };
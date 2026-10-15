/**
 * Measurement engine.
 *
 * Every number the studio shows a human or hands to the model is computed here,
 * from the canonical model, with an explicit formula. The LLM never invents a
 * measurement — it can only call `calculate_room_area` or
 * `calculate_building_areas`, both of which land in this module.
 *
 * Definitions used (stated once so the numbers mean something):
 *
 *   plot area          = plot.width × plot.depth
 *   buildable area     = (width − left − right) × (depth − front − rear)
 *   net indoor area    = Σ area of all indoor rooms, all floors
 *   footprint area     = Σ area of ground-floor indoor rooms
 *                        + Σ covered ground-floor decks (porch/terrace)
 *   gross covered area = Σ area of all indoor rooms, all floors
 *                        + Σ area of all roofed decks (balcony/terrace)
 *   open site area     = plot area − footprint area
 *   plot coverage      = footprint area ÷ plot area
 *   floor area ratio   = gross covered area ÷ plot area
 */
import { rectArea, rectPerimeter } from './geometry.ts';
import type { BuildingMeasurements, Id, Project, RoomMeasurement } from './types.ts';

/** Decks count toward covered area; terraces and porches on the ground do not. */
function isCoveredOutdoor(kind: string, elevation: number): boolean {
  if (kind === 'balcony') return true;
  // A ground-level terrace/porch under a roof would count; we have no roof data,
  // so conservatively exclude ground-level decks and include upper ones.
  return elevation > 0.05;
}

export function roomArea(project: Project, roomId: Id): number {
  const room = project.rooms.find((r) => r.id === roomId);
  if (!room) return 0;
  return rectArea({ x: room.x, y: room.y, width: room.width, depth: room.depth });
}

export function measureRoom(project: Project, roomId: Id): RoomMeasurement | null {
  const room = project.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const r = { x: room.x, y: room.y, width: room.width, depth: room.depth };
  return {
    roomId: room.id,
    label: room.label,
    kind: room.kind,
    area: rectArea(r),
    perimeter: rectPerimeter(r),
    width: room.width,
    depth: room.depth,
  };
}

export function measureBuilding(project: Project): BuildingMeasurements {
  const { plot } = project;

  const plotArea = plot.width * plot.depth;
  const buildableArea =
    Math.max(0, plot.width - plot.setbacks.left - plot.setbacks.right) *
    Math.max(0, plot.depth - plot.setbacks.front - plot.setbacks.rear);

  const rooms: RoomMeasurement[] = project.rooms
    .map((room) => measureRoom(project, room.id)!)
    .filter(Boolean);

  const floorOf = (id: Id) => project.floors.find((f) => f.id === id);
  const isIndoor = (roomId: Id) => !project.rooms.find((r) => r.id === roomId)?.outdoor;

  let netIndoorArea = 0;
  let footprintArea = 0;
  let grossCoveredArea = 0;

  for (const m of rooms) {
    const floor = floorOf(project.rooms.find((r) => r.id === m.roomId)?.floorId ?? '');
    if (!isIndoor(m.roomId)) continue;
    netIndoorArea += m.area;
    grossCoveredArea += m.area;
    if (floor?.order === 0) footprintArea += m.area;
  }

  for (const deck of project.outdoor) {
    const floor = floorOf(deck.floorId);
    const area = deck.width * deck.depth;
    // A porch is covered by definition — that is what separates it from a
    // terrace. It counts towards the covered area but not towards the building
    // footprint, because it is not enclosed space. Handling it here rather than
    // after the `isCoveredOutdoor` test matters: that test rejects anything at
    // ground level, and a porch only ever sits at ground level, so a porch
    // checked afterwards could never be reached.
    if (deck.kind === 'porch') {
      grossCoveredArea += area;
      continue;
    }
    if (!isCoveredOutdoor(deck.kind, floor?.elevation ?? 0)) continue;
    grossCoveredArea += area;
  }

  const openSiteArea = Math.max(0, plotArea - footprintArea);

  return {
    plotArea,
    buildableArea,
    netIndoorArea,
    footprintArea,
    grossCoveredArea,
    openSiteArea,
    plotCoverage: plotArea > 0 ? footprintArea / plotArea : 0,
    floorAreaRatio: plotArea > 0 ? grossCoveredArea / plotArea : 0,
    perFloor: project.floors
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((f) => {
        const floorRooms = project.rooms.filter((r) => r.floorId === f.id);
        const netArea = floorRooms.filter((r) => !r.outdoor).reduce((s, r) => s + r.width * r.depth, 0);
        // Same rule as the building total above, and for the same reason: a
        // porch must be counted before the ground-level test, or the per-floor
        // figure would disagree with the building figure and only one of them
        // would be true.
        const deckArea = project.outdoor
          .filter((d) => d.floorId === f.id && (d.kind === 'porch' || isCoveredOutdoor(d.kind, f.elevation)))
          .reduce((s, d) => s + d.width * d.depth, 0);
        return {
          floorId: f.id,
          label: f.name,
          elevation: f.elevation,
          netArea,
          coveredArea: netArea + deckArea,
          roomCount: floorRooms.length,
        };
      }),
    rooms,
  };
}

/** The buildable envelope: the rectangle inside the plot after setbacks. */
export function buildableRect(project: Project) {
  const { plot } = project;
  return {
    x: plot.setbacks.left,
    y: plot.setbacks.front,
    width: Math.max(0, plot.width - plot.setbacks.left - plot.setbacks.right),
    depth: Math.max(0, plot.depth - plot.setbacks.front - plot.setbacks.rear),
  };
}

/** How much of the buildable envelope is already occupied by indoor rooms. */
export function occupancy(project: Project): { used: number; total: number; ratio: number } {
  const env = buildableRect(project);
  const total = env.width * env.depth;
  let used = 0;
  for (const r of project.rooms) {
    const floor = project.floors.find((f) => f.id === r.floorId);
    if ((floor?.order ?? 0) !== 0 || r.outdoor) continue;
    used += r.width * r.depth;
  }
  return { used, total, ratio: total > 0 ? used / total : 0 };
}

/**
 * Free rectangular strips inside the buildable envelope that no room covers.
 * The generator uses these to place a corridor that actually fits.
 */
export function freeSpace(project: Project): Array<{ x: number; y: number; width: number; depth: number }> {
  const env = buildableRect(project);
  const groundRooms = project.rooms.filter((r) => {
    const f = project.floors.find((x) => x.id === r.floorId);
    return (f?.order ?? 0) === 0 && !r.outdoor;
  });

  // Grid-sweep the envelope on every room edge and report empty cells, then
  // merge horizontally. Exact enough for corridor placement, and cheap.
  const xs = new Set<number>([env.x, env.x + env.width]);
  const ys = new Set<number>([env.y, env.y + env.depth]);
  for (const r of groundRooms) {
    if (r.x > env.x && r.x < env.x + env.width) xs.add(r.x);
    if (r.x + r.width > env.x && r.x + r.width < env.x + env.width) xs.add(r.x + r.width);
    if (r.y > env.y && r.y < env.y + env.depth) ys.add(r.y);
    if (r.y + r.depth > env.y && r.y + r.depth < env.y + env.depth) ys.add(r.y + r.depth);
  }
  const xArr = [...xs].sort((a, b) => a - b);
  const yArr = [...ys].sort((a, b) => a - b);

  const free: Array<{ x: number; y: number; width: number; depth: number }> = [];
  for (let i = 0; i < xArr.length - 1; i++) {
    let runStart: number | null = null;
    for (let j = 0; j < yArr.length - 1; j++) {
      const cell = {
        x: xArr[i]!,
        y: yArr[j]!,
        width: xArr[i + 1]! - xArr[i]!,
        depth: yArr[j + 1]! - yArr[j]!,
      };
      const occupied = groundRooms.some((r) => {
        const ox = Math.min(cell.x + cell.width, r.x + r.width) - Math.max(cell.x, r.x);
        const oy = Math.min(cell.y + cell.depth, r.y + r.depth) - Math.max(cell.y, r.y);
        return ox > 0.01 && oy > 0.01;
      });
      if (!occupied && runStart === null) runStart = cell.y;
      if ((occupied || j === yArr.length - 2) && runStart !== null) {
        const end = occupied ? yArr[j]! : yArr[j + 1]!;
        if (end - runStart > 0.05) {
          free.push({ x: cell.x, y: runStart, width: cell.width, depth: end - runStart });
        }
        runStart = null;
      }
    }
  }
  return free;
}
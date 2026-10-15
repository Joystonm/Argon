/**
 * Validation engine.
 *
 * Pure, deterministic, and independent of the LLM. Everything here is a
 * measurement, not an opinion, and every issue carries:
 *   - a stable code
 *   - the element ids involved, so the UI can focus them
 *   - a sentence that names the object, the problem, and the numbers behind it
 *   - concrete fixes expressed as tool calls the user (or the agent) can apply
 *
 * These checks support early design decisions. They are NOT a building-code
 * certification, and jurisdiction-specific rules are opt-in configuration.
 */
import { newId } from './ids.ts';
import { KIND_LABEL, OPENING_DEFAULTS } from './catalog.ts';
import {
  TOL,
  aabbOfObb,
  doorSwingPolygon,
  obbOfItem,
  obbOverlap,
  openingFootprint,
  polygonObbOverlap,
  rectArea,
  rectContains,
  rectContainsRect,
  rectIntersects,
  rectOf,
  rectOverlapArea,
  footprintOfItem,
  wallFootprint,
  wallOBB,
  wallFrame,
  len as vlen,
} from './geometry.ts';
import { buildCirculation, overlapsWall } from './circulation.ts';
import { buildableRect, measureBuilding } from './measure.ts';
import { subtractRect, type Box } from './layout.ts';
import type { OBB } from './geometry.ts';
import type { FurnitureItem, Id, Issue, Project, Rect, Room, RoomKind, Vec2, Wall } from './types.ts';

export interface ConstraintRules {
  /** Max fraction of the plot that may be built on. Default 0.6. */
  maxPlotCoverage: number;
  /** Max gross covered area ÷ plot area. Default 1.8 for a two-storey home. */
  maxFloorAreaRatio: number;
  /** Minimum clear width for a room the model calls a corridor. */
  minCorridorWidth: number;
  /** Minimum window-to-floor-area ratio, a daylight heuristic (not a code). */
  minWindowRatio: number;
  /** Minimum clear width between a bathroom fixture and a wall. */
  minBathroomClearance: number;
  /** Set false to skip every setback/coverage check. */
  enforcePlotRules: boolean;
}

export const DEFAULT_RULES: ConstraintRules = {
  maxPlotCoverage: 0.6,
  maxFloorAreaRatio: 1.8,
  minCorridorWidth: 0.9,
  minWindowRatio: 0.12,
  minBathroomClearance: 0.6,
  enforcePlotRules: true,
};

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/**
 * The smallest floor area each kind of room is worth calling that, in m².
 *
 * These are comfort figures, not a code, and they are deliberately published as
 * numbers rather than hidden: a 2.2 m² "bathroom" cannot hold a bath, a basin
 * and a door, and a 6 m² "bedroom" cannot hold a bed and a wardrobe. A layout
 * that packs seven such rooms into one shallow band was told by the generator
 * that it was too cramped, and then validated clean — which is how a plan ends
 * up reporting "checks pass" while drawing something nobody would want to live
 * in.
 *
 * Outdoor kinds are absent on purpose: a balcony is meant to be small.
 */
const MIN_USABLE_AREA: Partial<Record<RoomKind, number>> = {
  living: 12,
  dining: 8,
  kitchen: 6,
  bedroom: 8,
  bathroom: 3,
  utility: 2.5,
  office: 6,
  guest: 8,
  prayer: 4,
  storage: 1.2,
  hall: 4,
  lobby: 4,
  pantry: 2,
  garage: 12,
};

/** Both sides scaled by the same factor, so the room keeps its shape. */
function growToArea(room: Room, target: number): { width: number; depth: number } {
  const area = room.width * room.depth;
  if (area <= 0) return { width: room.width, depth: room.depth };
  const k = Math.sqrt(target / area);
  return { width: room.width * k, depth: room.depth * k };
}

/** Two decimals, the precision every other number in the interface carries. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function issue(
  code: Issue['code'],
  severity: Issue['severity'],
  message: string,
  elements: Id[],
  fixes?: Issue['fixes'],
): Issue {
  return { id: newId('is'), code, severity, message, elements, ...(fixes ? { fixes } : {}) };
}

const label = (r?: Room): string => r ? `"${r.label}"` : 'A room';

/**
 * Corrective shrinks for two overlapping rooms.
 *
 * The obvious one-line version — shrink `a` to `b.y - a.y` deep — is only
 * right when `b` sits below `a`. Two rooms side by side at the same y then
 * get a suggested depth of 0, which `resizeRoom` rejects as too small, so the
 * engine would be offering the user a button that cannot work. Two rooms the
 * AI created next to each other is not an exotic case, it is the normal one.
 *
 * So: whichever room lies to the right or below the other can be shortened
 * along that axis, and of the two available corrections the one that leaves
 * more floor area is offered. A correction that would take a room under the
 * minimum dimension is not offered at all, for the same reason.
 */
function shrinkFixes(a: Room, b: Room): NonNullable<Issue['fixes']> {
  const candidates: Array<{ label: string; input: Record<string, unknown>; keeps: number }> = [];

  // Trimmed on the far side from the other room: keeps everything up to it.
  // The position is passed explicitly because `resizeRoom` otherwise anchors
  // on the bottom-right corner, which would slide the room sideways and leave
  // it overlapping the very room the correction was meant to clear.
  const towardRight = b.x > a.x;
  const w = towardRight ? b.x - a.x : a.x - (b.x + b.width);
  if (w > TOL.dimension) {
    const room = towardRight ? a : b;
    candidates.push({
      label: `Shrink ${room.label} to ${w.toFixed(2)} m wide`,
      input: { roomId: room.id, width: w, x: room.x, y: room.y },
      keeps: w * room.depth,
    });
  }

  const towardBottom = b.y > a.y;
  const d = towardBottom ? b.y - a.y : a.y - (b.y + b.depth);
  if (d > TOL.dimension) {
    const room = towardBottom ? a : b;
    candidates.push({
      label: `Shrink ${room.label} to ${d.toFixed(2)} m deep`,
      input: { roomId: room.id, depth: d, x: room.x, y: room.y },
      keeps: d * room.width,
    });
  }

  candidates.sort((p, q) => q.keeps - p.keeps);
  return candidates
    .slice(0, 1)
    .map((c) => ({ label: c.label, tool: 'resize_room', input: c.input }));
}
const wallLabel = (w: Wall): string => `Wall "${w.id}"`;

/**
 * The best free spot inside `room` for `item`, or null if the room is full.
 *
 * Furniture corrections used to be `{ tool: 'move_furniture', input: { id } }`,
 * which is not a correction at all: the tool needs a target position, and
 * without one the item does not move and the problem is still there after the
 * user clicks the button. So the position is computed here, by the same
 * deterministic search a person would do — sweep the room, throw out anywhere
 * the item would not fit or would still conflict, and take the room.
 *
 * `stillBad` is the caller's own predicate — the same test that produced the
 * issue — so a correction is only offered when it is known to clear the thing
 * that was actually reported, not merely some nearby problem.
 */
function clearSpot(
  item: FurnitureItem,
  room: Room,
  conflict: Rect,
  stillBad: (obb: OBB) => boolean,
): { x: number; y: number } | null {
  const bounds = rectOf(room);
  const step = 0.2;
  let best: { x: number; y: number; score: number } | null = null;

  for (let y = room.y; y <= room.y + room.depth + TOL.join; y += step) {
    for (let x = room.x; x <= room.x + room.width + TOL.join; x += step) {
      // Furniture x/y is its centre, which is also what moveFurniture takes.
      const moved = { ...item, x: +x.toFixed(3), y: +y.toFixed(3) };
      const footprint = footprintOfItem(moved);
      if (!rectContainsRect(bounds, footprint)) continue;
      if (stillBad(obbOfItem(moved))) continue;

      // Furthest from the conflict wins; ties keep the earlier, more
      // top-left position so the result does not depend on iteration order.
      const score = rectGap(footprint, conflict);
      if (!best || score > best.score + TOL.clearance) best = { x: moved.x, y: moved.y, score };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Shortest gap between two rectangles; 0 when they touch or overlap. */
function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.depth), b.y - (a.y + a.depth)));
  return Math.hypot(dx, dy);
}

/** Bounding rect of a point list, for scoring how far away a move puts an item. */
function boundsOfPoints(pts: Vec2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, depth: maxY - minY };
}

/**
 * A `move_furniture` correction, or none at all.
 *
 * The item must be hosted by a room: `moveFurniture` re-homes an item to
 * whichever room contains it and refuses one that is not in any, so a position
 * computed against no room would be a fix that cannot be applied.
 */
function moveFurnitureFix(
  project: Project,
  item: FurnitureItem,
  conflict: Rect,
  stillBad: (obb: OBB) => boolean,
  label: string,
): NonNullable<Issue['fixes']> {
  const room = project.rooms.find((r) => r.id === item.roomId);
  if (!room) return [];
  const spot = clearSpot(item, room, conflict, stillBad);
  if (!spot) return [];
  return [{ label, tool: 'move_furniture', input: { itemId: item.id, x: spot.x, y: spot.y } }];
}

/** The smallest room worth building: below this, a door will not fit round it. */
const MIN_NEW_ROOM = 2;
/** Cap on an automatically placed room, so a long thin leftover is not offered whole. */
const MAX_NEW_ROOM = 4.5;

/**
 * The largest free rectangle on a floor, big enough to be a room, or null.
 *
 * The buildable envelope minus every room and every wall already there. Walls
 * are subtracted because `create_room` only checks rooms and the plot, so a
 * room dropped across an existing wall would satisfy the tool and still be
 * nonsense — the correction has to leave a plan the rest of the engine accepts.
 */
function freeRoomSpot(project: Project, floorId: Id): { floorId: Id; box: Box } | null {
  const env = buildableRect(project);
  let free: Box[] = [{ ...env }];
  for (const room of project.rooms.filter((r) => r.floorId === floorId)) {
    free = free.flatMap((b) => subtractRect(b, rectOf(room)));
  }
  for (const wall of project.walls.filter((w) => w.floorId === floorId)) {
    free = free.flatMap((b) => subtractRect(b, wallFootprint(wall)));
  }

  const usable = free
    .filter((b) => b.width >= MIN_NEW_ROOM && b.depth >= MIN_NEW_ROOM)
    .sort((p, q) => q.width * q.depth - p.width * p.depth);
  const best = usable[0];
  if (!best) return null;
  return {
    floorId,
    box: {
      x: best.x,
      y: best.y,
      width: Math.min(best.width, MAX_NEW_ROOM),
      depth: Math.min(best.depth, MAX_NEW_ROOM),
    },
  };
}

/**
 * A `create_room` correction for a room the brief asked for and the plan lacks.
 *
 * Which floor: the one with the fewest rooms, ties going to the lower storey.
 * A home is nearly always fuller on the ground floor, so this puts an extra
 * bedroom upstairs and a ground-floor kitchen on the ground floor, which is
 * what the brief was usually getting at.
 *
 * If no floor has room left, no fix is offered. Inventing a rectangle that
 * `create_room` would reject, or worse one that would land on top of something
 * else, is exactly the kind of correction that makes the panel untrustworthy.
 */
function addMissingRoomFix(project: Project, kind: RoomKind): NonNullable<Issue['fixes']> {
  const floors = project.floors
    .slice()
    .sort(
      (a, b) =>
        project.rooms.filter((r) => r.floorId === a.id).length - project.rooms.filter((r) => r.floorId === b.id).length ||
        a.order - b.order,
    );
  for (const floor of floors) {
    const spot = freeRoomSpot(project, floor.id);
    if (spot) {
      return [
        {
          label: `Add ${KIND_LABEL[kind]} on ${floor.name}`,
          tool: 'create_room',
          input: { floorId: spot.floorId, kind, x: spot.box.x, y: spot.box.y, width: spot.box.width, depth: spot.box.depth },
        },
      ];
    }
  }
  return [];
}

/** Every check, run over the whole project. */
export function validate(project: Project, rules: ConstraintRules = DEFAULT_RULES): Issue[] {
  const issues: Issue[] = [];
  const roomById = new Map(project.rooms.map((r) => [r.id, r]));
  const floorById = new Map(project.floors.map((f) => [f.id, f]));

  // ── rooms ────────────────────────────────────────────────────────────────
  for (const room of project.rooms) {
    if (room.width < TOL.dimension || room.depth < TOL.dimension) {
      issues.push(
        issue(
          'room_degenerate',
          'error',
          `${label(room)} is ${room.width.toFixed(2)} m × ${room.depth.toFixed(2)} m, below the ${TOL.dimension} m minimum. Rooms need two usable dimensions.`,
          [room.id],
          [{ label: 'Remove the room', tool: 'remove_element', input: { kind: 'room', id: room.id } }],
        ),
      );
    }

    if (room.kind === 'corridor' && Math.min(room.width, room.depth) < rules.minCorridorWidth) {
      issues.push(
        issue(
          'dimension_implausible',
          'warning',
          `${label(room)} is ${Math.min(room.width, room.depth).toFixed(2)} m across — narrower than the ${rules.minCorridorWidth} m a corridor needs to be usable.`,
          [room.id],
          [
            {
              label: `Widen to ${rules.minCorridorWidth.toFixed(2)} m`,
              tool: 'resize_room',
              input: {
                roomId: room.id,
                ...(room.width <= room.depth
                  ? { width: rules.minCorridorWidth }
                  : { depth: rules.minCorridorWidth }),
                anchor: room.width <= room.depth ? 'top-left' : 'top-left',
              },
            },
          ],
        ),
      );
    }

    const minArea = MIN_USABLE_AREA[room.kind];
    if (minArea !== undefined && room.width * room.depth < minArea) {
      const grown = growToArea(room, minArea);
      issues.push(
        issue(
          'dimension_implausible',
          'warning',
          `${label(room)} is ${(room.width * room.depth).toFixed(1)} m², under the ${minArea} m² a ${KIND_LABEL[room.kind].toLowerCase()} needs before it is a usable room.`,
          [room.id],
          [
            {
              label: `Grow it to ${minArea} m²`,
              tool: 'resize_room',
              input: {
                roomId: room.id,
                width: round2(grown.width),
                depth: round2(grown.depth),
                anchor: 'top-left',
              },
            },
          ],
        ),
      );
    }

    if (room.x < -TOL.join || room.y < -TOL.join ||
        room.x + room.width > project.plot.width + TOL.join ||
        room.y + room.depth > project.plot.depth + TOL.join) {
      issues.push(
        issue(
          'room_out_of_plot',
          'error',
          `${label(room)} extends past the plot boundary (plot is ${project.plot.width.toFixed(2)} m × ${project.plot.depth.toFixed(2)} m).`,
          [room.id],
        ),
      );
    }
  }

  // Room-vs-room overlap, per floor.
  for (let i = 0; i < project.rooms.length; i++) {
    for (let j = i + 1; j < project.rooms.length; j++) {
      const a = project.rooms[i]!;
      const b = project.rooms[j]!;
      if (a.floorId !== b.floorId) continue;
      if (!rectIntersects(rectOf(a), rectOf(b), TOL.join)) continue;
      const area = rectOverlapArea(rectOf(a), rectOf(b));
      if (area <= 0.001) continue;
      issues.push(
        issue(
          'room_overlap',
          'error',
          `${label(a)} and ${label(b)} overlap by ${area.toFixed(2)} m². Rooms cannot occupy the same floor area.`,
          [a.id, b.id],
          [...shrinkFixes(a, b), { label: `Remove ${b.label}`, tool: 'remove_element', input: { kind: 'room', id: b.id } }],
        ),
      );
    }
  }

  // ── walls ────────────────────────────────────────────────────────────────
  for (const wall of project.walls) {
    const length = vlen({ x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y });
    if (length < TOL.length) {
      issues.push(
        issue(
          'wall_zero_length',
          'error',
          `${wallLabel(wall)} has zero length — its two ends are in the same place.`,
          [wall.id],
          [{ label: 'Delete the wall', tool: 'remove_element', input: { kind: 'wall', id: wall.id } }],
        ),
      );
      continue;
    }

    if (wall.roomIds.length === 0 && wall.type === 'interior') {
      issues.push(
        issue(
          'wall_unbounded',
          'warning',
          `${wallLabel(wall)} is an interior wall that does not sit on any room edge — it may be floating in space.`,
          [wall.id],
        ),
      );
    }

    const outside =
      wall.a.x < -TOL.join || wall.a.y < -TOL.join ||
      wall.b.x < -TOL.join || wall.b.y < -TOL.join ||
      wall.b.x > project.plot.width + TOL.join || wall.b.y > project.plot.depth + TOL.join;
    if (outside && wall.type !== 'boundary') {
      issues.push(
        issue(
          'wall_out_of_plot',
          'warning',
          `${wallLabel(wall)} extends outside the plot boundary.`,
          [wall.id],
        ),
      );
    }
  }

  // ── openings ─────────────────────────────────────────────────────────────
  for (const wall of project.walls) {
    const frame = wallFrame(wall);
    for (const o of wall.openings) {
      const start = o.offset - o.width / 2;
      const end = o.offset + o.width / 2;

      if (start < -TOL.join || end > frame.length + TOL.join) {
        issues.push(
          issue(
            'opening_overflows_wall',
            'error',
            `The ${o.kind} on ${wallLabel(wall)} runs from ${start.toFixed(2)} m to ${end.toFixed(2)} m but the wall is only ${frame.length.toFixed(2)} m long — it does not fit.`,
            [wall.id, o.id],
            [
              // Sliding it to the middle only helps while the opening is
              // narrower than the wall. A door wider than its wall cannot be
              // centred at all, so it is narrowed to fit instead of offering a
              // move that `moveOpening` would reject as too large.
              o.width > frame.length
                ? {
                    label: `Narrow it to the ${frame.length.toFixed(2)} m wall`,
                    tool: 'move_opening',
                    input: { wallId: wall.id, openingId: o.id, width: +frame.length.toFixed(2), offset: +(frame.length / 2).toFixed(2) },
                  }
                : {
                    label: 'Centre it on the wall',
                    tool: 'move_opening',
                    input: { wallId: wall.id, openingId: o.id, offset: +(frame.length / 2).toFixed(2) },
                  },
            ],
          ),
        );
      }

      if (o.sill + o.height > wall.height + 0.02) {
        issues.push(
          issue(
            'opening_overflows_wall',
            'error',
            `The ${o.kind} on ${wallLabel(wall)} has its head at ${(o.sill + o.height).toFixed(2)} m, above the ${wall.height.toFixed(2)} m wall.`,
            [wall.id, o.id],
            [
              {
                label: 'Resize to fit',
                tool: 'move_opening',
                input: {
                  wallId: wall.id,
                  openingId: o.id,
                  // The sill comes down with the head when it is the sill that
                  // is too high: shortening the opening alone would leave it
                  // still hanging above the wall.
                  ...(o.sill >= wall.height - 0.05
                    ? { sill: +Math.max(0, wall.height - 0.6).toFixed(2) }
                    : {}),
                  height: +Math.max(
                    0.4,
                    wall.height - (o.sill >= wall.height - 0.05 ? Math.max(0, wall.height - 0.6) : o.sill) - 0.05,
                  ).toFixed(2),
                },
              },
            ],
          ),
        );
      }

      for (const other of wall.openings) {
        if (other.id === o.id || other.id < o.id) continue;
        const gap = Math.abs(other.offset - o.offset) - (other.width + o.width) / 2;
        if (gap < -TOL.join) {
          issues.push(
            issue(
              'opening_overlap',
              'error',
              `Two openings on ${wallLabel(wall)} overlap by ${(-gap).toFixed(2)} m (a ${o.kind} and a ${other.kind}).`,
              [wall.id, o.id, other.id],
            ),
          );
        }
      }
    }
  }

  // ── door swings vs walls, rooms and furniture ────────────────────────────
  for (const wall of project.walls) {
    for (const o of wall.openings) {
      if (o.kind !== 'door' && o.kind !== 'doorway') continue;
      const swing = doorSwingPolygon(wall, o);

      for (const blocker of project.walls) {
        if (blocker.id === wall.id || blocker.floorId !== wall.floorId || blocker.type === 'railing') continue;
        if (!polygonObbOverlap(swing, wallOBB(blocker))) continue;
        // The leaf resting in its own wall plane is not a blocker.
        if (blocker.roomIds.some((id) => wall.roomIds.includes(id))) continue;
        issues.push(
          issue(
            'door_swing_blocked',
            'warning',
            `The ${o.kind} on ${wallLabel(wall)} swings into ${wallLabel(blocker)}. Change its swing side or hinge.`,
            [wall.id, o.id, blocker.id],
            [
              {
                label: 'Swing the other way',
                tool: 'move_opening',
                input: { wallId: wall.id, openingId: o.id, swing: o.swing === 'positive' ? 'negative' : 'positive' },
              },
            ],
          ),
        );
        break;
      }

      for (const f of project.furniture) {
        if (f.floorId !== wall.floorId) continue;
        if (!polygonObbOverlap(swing, obbOfItem(f))) continue;
        issues.push(
          issue(
            'door_swing_blocked',
            'warning',
            `${f.label} sits in the swing path of the ${o.kind} on ${wallLabel(wall)} — the door would hit it.`,
            [wall.id, o.id, f.id],
            moveFurnitureFix(
              project,
              f,
              boundsOfPoints(swing),
              (obb) => polygonObbOverlap(swing, obb),
              'Move the item out of the swing',
            ),
          ),
        );
      }
    }
  }

  // ── furniture ────────────────────────────────────────────────────────────
  for (const f of project.furniture) {
    const r = footprintOfItem(f);

    const hit = overlapsWall(project, f.floorId, r);
    if (hit) {
      issues.push(
        issue(
          'furniture_crosses_wall',
          'error',
          `${f.label} (${f.width.toFixed(2)} m × ${f.depth.toFixed(2)} m) crosses ${wallLabel(project.walls.find((w) => w.id === hit)!)}, which is ${(project.walls.find((w) => w.id === hit)?.thickness ?? 0).toFixed(2)} m thick.`,
          [f.id, hit],
          moveFurnitureFix(
            project,
            f,
            wallFootprint(project.walls.find((w) => w.id === hit)!),
            (obb) => overlapsWall(project, f.floorId, aabbOfObb(obb)) !== null,
            'Move it clear of the wall',
          ),
        ),
      );
    }

    const host = project.rooms.find((room) => room.id === f.roomId);
    if (host && !rectContains(rectOf(host), { x: f.x, y: f.y })) {
      issues.push(
        issue(
          'furniture_out_of_room',
          'warning',
          `${f.label} is assigned to ${label(host)} but is no longer inside it after the room moved.`,
          [f.id, host.id],
        ),
      );
    }
  }

  for (let i = 0; i < project.furniture.length; i++) {
    for (let j = i + 1; j < project.furniture.length; j++) {
      const a = project.furniture[i]!;
      const b = project.furniture[j]!;
      if (a.floorId !== b.floorId) continue;
      const res = obbOverlap(obbOfItem(a), obbOfItem(b));
      if (!res.overlap) continue;
      // Ignore rug/carpet overlaps: they are meant to sit under other pieces.
      if (a.height <= 0.05 || b.height <= 0.05) continue;
      issues.push(
        issue(
          'furniture_overlap',
          'warning',
          `${a.label} and ${b.label} overlap — they cannot both be there.`,
          [a.id, b.id],
          [{ label: `Remove ${b.label}`, tool: 'remove_element', input: { kind: 'furniture', id: b.id } }],
        ),
      );
    }
  }

  // ── circulation, per floor ───────────────────────────────────────────────
  const circulationByFloor = new Map<Id, ReturnType<typeof buildCirculation>>();
  for (const floor of project.floors) {
    const g = buildCirculation(project, floor.id);
    circulationByFloor.set(floor.id, g);

    if (floor.order === 0 && !g.hasEntrance) {
      const hasExteriorWall = project.walls.some(
        (w) => w.floorId === floor.id && w.type === 'exterior' && w.openings.some((o) => o.kind === 'door'),
      );
      if (!hasExteriorWall && project.rooms.some((r) => r.floorId === floor.id && !r.outdoor)) {
        // The wall is resolved here rather than left to `?.id` further down:
        // a fix carrying `wallId: undefined` would render a button that fails
        // on click, so the fix is offered only when the wall actually exists.
        const frontRoom = project.rooms.find((r) => r.floorId === floor.id && !r.outdoor);
        const frontWall = frontRoom
          ? project.walls.find((w) => w.floorId === floor.id && w.type === 'exterior' && w.roomIds.includes(frontRoom.id))
          : undefined;
        issues.push(
          issue(
            'no_entrance',
            'error',
            `No entrance door on ${floor.name} — there is no way into the house.`,
            [floor.id],
            frontWall
              ? [
                  {
                    label: 'Add a door on the front wall',
                    tool: 'add_door',
                    input: { wallId: frontWall.id, width: OPENING_DEFAULTS.entranceDoor.width },
                  },
                ]
              : [],
          ),
        );
      }
    }

    for (const id of g.unreachable) {
      const room = roomById.get(id)!;
      const doorless = g.doorless.has(id);
      issues.push(
        issue(
          'room_no_access',
          'error',
          doorless
            ? `${label(room)} has no door on any of its walls — you cannot get in or out.`
            : `${label(room)} cannot be reached from the entrance. Its door leads into a space that is itself unreachable.`,
          [room.id, floor.id],
        ),
      );
    }
  }

  // ── stairs and multi-floor ───────────────────────────────────────────────
  const stairsByFloor = new Map<Id, string[]>();
  for (const s of project.stairs) {
    if (!stairsByFloor.has(s.floorId)) stairsByFloor.set(s.floorId, []);
    stairsByFloor.get(s.floorId)!.push(s.id);

    if (!s.connectsToFloorId) {
      issues.push(
        issue('stair_not_connected', 'error', `Staircase "${s.name}" does not reach any floor.`, [s.id]),
      );
      continue;
    }
    const target = floorById.get(s.connectsToFloorId);
    const from = floorById.get(s.floorId);
    if (!target || !from) continue;
    if (target.order <= from.order) {
      issues.push(
        issue(
          'stair_not_connected',
          'error',
          `Staircase "${s.name}" goes from ${from.name} to ${target.name}, but ${target.name} is not above it.`,
          [s.id, from.id, target.id],
        ),
      );
    }
    if (s.width < 0.7) {
      issues.push(
        issue(
          'stair_geometry_invalid',
          'warning',
          `Staircase "${s.name}" is only ${s.width.toFixed(2)} m wide; 0.90 m is a practical minimum.`,
          [s.id],
        ),
      );
    }
  }

  // Every floor above the ground needs a way up from the floor below.
  for (const floor of project.floors.filter((f) => f.order > 0)) {
    const below = project.floors.find((f) => f.order === floor.order - 1)!;
    const arrives = project.stairs.some(
      (s) => s.connectsToFloorId === floor.id && s.floorId === below.id,
    );
    if (!arrives) {
      issues.push(
        issue(
          'floor_disconnected',
          'error',
          `${floor.name} has no staircase arriving from ${below.name}.`,
          [floor.id, below.id],
        ),
      );
    }
  }

  // ── plot rules ───────────────────────────────────────────────────────────
  if (rules.enforcePlotRules) {
    const env = buildableRect(project);
    for (const room of project.rooms) {
      const floor = floorById.get(room.floorId);
      if (floor?.order !== 0) continue;
      const r = rectOf(room);
      const violations: string[] = [];
      if (r.x < env.x - 0.01) violations.push(`left by ${(env.x - r.x).toFixed(2)} m`);
      if (r.y < env.y - 0.01) violations.push(`front by ${(env.y - r.y).toFixed(2)} m`);
      if (r.x + r.width > env.x + env.width + 0.01) {
        violations.push(`right by ${(r.x + r.width - env.x - env.width).toFixed(2)} m`);
      }
      if (r.y + r.depth > env.y + env.depth + 0.01) {
        violations.push(`rear by ${(r.y + r.depth - env.y - env.depth).toFixed(2)} m`);
      }
      if (violations.length) {
        issues.push(
          issue(
            'setback_violation',
            'warning',
            `${label(room)} crosses the buildable envelope on the ${violations.join(' and ')}. Check your setbacks.`,
            [room.id],
          ),
        );
      }
    }

    const m = measureBuilding(project);
    if (m.plotCoverage > rules.maxPlotCoverage) {
      issues.push(
        issue(
          'coverage_exceeded',
          'warning',
          `Plot coverage is ${(m.plotCoverage * 100).toFixed(0)}%, above the ${(rules.maxPlotCoverage * 100).toFixed(0)}% target set for this project. That is a project rule, not a legal limit.`,
          [],
        ),
      );
    }
    if (m.floorAreaRatio > rules.maxFloorAreaRatio) {
      issues.push(
        issue(
          'far_exceeded',
          'warning',
          `Floor-area ratio is ${m.floorAreaRatio.toFixed(2)} (${m.grossCoveredArea.toFixed(0)} m² built on ${m.plotArea.toFixed(0)} m² of plot), above the ${rules.maxFloorAreaRatio.toFixed(2)} target. This is a project target, not a code limit.`,
          [],
        ),
      );
    }
  }

  // ── brief satisfaction ───────────────────────────────────────────────────
  if (project.brief) {
    for (const entry of project.brief.rooms) {
      const have = project.rooms.filter((r) => r.kind === entry.kind).length;
      if (have < entry.count) {
        issues.push(
          issue(
            'brief_room_missing',
            'info',
            `The brief asked for ${entry.count} × ${KIND_LABEL[entry.kind]}, but only ${have} exist.`,
            [],
            addMissingRoomFix(project, entry.kind),
          ),
        );
      }
    }
  }

  // ── daylight heuristic ───────────────────────────────────────────────────
  for (const floor of project.floors.filter((f) => f.order === 0)) {
    const floorRooms = project.rooms.filter(
      (r) => r.floorId === floor.id && !r.outdoor && !['corridor', 'storage', 'garage', 'hall'].includes(r.kind),
    );
    if (!floorRooms.length) continue;
    const totalArea = floorRooms.reduce((s, r) => s + rectArea(rectOf(r)), 0);
    const glazing = project.walls
      .filter((w) => w.floorId === floor.id)
      .flatMap((w) => w.openings)
      .filter((o) => o.kind === 'window')
      .reduce((s, o) => s + o.width * o.height, 0);
    const ratio = totalArea > 0 ? glazing / totalArea : 0;
    if (ratio < rules.minWindowRatio) {
      issues.push(
        issue(
          'window_into_service_space',
          'info',
          `Glazing on ${floor.name} is ${(ratio * 100).toFixed(0)}% of the indoor floor area — below the ${(rules.minWindowRatio * 100).toFixed(0)}% daylight target. This is a design heuristic, not a regulation.`,
          [floor.id],
        ),
      );
    }
  }

  return issues.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code),
  );
}

/** Just the errors — used for the headline badge and the tests. */
export const errorsOnly = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === 'error');

/** Issues touching a given element. */
export const issuesFor = (issues: Issue[], id: Id): Issue[] => issues.filter((i) => i.elements.includes(id));

/** Exposed for the 3D builder: which opening rectangles are on which wall. */
export function openingRectsFor(wall: Wall) {
  return wall.openings.map((o) => ({ opening: o, rect: openingFootprint(wall, o) }));
}

export { wallFootprint };
/**
 * The operation system.
 *
 * Every mutation to the canonical model goes through this module. The 2D
 * editor, the 3D view, the assistant and the importer all call these functions —
 * there is no second path that writes to the model.
 *
 * Two rules make this safe:
 *
 *  1. **Pure functions.** An operation takes a `Project` and returns a NEW
 *     `Project`. Nothing is mutated in place, so undo is "keep the old object"
 *     and the renderer never sees a half-applied edit.
 *
 *  2. **Re-derive, never patch.** Operations change the authored facts (room
 *     rectangles, wall centrelines, opening offsets). Everything derived
 *     (`wall.roomIds`, `floor.roomIds`, measurements, issues) is recomputed by
 *     `reindex()` at the end of each operation. That is why moving a room also
 *     updates its hosted doors, its 3D geometry and its measurements without
 *     any of those systems knowing a room moved.
 */
import { newId } from './ids.ts';
import {
  CATALOG,
  DEFAULT_MATERIALS,
  KIND_LABEL,
  OPENING_DEFAULTS,
  WALL_THICKNESS,
} from './catalog.ts';
import {
  TOL,
  clamp,
  rectContains,
  rectOf,
  sharedEdgeLength,
  wallFrame,
  len as vlen,
} from './geometry.ts';
import {
  SCHEMA_VERSION,
  type DesignBrief,
  type Floor,
  type FurnitureItem,
  type Id,
  type MaterialDef,
  type Opening,
  type OutdoorSpace,
  type Plot,
  type Project,
  type Room,
  type RoomKind,
  type Staircase,
  type Wall,
} from './types.ts';

const CATALOG_INDEX = new Map(CATALOG.map((c) => [c.id, c]));

/**
 * Standard horizontal going per riser, in metres. A comfortable domestic stair
 * is a ~170 mm rise against a ~260 mm going; the run of a flight is simply
 * risers × going.
 */
export const GOING = 0.26;
/** Nominal rise per riser, used when a storey height has to be divided up. */
export const RISER = 0.18;

// ─────────────────────────────────────────────────────────── operations ───────

/**
 * The result of one operation. Errors are sentences, not codes: the assistant
 * reads them and recovers, and the UI shows them verbatim to the human.
 */
export type OpResult<T = unknown> =
  | { ok: true; project: Project; data: T; createdIds: Id[]; removedIds: Id[] }
  | { ok: false; error: string; code: OpErrorCode; hint?: string };

export type OpErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'out_of_range'
  | 'conflict'
  | 'too_small'
  | 'forbidden';

const fail = (
  code: OpErrorCode,
  error: string,
  hint?: string,
): OpResult<never> => ({ ok: false, code, error, ...(hint ? { hint } : {}) });

const done = <T>(project: Project, data: T, createdIds: Id[] = [], removedIds: Id[] = []): OpResult<T> => ({
  ok: true,
  project,
  data,
  createdIds,
  removedIds,
});

// ──────────────────────────────────────────────────────────── factory ─────────

export const DEFAULT_PLOT: Plot = {
  width: 15,
  depth: 20,
  orientation: 0,
  setbacks: { front: 4.5, rear: 4.5, left: 3, right: 3 },
};

export function emptyProject(name = 'Untitled home'): Project {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('p'),
    name,
    createdAt: now,
    updatedAt: now,
    displayUnits: 'm',
    brief: null,
    plot: structuredClone(DEFAULT_PLOT),
    floors: [],
    rooms: [],
    walls: [],
    stairs: [],
    outdoor: [],
    furniture: [],
    materials: structuredClone(DEFAULT_MATERIALS),
    underlays: [],
    revision: 0,
  };
}

export function makeFloor(project: Project, index: number, name?: string): Floor {
  const floorId = newId('fl');
  return {
    id: floorId,
    name: name ?? (index === 0 ? 'Ground floor' : `Floor ${index + 1}`),
    elevation: index === 0 ? 0 : project.floors[index - 1]!.elevation + project.floors[index - 1]!.height,
    height: index === 0 ? 3 : 2.9,
    order: index,
    roomIds: [],
    wallIds: [],
    stairIds: [],
    outdoorIds: [],
  };
}

/** Convenience: an empty project with one ground floor. */
export function blankProject(name = 'Untitled home'): Project {
  const p = emptyProject(name);
  p.floors = [makeFloor(p, 0)];
  return reindex(p);
}

// ──────────────────────────────────────────────────────────── reindex ──────────

/**
 * Recompute every derived field. Called at the end of every operation.
 *
 * This is the heart of "one source of truth": wall→room and room→wall links,
 * per-floor id lists, stair elevations and floor connectivity are all derived
 * here, so no operation has to remember to update them.
 */
export function reindex(project: Project): Project {
  const next: Project = {
    ...project,
    rooms: project.rooms.map((r) => ({ ...r })),
    walls: project.walls.map((w) => ({ ...w, roomIds: [], openings: w.openings.map((o) => ({ ...o })) })),
    floors: project.floors.map((f) => ({ ...f, roomIds: [], wallIds: [], stairIds: [], outdoorIds: [] })),
    stairs: project.stairs.map((s) => ({ ...s })),
    outdoor: project.outdoor.map((o) => ({ ...o })),
    furniture: project.furniture.map((f) => ({ ...f })),
    revision: project.revision + 1,
  };

  const floorById = new Map(next.floors.map((f) => [f.id, f]));
  const roomById = new Map(next.rooms.map((r) => [r.id, r]));

  // Walls: normalise zero/thickness values and attach the rooms they bound.
  //
  // A wall bounds a room when its centreline lies on one of the room's four
  // edges (within half the wall thickness, so interior walls sitting exactly on
  // the shared boundary match both neighbours) AND spans more than a join
  // tolerance along that edge.
  for (const w of next.walls) {
    w.thickness = Math.max(0.05, w.thickness || WALL_THICKNESS.interior);
    w.height = Math.max(0.1, w.height || floorById.get(w.floorId)?.height || 2.9);
    const band = w.thickness / 2 + 0.05;

    for (const r of next.rooms) {
      if (r.floorId !== w.floorId) continue;
      const horiz = Math.abs(w.b.y - w.a.y) < Math.abs(w.b.x - w.a.x);
      const wLo = horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
      const wHi = horiz ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y);

      // The room edges parallel to this wall.
      const lines = horiz
        ? [r.y, r.y + r.depth]
        : [r.x, r.x + r.width];
      const eLo = horiz ? r.x : r.y;
      const eHi = horiz ? r.x + r.width : r.y + r.depth;

      const wPos = horiz ? (w.a.y + w.b.y) / 2 : (w.a.x + w.b.x) / 2;
      const onEdge = lines.some((l) => Math.abs(l - wPos) <= band);
      if (!onEdge) continue;

      const span = Math.min(wHi, eHi) - Math.max(wLo, eLo);
      if (span > TOL.join) w.roomIds.push(r.id);
    }
  }

  // Openings: clamp offsets into their wall and record the rooms they join.
  for (const w of next.walls) {
    const wallLen = vlen({ x: w.b.x - w.a.x, y: w.b.y - w.a.y });
    for (const o of w.openings) {
      const half = o.width / 2;
      o.offset = wallLen > 0 ? clamp(o.offset, half, Math.max(half, wallLen - half)) : half;
      o.height = Math.max(0.2, o.height);
      o.sill = Math.max(0, o.sill);
      // Only a window sits at a sill; a door or cased opening reaches the floor.
      if (o.kind === 'window') {
        o.sill = o.sill > 0 ? o.sill : 0.9;
      } else {
        o.sill = 0;
      }
      if (!o.connects) {
        const a = w.roomIds[0] ?? null;
        const b = w.roomIds[1] ?? null;
        o.connects = [a, b];
      }
    }
  }

  // Rooms: default height, clear dangling stair/room links.
  for (const r of next.rooms) {
    const f = floorById.get(r.floorId);
    r.height = r.height || f?.height || 2.9;
  }

  // Stairs: derive elevation/riser geometry and mark floor connectivity.
  for (const s of next.stairs) {
    s.riserCount = Math.max(2, Math.round(s.riserCount));
    s.width = Math.max(0.6, s.width);
    const from = floorById.get(s.floorId);
    const to = s.connectsToFloorId ? floorById.get(s.connectsToFloorId) : undefined;
    const rise = to && from ? Math.abs(to.elevation - from.elevation) : 0;
    if (rise > 0) {
      // The storey height is authoritative: the risers have to add up to it.
      // Keep a riser count the user chose as long as it climbs the storey at a
      // believable slope, otherwise re-derive it — and always re-derive the run
      // from the riser count, because a run scaled by the rise as well as the
      // riser count produces a stair tens of metres long.
      const climbed = s.riserCount * RISER;
      if (climbed < rise * 0.55 || climbed > rise * 1.5) {
        s.riserCount = Math.max(2, Math.round(rise / RISER));
      }
      s.run = Math.max(0.9, s.riserCount * GOING);
      s.rise = rise;
    }
  }

  // Per-floor id lists.
  for (const r of next.rooms) floorById.get(r.floorId)?.roomIds.push(r.id);
  for (const w of next.walls) floorById.get(w.floorId)?.wallIds.push(w.id);
  for (const s of next.stairs) floorById.get(s.floorId)?.stairIds.push(s.id);
  for (const o of next.outdoor) floorById.get(o.floorId)?.outdoorIds.push(o.id);

  // Openings referencing rooms that no longer exist.
  for (const w of next.walls) {
    for (const o of w.openings) {
      if (o.connects) {
        o.connects = [
          o.connects[0] && roomById.has(o.connects[0]) ? o.connects[0] : null,
          o.connects[1] && roomById.has(o.connects[1]) ? o.connects[1] : null,
        ];
      }
    }
  }

  // Stairs pointing at floors that no longer exist.
  for (const s of next.stairs) {
    if (s.connectsToFloorId && !floorById.has(s.connectsToFloorId)) s.connectsToFloorId = null;
  }

  return next;
}

// ───────────────────────────────────────────────────────────── floors ─────────

export function addFloor(project: Project, name?: string): OpResult<Floor> {
  const floor = makeFloor(project, project.floors.length, name);
  const next = reindex({ ...project, floors: [...project.floors, floor] });
  return done(next, floor, [floor.id]);
}

export function renameFloor(project: Project, floorId: Id, name: string): OpResult<Floor> {
  const floor = project.floors.find((f) => f.id === floorId);
  if (!floor) return fail('not_found', `Floor "${floorId}" not found.`);
  const next = reindex({
    ...project,
    floors: project.floors.map((f) => (f.id === floorId ? { ...f, name: name.trim() || f.name } : f)),
  });
  return done(next, next.floors.find((f) => f.id === floorId)!);
}

/** Delete a floor and everything on it. Destructive: callers must confirm. */
export function removeFloor(project: Project, floorId: Id): OpResult<{ removedIds: Id[] }> {
  const floor = project.floors.find((f) => f.id === floorId);
  if (!floor) return fail('not_found', `Floor "${floorId}" not found.`);
  if (project.floors.length <= 1) {
    return fail('forbidden', 'A project needs at least one floor. Delete the rooms on it instead.');
  }
  const removedIds = [
    floorId,
    ...floor.roomIds,
    ...floor.wallIds,
    ...floor.stairIds,
    ...floor.outdoorIds,
  ];
  const next = reindex({
    ...project,
    floors: project.floors.filter((f) => f.id !== floorId).map((f, i) => ({ ...f, order: i })),
    rooms: project.rooms.filter((r) => r.floorId !== floorId),
    walls: project.walls.filter((w) => w.floorId !== floorId),
    stairs: project.stairs.filter((s) => s.floorId !== floorId),
    outdoor: project.outdoor.filter((o) => o.floorId !== floorId),
    furniture: project.furniture.filter((f) => f.floorId !== floorId),
  });
  return done(next, { removedIds }, [], removedIds);
}

export function setFloorHeight(project: Project, floorId: Id, height: number): OpResult<Floor> {
  const floor = project.floors.find((f) => f.id === floorId);
  if (!floor) return fail('not_found', `Floor "${floorId}" not found.`);
  if (!(height >= 1.8 && height <= 6)) return fail('out_of_range', 'Floor height must be between 1.8 m and 6 m.');
  const floors = project.floors.map((f) => {
    if (f.id !== floorId) return f;
    return { ...f, height };
  });
  // Push every upper floor up so elevations stay consistent.
  for (let i = 0; i < floors.length; i++) {
    const f = floors[i]!;
    if (f.order === 0) {
      f.elevation = 0;
      continue;
    }
    const below = floors.find((x) => x.order === f.order - 1);
    f.elevation = below ? below.elevation + below.height : f.elevation;
  }
  return done(reindex({ ...project, floors }), floors.find((f) => f.id === floorId)!);
}

// ────────────────────────────────────────────────────────────── plot ──────────

export function setPlot(
  project: Project,
  patch: Partial<Pick<Plot, 'width' | 'depth' | 'orientation' | 'setbacks'>>,
): OpResult<Plot> {
  const plot: Plot = { ...project.plot, ...patch, setbacks: { ...project.plot.setbacks, ...(patch.setbacks ?? {}) } };
  if (!(plot.width > 0) || !(plot.depth > 0)) {
    return fail('invalid_input', 'Plot width and depth must both be greater than zero.');
  }
  const sb = plot.setbacks;
  if ([sb.front, sb.rear, sb.left, sb.right].some((n) => !(n >= 0))) {
    return fail('invalid_input', 'Setbacks cannot be negative. Use 0 for a shared boundary wall.');
  }
  const bw = plot.width - sb.left - sb.right;
  const bd = plot.depth - sb.front - sb.rear;
  if (bw <= 1 || bd <= 1) {
    return fail(
      'conflict',
      `Setbacks leave only ${bw.toFixed(2)} m × ${bd.toFixed(2)} m inside the plot — not enough to build on.`,
      'Reduce the setbacks or enlarge the plot.',
    );
  }
  return done(reindex({ ...project, plot }), plot);
}

// ───────────────────────────────────────────────────────────── rooms ───────────

export interface CreateRoomInput {
  floorId?: Id;
  kind: RoomKind;
  label?: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  height?: number;
}

export function createRoom(project: Project, input: CreateRoomInput): OpResult<Room> {
  const floorId = input.floorId ?? project.floors[0]?.id;
  if (!floorId) return fail('not_found', 'This project has no floors yet.');
  if (!project.floors.some((f) => f.id === floorId)) return fail('not_found', `Floor "${floorId}" not found.`);

  const width = Number(input.width);
  const depth = Number(input.depth);
  if (!Number.isFinite(width) || !Number.isFinite(depth)) return fail('invalid_input', 'Room width and depth must be numbers.');
  if (width < TOL.dimension || depth < TOL.dimension) {
    return fail(
      'too_small',
      `A ${width.toFixed(2)} m × ${depth.toFixed(2)} m room is too small to use — the minimum is ${TOL.dimension} m per side.`,
      'Enlarge the room, or place a wall opening instead.',
    );
  }
  const room: Room = {
    id: newId('rm'),
    floorId,
    kind: input.kind,
    label: input.label?.trim() || KIND_LABEL[input.kind],
    x: Number(input.x),
    y: Number(input.y),
    width,
    depth,
    height: input.height ?? 0,
  };
  const next = reindex({ ...project, rooms: [...project.rooms, room] });
  return done(next, next.rooms.find((r) => r.id === room.id)!, [room.id]);
}

export interface ResizeRoomInput {
  roomId: Id;
  x?: number;
  y?: number;
  width?: number;
  depth?: number;
  /** Which corner/edge is fixed while resizing. Defaults to the top-left. */
  anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
}

export function resizeRoom(project: Project, input: ResizeRoomInput): OpResult<Room> {
  const room = project.rooms.find((r) => r.id === input.roomId);
  if (!room) return fail('not_found', `Room "${input.roomId}" not found.`, 'Call list_rooms to get real ids.');

  const anchor = input.anchor ?? 'bottom-right';
  const width = input.width === undefined ? room.width : Number(input.width);
  const depth = input.depth === undefined ? room.depth : Number(input.depth);
  const x = input.x === undefined ? room.x : Number(input.x);
  const y = input.y === undefined ? room.y : Number(input.y);

  if (![width, depth, x, y].every(Number.isFinite)) return fail('invalid_input', 'Room geometry must be numbers.');
  if (width < TOL.dimension || depth < TOL.dimension) {
    return fail(
      'too_small',
      `That would make "${room.label}" ${width.toFixed(2)} m × ${depth.toFixed(2)} m — below the ${TOL.dimension} m minimum.`,
      'Pick a larger size, or remove the room with remove_element.',
    );
  }

  let nx = x;
  let ny = y;
  if (input.x === undefined || input.y === undefined) {
    switch (anchor) {
      case 'top-left':
        nx = x;
        ny = y;
        break;
      case 'top-right':
        nx = x + (room.width - width);
        ny = y;
        break;
      case 'bottom-left':
        nx = x;
        ny = y + (room.depth - depth);
        break;
      case 'bottom-right':
        nx = x + (room.width - width);
        ny = y + (room.depth - depth);
        break;
      case 'center':
        nx = x + (room.width - width) / 2;
        ny = y + (room.depth - depth) / 2;
        break;
    }
  }

  const nextRoom: Room = { ...room, x: nx, y: ny, width, depth };
  const next = reindex({ ...project, rooms: project.rooms.map((r) => (r.id === room.id ? nextRoom : r)) });
  return done(next, next.rooms.find((r) => r.id === room.id)!);
}

/**
 * Move a room so its top-left corner lands on (x, y).
 *
 * Absolute rather than relative on purpose. A drag can easily work out the
 * delta it wants, but the assistant works in the same absolute plan
 * coordinates the inspector shows, and a relative move there is a silent way to
 * put a room in the wrong place.
 */
export function moveRoom(project: Project, roomId: Id, x: number, y: number): OpResult<Room> {
  const room = project.rooms.find((r) => r.id === roomId);
  if (!room) return fail('not_found', `Room "${roomId}" not found.`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return fail('invalid_input', 'Room coordinates must be finite numbers in metres.');
  }
  return resizeRoom(project, { roomId, x, y, width: room.width, depth: room.depth });
}

export function setRoomLabel(project: Project, roomId: Id, label: string, kind?: RoomKind): OpResult<Room> {
  const room = project.rooms.find((r) => r.id === roomId);
  if (!room) return fail('not_found', `Room "${roomId}" not found.`);
  const updated: Room = {
    ...room,
    label: label.trim() || KIND_LABEL[kind ?? room.kind],
    kind: kind ?? room.kind,
  };
  return done(
    reindex({ ...project, rooms: project.rooms.map((r) => (r.id === roomId ? updated : r)) }),
    updated,
  );
}

/** Delete a room together with any wall that existed only for it. */
export function removeRoom(project: Project, roomId: Id): OpResult<{ removedIds: Id[] }> {
  const room = project.rooms.find((r) => r.id === roomId);
  if (!room) return fail('not_found', `Room "${roomId}" not found.`);

  // A wall whose only remaining purpose was this room's boundary goes too,
  // unless another room still needs it.
  const removedIds: Id[] = [roomId];
  const survivors = project.rooms.filter((r) => r.id !== roomId);
  const survivingWallIds = new Set<string>();

  const walls = project.walls
    .filter((w) => w.floorId === room.floorId)
    .map((w) => ({ ...w, roomIds: w.roomIds.filter((id) => id !== roomId) }));

  const keep = walls.filter((w) => {
    const stillBounded = w.roomIds.filter((id) => survivors.some((r) => r.id === id));
    if (stillBounded.length === 0) return false;
    survivingWallIds.add(w.id);
    return true;
  });

  const furniture = project.furniture.filter((f) => f.roomId !== roomId);
  for (const f of furniture) removedIds.push(f.id);

  const next = reindex({
    ...project,
    rooms: survivors,
    walls: keep,
    furniture,
  });
  for (const w of project.walls) if (!survivingWallIds.has(w.id)) removedIds.push(w.id);
  return done(next, { removedIds }, [], removedIds);
}

// ───────────────────────────────────────────────────────────── walls ───────────

export interface CreateWallInput {
  floorId?: Id;
  type?: Wall['type'];
  a: { x: number; y: number };
  b: { x: number; y: number };
  thickness?: number;
  height?: number;
  material?: string;
}

export function createWall(project: Project, input: CreateWallInput): OpResult<Wall> {
  const floorId = input.floorId ?? project.floors[0]?.id;
  if (!floorId) return fail('not_found', 'This project has no floors yet.');
  const type = input.type ?? 'interior';
  const length = Math.hypot(input.b.x - input.a.x, input.b.y - input.a.y);
  if (!Number.isFinite(length)) return fail('invalid_input', 'Wall endpoints must be numbers.');
  if (length < TOL.length) {
    return fail('too_small', `That wall is ${length.toFixed(3)} m long — too short to build.`, 'Give the wall a real length.');
  }
  const thickness = input.thickness ?? WALL_THICKNESS[type] ?? WALL_THICKNESS.interior;
  if (!(thickness >= 0.05 && thickness <= 0.6)) {
    return fail('out_of_range', 'Wall thickness must be between 0.05 m and 0.60 m.');
  }
  const wall: Wall = {
    id: newId('wl'),
    floorId,
    type,
    a: { x: input.a.x, y: input.a.y },
    b: { x: input.b.x, y: input.b.y },
    thickness,
    height: input.height ?? 0,
    roomIds: [],
    openings: [],
    material: input.material ?? (type === 'exterior' ? 'exterior.render' : 'interior.partition'),
  };
  const next = reindex({ ...project, walls: [...project.walls, wall] });
  return done(next, next.walls.find((w) => w.id === wall.id)!, [wall.id]);
}

export interface MoveWallInput {
  wallId: Id;
  /** Absolute new endpoint. Omit to leave that end alone. */
  a?: { x: number; y: number };
  b?: { x: number; y: number };
  /** Translate the whole wall. */
  dx?: number;
  dy?: number;
  thickness?: number;
  type?: Wall['type'];
}

export function moveWall(project: Project, input: MoveWallInput): OpResult<Wall> {
  const wall = project.walls.find((w) => w.id === input.wallId);
  if (!wall) return fail('not_found', `Wall "${input.wallId}" not found.`, 'Call list_walls to get real ids.');

  const dx = input.dx ?? 0;
  const dy = input.dy ?? 0;
  const a = input.a
    ? { x: input.a.x + dx, y: input.a.y + dy }
    : { x: wall.a.x + dx, y: wall.a.y + dy };
  const b = input.b
    ? { x: input.b.x + dx, y: input.b.y + dy }
    : { x: wall.b.x + dx, y: wall.b.y + dy };

  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < TOL.length) {
    return fail('too_small', 'That move would collapse the wall to zero length.', 'Move one endpoint instead of translating the whole wall.');
  }
  const thickness = input.thickness ?? wall.thickness;
  if (!(thickness >= 0.05 && thickness <= 0.6)) {
    return fail('out_of_range', 'Wall thickness must be between 0.05 m and 0.60 m.');
  }

  const updated: Wall = {
    ...wall,
    a,
    b,
    thickness,
    type: input.type ?? wall.type,
  };
  const next = reindex({ ...project, walls: project.walls.map((w) => (w.id === wall.id ? updated : w)) });
  return done(next, next.walls.find((w) => w.id === wall.id)!);
}

/**
 * Resize a wall along its own axis. Openings keep their offsets from the start
 * end but are clamped back inside, so resizing a wall never silently deletes a
 * door — it slides it into the wall and validation flags the overlap.
 */
export function resizeWall(project: Project, wallId: Id, newLength: number): OpResult<Wall> {
  const wall = project.walls.find((w) => w.id === wallId);
  if (!wall) return fail('not_found', `Wall "${wallId}" not found.`);
  if (!(newLength >= TOL.length)) return fail('too_small', 'Wall length must be at least 0.02 m.');
  const f = wallFrame(wall);
  const updated: Wall = { ...wall, b: { x: wall.a.x + f.dir.x * newLength, y: wall.a.y + f.dir.y * newLength } };
  const next = reindex({ ...project, walls: project.walls.map((w) => (w.id === wallId ? updated : w)) });
  return done(next, next.walls.find((w) => w.id === wallId)!);
}

export function removeWall(project: Project, wallId: Id): OpResult<{ removedIds: Id[] }> {
  const wall = project.walls.find((w) => w.id === wallId);
  if (!wall) return fail('not_found', `Wall "${wallId}" not found.`);
  const next = reindex({ ...project, walls: project.walls.filter((w) => w.id !== wallId) });
  return done(next, { removedIds: [wallId] }, [], [wallId]);
}

// ────────────────────────────────────────────────────────── openings ───────────

export interface AddOpeningInput {
  wallId: Id;
  kind: Opening['kind'];
  /** Distance from the wall's start end, in metres. Defaults to the middle. */
  offset?: number;
  width?: number;
  height?: number;
  sill?: number;
  swing?: Opening['swing'];
  hinge?: Opening['hinge'];
}

export function addOpening(project: Project, input: AddOpeningInput): OpResult<{ wall: Wall; opening: Opening }> {
  const wall = project.walls.find((w) => w.id === input.wallId);
  if (!wall) return fail('not_found', `Wall "${input.wallId}" not found.`, 'Call inspect_wall to see which walls exist.');

  const f = wallFrame(wall);
  const defaults =
    input.kind === 'window'
      ? OPENING_DEFAULTS.window
      : input.kind === 'doorway'
        ? { width: 1.4, height: 2.2, sill: 0 }
        : OPENING_DEFAULTS.interiorDoor;
  const width = input.width ?? defaults.width;
  const height = input.height ?? defaults.height;
  const sill = input.sill ?? defaults.sill;

  if (!(width > 0) || !(height > 0)) return fail('invalid_input', 'Opening width and height must be positive.');
  if (width > f.length) {
    return fail(
      'too_small',
      `A ${width.toFixed(2)} m opening will not fit on a ${f.length.toFixed(2)} m wall.`,
      'Widen the wall first, or use a narrower opening.',
    );
  }
  if (sill + height > wall.height + 0.01) {
    return fail(
      'conflict',
      `A ${sill.toFixed(2)} m sill plus a ${height.toFixed(2)} m head is taller than this ${wall.height.toFixed(2)} m wall.`,
      'Lower the sill or reduce the opening height.',
    );
  }

  // Default to a swing into the larger room so the door does not jam.
  const swing = input.swing ?? (wall.roomIds.length === 1 ? 'positive' : 'positive');

  const opening: Opening = {
    id: newId('op'),
    kind: input.kind,
    offset: input.offset ?? f.length / 2,
    width,
    height,
    sill,
    swing,
    hinge: input.hinge ?? 'start',
  };

  // Check for overlap with existing openings before adding.
  for (const existing of wall.openings) {
    const clash = Math.abs(existing.offset - opening.offset) < (existing.width + opening.width) / 2 - TOL.point;
    if (clash) {
      return fail(
        'conflict',
        `This opening would overlap the ${existing.kind} already at ${existing.offset.toFixed(2)} m along this wall.`,
        `Move it further along the wall (try offset ${(existing.offset + (existing.width + opening.width) / 2 + 0.1).toFixed(2)}).`,
      );
    }
  }

  const updated: Wall = { ...wall, openings: [...wall.openings, opening] };
  const next = reindex({ ...project, walls: project.walls.map((w) => (w.id === wall.id ? updated : w)) });
  const newWall = next.walls.find((w) => w.id === wall.id)!;
  return done(next, { wall: newWall, opening: newWall.openings.find((o) => o.id === opening.id)! }, [opening.id]);
}

export interface MoveOpeningInput {
  wallId: Id;
  openingId: Id;
  offset?: number;
  width?: number;
  height?: number;
  sill?: number;
  swing?: Opening['swing'];
  hinge?: Opening['hinge'];
}

export function moveOpening(project: Project, input: MoveOpeningInput): OpResult<Opening> {
  const wall = project.walls.find((w) => w.id === input.wallId);
  if (!wall) return fail('not_found', `Wall "${input.wallId}" not found.`);
  const opening = wall.openings.find((o) => o.id === input.openingId);
  if (!opening) return fail('not_found', `Opening "${input.openingId}" not found on wall "${input.wallId}".`);

  const f = wallFrame(wall);
  const width = input.width ?? opening.width;
  const height = input.height ?? opening.height;
  const sill = input.sill ?? opening.sill;
  if (!(width > 0) || !(height > 0)) return fail('invalid_input', 'Opening width and height must be positive.');
  if (width > f.length) {
    return fail('too_small', `A ${width.toFixed(2)} m opening will not fit on a ${f.length.toFixed(2)} m wall.`);
  }
  if (sill + height > wall.height + 0.01) {
    return fail('conflict', `Sill ${sill.toFixed(2)} m + height ${height.toFixed(2)} m exceeds the ${wall.height.toFixed(2)} m wall.`);
  }

  const updated: Opening = {
    ...opening,
    width,
    height,
    sill,
    offset: input.offset ?? opening.offset,
    swing: input.swing ?? opening.swing,
    hinge: input.hinge ?? opening.hinge,
  };
  for (const other of wall.openings) {
    if (other.id === opening.id) continue;
    if (Math.abs(other.offset - updated.offset) < (other.width + updated.width) / 2 - TOL.point) {
      return fail(
        'conflict',
        `This ${updated.kind} would overlap the ${other.kind} on the same wall.`,
        `Try offset ${(other.offset + (other.width + updated.width) / 2 + 0.1).toFixed(2)} or smaller.`,
      );
    }
  }

  const nextWall: Wall = { ...wall, openings: wall.openings.map((o) => (o.id === opening.id ? updated : o)) };
  const next = reindex({ ...project, walls: project.walls.map((w) => (w.id === wall.id ? nextWall : w)) });
  return done(next, next.walls.find((w) => w.id === wall.id)!.openings.find((o) => o.id === opening.id)!);
}

export function removeOpening(project: Project, wallId: Id, openingId: Id): OpResult<{ removedIds: Id[] }> {
  const wall = project.walls.find((w) => w.id === wallId);
  if (!wall) return fail('not_found', `Wall "${wallId}" not found.`);
  if (!wall.openings.some((o) => o.id === openingId)) return fail('not_found', `Opening "${openingId}" not found on that wall.`);
  const next = reindex({
    ...project,
    walls: project.walls.map((w) =>
      w.id === wallId ? { ...w, openings: w.openings.filter((o) => o.id !== openingId) } : w,
    ),
  });
  return done(next, { removedIds: [openingId] }, [], [openingId]);
}

// ───────────────────────────────────────────────────────────── stairs ──────────

export interface AddStairInput {
  floorId: Id;
  /** Floor this stair arrives at. Defaults to the floor above. */
  connectsToFloorId?: Id;
  x: number;
  y: number;
  width?: number;
  riserCount?: number;
  direction?: -1 | 1;
  name?: string;
}

export function addStaircase(project: Project, input: AddStairInput): OpResult<Staircase> {
  const floor = project.floors.find((f) => f.id === input.floorId);
  if (!floor) return fail('not_found', `Floor "${input.floorId}" not found.`);

  const target = input.connectsToFloorId
    ? project.floors.find((f) => f.id === input.connectsToFloorId)
    : project.floors.find((f) => f.order === floor.order + 1);

  if (input.connectsToFloorId && !target) {
    return fail('not_found', `Floor "${input.connectsToFloorId}" not found.`);
  }
  if (!target) {
    return fail(
      'conflict',
      `"${floor.name}" is the top floor — a staircase needs a floor above it to reach.`,
      'Add another floor first with add_floor.',
    );
  }
  if (target.order <= floor.order) {
    return fail(
      'conflict',
      `A staircase must connect "${floor.name}" to a floor above it, but "${target.name}" is not higher.`,
    );
  }

  const width = input.width ?? 1.1;
  if (!(width >= 0.7 && width <= 3)) return fail('out_of_range', 'Staircase width must be between 0.70 m and 3.00 m.');

  const stair: Staircase = {
    id: newId('st'),
    floorId: input.floorId,
    name: input.name ?? `${floor.name} → ${target.name}`,
    x: input.x,
    y: input.y,
    width,
    run: 0, // derived by reindex() from the storey height
    riserCount: input.riserCount ?? Math.max(8, Math.round((target.elevation - floor.elevation) / RISER)),
    direction: input.direction ?? 1,
    connectsToFloorId: target.id,
    voidWidth: width,
  };
  const next = reindex({ ...project, stairs: [...project.stairs, stair] });
  return done(next, next.stairs.find((s) => s.id === stair.id)!, [stair.id]);
}

export function removeStaircase(project: Project, stairId: Id): OpResult<{ removedIds: Id[] }> {
  if (!project.stairs.some((s) => s.id === stairId)) return fail('not_found', `Staircase "${stairId}" not found.`);
  const next = reindex({ ...project, stairs: project.stairs.filter((s) => s.id !== stairId) });
  return done(next, { removedIds: [stairId] }, [], [stairId]);
}

// ──────────────────────────────────────────────────────────── outdoor ──────────

export interface AddOutdoorInput {
  floorId: Id;
  kind: OutdoorSpace['kind'];
  x: number;
  y: number;
  width: number;
  depth: number;
  label?: string;
  servesRoomId?: Id;
  elevationOffset?: number;
}

export function addOutdoorSpace(project: Project, input: AddOutdoorInput): OpResult<OutdoorSpace> {
  if (!project.floors.some((f) => f.id === input.floorId)) return fail('not_found', `Floor "${input.floorId}" not found.`);
  if (!(input.width > 0.4) || !(input.depth > 0.4)) return fail('too_small', 'An outdoor space needs to be at least 0.4 m × 0.4 m.');
  const floor = project.floors.find((f) => f.id === input.floorId)!;
  const space: OutdoorSpace = {
    id: newId('od'),
    floorId: input.floorId,
    kind: input.kind,
    label: input.label?.trim() || KIND_LABEL[input.kind === 'porch' ? 'lobby' : input.kind],
    x: input.x,
    y: input.y,
    width: input.width,
    depth: input.depth,
    elevationOffset: input.elevationOffset ?? (floor.elevation > 0 ? 0 : 0.15),
    railingHeight: input.kind === 'porch' ? 0 : 1.05,
    servesRoomId: input.servesRoomId,
  };
  const next = reindex({ ...project, outdoor: [...project.outdoor, space] });
  return done(next, next.outdoor.find((s) => s.id === space.id)!, [space.id]);
}

export function removeOutdoorSpace(project: Project, id: Id): OpResult<{ removedIds: Id[] }> {
  if (!project.outdoor.some((o) => o.id === id)) return fail('not_found', `Outdoor space "${id}" not found.`);
  const next = reindex({ ...project, outdoor: project.outdoor.filter((o) => o.id !== id) });
  return done(next, { removedIds: [id] }, [], [id]);
}

// ────────────────────────────────────────────────────────── furniture ─────────

export interface AddFurnitureInput {
  floorId?: Id;
  roomId?: Id;
  catalogId: string;
  x: number;
  y: number;
  rotation?: number;
  /** Override the catalogue footprint when the item has been resized. */
  width?: number;
  depth?: number;
  label?: string;
  color?: string;
}

export function addFurniture(project: Project, input: AddFurnitureInput): OpResult<FurnitureItem> {
  const catalogEntry = catalogLookup(input.catalogId);
  if (!catalogEntry) {
    return fail(
      'not_found',
      `No catalogue item called "${input.catalogId}".`,
      'Call list_catalogue to see the available ids.',
    );
  }
  const floorId = input.floorId ?? project.floors[0]?.id;
  if (!floorId) return fail('not_found', 'This project has no floors yet.');
  const host = input.roomId ? project.rooms.find((r) => r.id === input.roomId) : undefined;
  if (input.roomId && !host) {
    return fail('not_found', `Room "${input.roomId}" not found.`);
  }

  const width = input.width ?? catalogEntry.width;
  const depth = input.depth ?? catalogEntry.depth;
  const rotation = ((input.rotation ?? 0) % 360 + 360) % 360;

  // Refuse furniture that cannot physically fit the room it is assigned to.
  // Overhanging slightly is a legitimate thing to want while dragging, but an
  // item wider than the room is never right, and letting it through would put
  // a nonsense object in the model that the validator could only report after
  // the fact.
  if (host) {
    const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    const fw = quarter ? depth : width;
    const fd = quarter ? width : depth;
    if (fw > host.width + TOL.clearance || fd > host.depth + TOL.clearance) {
      return fail(
        'too_small',
        `${catalogEntry.label} is ${width.toFixed(2)} m × ${depth.toFixed(2)} m and does not fit inside ${host.label} (${host.width.toFixed(2)} m × ${host.depth.toFixed(2)} m).`,
        'Give it its own room, or place it in a larger one.',
      );
    }
  }

  // Home the item to whichever room contains it. Without this, an item placed
  // without an explicit roomId — which is how the assistant almost always
  // places one, since it does not track room ids — would have no host at all,
  // and `moveFurniture` refuses to move an unhomed item, so the one correction
  // that could fix a later conflict would be unavailable for exactly the
  // furniture most likely to need it.
  const home = host ?? project.rooms.find((r) => r.floorId === floorId && rectContains(rectOf(r), { x: input.x, y: input.y }));

  const item: FurnitureItem = {
    id: newId('fu'),
    floorId,
    roomId: home?.id ?? null,
    catalogId: catalogEntry.id,
    label: input.label?.trim() || catalogEntry.label,
    x: input.x,
    y: input.y,
    width,
    depth,
    height: catalogEntry.height,
    rotation,
    color: input.color ?? catalogEntry.color,
  };
  const next = reindex({ ...project, furniture: [...project.furniture, item] });
  return done(next, next.furniture.find((f) => f.id === item.id)!, [item.id]);
}

export function removeFurniture(project: Project, id: Id): OpResult<{ removedIds: Id[] }> {
  if (!project.furniture.some((f) => f.id === id)) return fail('not_found', `Furniture "${id}" not found.`);
  const next = reindex({ ...project, furniture: project.furniture.filter((f) => f.id !== id) });
  return done(next, { removedIds: [id] }, [], [id]);
}

// ─────────────────────────────────────────────────────────── materials ─────────

export interface MoveFurnitureInput {
  itemId: Id;
  /** New centre in plan coordinates. Omit to leave an axis alone. */
  x?: number;
  y?: number;
  rotation?: number;
  width?: number;
  depth?: number;
  roomId?: Id | null;
  color?: string;
}

/**
 * Move, rotate or resize a furniture item.
 *
 * Moving an item does not move it out of its room silently: if the item is
 * assigned to a room, the assignment is re-derived from where it actually
 * ended up, so dragging a sofa across a doorway relocates it rather than
 * leaving a piece of furniture nominally "in the bedroom" that is drawn in the
 * hall. A footprint larger than its new host room is refused for the same
 * reason `addFurniture` refuses one.
 */
export function moveFurniture(project: Project, input: MoveFurnitureInput): OpResult<FurnitureItem> {
  const item = project.furniture.find((f) => f.id === input.itemId);
  if (!item) return fail('not_found', `Furniture "${input.itemId}" not found.`, 'Call inspect_room to get real ids.');
  if (!item.roomId) return fail('invalid_input', 'Furniture items in this project are always hosted by a room.');

  const x = input.x === undefined ? item.x : Number(input.x);
  const y = input.y === undefined ? item.y : Number(input.y);
  const rotation = ((input.rotation ?? item.rotation) % 360 + 360) % 360;
  const width = input.width === undefined ? item.width : Number(input.width);
  const depth = input.depth === undefined ? item.depth : Number(input.depth);
  if (![x, y, width, depth].every(Number.isFinite)) {
    return fail('invalid_input', 'Furniture geometry must be finite numbers in metres.');
  }
  if (width < 0.05 || depth < 0.05) {
    return fail('too_small', 'Furniture footprint must be at least 0.05 m in both directions.');
  }

  // Re-home the item: the room that actually contains it now wins.
  const host = roomAt(project, item.floorId, x, y);
  if (host) {
    const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    const fw = quarter ? depth : width;
    const fd = quarter ? width : depth;
    if (fw > host.width + TOL.clearance || fd > host.depth + TOL.clearance) {
      return fail(
        'too_small',
        `That footprint is ${width.toFixed(2)} m × ${depth.toFixed(2)} m and does not fit inside ${host.label} (${host.width.toFixed(2)} m × ${host.depth.toFixed(2)} m).`,
        'Move it to a larger room, or turn it so the shorter side runs along the wall.',
      );
    }
  }

  const updated: FurnitureItem = {
    ...item,
    x,
    y,
    rotation,
    width,
    depth,
    roomId: host?.id ?? null,
    ...(input.color ? { color: input.color } : {}),
  };
  const next = reindex({ ...project, furniture: project.furniture.map((f) => (f.id === item.id ? updated : f)) });
  return done(next, next.furniture.find((f) => f.id === item.id)!);
}

export function applyMaterial(
  project: Project,
  target: { kind: 'room' | 'wall' | 'exterior' | 'floor'; id?: string },
  materialId: string,
): OpResult<Project> {
  if (!project.materials[materialId]) {
    return fail('not_found', `No material called "${materialId}".`, 'Call list_materials to see the available ids.');
  }
  switch (target.kind) {
    case 'room': {
      const room = project.rooms.find((r) => r.id === target.id);
      if (!room) return fail('not_found', `Room "${target.id}" not found.`);
      return done(
        reindex({ ...project, rooms: project.rooms.map((r) => (r.id === room.id ? { ...r, material: materialId } : r)) }),
        project,
      );
    }
    case 'wall': {
      const wall = project.walls.find((w) => w.id === target.id);
      if (!wall) return fail('not_found', `Wall "${target.id}" not found.`);
      return done(
        reindex({ ...project, walls: project.walls.map((w) => (w.id === wall.id ? { ...w, material: materialId } : w)) }),
        project,
      );
    }
    case 'exterior': {
      const walls = project.walls.map((w) =>
        w.type === 'exterior' ? { ...w, material: materialId } : w,
      );
      return done(reindex({ ...project, walls }), project);
    }
    case 'floor': {
      const rooms = project.rooms.map((r) => ({ ...r, floorMaterial: materialId }));
      return done(reindex({ ...project, rooms }), project);
    }
  }
}

export function defineMaterial(
  project: Project,
  def: {
    id: string;
    label: string;
    color: string;
    roughness?: number;
    metalness?: number;
    opacity?: number;
    kind?: MaterialDef['kind'];
  },
): OpResult<Project> {
  if (!/^[a-z0-9_.-]{2,40}$/.test(def.id)) {
    return fail('invalid_input', 'Material ids may only contain a-z, 0-9, dot, dash and underscore.');
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(def.color)) {
    return fail('invalid_input', 'Material colour must be a hex string like "#b4622d".');
  }
  const materials = {
    ...project.materials,
    [def.id]: {
      id: def.id,
      label: def.label,
      color: def.color,
      roughness: def.roughness ?? 0.8,
      metalness: def.metalness ?? 0,
      opacity: def.opacity ?? 1,
      kind: def.kind ?? 'paint',
    },
  };
  return done(reindex({ ...project, materials }), project);
}

// ────────────────────────────────────────────────────────── underlays ──────────

export function addUnderlay(project: Project, underlay: Project['underlays'][number]): OpResult<string> {
  const next = reindex({ ...project, underlays: [...project.underlays, underlay] });
  return done(next, underlay.id, [underlay.id]);
}

export function updateUnderlay(
  project: Project,
  id: string,
  patch: Partial<Project['underlays'][number]>,
): OpResult<Project['underlays'][number]> {
  const existing = project.underlays.find((u) => u.id === id);
  if (!existing) return fail('not_found', `Underlay "${id}" not found.`);
  const updated = { ...existing, ...patch, id };
  return done(reindex({ ...project, underlays: project.underlays.map((u) => (u.id === id ? updated : u)) }), updated);
}

export function removeUnderlay(project: Project, id: string): OpResult<{ removedIds: Id[] }> {
  if (!project.underlays.some((u) => u.id === id)) return fail('not_found', `Underlay "${id}" not found.`);
  const next = reindex({ ...project, underlays: project.underlays.filter((u) => u.id !== id) });
  return done(next, { removedIds: [id] }, [], [id]);
}

// ────────────────────────────────────────────────────────────── helpers ────────

function catalogLookup(id: string) {
  return CATALOG_INDEX.get(id);
}

/** Which room contains a point, or null. */
export function roomAt(project: Project, floorId: Id, x: number, y: number): Room | null {
  const hits = project.rooms.filter((r) => r.floorId === floorId && rectContains(rectOf(r), { x, y }));
  // Smallest wins, so a room inside a balcony resolves to the balcony.
  hits.sort((a, b) => a.width * a.depth - b.width * b.depth);
  return hits[0] ?? null;
}

/** Which wall is closest to a point within `radius` metres. */
export function wallNear(project: Project, floorId: Id, x: number, y: number, radius = 0.6): Wall | null {
  let best: Wall | null = null;
  let bestD = radius;
  for (const w of project.walls) {
    if (w.floorId !== floorId) continue;
    const f = wallFrame(w);
    const dx = x - w.a.x;
    const dy = y - w.a.y;
    let t = dx * f.dir.x + dy * f.dir.y;
    t = clamp(t, 0, f.length);
    const d = Math.hypot(x - (w.a.x + f.dir.x * t), y - (w.a.y + f.dir.y * t));
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

/** Rooms that share an edge with `room`, with the shared length. */
export function neighboursOf(project: Project, room: Room): Array<{ room: Room; shared: number }> {
  return project.rooms
    .filter((r) => r.floorId === room.floorId && r.id !== room.id)
    .map((r) => ({ room: r, shared: sharedEdgeLength(room, r) }))
    .filter((x) => x.shared > TOL.join)
    .sort((a, b) => b.shared - a.shared);
}

export function setBrief(project: Project, brief: DesignBrief): OpResult<Project> {
  if (!brief.plot || !(brief.plot.width > 0) || !(brief.plot.depth > 0)) {
    return fail('invalid_input', 'The brief needs a plot width and depth greater than zero.');
  }
  return done(reindex({ ...project, brief, plot: brief.plot }), project);
}

export function renameProject(project: Project, name: string): OpResult<Project> {
  const trimmed = name.trim();
  if (!trimmed) return fail('invalid_input', 'A project needs a name.');
  return done(reindex({ ...project, name: trimmed }), project);
}

export function setDisplayUnits(project: Project, units: 'm' | 'ft'): OpResult<Project> {
  return done(reindex({ ...project, displayUnits: units }), project);
}
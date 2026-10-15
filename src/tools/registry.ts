/**
 * The assistant's tool surface.
 *
 * This is the security boundary. The model can choose a *name* from this list
 * and supply arguments that are checked here, against the current project. It
 * cannot return code, cannot invent an id, cannot bypass a validation failure,
 * and cannot touch anything that is not one of these operations. Every handler
 * resolves through the same `run` dispatch the mouse uses, so there is exactly
 * one path from "an edit should happen" to "the edit happened" — and that path
 * enforces undo, the activity log and persistence.
 *
 * Each tool carries:
 *   · an input schema, sent to the model so it cannot guess argument names
 *   · an output schema, used to validate what the handler returns
 *   · a permission level, which decides whether the user must approve first
 *
 * Permission levels:
 *   read         — cannot change anything; runs freely
 *   write        — changes geometry; runs freely, but is logged and undoable
 *   destructive  — deletes or replaces; always confirmed by the user first
 */
import { CATALOG, KIND_LABEL } from '../model/catalog.ts';
import { DEFAULT_MATERIALS } from '../model/catalog.ts';
import { formatArea, formatLength, wallLength } from '../model/geometry.ts';
import { measureBuilding, measureRoom } from '../model/measure.ts';
import { errorsOnly, validate } from '../model/validate.ts';
import { buildScene } from '../three/sceneModel.ts';
import { useProject, type OperationName } from '../store/useProject.ts';
import type { Issue, Project } from '../model/types.ts';
import type { ResizeRoomInput } from '../model/ops.ts';

export type Permission = 'read' | 'write' | 'destructive';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolOutcome<T = unknown> {
  ok: boolean;
  /** Compact, model-readable summary. This is what the model sees next turn. */
  summary: string;
  data?: T;
  /** Present when ok is false. */
  error?: string;
  errorCode?: string;
  hint?: string;
  /** Ids created or removed, so the UI can highlight them and undo can work. */
  createdIds?: string[];
  removedIds?: string[];
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  permission: Permission;
  input: JsonSchema;
  /** Declared for documentation and for the client's response validation. */
  output: JsonSchema;
  handler(input: Record<string, unknown>): ToolOutcome;
}

/* ────────────────────────────────────────────────────────────── helpers ─────── */

/**
 * Who is running the tool currently in flight.
 *
 * The same handler is reached from the assistant and from the validator's
 * click-to-fix buttons, and the activity feed has to say which. It is ambient
 * for the duration of one synchronous `runTool` call — there is no concurrency
 * here, the store's run is synchronous — and restored afterwards.
 */
let currentActor: 'assistant' | 'user' = 'assistant';

/**
 * Runs an operation through the store and normalises the result.
 *
 * The actor is what makes the activity feed show who did what, and it is the
 * reason the app can honestly say the model changed something: the log entry
 * only exists because this call actually succeeded.
 */
function apply<A extends unknown[]>(
  op: OperationName,
  args: A,
  summary: (data: unknown) => string,
): ToolOutcome {
  const res = useProject.getState().run(op, args, { actor: currentActor });
  if (!res.ok) return { ok: false, summary: '', error: res.error, errorCode: res.code, hint: res.hint };
  return {
    ok: true,
    summary: summary(res.data),
    data: res.data,
    createdIds: res.createdIds,
    removedIds: res.removedIds,
  };
}

const project = (): Project => useProject.getState().project;
const activeFloorId = (): string => useProject.getState().activeFloorId || project().floors[0]?.id || '';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown): boolean => v === true;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function bad(message: string, hint?: string): ToolOutcome {
  return { ok: false, summary: '', error: message, errorCode: 'invalid_input', hint };
}

/** The envelope the model gets for reads: small, and never the whole project. */
function envelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const p = project();
  const floorId = activeFloorId();
  const floor = p.floors.find((f) => f.id === floorId);
  return {
    project: {
      name: p.name,
      units: p.displayUnits ?? 'm',
      plot: { width: p.plot.width, depth: p.plot.depth, orientation: p.plot.orientation, setbacks: p.plot.setbacks },
      activeFloor: floor ? { id: floor.id, name: floor.name, order: floor.order, elevation: floor.elevation, height: floor.height } : null,
      counts: {
        floors: p.floors.length,
        rooms: p.rooms.filter((r) => r.floorId === floorId).length,
        walls: p.walls.filter((w) => w.floorId === floorId).length,
        furniture: p.furniture.filter((f) => f.floorId === floorId).length,
      },
    },
    ...extra,
  };
}

const ROOM_SUMMARY: JsonSchema = { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string' }, area: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, depth: { type: 'number' } } };

/* ─────────────────────────────────────────────────────────────── the tools ───── */

export const TOOLS: ToolSpec[] = [
  {
    name: 'inspect_project',
    title: 'Inspect the whole project',
    description:
      'Read the project summary: plot size and setbacks, which floor is active, and how many rooms, walls and furniture items are on it. Start here — it is the cheapest way to find out what exists.',
    permission: 'read',
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: { project: { type: 'object' } } },
    handler: () => ({ ok: true, summary: 'Read the project summary.', data: envelope() }),
  },

  {
    name: 'get_floor_details',
    title: 'Get one floor',
    description: 'Full detail for a specific floor: its elevation, height, and every room, wall, opening and stair on it.',
    permission: 'read',
    input: { type: 'object', properties: { floorId: { type: 'string', description: 'Floor id. Defaults to the active floor.' } } },
    output: { type: 'object', properties: { floor: { type: 'object' }, rooms: { type: 'array' }, walls: { type: 'array' } } },
    handler: (input) => {
      const p = project();
      const floorId = str(input.floorId) || activeFloorId();
      const floor = p.floors.find((f) => f.id === floorId);
      if (!floor) return bad(`There is no floor with id "${floorId}".`, `Valid floors: ${p.floors.map((f) => f.id).join(', ')}`);
      const rooms = p.rooms.filter((r) => r.floorId === floorId);
      const walls = p.walls.filter((w) => w.floorId === floorId);
      return {
        ok: true,
        summary: `${floor.name}: ${rooms.length} rooms, ${walls.length} walls.`,
        data: envelope({
          floor,
          rooms: rooms.map((r) => ({ id: r.id, label: r.label, kind: r.kind, x: r.x, y: r.y, width: r.width, depth: r.depth, area: +(r.width * r.depth).toFixed(2) })),
          walls: walls.map((w) => ({ id: w.id, type: w.type, a: w.a, b: w.b, length: +wallLength(w).toFixed(3), thickness: w.thickness, openings: w.openings.map((o) => ({ id: o.id, kind: o.kind, offset: o.offset, width: o.width })) })),
        }),
      };
    },
  },

  {
    name: 'list_rooms',
    title: 'List the rooms on this floor',
    description: 'Every room on the active floor with its real id, kind, position and area. Use this before editing a room — the ids here are the only valid ones.',
    permission: 'read',
    input: { type: 'object', properties: { floorId: { type: 'string' } } },
    output: { type: 'object', properties: { rooms: { type: 'array', items: ROOM_SUMMARY } } },
    handler: (input) => {
      const p = project();
      const floorId = str(input.floorId) || activeFloorId();
      const rooms = p.rooms.filter((r) => r.floorId === floorId);
      if (!rooms.length) return { ok: true, summary: `No rooms on this floor yet.`, data: { rooms: [] } };
      return {
        ok: true,
        summary: `${rooms.length} rooms: ${rooms.map((r) => `${r.label} (${r.id}, ${(r.width * r.depth).toFixed(1)} m²)`).join('; ')}`,
        data: { rooms: rooms.map((r) => ({ id: r.id, label: r.label, kind: r.kind, x: r.x, y: r.y, width: r.width, depth: r.depth, area: +(r.width * r.depth).toFixed(2) })) },
      };
    },
  },

  {
    name: 'inspect_room',
    title: 'Inspect one room',
    description: 'Everything about a single room: size, area, which walls bound it, which doors reach it, and what furniture is inside.',
    permission: 'read',
    input: { type: 'object', properties: { roomId: { type: 'string' } }, required: ['roomId'] },
    output: { type: 'object', properties: { room: ROOM_SUMMARY, walls: { type: 'array' }, furniture: { type: 'array' }, doors: { type: 'array' } } },
    handler: (input) => {
      const p = project();
      const room = p.rooms.find((r) => r.id === str(input.roomId));
      if (!room) return bad(`No room has id "${str(input.roomId)}".`, 'Call list_rooms for the real ids.');
      const m = measureRoom(p, room.id);
      const walls = p.walls.filter((w) => w.roomIds.includes(room.id));
      const furniture = p.furniture.filter((f) => f.roomId === room.id);
      const doors = walls.flatMap((w) => w.openings.filter((o) => o.kind === 'door' || o.kind === 'doorway').map((o) => ({ wallId: w.id, openingId: o.id, offset: o.offset })));
      return {
        ok: true,
        summary: `${room.label} — ${room.width.toFixed(2)} × ${room.depth.toFixed(2)} m, ${m ? m.area.toFixed(1) : '0'} m², ${walls.length} bounding walls, ${furniture.length} items, ${doors.length} doors.`,
        data: { room, area: m?.area ?? null, walls: walls.map((w) => w.id), furniture, doors },
      };
    },
  },

  {
    name: 'inspect_wall',
    title: 'Inspect one wall',
    description: 'A wall by id: its endpoints, length, thickness, and the doors and windows already in it with their offsets.',
    permission: 'read',
    input: { type: 'object', properties: { wallId: { type: 'string' } }, required: ['wallId'] },
    output: { type: 'object', properties: { wall: { type: 'object' } } },
    handler: (input) => {
      const wall = project().walls.find((w) => w.id === str(input.wallId));
      if (!wall) return bad(`No wall has id "${str(input.wallId)}".`, 'Call get_floor_details for the real ids.');
      return {
        ok: true,
        summary: `Wall ${wall.id}: ${wall.type}, ${wallLength(wall).toFixed(2)} m long, ${wall.thickness} m thick, ${wall.openings.length} openings.`,
        data: { wall, length: wallLength(wall), openings: wall.openings },
      };
    },
  },

  {
    name: 'create_room',
    title: 'Create a room',
    description:
      'Add an axis-aligned rectangular room in metres. x,y is its top-left corner, width and depth run right and down. It must sit inside the plot and must not overlap an existing room.',
    permission: 'write',
    input: {
      type: 'object',
      properties: {
        floorId: { type: 'string' },
        kind: { type: 'string', enum: Object.keys(KIND_LABEL) },
        label: { type: 'string' },
        x: { type: 'number', description: 'Left edge, metres from the plot origin' },
        y: { type: 'number', description: 'Top edge, metres from the plot origin' },
        width: { type: 'number' },
        depth: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['kind', 'x', 'y', 'width', 'depth'],
    },
    output: ROOM_SUMMARY,
    handler: (input) =>
      apply(
        'createRoom',
        [{ floorId: str(input.floorId) || activeFloorId(), kind: str(input.kind) as never, label: str(input.label) || undefined, x: num(input.x), y: num(input.y), width: num(input.width), depth: num(input.depth), height: num(input.height) || undefined }],
        (d) => `Created ${(d as { label: string }).label} with id ${(d as { id: string }).id}.`,
      ),
  },

  {
    name: 'resize_room',
    title: 'Resize a room',
    description:
      'Change a room\'s width and/or depth. anchor fixes which corner stays put: top-left (default), top-right, bottom-left, bottom-right or center. Give anchor only if the room must stay against a particular wall.',
    permission: 'write',
    input: {
      type: 'object',
      properties: {
        roomId: { type: 'string' },
        width: { type: 'number' },
        depth: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
        anchor: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'] },
      },
      required: ['roomId'],
    },
    output: ROOM_SUMMARY,
    handler: (input) => {
      const p: ResizeRoomInput = { roomId: str(input.roomId) };
      for (const k of ['width', 'depth', 'x', 'y'] as const) if (input[k] !== undefined) p[k] = num(input[k]);
      if (input.anchor) p.anchor = str(input.anchor) as ResizeRoomInput['anchor'];
      return apply('resizeRoom', [p], (d) => `Resized ${(d as { label: string }).label} to ${(d as { width: number }).width.toFixed(2)} × ${(d as { depth: number }).depth.toFixed(2)} m.`);
    },
  },

  {
    name: 'move_room',
    title: 'Move a room',
    description: 'Move a room\'s top-left corner to an absolute x,y in metres. Its size does not change.',
    permission: 'write',
    input: { type: 'object', properties: { roomId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['roomId', 'x', 'y'] },
    output: ROOM_SUMMARY,
    handler: (input) => apply('moveRoom', [str(input.roomId), num(input.x), num(input.y)], (d) => `Moved ${(d as { label: string }).label}.`),
  },

  {
    name: 'create_wall',
    title: 'Create a wall',
    description: 'Add a wall between two plan points. Walls are what 3D, doors and windows are built on, so a room without walls is a diagram, not a building.',
    permission: 'write',
    input: {
      type: 'object',
      properties: {
        floorId: { type: 'string' },
        type: { type: 'string', enum: ['exterior', 'interior', 'parapet', 'railing'] },
        a: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        b: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        thickness: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    output: { type: 'object', properties: { id: { type: 'string' }, length: { type: 'number' } } },
    handler: (input) => {
      const a = obj(input.a);
      const b = obj(input.b);
      return apply(
        'createWall',
        [{ floorId: str(input.floorId) || activeFloorId(), type: (str(input.type) || 'interior') as never, a: { x: num(a.x), y: num(a.y) }, b: { x: num(b.x), y: num(b.y) }, thickness: num(input.thickness) || undefined }],
        (d) => `Created ${(d as { type: string }).type} wall ${(d as { id: string }).id}, ${wallLength(d as never).toFixed(2)} m.`,
      );
    },
  },

  {
    name: 'move_wall',
    title: 'Move or reshape a wall',
    description: 'Move a whole wall with dx/dy in metres, or set an absolute new endpoint with a or b. Thickness and type can be changed here too.',
    permission: 'write',
    input: {
      type: 'object',
      properties: {
        wallId: { type: 'string' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        a: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        b: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        thickness: { type: 'number' },
        type: { type: 'string' },
      },
      required: ['wallId'],
    },
    output: { type: 'object', properties: { id: { type: 'string' } } },
    handler: (input) => {
      const payload: Record<string, unknown> = { wallId: str(input.wallId) };
      if (input.dx !== undefined) payload.dx = num(input.dx);
      if (input.dy !== undefined) payload.dy = num(input.dy);
      if (input.a) payload.a = { x: num(obj(input.a).x), y: num(obj(input.a).y) };
      if (input.b) payload.b = { x: num(obj(input.b).x), y: num(obj(input.b).y) };
      if (input.thickness !== undefined) payload.thickness = num(input.thickness);
      if (input.type) payload.type = str(input.type);
      return apply('moveWall', [payload], (d) => `Wall ${(d as { id: string }).id} is now ${wallLength(d as never).toFixed(2)} m, ${(d as { thickness: number }).thickness} m thick.`);
    },
  },

  {
    name: 'add_door',
    title: 'Add a door',
    description: 'Put a door into an existing wall. offset is the distance in metres from the wall\'s start point; omit it for the middle. The opening must fit inside the wall and must not collide with another opening.',
    permission: 'write',
    input: {
      type: 'object',
      properties: { wallId: { type: 'string' }, offset: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, swing: { type: 'string', enum: ['positive', 'negative'] } },
      required: ['wallId'],
    },
    output: { type: 'object', properties: { wallId: { type: 'string' }, openingId: { type: 'string' } } },
    handler: (input) =>
      apply(
        'addOpening',
        [{ wallId: str(input.wallId), kind: 'door', offset: input.offset === undefined ? undefined : num(input.offset), width: num(input.width) || 0.9, height: num(input.height) || 2.1, swing: str(input.swing) || undefined }],
        (d) => `Door ${(d as { opening: { id: string } }).opening.id} added to wall ${(d as { wall: { id: string } }).wall.id}.`,
      ),
  },

  {
    name: 'add_window',
    title: 'Add a window',
    description: 'Put a window into an existing wall. sill is the height of the bottom of the glass above the floor; omit it for the standard 0.9 m.',
    permission: 'write',
    input: {
      type: 'object',
      properties: { wallId: { type: 'string' }, offset: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, sill: { type: 'number' } },
      required: ['wallId'],
    },
    output: { type: 'object', properties: { wallId: { type: 'string' }, openingId: { type: 'string' } } },
    handler: (input) =>
      apply(
        'addOpening',
        [{ wallId: str(input.wallId), kind: 'window', offset: input.offset === undefined ? undefined : num(input.offset), width: num(input.width) || 1.2, height: num(input.height) || 1.4, sill: num(input.sill) || 0.9 }],
        (d) => `Window ${(d as { opening: { id: string } }).opening.id} added to wall ${(d as { wall: { id: string } }).wall.id}.`,
      ),
  },

  {
    name: 'move_opening',
    title: 'Move an opening',
    description:
      'Slide an existing door or window along its wall, or resize it. offset is the distance in metres from the wall\'s start point to the opening\'s centre; omit any field to leave it alone. The opening must still fit inside the wall and must not collide with another opening.',
    permission: 'write',
    input: {
      type: 'object',
      properties: { wallId: { type: 'string' }, openingId: { type: 'string' }, offset: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, sill: { type: 'number' }, swing: { type: 'string', enum: ['positive', 'negative'] } },
      required: ['wallId', 'openingId'],
    },
    output: { type: 'object', properties: { wallId: { type: 'string' }, openingId: { type: 'string' }, offset: { type: 'number' } } },
    handler: (input) => {
      const payload: Record<string, unknown> = { wallId: str(input.wallId), openingId: str(input.openingId) };
      for (const k of ['offset', 'width', 'height', 'sill'] as const) if (input[k] !== undefined) payload[k] = num(input[k]);
      if (input.swing) payload.swing = str(input.swing);
      return apply('moveOpening', [payload], (d) => {
        const o = d as { offset: number; kind: string };
        return `The ${o.kind} on ${str(input.wallId)} now sits ${o.offset.toFixed(2)} m along the wall.`;
      });
    },
  },

  {
    name: 'add_staircase',
    title: 'Add a staircase',
    description: 'Add a straight flight. direction 1 climbs from this floor to the one above; -1 descends. The flight must actually reach the floor it claims to connect to.',
    permission: 'write',
    input: {
      type: 'object',
      properties: { floorId: { type: 'string' }, connectsToFloorId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, riserCount: { type: 'number' }, direction: { type: 'number', enum: [-1, 1] }, name: { type: 'string' } },
      required: ['floorId', 'x', 'y'],
    },
    output: { type: 'object', properties: { id: { type: 'string' }, riserCount: { type: 'number' } } },
    handler: (input) =>
      apply(
        'addStaircase',
        [{ floorId: str(input.floorId) || activeFloorId(), connectsToFloorId: str(input.connectsToFloorId) || undefined, x: num(input.x), y: num(input.y), width: num(input.width) || undefined, riserCount: num(input.riserCount) || undefined, direction: (num(input.direction) === -1 ? -1 : 1) as -1 | 1, name: str(input.name) || undefined }],
        (d) => `Staircase ${(d as { id: string }).id} added with ${(d as { riserCount: number }).riserCount} risers.`,
      ),
  },

  {
    name: 'add_furniture',
    title: 'Add a piece of furniture',
    description: 'Place a catalogue item by id, at a centre point in metres. Use list_catalog for valid ids. The item must fit inside the room it lands in.',
    permission: 'write',
    input: {
      type: 'object',
      properties: { catalogId: { type: 'string', description: 'A catalogue id, e.g. bed-double or sofa-3' }, x: { type: 'number' }, y: { type: 'number' }, roomId: { type: 'string' }, rotation: { type: 'number' }, color: { type: 'string' } },
      required: ['catalogId', 'x', 'y'],
    },
    output: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } },
    handler: (input) =>
      apply(
        'addFurniture',
        [{ floorId: activeFloorId(), roomId: str(input.roomId) || undefined, catalogId: str(input.catalogId), x: num(input.x), y: num(input.y), rotation: num(input.rotation) || undefined, color: str(input.color) || undefined }],
        (d) => `Placed ${(d as { label: string }).label} as ${(d as { id: string }).id}.`,
      ),
  },

  {
    name: 'move_furniture',
    title: 'Move a piece of furniture',
    description: 'Move, rotate or resize an existing item by id. Omit any field to leave it alone. The item re-homes to whichever room now contains it.',
    permission: 'write',
    input: {
      type: 'object',
      properties: { itemId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'number' }, width: { type: 'number' }, depth: { type: 'number' }, color: { type: 'string' } },
      required: ['itemId'],
    },
    output: { type: 'object', properties: { id: { type: 'string' } } },
    handler: (input) => {
      const payload: Record<string, unknown> = { itemId: str(input.itemId) };
      for (const k of ['x', 'y', 'rotation', 'width', 'depth'] as const) if (input[k] !== undefined) payload[k] = num(input[k]);
      if (input.color) payload.color = str(input.color);
      return apply('moveFurniture', [payload], (d) => `${(d as { label: string }).label} is now at ${(d as { x: number }).x.toFixed(2)}, ${(d as { y: number }).y.toFixed(2)}.`);
    },
  },

  {
    name: 'remove_element',
    title: 'Delete something',
    description: 'Delete a room, wall, opening, stair, outdoor space or furniture item by id. This is destructive: the user is asked to confirm before it happens.',
    permission: 'destructive',
    input: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['room', 'wall', 'opening', 'stair', 'outdoor', 'furniture'], description: 'Required for openings, which need their parent wall.' }, wallId: { type: 'string' } }, required: ['id'] },
    output: { type: 'object', properties: { removedIds: { type: 'array' } } },
    handler: (input) => {
      const p = project();
      const id = str(input.id);
      const explicit = str(input.kind);
      const kind =
        explicit ||
        (p.rooms.some((r) => r.id === id) ? 'room'
        : p.walls.some((w) => w.id === id) ? 'wall'
        : p.furniture.some((f) => f.id === id) ? 'furniture'
        : p.outdoor.some((o) => o.id === id) ? 'outdoor'
        : p.stairs.some((s) => s.id === id) ? 'stair'
        : p.walls.some((w) => w.openings.some((o) => o.id === id)) ? 'opening'
        : null);
      if (!kind) return bad(`Nothing in this project has id "${id}".`, 'Call list_rooms or get_floor_details for the real ids.');
      const label = p.rooms.find((r) => r.id === id)?.label ?? kind;
      if (kind === 'opening') {
        const wall = p.walls.find((w) => w.openings.some((o) => o.id === id));
        if (!wall) return bad(`Opening "${id}" is not in any wall.`);
        return apply('removeOpening', [wall.id, id], () => `Deleted the opening in ${wall.id}.`);
      }
      const op = `remove${kind[0]!.toUpperCase()}${kind.slice(1)}` as OperationName;
      return apply(op, [id], () => `Deleted ${label}.`);
    },
  },

  {
    name: 'calculate_room_area',
    title: 'Measure one room',
    description: 'Exact area, perimeter and dimensions of one room, computed from the model — never estimated.',
    permission: 'read',
    input: { type: 'object', properties: { roomId: { type: 'string' } }, required: ['roomId'] },
    output: { type: 'object', properties: { area: { type: 'number' }, perimeter: { type: 'number' } } },
    handler: (input) => {
      const m = measureRoom(project(), str(input.roomId));
      if (!m) return bad(`No room has id "${str(input.roomId)}".`);
      return { ok: true, summary: `${m.label} is ${m.area.toFixed(2)} m² (${m.width.toFixed(2)} × ${m.depth.toFixed(2)} m, perimeter ${m.perimeter.toFixed(2)} m).`, data: m };
    },
  },

  {
    name: 'calculate_building_areas',
    title: 'Measure the whole building',
    description: 'Plot area, buildable area, net indoor area, footprint, gross covered area, open site area, plot coverage and floor-area ratio — each computed from real geometry with its formula.',
    permission: 'read',
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: { netIndoorArea: { type: 'number' }, plotCoverage: { type: 'number' }, floorAreaRatio: { type: 'number' } } },
    handler: () => {
      const m = measureBuilding(project());
      return {
        ok: true,
        summary:
          `Plot ${m.plotArea.toFixed(1)} m² · net indoor ${m.netIndoorArea.toFixed(1)} m² · footprint ${m.footprintArea.toFixed(1)} m² · ` +
          `gross covered ${m.grossCoveredArea.toFixed(1)} m² · open site ${m.openSiteArea.toFixed(1)} m² · coverage ${(m.plotCoverage * 100).toFixed(1)}% · FAR ${m.floorAreaRatio.toFixed(2)}`,
        data: m,
      };
    },
  },

  {
    name: 'validate_floor_plan',
    title: 'Check the plan for problems',
    description: 'Run the deterministic checks: overlaps, walls that do not meet, openings that do not fit, doors that cannot be reached, rooms with no way in, stairs that do not connect, furniture through walls, setbacks and coverage.',
    permission: 'read',
    input: { type: 'object', properties: { severity: { type: 'string', enum: ['all', 'errors'] } } },
    output: { type: 'object', properties: { issues: { type: 'array' } } },
    handler: (input) => {
      const list = str(input.severity) === 'errors' ? errorsOnly(validate(project())) : validate(project());
      const n = errorsOnly(list).length;
      return {
        ok: true,
        summary: list.length === 0 ? 'The plan is clean — 0 issues.' : `${n} error(s), ${list.length - n} warning(s): ${list.slice(0, 12).map((i) => i.message).join(' ')}`,
        data: { issues: list, errorCount: n },
      };
    },
  },

  {
    name: 'get_layout_issues',
    title: 'List the current problems',
    description: 'The same issue list the Checks panel shows, with each problem\'s code, the objects involved and any suggested corrections. Call this after editing, and fix what it reports.',
    permission: 'read',
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: { issues: { type: 'array' } } },
    handler: () => {
      const list = validate(project());
      return {
        ok: true,
        summary: list.length === 0 ? 'No issues. The plan is clean.' : list.map((i) => `[${i.severity}] ${i.code}: ${i.message}`).join('\n'),
        data: { issues: list as Issue[] },
      };
    },
  },

  {
    name: 'apply_material',
    title: 'Apply a material',
    description: 'Apply a named material to a room, a wall, every exterior wall, or every floor finish. Use list_materials for valid ids.',
    permission: 'write',
    input: { type: 'object', properties: { materialId: { type: 'string' }, target: { type: 'string', enum: ['room', 'wall', 'exterior', 'floor'] }, elementId: { type: 'string' } }, required: ['materialId', 'target'] },
    output: { type: 'object', properties: { ok: { type: 'boolean' } } },
    handler: (input) =>
      apply(
        'applyMaterial',
        [{ kind: (str(input.target) || 'room') as never, id: str(input.elementId) || undefined }, str(input.materialId)],
        () => `Applied ${str(input.materialId)}.`,
      ),
  },

  {
    name: 'get_3d_scene_state',
    title: 'Read what the 3D view is showing',
    description: 'How many boxes the 3D build produced, the building bounds, and how many collision volumes the walk camera has. Useful for confirming that an edit actually reached 3D.',
    permission: 'read',
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: { boxCount: { type: 'number' }, bounds: { type: 'object' } } },
    handler: () => {
      const scene = buildScene(project());
      const byKind: Record<string, number> = {};
      for (const b of scene.boxes) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
      return {
        ok: true,
        summary: `3D: ${scene.boxes.length} meshes (${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(', ')}), ${scene.colliders.length} colliders, ${scene.bounds.height.toFixed(2)} m tall.`,
        data: { boxCount: scene.boxes.length, byKind, colliders: scene.colliders.length, bounds: scene.bounds },
      };
    },
  },

  {
    name: 'list_catalog',
    title: 'List furniture catalogue',
    description: 'Every catalogue item with its id and real footprint in metres. Use these ids for add_furniture and move_furniture.',
    permission: 'read',
    input: { type: 'object', properties: { category: { type: 'string' } } },
    output: { type: 'object', properties: { items: { type: 'array' } } },
    handler: (input) => {
      const category = str(input.category);
      const items = (category ? CATALOG.filter((c) => c.category === category) : CATALOG).map((c) => ({ id: c.id, label: c.label, width: c.width, depth: c.depth, height: c.height, category: c.category }));
      return { ok: true, summary: `${items.length} items: ${items.map((i) => `${i.id} (${i.width}×${i.depth}m)`).join('; ')}`, data: { items } };
    },
  },

  {
    name: 'list_materials',
    title: 'List materials',
    description: 'Every material Argon knows, with its id and role.',
    permission: 'read',
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: { materials: { type: 'array' } } },
    handler: () => {
      const materials = Object.entries(DEFAULT_MATERIALS).map(([id, m]) => ({ id, label: m.label, kind: m.kind }));
      return { ok: true, summary: `${materials.length} materials: ${materials.map((m) => `${m.id} (${m.kind})`).join('; ')}`, data: { materials } };
    },
  },

  {
    name: 'undo_last_operation',
    title: 'Undo the last change',
    description: 'Step back one edit in the shared undo history, whatever made it.',
    permission: 'write',
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: { undone: { type: 'boolean' } } },
    handler: () => {
      const before = project();
      useProject.getState().undo();
      const after = project();
      return { ok: true, summary: after === before ? 'Nothing was left to undo.' : 'Undid the last change.', data: { undone: after !== before } };
    },
  },

  {
    name: 'export_project',
    title: 'Export the project',
    description: 'Produce the project as JSON text. This is the lossless format Argon can import back, and it is the only honest way to hand a project to someone else.',
    permission: 'read',
    input: { type: 'object', properties: { pretty: { type: 'boolean' } } },
    output: { type: 'object', properties: { json: { type: 'string' } } },
    handler: (input) => {
      void import('../model/serialize.ts').then(({ toJSON }) => {
        const p = project();
        const json = toJSON(p, bool(input.pretty));
        useProject.getState().toast('success', `Exported ${formatArea(p.rooms.length ? 1 : 0, 'm')} of project JSON (${json.length.toLocaleString()} characters). Download it from the Export menu.`);
      });
      const p = project();
      return { ok: true, summary: `Project "${p.name}" has ${p.floors.length} floors, ${p.rooms.length} rooms, ${p.walls.length} walls. Use the Export menu for the file itself.`, data: { name: p.name, floors: p.floors.length, rooms: p.rooms.length, walls: p.walls.length } };
    },
  },

  {
    name: 'regenerate_floor',
    title: 'Re-plan a floor from the brief',
    description: 'Throw away the current layout of one floor and lay it out again from the stored brief. This is destructive — every room, wall and opening on that floor is replaced.',
    permission: 'destructive',
    input: { type: 'object', properties: { floorId: { type: 'string' } } },
    output: { type: 'object', properties: { floorId: { type: 'string' } } },
    handler: (input) => {
      const floorId = str(input.floorId) || activeFloorId();
      return apply('replanFloor', [floorId], () => `Re-planned ${floorId} from the brief.`);
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * The tool list as sent to the model.
 *
 * Read tools are advertised first and edits later: the model should look before
 * it leaps, and ordering is the cheapest way to nudge that without a longer
 * prompt. `input_schema` is the property name MiniMax's Anthropic-compatible
 * endpoint expects.
 */
export function toolDefinitionsForModel(): Array<{ name: string; description: string; input_schema: JsonSchema }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input }));
}

/** Every tool name, as a union. `SuggestedFix.tool` is typed with it. */
export type ToolName = (typeof TOOLS)[number]['name'];

/**
 * Run one tool by name against the live project.
 *
 * The single place a named edit becomes an actual change. The assistant's
 * pipeline, the validator's click-to-fix buttons and the tests all come through
 * here, so a correction the validation panel offers is executed by exactly the
 * same code path — with the same argument checking, the same activity log and
 * the same undo history — that the model uses. There is no second, looser route
 * into the model for the UI to take.
 *
 * Never throws: an unknown name or a throwing handler comes back as a failed
 * outcome, so a caller that forgets to check `ok` still cannot corrupt state.
 */
export function runTool(
  name: string,
  input: Record<string, unknown> = {},
  actor: 'assistant' | 'user' = 'assistant',
): ToolOutcome {
  const spec = TOOLS_BY_NAME.get(name);
  if (!spec) return bad(`There is no tool called "${name}".`);
  const previous = currentActor;
  currentActor = actor;
  try {
    return spec.handler(input);
  } catch (e) {
    return { ok: false, summary: '', error: e instanceof Error ? e.message : String(e) };
  } finally {
    currentActor = previous;
  }
}

export { formatArea, formatLength };
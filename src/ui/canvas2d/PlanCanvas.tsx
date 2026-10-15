/**
 * The interactive 2D floor plan.
 *
 * This is a real editor over the canonical model, not a picture of one: every
 * shape below is a live binding to a room / wall / opening / furniture id,
 * every drag calls a deterministic operation, and the 3D view is reading the
 * very same objects. Deleting a room here deletes it everywhere; there is no
 * separate "diagram" that only exists in SVG.
 *
 * Geometry is rendered as SVG. The choice matters: vector output means the
 * same code path produces the exported plan file, snapping to grid lines is
 * exact rather than approximate, and hit-testing is a point-in-rect test in
 * plan space rather than a hit test against painted pixels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElementKind, Floor, FurnitureItem, Opening, Project, Room, Wall } from '../../model/types.ts';
import { TOL, footprintOfItem, formatLength, rectContains, v } from '../../model/geometry.ts';
import { KIND_LABEL, catalogById, defaultRoomFootprint } from '../../model/catalog.ts';
import { validate } from '../../model/validate.ts';
import { useProject } from '../../store/useProject.ts';
import {
  fitTransform,
  gridStepFor,
  makeTransform,
  panBy,
  screenToPlan,
  snapToGeometry,
  zoomAt,
  type ViewTransform,
} from './view.ts';
import { TraceOverlay } from './TraceOverlay.tsx';
import { ContextMenu, type MenuTarget } from './ContextMenu.tsx';
import { WALL_FILL, wallPiers } from './poche.ts';
import { DoorSymbol, FurnitureGlyph, WindowSymbol } from './symbols.tsx';

const C = {
  plot: '#efece4',
  plotEdge: '#b9b2a3',
  setback: '#c9c2b1',
  roomStroke: '#8d8577',
  roomStrokeSelected: '#2563eb',
  floor: '#fdfcfa',
  outdoor: '#f1f4f0',
  wall: '#3f3a33',
  wallExterior: '#2b2722',
  opening: '#fbfaf7',
  glass: '#5b8ba6',
  furniture: '#c9c2b1',
  furnitureStroke: '#9a9284',
  label: '#3f3a33',
  labelDim: '#8d8577',
  guide: '#2563eb',
  measure: '#b45309',
  error: '#dc2626',
} as const;

const KIND_TINT: Record<string, string> = {
  living: '#fdf6ec',
  dining: '#fdf6ec',
  kitchen: '#fdf6ec',
  bedroom: '#f2f6fc',
  bathroom: '#f0f9fb',
  guest: '#f2f6fc',
  office: '#f5f3fb',
  prayer: '#f7f4fb',
  storage: '#f6f5f2',
  utility: '#f6f5f2',
  pantry: '#f6f5f2',
  corridor: '#f8f7f4',
  hall: '#f8f7f4',
  lobby: '#f8f7f4',
  garage: '#f4f3f0',
  balcony: '#f3faf6',
  terrace: '#f3faf6',
};

/** How close, in metres, a dragged edge must come to real geometry to snap to it. */
const SNAP_TOLERANCE_M = 0.28;

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: ViewTransform }
  | { kind: 'moveRoom'; id: string; grabX: number; grabY: number }
  | { kind: 'resizeRoom'; id: string; edge: ResizeEdge; grabX: number; grabY: number }
  | { kind: 'moveFurniture'; id: string; grabX: number; grabY: number }
  | { kind: 'moveWall'; id: string; grab: { x: number; y: number } }
  | { kind: 'moveOpening'; id: string; wallId: string }
  | { kind: 'drawWall'; wallId: string; start: { x: number; y: number }; cursor: { x: number; y: number } }
  | { kind: 'measure'; a: { x: number; y: number }; b: { x: number; y: number } };

export interface PlanCanvasProps {
  /** Element ids to briefly highlight (e.g. what the assistant just made). */
  highlightIds?: string[];
  onRegister?: (h: { fit: () => void }) => void;
}

export function PlanCanvas({ highlightIds = [], onRegister }: PlanCanvasProps) {
  const project = useProject((s) => s.project);
  const activeFloorId = useProject((s) => s.activeFloorId);
  const selection = useProject((s) => s.selection);
  const tool = useProject((s) => s.tool);
  const snapOn = useProject((s) => s.snapEnabled);
  const gridOn = useProject((s) => s.gridEnabled);
  const pendingFurnitureId = useProject((s) => s.pendingFurnitureId);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 960, height: 640 });
  const [view, setView] = useState<ViewTransform>(() => makeTransform(960, 640, 40));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guides, setGuides] = useState<Array<{ axis: 'x' | 'y'; value: number }>>([]);
  const [menu, setMenu] = useState<{ target: MenuTarget; x: number; y: number } | null>(null);

  const floor: Floor | undefined = useMemo(
    () => project.floors.find((f) => f.id === activeFloorId) ?? project.floors[0],
    [project.floors, activeFloorId],
  );

  const rooms = useMemo(() => project.rooms.filter((r) => r.floorId === floor?.id), [project.rooms, floor?.id]);
  const walls = useMemo(() => project.walls.filter((w) => w.floorId === floor?.id), [project.walls, floor?.id]);
  const furniture = useMemo(() => project.furniture.filter((f) => f.floorId === floor?.id), [project.furniture, floor?.id]);
  const stairs = useMemo(() => project.stairs.filter((s) => s.floorId === floor?.id), [project.stairs, floor?.id]);
  const outdoor = useMemo(() => project.outdoor.filter((o) => o.floorId === floor?.id), [project.outdoor, floor?.id]);

  // Validation is a pure function of the project, so a memo on the revision
  // is exactly right: same revision ⇒ same issues, no recompute.
  const issues = useMemo(() => validate(project), [project]);

  // ── sizing / fit ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 10 && r.height > 10) setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * The extent of what has actually been drawn.
   *
   * Fitting the *plot* meant a 9 × 8 m house on a 30 × 25 m plot arrived as a
   * small island in a large field of nothing, which is a big part of why the
   * plan read as a diagram rather than as a drawing. When there is a building,
   * the view frames the building and lets the plot run off the edges — which
   * is also what you do on site.
   */
  const contentBounds = useMemo(() => {
    if (!rooms.length && !walls.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const take = (x: number, y: number): void => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const r of rooms) {
      take(r.x, r.y);
      take(r.x + r.width, r.y + r.depth);
    }
    for (const w of walls) {
      take(w.a.x, w.a.y);
      take(w.b.x, w.b.y);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), depth: Math.max(1, maxY - minY) };
  }, [rooms, walls]);

  const fit = useCallback(() => {
    const b = contentBounds;
    // A metre margin so doors, swings and dimension text at the outer wall are
    // not flush against the frame.
    const pad = b ? Math.max(0.6, Math.max(b.width, b.depth) * 0.06) : 0;
    setView(
      fitTransform(
        size.width,
        size.height,
        b
          ? { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, depth: b.depth + pad * 2 }
          : { x: 0, y: 0, width: project.plot.width, depth: project.plot.depth },
      ),
    );
  }, [size.width, size.height, project.plot.width, project.plot.depth, contentBounds]);

  const hasBuilding = contentBounds !== null;

  useEffect(() => {
    fit();
    onRegister?.({ fit });
    // On plot-shape change, and once when the building first appears — a
    // resize must not discard the user's zoom and pan mid-draw, but a house
    // that was just generated should not stay at the pre-generation zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.plot.width, project.plot.depth, hasBuilding]);

  const toPlan = useCallback(
    (clientX: number, clientY: number) => {
      const el = hostRef.current;
      if (!el) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      return screenToPlan(view, { x: clientX - r.left, y: clientY - r.top });
    },
    [view],
  );

  const gridStep = gridStepFor(view.scale);

  const snapCandidates = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of rooms) {
      xs.push(r.x, r.x + r.width);
      ys.push(r.y, r.y + r.depth);
    }
    for (const w of walls) {
      xs.push(w.a.x, w.b.x);
      ys.push(w.a.y, w.b.y);
    }
    return { xs, ys };
  }, [rooms, walls]);

  const snapX = useCallback((v: number) => snapToGeometry(v, snapCandidates.xs, SNAP_TOLERANCE_M, gridStep, snapOn), [snapCandidates.xs, snapOn, gridStep]);
  const snapY = useCallback((v: number) => snapToGeometry(v, snapCandidates.ys, SNAP_TOLERANCE_M, gridStep, snapOn), [snapCandidates.ys, snapOn, gridStep]);

  const store = useProject;

  // ── right-click ────────────────────────────────────────────────────────────
  // Resolves the element under the cursor in the same priority order a left
  // click uses, so right-clicking always addresses the thing you can see
  // selected when you right-clicked it.
  const onContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    // The plan is the document here. The browser's own menu offers "Save image
    // as…" and nothing else worth having.
    e.preventDefault();
    e.stopPropagation();
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = screenToPlan(view, { x, y });
    const open = (target: MenuTarget, kinds: ElementKind[]) => {
      store.getState().setSelection({ kinds, ids: target.id ? [target.id] : [] });
      setMenu({ target, x, y });
    };

    const furnHit = furnitureAtPoint(furniture, p.x, p.y);
    if (furnHit) {
      open({ kind: 'furniture', id: furnHit.id }, ['furniture']);
      return;
    }
    const stairHit = stairs.find((st) => Math.abs(p.x - st.x) <= st.width / 2 + 0.1 && p.y >= st.y && p.y <= st.y + st.run);
    if (stairHit) {
      open({ kind: 'stair', id: stairHit.id }, ['stair']);
      return;
    }
    const outHit = outdoor.find((o) => rectContains({ x: o.x, y: o.y, width: o.width, depth: o.depth }, v(p.x, p.y)));
    if (outHit) {
      open({ kind: 'outdoor', id: outHit.id }, ['outdoor']);
      return;
    }
    const roomHit = roomAtPoint(rooms, p.x, p.y);

    // A partition runs through the middle of two rooms, so testing the room
    // first meant a right-click anywhere along a wall addressed whichever room
    // happened to be on top and the wall could never be reached at all. Walls
    // win when the cursor is on one; a resize handle wins over both.
    const onWall = wallUnderPoint(project, floor?.id ?? '', p.x, p.y, view.scale);
    if (onWall) {
      const opening = onWall.wall.openings.find((o) => Math.abs(o.offset - onWall.along) < o.width / 2 + 0.12);
      const target: MenuTarget = opening
        ? { kind: 'opening', id: opening.id, along: onWall.along }
        : { kind: 'wall', id: onWall.wall.id, along: onWall.along };
      open(target, [opening ? 'opening' : 'wall']);
      return;
    }

    if (roomHit) {
      open({ kind: 'room', id: roomHit.id }, ['room']);
      return;
    }

    const wallHit = nearWallAt(project, floor?.id ?? '', p.x, p.y, 0.55);
    if (wallHit) {
      const { along } = projectWallPoint(wallHit, p);
      const opening = wallHit.openings.find((o) => Math.abs(o.offset - along) < o.width / 2 + 0.12);
      open(opening ? { kind: 'opening', id: opening.id, along } : { kind: 'wall', id: wallHit.id, along },
        opening ? ['opening'] : ['wall']);
      return;
    }
    open({ kind: 'none', id: '' }, []);
  };

  // ── pointer down ──────────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    svg.setPointerCapture(e.pointerId);

    if (e.button === 1 || tool === 'pan' || e.altKey) {
      setDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, view });
      return;
    }
    if (e.button !== 0) return;

    const p = toPlan(e.clientX, e.clientY);

    if (tool === 'room') {
      // Clicking on a room that is already there picks that room up instead of
      // dropping a second copy of the pending kind on top of it. Staying armed
      // after a placement is right — laying out a floor is dropping several
      // rooms in a row — but staying armed *through* the next click meant that
      // reaching for a room to move or delete it added a duplicate instead, and
      // the plan filled up with rooms nobody drew.
      const furnHit = furnitureAtPoint(furniture, p.x, p.y);
      if (furnHit) {
        store.getState().setSelection({ kinds: ['furniture'], ids: [furnHit.id] });
        return;
      }
      const hit = roomAtPoint(rooms, p.x, p.y);
      if (hit) {
        store.getState().setSelection({ kinds: ['room'], ids: [hit.id] });
        return;
      }

      const kind = store.getState().pendingRoomKind;
      const { width, depth } = defaultRoomFootprint(kind);
      // Centre the room on the click. This used to put the room's bottom-right
      // corner under the cursor and always make a 3 × 3 m bedroom, which is
      // how "I cannot add a kitchen" happened: the tool had no type and no size.
      const cx = snapX(p.x).value;
      const cy = snapY(p.y).value;
      const res = store.getState().run(
        'createRoom',
        [{ floorId: floor?.id, kind, x: Math.max(0, cx - width / 2), y: Math.max(0, cy - depth / 2), width, depth }],
        { label: `Add ${KIND_LABEL[kind].toLowerCase()}` },
      );
      // The tool stays active after a placement, so a refused one has to say
      // why. Silence here reads as the tool being broken.
      if (res.ok) store.getState().setSelection({ kinds: ['room'], ids: [res.data.id] });
      else store.getState().toast('error', 'hint' in res && res.hint ? `${res.error} ${res.hint}` : res.error);
      return;
    }

    if (tool === 'wall') {
      // Same guard as the room tool: a click in the middle of a wall that is
      // already there selects it rather than starting a second wall across it.
      // Starting from near an *end* is how a partition is meant to join an
      // existing wall, so that case still draws.
      const under = wallUnderPoint(project, floor?.id ?? '', p.x, p.y, view.scale);
      if (under) {
        const len = Math.hypot(under.wall.b.x - under.wall.a.x, under.wall.b.y - under.wall.a.y);
        if (under.along > 0.35 && under.along < len - 0.35) {
          selectWallOrOpening(under.wall, under.along, p);
          store.getState().toast('info', 'That wall is already here — press Delete to remove it, or drag it to move it.');
          return;
        }
      }
      const sx = snapX(p.x).value;
      const sy = snapY(p.y).value;
      const res = store.getState().run(
        'createWall',
        [{ floorId: floor?.id, type: 'interior', a: { x: sx, y: sy }, b: { x: sx + 0.4, y: sy } }],
        { label: 'Draw wall', undoable: false, deferSave: true },
      );
      if (res.ok) {
        store.getState().beginGesture('wall-draw');
        setDrag({ kind: 'drawWall', wallId: res.data.id, start: { x: sx, y: sy }, cursor: { x: sx, y: sy } });
      } else {
        store.getState().toast('error', 'hint' in res && res.hint ? `${res.error} ${res.hint}` : res.error);
      }
      return;
    }

    if (tool === 'door' || tool === 'window') {
      const hit = nearWallAt(project, floor?.id ?? '', p.x, p.y, 0.9);
      if (!hit) {
        store.getState().toast('info', 'Click on or very near a wall — doors and windows sit inside one.');
        return;
      }
      const { along } = projectWallPoint(hit, p);
      store.getState().run('addOpening', [{ wallId: hit.id, kind: tool === 'door' ? 'door' : 'window', offset: along }], {
        label: tool === 'door' ? 'Add door' : 'Add window',
      });
      store.getState().setTool('select');
      return;
    }

    if (tool === 'furniture' && pendingFurnitureId) {
      const host = roomAtPoint(rooms, p.x, p.y);
      store.getState().run('addFurniture', [{ floorId: floor?.id, roomId: host?.id ?? null, catalogId: pendingFurnitureId, x: p.x, y: p.y }], {
        label: `Add ${pendingFurnitureId}`,
      });
      return;
    }

    if (tool === 'measure') {
      setDrag({ kind: 'measure', a: p, b: p });
      return;
    }

    // ── select tool ────────────────────────────────────────────────────────
    // Furniture first (it sits on top), then a resize handle, then walls, then
    // the room behind them. Walls are thin and rooms are large, so the pick
    // goes to whichever the cursor is more precisely on — see `wallUnderPoint`
    // for why rooms cannot be tested first.
    const furnHit = furnitureAtPoint(furniture, p.x, p.y);
    if (furnHit) {
      store.getState().setSelection({ kinds: ['furniture'], ids: [furnHit.id] });
      store.getState().beginGesture(`move-furniture:${furnHit.id}`);
      setDrag({ kind: 'moveFurniture', id: furnHit.id, grabX: p.x - furnHit.x, grabY: p.y - furnHit.y });
      return;
    }

    // A handle is a 9 px target, and in a planned plan every room edge is a wall
    // centreline — so the two sit exactly on top of each other. A *corner* is
    // unambiguous and outranks the wall; a plain edge handle only gets used
    // where the room has no wall on that side.
    const handleRoom = roomAtPoint(rooms, p.x, p.y);
    const roomHandle = handleRoom ? handleAt(handleRoom, p, view.scale) : null;
    if (handleRoom && roomHandle && isRoomCorner(handleRoom, p, view.scale)) {
      store.getState().setSelection({ kinds: ['room'], ids: [handleRoom.id] });
      store.getState().beginGesture(`resize-room:${handleRoom.id}`);
      setDrag({ kind: 'resizeRoom', id: handleRoom.id, edge: roomHandle, grabX: p.x, grabY: p.y });
      return;
    }

    const onWall = wallUnderPoint(project, floor?.id ?? '', p.x, p.y, view.scale);
    if (onWall) {
      selectWallOrOpening(onWall.wall, onWall.along, p);
      return;
    }

    if (handleRoom && roomHandle) {
      store.getState().setSelection({ kinds: ['room'], ids: [handleRoom.id] });
      store.getState().beginGesture(`resize-room:${handleRoom.id}`);
      setDrag({ kind: 'resizeRoom', id: handleRoom.id, edge: roomHandle, grabX: p.x, grabY: p.y });
      return;
    }

    if (handleRoom) {
      store.getState().setSelection({ kinds: ['room'], ids: [handleRoom.id] });
      store.getState().beginGesture(`move-room:${handleRoom.id}`);
      setDrag({ kind: 'moveRoom', id: handleRoom.id, grabX: p.x - handleRoom.x, grabY: p.y - handleRoom.y });
      return;
    }

    // Nothing under the cursor but within arm's reach of a wall — the strip
    // between the building and the setback line, where there is no room to
    // pick and a generous radius is the only thing that answers.
    const nearWall = nearWallAt(project, floor?.id ?? '', p.x, p.y, 0.55);
    if (nearWall) {
      selectWallOrOpening(nearWall, projectWallPoint(nearWall, p).along, p);
      return;
    }

    store.getState().clearSelection();
  };

  /** Selects an opening if the point is on one, otherwise the wall, and arms the matching drag. */
  const selectWallOrOpening = (wall: Wall, along: number, p: { x: number; y: number }) => {
    const opening = wall.openings.find((o) => Math.abs(o.offset - along) < o.width / 2 + 0.12);
    if (opening) {
      store.getState().setSelection({ kinds: ['opening'], ids: [opening.id] });
      store.getState().beginGesture(`move-opening:${opening.id}`);
      setDrag({ kind: 'moveOpening', id: opening.id, wallId: wall.id });
      return;
    }
    store.getState().setSelection({ kinds: ['wall'], ids: [wall.id] });
    store.getState().beginGesture(`move-wall:${wall.id}`);
    setDrag({ kind: 'moveWall', id: wall.id, grab: p });
  };

  // ── pointer move ──────────────────────────────────────────────────────────
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toPlan(e.clientX, e.clientY);
    if (!drag) return;

    switch (drag.kind) {
      case 'pan':
        setView(panBy(drag.view, e.clientX - drag.startX, e.clientY - drag.startY));
        return;

      case 'measure':
        setDrag({ ...drag, b: p });
        return;

      case 'drawWall': {
        const vx = snapX(p.x).value;
        const vy = snapY(p.y).value;
        const w = project.walls.find((x) => x.id === drag.wallId);
        if (w) {
          store.getState().run('moveWall', [{ wallId: drag.wallId, b: { x: vx, y: vy } }], {
            label: 'Draw wall',
            coalesceKey: 'wall-draw',
            deferSave: true,
          });
        }
        setDrag({ ...drag, cursor: { x: vx, y: vy } });
        return;
      }

      case 'moveRoom': {
        const sx = snapX(p.x - drag.grabX);
        const sy = snapY(p.y - drag.grabY);
        setGuides([{ axis: 'x', value: sx.value }, { axis: 'y', value: sy.value }]);
        store.getState().run('moveRoom', [drag.id, sx.value, sy.value], {
          label: 'Move room',
          coalesceKey: `move-room:${drag.id}`,
          deferSave: true,
        });
        return;
      }

      case 'resizeRoom': {
        const room = project.rooms.find((r) => r.id === drag.id);
        if (!room) return;
        const gx = snapX(p.x);
        const gy = snapY(p.y);
        // Keep the opposite edge fixed, which is what a resize handle means.
        const west = drag.edge.includes('w');
        const north = drag.edge.includes('n');
        const x = west ? gx.value : room.x;
        const y = north ? gy.value : room.y;
        const right = west ? room.x + room.width : gx.value;
        const bottom = north ? room.y + room.depth : gy.value;
        setGuides([{ axis: 'x', value: gx.value }, { axis: 'y', value: gy.value }]);
        store.getState().run('resizeRoom', [{ roomId: drag.id, x, y, width: right - x, depth: bottom - y }], {
          label: 'Resize room',
          coalesceKey: `resize-room:${drag.id}`,
          deferSave: true,
        });
        return;
      }

      case 'moveFurniture': {
        const sx = snapX(p.x - drag.grabX);
        const sy = snapY(p.y - drag.grabY);
        store.getState().run('moveFurniture', [{ itemId: drag.id, x: sx.value, y: sy.value }], {
          label: 'Move furniture',
          coalesceKey: `move-furniture:${drag.id}`,
          deferSave: true,
        });
        return;
      }

      case 'moveWall': {
        // Translate the whole wall by the snapped delta from where it was grabbed.
        const w = project.walls.find((x) => x.id === drag.id);
        if (!w) return;
        const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
        const sx = snapX(mid.x + (p.x - drag.grab.x));
        const sy = snapY(mid.y + (p.y - drag.grab.y));
        store.getState().run('moveWall', [{ wallId: drag.id, dx: sx.value - mid.x, dy: sy.value - mid.y }], {
          label: 'Move wall',
          coalesceKey: `move-wall:${drag.id}`,
          deferSave: true,
        });
        return;
      }

      case 'moveOpening': {
        const w = project.walls.find((x) => x.id === drag.wallId);
        if (!w) return;
        const { along } = projectWallPoint(w, p);
        store.getState().run('moveOpening', [{ wallId: drag.wallId, openingId: drag.id, offset: along }], {
          label: 'Move opening',
          coalesceKey: `move-opening:${drag.id}`,
          deferSave: true,
        });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag) {
      if (drag.kind === 'drawWall') {
        const w = project.walls.find((x) => x.id === drag.wallId);
        const len = w ? Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) : 0;
        if (len < 0.25) {
          // A click with no drag should not leave a stub wall behind.
          store.getState().run('removeWall', [drag.wallId], { label: 'Discard wall', undoable: false });
        }
        store.getState().endGesture();
        store.getState().setTool('select');
      } else if (drag.kind === 'pan') {
        store.getState().markSaved();
      } else {
        store.getState().endGesture();
      }
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    setDrag(null);
    setGuides([]);
  };

  const onWheel = (e: React.WheelEvent) => {
    const el = hostRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setView((v) => zoomAt(v, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016)));
  };

  // ── derived ───────────────────────────────────────────────────────────────
  const plotW = project.plot.width;
  const plotD = project.plot.depth;
  const sb = project.plot.setbacks;

  const errorIds = useMemo(() => {
    const s = new Set<string>();
    for (const i of issues) if (i.severity === 'error') for (const e of i.elements) s.add(e);
    return s;
  }, [issues]);

  const highlight = useMemo(() => new Set(highlightIds), [highlightIds]);
  const selectedRoom = selection.ids.find((id) => errorIds.has(id) || rooms.some((r) => r.id === id)) ?? null;

  const grid = useMemo(() => {
    if (!gridOn) return null;
    const step = gridStep;
    const out: React.ReactElement[] = [];
    const x0 = Math.floor(-view.offsetX / view.scale / step) * step;
    const y0 = Math.floor(-view.offsetY / view.scale / step) * step;
    const x1 = (size.width - view.offsetX) / view.scale;
    const y1 = (size.height - view.offsetY) / view.scale;
    const majorUnit = step * 5;
    let n = 0;
    for (let x = x0; x <= x1; x += step, n++) {
      const sx = x * view.scale + view.offsetX;
      const major = Math.abs(x / majorUnit - Math.round(x / majorUnit)) < 1e-6;
      out.push(<line key={`gx${n}`} x1={sx} y1={0} x2={sx} y2={size.height} stroke={major ? '#d9d3c7' : '#e8e4dc'} strokeWidth={major ? 1 : 0.5} />);
    }
    n = 0;
    for (let y = y0; y <= y1; y += step, n++) {
      const sy = y * view.scale + view.offsetY;
      const major = Math.abs(y / majorUnit - Math.round(y / majorUnit)) < 1e-6;
      out.push(<line key={`gy${n}`} x1={0} y1={sy} x2={size.width} y2={sy} stroke={major ? '#d9d3c7' : '#e8e4dc'} strokeWidth={major ? 1 : 0.5} />);
    }
    return <g data-testid="plan-grid">{out}</g>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOn, view, size]);

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden" data-testid="plan-canvas" style={{ touchAction: 'none' }}>
      <svg
        width={size.width}
        height={size.height}
        className="block select-none"
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {grid}

        {/* One defs block for the whole drawing. These used to be emitted per
            stair and per room, which put duplicate ids in the DOM and made
            `url(#argon-arrow)` depend on render order. */}
        <defs>
          <marker id="argon-arrow" markerWidth={7} markerHeight={7} refX={3} refY={3.5} orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#6b6357" />
          </marker>
          <pattern id="argon-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={6} stroke={C.setback} strokeWidth={1} />
          </pattern>
        </defs>

        <g data-testid="plot">
          <R x={0} y={0} w={plotW} d={plotD} view={view} fill={C.plot} stroke={C.plotEdge} sw={1.5} />
          <R
            x={sb.left}
            y={sb.front}
            w={Math.max(0, plotW - sb.left - sb.right)}
            d={Math.max(0, plotD - sb.front - sb.rear)}
            view={view}
            fill="none"
            stroke={C.setback}
            sw={1}
            dash="6 5"
          />
          <text
            x={view.offsetX + 2}
            y={view.offsetY - 8}
            fontSize={11}
            fill={C.labelDim}
          >
            plot {plotW.toFixed(1)} × {plotD.toFixed(1)} m · setbacks F{sb.front} R{sb.rear} L{sb.left} R{sb.right}
          </text>
        </g>

        {project.underlays.map((u) => {
          // A calibrated underlay is positioned by its calibration, not by the
          // loose x/y/width the user last dragged it to — otherwise calibrating
          // would change the scale without moving what is on screen.
          const cal = u.calibration;
          const ux = cal?.confirmed ? cal.offX : u.x;
          const uy = cal?.confirmed ? cal.offY : u.y;
          const uw = cal?.confirmed ? u.naturalWidth * cal.scale : u.width;
          const uh = cal?.confirmed ? u.naturalHeight * cal.scale : u.depth;
          return (
            <image
              key={u.id}
              href={u.dataUrl || undefined}
              x={ux * view.scale + view.offsetX}
              y={uy * view.scale + view.offsetY}
              width={uw * view.scale}
              height={uh * view.scale}
              opacity={u.opacity}
              preserveAspectRatio="none"
              data-testid="underlay"
              data-underlay-id={u.id}
              data-calibrated={cal?.confirmed ? 'true' : 'false'}
            />
          );
        })}

        {outdoor.map((o) => (
          <R
            key={o.id}
            x={o.x - o.width / 2}
            y={o.y - o.depth / 2}
            w={o.width}
            d={o.depth}
            view={view}
            fill={KIND_TINT.balcony}
            stroke={C.roomStroke}
            sw={1}
            dash="4 3"
          />
        ))}

        <g data-testid="rooms">
          {rooms.map((r) => (
            <RoomShape
              key={r.id}
              room={r}
              view={view}
              selected={selection.ids.includes(r.id)}
              hasError={errorIds.has(r.id)}
              highlighted={highlight.has(r.id)}
              units={project.displayUnits}
            />
          ))}
        </g>

        <g data-testid="walls">
          {walls.map((w) => (
            <WallShape key={w.id} wall={w} view={view} selected={selection.ids.includes(w.id)} hasError={errorIds.has(w.id)} selectionIds={selection.ids} />
          ))}
        </g>

        {stairs.map((s) => (
          <StairShape key={s.id} stair={s} view={view} selected={selection.ids.includes(s.id)} />
        ))}

        <g data-testid="furniture">
          {furniture.map((f) => (
            <FurnitureShape
              key={f.id}
              item={f}
              view={view}
              selected={selection.ids.includes(f.id)}
              hasError={errorIds.has(f.id)}
              showLabel={view.scale > 34}
            />
          ))}
        </g>

        {/* Opening symbols last. A door swing is a statement about the wall, but
            it is drawn across the room the door opens into — and a kitchen run
            parked against that wall hid the swing completely. Furniture is a
            movable thing; the swing is part of the drawing. */}
        <g data-testid="opening-symbols">
          {walls.map((w) =>
            w.openings.map((o) => (
              <OpeningSymbol key={`${w.id}:${o.id}`} wall={w} opening={o} view={view} hasError={errorIds.has(w.id)} />
            )),
          )}
        </g>

        {/* Overall dimensions, set off the building the way a drawing sets them
            off — never inside it, where they would be read as part of a room. */}
        {contentBounds && (
          <OverallDimensions bounds={contentBounds} view={view} units={project.displayUnits} />
        )}

        {/* Resize handles, drawn last so they sit above furniture. */}
        {selectedRoom && (
          <ResizeHandles room={rooms.find((r) => r.id === selectedRoom)!} view={view} />
        )}

        {guides.map((g, i) =>
          g.axis === 'x' ? (
            <line key={i} x1={g.value * view.scale + view.offsetX} y1={0} x2={g.value * view.scale + view.offsetX} y2={size.height} stroke={C.guide} strokeWidth={1} strokeDasharray="4 3" />
          ) : (
            <line key={i} x1={0} y1={g.value * view.scale + view.offsetY} x2={size.width} y2={g.value * view.scale + view.offsetY} stroke={C.guide} strokeWidth={1} strokeDasharray="4 3" />
          ),
        )}

        {drag?.kind === 'measure' && <MeasureReadout a={drag.a} b={drag.b} view={view} units={project.displayUnits} />}

        <NorthArrow x={size.width - 60} y={44} rotationDeg={-project.plot.orientation} />
        <ScaleBar view={view} units={project.displayUnits} x={16} y={size.height - 18} />
      </svg>

      {menu && (
        <ContextMenu
          target={menu.target}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onFit={fit}
        />
      )}

      <TraceOverlay view={view} size={size} toPlan={toPlan} />

      <div className="pointer-events-none absolute bottom-3 right-3 rounded border border-stone-200 bg-white/90 px-2 py-1 text-[11px] tabular-nums text-stone-500 shadow-sm">
        {Math.round(view.scale)} px/m · grid {gridStep} m · {rooms.length} rooms · {walls.length} walls
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── shapes ──────

function R({
  x,
  y,
  w,
  d,
  view,
  fill,
  stroke,
  sw,
  dash,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  view: ViewTransform;
  fill: string;
  stroke: string;
  sw: number;
  dash?: string;
}) {
  return (
    <rect
      x={x * view.scale + view.offsetX}
      y={y * view.scale + view.offsetY}
      width={w * view.scale}
      height={d * view.scale}
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      strokeDasharray={dash || undefined}
    />
  );
}

function RoomShape({
  room,
  view,
  selected,
  hasError,
  highlighted,
  units,
}: {
  room: Room;
  view: ViewTransform;
  selected: boolean;
  hasError: boolean;
  highlighted: boolean;
  units: 'm' | 'ft';
}) {
  const s = view.scale;
  const px = room.x * s + view.offsetX;
  const py = room.y * s + view.offsetY;
  const pw = room.width * s;
  const ph = room.depth * s;
  const area = room.width * room.depth;
  // A narrow room is labelled along its long axis, upright, the way a drafted
  // plan does it: in a 1.2 m corridor horizontal text either overruns the walls
  // or has to be left out, and a corridor with no name is a corridor nobody can
  // find. Which axis is the long one is the same test as the label's own
  // orientation, so the two cannot disagree.
  const upright = ph > pw * 1.25;
  const big = upright ? ph > 78 : pw > 46 && ph > 30;
  const mid = upright ? ph > 122 : pw > 60 && ph > 58;
  // A drafted plan does not colour its rooms by function — the floor is blank
  // and the walls carry the drawing. The pastel-per-kind fills made every room
  // a different colour, which is the single strongest reason the plan read as a
  // diagram rather than as a floor plan. Outdoors stay distinguishable, by
  // hatching rather than by hue.
  const fill = room.outdoor ? C.outdoor : C.floor;

  return (
    <g data-testid="room" data-room-id={room.id} data-kind={room.kind} style={{ cursor: 'move' }}>
      <rect x={px} y={py} width={pw} height={ph} fill={fill} />
      {room.outdoor && (
        <rect x={px} y={py} width={pw} height={ph} fill="url(#argon-hatch)" stroke="none" />
      )}
      {/* The stroke is a hairline that sits *under* the wall poché, so a room
          with a wall on every side shows wall, not a second outline. */}
      <rect
        x={px}
        y={py}
        width={pw}
        height={ph}
        fill="none"
        stroke={hasError ? C.error : selected ? C.roomStrokeSelected : C.roomStroke}
        strokeWidth={selected || hasError ? 2 : 0.6}
      />
      {highlighted && <rect x={px - 3} y={py - 3} width={pw + 6} height={ph + 6} fill="none" stroke={C.guide} strokeWidth={2} opacity={0.85} />}
      {big && (
        <g transform={upright ? `rotate(-90 ${px + pw / 2} ${py + ph / 2})` : undefined}>
          <text x={px + pw / 2} y={py + ph / 2 - 1} textAnchor="middle" fontSize={12} fontWeight={500} fill={C.label}>
            {room.label}
          </text>
          <text x={px + pw / 2} y={py + ph / 2 + 13} textAnchor="middle" fontSize={10.5} fill={C.labelDim}>
            {units === 'm' ? `${area.toFixed(1)} m²` : `${(area * 10.7639).toFixed(0)} ft²`}
          </text>
          {mid && (
            <text x={px + pw / 2} y={py + ph / 2 + 27} textAnchor="middle" fontSize={10} fill={C.labelDim}>
              {formatLength(room.width, units)} × {formatLength(room.depth, units)}
            </text>
          )}
        </g>
      )}
    </g>
  );
}

/**
 * Half the drawn wall thickness, in metres.
 *
 * The pixel floor exists so a 0.1 m partition is still a visible line when the
 * whole plot is in view. It is a drawing floor only: the model, the hit test
 * and the 3D scene all use `wall.thickness`.
 */
function drawnHalfM(wall: Wall, scale: number): number {
  return Math.max(wall.thickness / 2, 1.6 / scale);
}

function WallShape({ wall, view, selected, hasError, selectionIds }: {
  wall: Wall;
  view: ViewTransform;
  selected: boolean;
  hasError: boolean;
  /** Every selected id, so an opening inside this wall can show as selected. */
  selectionIds: readonly string[];
}) {
  const s = view.scale;
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
  if (len < 1e-6) return null;

  const halfM = drawnHalfM(wall, s);
  // The pier is widened a little past the same floor so the plan keeps its
  // interior when you zoom out. The opening gap keeps the true thickness:
  // widening it would make the doors the wrong size.
  const pierM = Math.max(wall.thickness / 2, (1.6 / s) * 1.6);
  const fill = hasError ? C.error : (WALL_FILL[wall.type] ?? C.wall);
  const ink = hasError ? C.error : C.wallExterior;
  const readable = s > 14;

  return (
    <g data-testid="wall" data-wall-id={wall.id} data-wall-type={wall.type}>
      {wallPiers(wall, pierM).map((pier, i) => (
        <polygon
          key={i}
          points={pier.map(([x, y]) => `${x * s + view.offsetX},${y * s + view.offsetY}`).join(' ')}
          fill={fill}
          /* A hairline edge keeps a dark poché from bleeding into the room fill
             at low zoom, where the polygon and the room underneath are the same
             width. */
          stroke={ink}
          strokeWidth={hasError || selected ? (selected ? 1.6 : 0.6) : 0.35}
          strokeLinejoin="round"
          style={{ cursor: 'move' }}
        />
      ))}
      {/* Hit targets only — the symbols are drawn in their own layer above the
          furniture. These reach a little past the wall face because a 0.23 m
          wall is an 11 px target and openings are small. */}
      {readable &&
        wall.openings.map((o) => (
          <polygon
            key={o.id}
            points={openingQuad(wall, o, s, view, halfM + 0.04)}
            fill="transparent"
            data-testid="opening"
            data-opening-id={o.id}
            data-opening-kind={o.kind}
            style={{ cursor: 'move' }}
          />
        ))}
      {!readable &&
        wall.openings.map((o) => (
          <polygon
            key={o.id}
            points={openingQuad(wall, o, s, view, halfM)}
            fill={o.kind === 'window' ? C.glass : C.opening}
            data-testid="opening"
            data-opening-id={o.id}
            data-opening-kind={o.kind}
            style={{ cursor: 'move' }}
          />
        ))}
      {/* An opening had no selected state of its own: the wall's centre line
          only lights up for the wall, so clicking a door highlighted nothing at
          all and pressing Delete then looked broken. */}
      {wall.openings
        .filter((o) => selectionIds.includes(o.id))
        .map((o) => (
          <polygon
            key={`sel-${o.id}`}
            points={openingQuad(wall, o, s, view, halfM + 0.09)}
            fill={C.guide}
            fillOpacity={0.16}
            stroke={C.guide}
            strokeWidth={1.4}
            pointerEvents="none"
          />
        ))}
      {selected && (
        <line
          x1={wall.a.x * s + view.offsetX}
          y1={wall.a.y * s + view.offsetY}
          x2={wall.b.x * s + view.offsetX}
          y2={wall.b.y * s + view.offsetY}
          stroke={C.roomStrokeSelected}
          strokeWidth={1}
          strokeDasharray="4 4"
          pointerEvents="none"
        />
      )}
    </g>
  );
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  depth: number;
}

/**
 * Overall building dimensions: one chain across the width, one down the depth.
 *
 * This is the dimension you actually want when you are laying a house out on a
 * plot — how big the thing is — and it is the one the drawing was missing. It
 * sits outside the building with witness lines running back to it, because a
 * dimension drawn across a room is read as a room size.
 *
 * Both chains are in metres regardless of the project's display units: an
 * overall building dimension that changes unit with the rest of the interface
 * is worse than one that does not.
 */
function OverallDimensions({ bounds, view, units }: { bounds: Bounds; view: ViewTransform; units: 'm' | 'ft' }) {
  const s = view.scale;
  // Below this the building is too small on screen for a dimension to be read
  // rather than guessed at.
  if (bounds.width * s < 110 || bounds.depth * s < 90) return null;

  // Hold the dimension line about 34 px clear of the building, in plan units so
  // it keeps that distance at every zoom.
  const gap = 34 / s;
  const tick = 5 / s;
  const x0 = bounds.x;
  const x1 = bounds.x + bounds.width;
  const y0 = bounds.y;
  const y1 = bounds.y + bounds.depth;
  const yDim = y1 + gap;
  const xDim = x0 - gap;

  const P = (x: number, y: number): [number, number] => [x * s + view.offsetX, y * s + view.offsetY];
  const line = (a: [number, number], b: [number, number]) => (
    <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={C.measure} strokeWidth={0.8} />
  );
  // The 45° slash a dimension is terminated with, as distinct from an arrowhead
  // — it reads as a dimension rather than as a measurement arrow.
  const tickAt = (p: [number, number], vertical: boolean): JSX.Element => (
    <line
      x1={p[0] - (vertical ? 0 : tick * s) / 2}
      y1={p[1] - (vertical ? tick * s : 0) / 2}
      x2={p[0] + (vertical ? 0 : tick * s) / 2}
      y2={p[1] + (vertical ? tick * s : 0) / 2}
      stroke={C.measure}
      strokeWidth={1.1}
    />
  );

  const [wx0, wy0] = P(x0, y0);
  const [wx1, wy1] = P(x1, y1);
  const [ax0, ay0] = P(x0, yDim);
  const [ax1, ay1] = P(x1, yDim);
  const [bx0, by0] = P(xDim, y0);
  const [bx1, by1] = P(xDim, y1);

  return (
    <g data-testid="overall-dimensions" style={{ pointerEvents: 'none' }}>
      {/* Witness lines, then the dimension line, then the ticks. */}
      {line([wx0, wy1], [ax0, ay0 + 4])}
      {line([wx1, wy1], [ax1, ay1 + 4])}
      {line([ax0, ay0], [ax1, ay1])}
      {tickAt([ax0, ay0], false)}
      {tickAt([ax1, ay1], false)}
      <text x={(ax0 + ax1) / 2} y={ay0 - 5} textAnchor="middle" fontSize={10} fill={C.measure}>
        {formatLength(bounds.width, units)}
      </text>

      {line([wx0, wy0], [bx0 - 4, by0])}
      {line([wx0, wy1], [bx0 - 4, by1])}
      {line([bx0, by0], [bx1, by1])}
      {tickAt([bx0, by0], true)}
      {tickAt([bx1, by1], true)}
      <text
        x={bx0 - 5}
        y={(by0 + by1) / 2}
        textAnchor="middle"
        fontSize={10}
        fill={C.measure}
        transform={`rotate(-90 ${bx0 - 5} ${(by0 + by1) / 2})`}
      >
        {formatLength(bounds.depth, units)}
      </text>
    </g>
  );
}

/** One door swing or window frame, drawn above the furniture. */
function OpeningSymbol({ wall, opening, view, hasError }: { wall: Wall; opening: Opening; view: ViewTransform; hasError: boolean }) {
  const s = view.scale;
  if (s <= 14) return null;
  const props = {
    wall,
    opening,
    toScreen: (p: { x: number; y: number }): [number, number] => [p.x * s + view.offsetX, p.y * s + view.offsetY],
    scale: s,
    halfM: drawnHalfM(wall, s),
    ink: hasError ? C.error : C.wallExterior,
    glass: C.glass,
  };
  return opening.kind === 'window' ? <WindowSymbol {...props} /> : <DoorSymbol {...props} />;
}

/**
 * The opening's rectangle across the wall, as an SVG points string.
 *
 * `halfM` is in metres, like everything else here. It used to be a pixel
 * count, which made every opening's clickable area about thirteen metres wide.
 */
function openingQuad(wall: Wall, o: Opening, s: number, view: ViewTransform, halfM: number): string {
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
  const ux = (wall.b.x - wall.a.x) / len;
  const uy = (wall.b.y - wall.a.y) / len;
  const h = o.width / 2;
  const px = o.offset;
  return [
    [px + h, -halfM],
    [px - h, -halfM],
    [px - h, halfM],
    [px + h, halfM],
  ]
    .map(([along, side]) => {
      const x = wall.a.x + ux * along - uy * side;
      const y = wall.a.y + uy * along + ux * side;
      return `${x * s + view.offsetX},${y * s + view.offsetY}`;
    })
    .join(' ');
}

function StairShape({ stair, view, selected }: { stair: Project['stairs'][number]; view: ViewTransform; selected: boolean }) {
  const s = view.scale;
  const x = (stair.x - stair.width / 2) * s + view.offsetX;
  const y = stair.y * s + view.offsetY;
  const w = stair.width * s;
  const h = stair.run * s;
  const treads = Math.max(2, Math.min(30, stair.riserCount));
  const step = h / treads;
  const lines = [];
  for (let i = 1; i < treads; i++) {
    lines.push(<line key={i} x1={x} y1={y + i * step} x2={x + w} y2={y + i * step} stroke="#8d8577" strokeWidth={0.75} />);
  }
  const up = stair.direction === 1;
  return (
    <g data-testid="stair" data-stair-id={stair.id}>
      <rect x={x} y={y} width={w} height={h} fill="#f2efe8" stroke={selected ? C.roomStrokeSelected : C.roomStroke} strokeWidth={selected ? 2 : 1} />
      {lines}
      <line
        x1={x + w / 2}
        y1={up ? y + h - 10 : y + 10}
        x2={x + w / 2}
        y2={up ? y + 10 : y + h - 10}
        stroke="#6b6357"
        strokeWidth={1.4}
        markerEnd="url(#argon-arrow)"
      />
      {h > 40 && w > 44 && (
        <text x={x + w / 2} y={y + h / 2 + 3} textAnchor="middle" fontSize={10} fill="#6b6357">
          {stair.riserCount} risers
        </text>
      )}
    </g>
  );
}

function FurnitureShape({
  item,
  view,
  selected,
  hasError,
  showLabel,
}: {
  item: FurnitureItem;
  view: ViewTransform;
  selected: boolean;
  hasError: boolean;
  showLabel: boolean;
}) {
  const s = view.scale;
  const cx = item.x * s + view.offsetX;
  const cy = item.y * s + view.offsetY;
  // Draw the UNROTATED box, then rotate the group. Using the rotated
  // footprint's axis-aligned bounding box instead would visibly grow a rotated
  // item to fit its bounding rectangle.
  const w = item.width * s;
  const h = item.depth * s;
  if (w < 2 && h < 2) return null;

  // The symbol is drawn unrotated in its own group and only that group is
  // rotated. Text has to stay outside it: a <text> inside the rotate() turns
  // with the furniture, so a sofa at 90° was labelled upside down.
  const quarterTurn = Math.abs(((item.rotation % 180) + 180) % 180 - 90) < 1;
  const fill = hasError ? '#fecaca' : (item.color ?? C.furniture);
  const ink = hasError ? C.error : selected ? C.roomStrokeSelected : C.furnitureStroke;
  const detail = w > 22 && h > 14;

  return (
    <g data-testid="furniture" data-furniture-id={item.id} data-catalog={item.catalogId}>
      <g transform={`rotate(${item.rotation} ${cx} ${cy})`} style={{ cursor: 'move' }}>
        <g transform={`translate(${cx - w / 2} ${cy - h / 2})`}>
          <FurnitureGlyph
            item={catalogById.get(item.catalogId)}
            w={w}
            h={h}
            fill={fill}
            stroke={selected || hasError ? ink : C.furnitureStroke}
            detail={detail}
          />
        </g>
        {selected && (
          <rect
            x={cx - w / 2}
            y={cy - h / 2}
            width={w}
            height={h}
            fill="none"
            stroke={C.roomStrokeSelected}
            strokeWidth={1.6}
          />
        )}
      </g>
      {showLabel && (quarterTurn ? h > 44 && w > 14 : w > 48 && h > 16) && (
        // Measured against the *rotated* footprint: at 90° or 270° the room for
        // text runs down the item's short axis, which is the only direction it
        // fits. Upright either way.
        <text
          x={cx}
          y={cy + 3.5}
          textAnchor="middle"
          fontSize={9.5}
          fill="#4a443c"
          style={{ pointerEvents: 'none' }}
        >
          {item.label}
        </text>
      )}
    </g>
  );
}

function ResizeHandles({ room, view }: { room: Room; view: ViewTransform }) {
  const s = view.scale;
  const px = room.x * s + view.offsetX;
  const py = room.y * s + view.offsetY;
  const pw = room.width * s;
  const ph = room.depth * s;
  if (pw < 30 || ph < 30) return null;
  const R = 4;
  const pts: Array<[number, number]> = [
    [px, py],
    [px + pw, py],
    [px, py + ph],
    [px + pw, py + ph],
    [px + pw / 2, py],
    [px + pw / 2, py + ph],
    [px, py + ph / 2],
    [px + pw, py + ph / 2],
  ];
  return (
    <g data-testid="resize-handles">
      {pts.map(([x, y], i) => (
        <rect key={i} x={x - R} y={y - R} width={R * 2} height={R * 2} fill="#ffffff" stroke={C.roomStrokeSelected} strokeWidth={1.5} style={{ cursor: handleCursor(i) }} />
      ))}
    </g>
  );
}

const handleCursor = (i: number): string =>
  ['nwse-resize', 'nesw-resize', 'nesw-resize', 'nwse-resize', 'ns-resize', 'ns-resize', 'ew-resize', 'ew-resize'][i] ?? 'default';

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Which resize handle (if any) a plan-space point is over, given the zoom. */
export function handleAt(room: Room, p: { x: number; y: number }, scale: number): ResizeEdge | null {
  const tol = 9 / scale;
  const west = Math.abs(p.x - room.x) <= tol;
  const east = Math.abs(p.x - (room.x + room.width)) <= tol;
  const north = Math.abs(p.y - room.y) <= tol;
  const south = Math.abs(p.y - (room.y + room.depth)) <= tol;
  if (!west && !east && !north && !south) return null;
  const ns = north ? 'n' : south ? 's' : '';
  const ew = west ? 'w' : east ? 'e' : '';
  return `${ns}${ew}` as ResizeEdge;
}

/**
 * Whether a handle hit is on a room *corner* rather than somewhere along one
 * edge. Rooms are laid out with their edges on the wall centrelines, so a
 * plain edge handle is underneath a wall and cannot be told apart from it;
 * a corner is the one place the two gestures are distinguishable.
 */
export function isRoomCorner(room: Room, p: { x: number; y: number }, scale: number): boolean {
  const tol = 9 / scale;
  const onX = Math.abs(p.x - room.x) <= tol || Math.abs(p.x - (room.x + room.width)) <= tol;
  const onY = Math.abs(p.y - room.y) <= tol || Math.abs(p.y - (room.y + room.depth)) <= tol;
  return onX && onY;
}

function MeasureReadout({ a, b, view, units }: { a: { x: number; y: number }; b: { x: number; y: number }; view: ViewTransform; units: 'm' | 'ft' }) {
  const s = view.scale;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return (
    <g data-testid="measure-readout">
      <line x1={a.x * s + view.offsetX} y1={a.y * s + view.offsetY} x2={b.x * s + view.offsetX} y2={b.y * s + view.offsetY} stroke={C.measure} strokeWidth={1.5} strokeDasharray="6 3" />
      <circle cx={a.x * s + view.offsetX} cy={a.y * s + view.offsetY} r={3.5} fill={C.measure} />
      <circle cx={b.x * s + view.offsetX} cy={b.y * s + view.offsetY} r={3.5} fill={C.measure} />
      <rect
        x={(a.x + b.x) / 2 * s + view.offsetX - 34}
        y={(a.y + b.y) / 2 * s + view.offsetY - 24}
        width={68}
        height={18}
        rx={4}
        fill="#ffffff"
        stroke={C.measure}
        strokeWidth={0.75}
      />
      <text
        x={(a.x + b.x) / 2 * s + view.offsetX}
        y={(a.y + b.y) / 2 * s + view.offsetY - 11}
        textAnchor="middle"
        fontSize={11.5}
        fontWeight={600}
        fill={C.measure}
      >
        {formatLength(len, units)}
      </text>
    </g>
  );
}

function NorthArrow({ x, y, rotationDeg }: { x: number; y: number; rotationDeg: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotationDeg})`} opacity={0.65}>
      <circle r={16} fill="none" stroke="#8d8577" strokeWidth={1} />
      <path d="M0,-13 L4.5,4 L0,1.5 L-4.5,4 Z" fill="#3f3a33" />
      <text y={13} textAnchor="middle" fontSize={9} fill="#3f3a33" fontWeight={700}>
        N
      </text>
    </g>
  );
}

function ScaleBar({ view, units, x, y }: { view: ViewTransform; units: 'm' | 'ft'; x: number; y: number }) {
  const raw = 120 / view.scale;
  const nice = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a), 1);
  const w = nice * view.scale;
  return (
    <g transform={`translate(${x} ${y})`} opacity={0.8}>
      <line x1={0} y1={0} x2={w} y2={0} stroke="#3f3a33" strokeWidth={1.5} />
      <line x1={0} y1={-3} x2={0} y2={3} stroke="#3f3a33" strokeWidth={1.5} />
      <line x1={w} y1={-3} x2={w} y2={3} stroke="#3f3a33" strokeWidth={1.5} />
      <text x={w / 2} y={-6} textAnchor="middle" fontSize={10} fill="#3f3a33">
        {formatLength(nice, units, 0)}
      </text>
    </g>
  );
}

// ─────────────────────────────────────────────────────── hit-testing ─────────

/** Topmost room containing the point. Later rooms win, as in the render order. */
export function roomAtPoint(rooms: Room[], x: number, y: number): Room | null {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const r = rooms[i]!;
    if (x >= r.x - TOL.point && x <= r.x + r.width + TOL.point && y >= r.y - TOL.point && y <= r.y + r.depth + TOL.point) return r;
  }
  return null;
}

export function furnitureAtPoint(items: FurnitureItem[], x: number, y: number): FurnitureItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const f = items[i]!;
    // The rotated bounding box is the honest click target: a rotated item is
    // clickable over the space it actually occupies.
    const r = footprintOfItem(f);
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.depth) return f;
  }
  return null;
}

/** Nearest wall within `radius` metres of the centreline. */
export function nearWallAt(project: Project, floorId: string, x: number, y: number, radius = 0.6): Wall | null {
  let best: Wall | null = null;
  let bestD = radius;
  for (const w of project.walls) {
    if (w.floorId !== floorId) continue;
    const d = pointSegmentDistance({ x, y }, w.a, w.b);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

/**
 * The wall a click is *on*, as opposed to the nearest wall to a click.
 *
 * Rooms tile the whole envelope, so every point of an interior partition is
 * also a point inside a room. Testing rooms first therefore meant an interior
 * wall could never be picked at all — not by the mouse, not by the right-click
 * menu, not by the Delete key, because no pointer event ever addressed one.
 * The only way to remove a wall was to rebuild the floor.
 *
 * Walls are drawn as a poche band of exactly `thickness` metres, so the honest
 * test is distance to the *band*, not to the centreline: a point within half a
 * thickness plus a finger-sized margin is visibly on the wall, and one further
 * out is visibly in the room.
 */
export function wallUnderPoint(
  project: Project,
  floorId: string,
  x: number,
  y: number,
  scale: number,
): { wall: Wall; along: number } | null {
  const margin = Math.max(0.12, 5 / scale);
  let best: { wall: Wall; along: number; gap: number } | null = null;
  for (const w of project.walls) {
    if (w.floorId !== floorId) continue;
    const gap = pointSegmentDistance({ x, y }, w.a, w.b) - w.thickness / 2;
    if (gap > margin) continue;
    if (best && gap >= best.gap) continue;
    best = { wall: w, along: projectWallPoint(w, { x, y }).along, gap };
  }
  return best ? { wall: best.wall, along: best.along } : null;
}

/** Project a plan point onto a wall: distance along the centreline, and side. */
export function projectWallPoint(wall: Wall, p: { x: number; y: number }): { along: number; side: number } {
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return { along: 0, side: 0 };
  const t = ((p.x - wall.a.x) * dx + (p.y - wall.a.y) * dy) / (len * len);
  const along = Math.max(0, Math.min(len, t * len));
  const ux = dx / len;
  const uy = dy / len;
  const cx = wall.a.x + ux * along;
  const cy = wall.a.y + uy * along;
  return { along, side: (p.x - cx) * -uy + (p.y - cy) * ux };
}

function pointSegmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
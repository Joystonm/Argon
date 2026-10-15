/**
 * The contextual properties inspector.
 *
 * Shows exactly one thing at a time: the selection. When nothing is selected it
 * shows the current floor and the furniture catalogue, because those are the
 * two things you reach for when you have nothing selected.
 *
 * Every field writes straight through an operation. There is no "apply" button
 * and no local draft — a number you typed is a number in the model, the plan
 * redraws, the 3D rebuilds, and undo reverts it. Coalescing keys keep a drag on
 * a spinner from filling the history with forty entries.
 */
import { useMemo } from 'react';
import { useProject } from '../store/useProject.ts';
import { CATALOG, KIND_LABEL, OPENING_DEFAULTS, DEFAULT_MATERIALS, isFloorMaterial, isWallMaterial } from '../model/catalog.ts';
import { formatArea, formatLength, wallLength } from '../model/geometry.ts';
import { measureRoom } from '../model/measure.ts';
import type { Opening, Room, RoomKind, Wall } from '../model/types.ts';

export function Inspector() {
  const project = useProject((s) => s.project);
  const selection = useProject((s) => s.selection);

  const room = selection.ids.length === 1 ? project.rooms.find((r) => r.id === selection.ids[0]) ?? null : null;
  const wall = selection.ids.length === 1 ? project.walls.find((w) => w.id === selection.ids[0]) ?? null : null;
  const furniture = selection.ids.length === 1 ? project.furniture.find((f) => f.id === selection.ids[0]) ?? null : null;
  const opening = wall?.openings.length === 1 ? wall.openings[0] : null;
  const outdoor = selection.ids.length === 1 ? project.outdoor.find((o) => o.id === selection.ids[0]) ?? null : null;
  const stair = selection.ids.length === 1 ? project.stairs.find((s) => s.id === selection.ids[0]) ?? null : null;

  if (room) return <RoomInspector room={room} />;
  if (wall && !opening) return <WallInspector wall={wall} />;
  if (wall && opening) return <OpeningInspector wall={wall} opening={opening} />;
  if (furniture) return <FurnitureInspector item={furniture} />;
  if (outdoor) return <OutdoorInspector id={outdoor.id} />;
  if (stair) return <StairInspector id={stair.id} />;
  if (selection.ids.length > 1) return <MultiInspector />;
  return <FloorPanel />;
}

/* ────────────────────────────────────────────────────────────── scaffolding ──── */

function Group({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-2.5 last:border-b-0">
      <header className="mb-2 flex h-5 items-center justify-between">
        <h3 className="panel-title">{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="mb-1.5 flex items-center gap-2" title={hint}>
      <span className="w-[86px] shrink-0 text-[11px] text-inkSoft">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

/** A numeric field that writes through on change and coalesces into one undo step. */
function Num({
  value, onChange, step = 0.05, min, max, suffix,
}: {
  value: number; onChange(v: number): void; step?: number; min?: number; max?: number; suffix?: string;
}) {
  return (
    <span className="relative block">
      <input
        type="number"
        className="field pr-7 text-right font-mono"
        value={Number.isFinite(value) ? Number(value.toFixed(3)) : 0}
        step={step}
        min={min}
        max={max}
        data-testid={`num-${suffix ?? ''}`}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {suffix && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-inkFaint">{suffix}</span>}
    </span>
  );
}

const run = (name: never, args: unknown[], key?: string) =>
  useProject.getState().run(name, args, { actor: 'user', coalesceKey: key ?? null });

/* ────────────────────────────────────────────────────────────────── room ─────── */

function RoomInspector({ room }: { room: Room }) {
  const project = useProject((s) => s.project);
  const units = project.displayUnits ?? 'm';
  const measured = useMemo(() => measureRoom(project, room.id), [project, room.id]);
  const neighbours = project.rooms.filter((r) => r.floorId === room.floorId && r.id !== room.id && Math.abs(r.y + r.depth - room.y) < 0.35 && Math.abs(r.x - room.x) < 0.35);

  return (
    <>
      <Group
        title="Room"
        actions={
          <button
            className="btn btn-ghost btn-danger h-6 px-1.5 text-[11px]"
            onClick={() => useProject.getState().run('removeRoom', [room.id], { actor: 'user' })}
          >
            Delete
          </button>
        }
      >
        <Row label="Name">
          <input
            className="field"
            value={room.label}
            data-testid="room-label"
            onChange={(e) => run('setRoomLabel' as never, [room.id, e.target.value], `label:${room.id}`)}
          />
        </Row>
        <Row label="Type">
          <select
            className="field field-select"
            value={room.kind}
            data-testid="room-kind"
            onChange={(e) => run('setRoomLabel' as never, [room.id, room.label, e.target.value as RoomKind])}
          >
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </Row>
      </Group>

      <Group title="Size and position">
        <div className="grid grid-cols-2 gap-x-2">
          <Row label="Width"><Num value={room.width} suffix="w" onChange={(v) => run('resizeRoom' as never, [{ roomId: room.id, width: v }], `rw:${room.id}`)} /></Row>
          <Row label="Depth"><Num value={room.depth} suffix="d" onChange={(v) => run('resizeRoom' as never, [{ roomId: room.id, depth: v }], `rd:${room.id}`)} /></Row>
          <Row label="Left (X)"><Num value={room.x} suffix="x" onChange={(v) => run('moveRoom' as never, [room.id, v, room.y])} /></Row>
          <Row label="Top (Y)"><Num value={room.y} suffix="y" onChange={(v) => run('moveRoom' as never, [room.id, room.x, v])} /></Row>
          <Row label="Ceiling"><Num value={room.height} suffix="h" onChange={(v) => run('resizeRoom' as never, [{ roomId: room.id, height: v }], `rh:${room.id}`)} /></Row>
        </div>
        {measured && (
          <div className="mt-2 flex items-center justify-between rounded bg-paper px-2 py-1.5">
            <span className="text-[11px] text-inkSoft">Area</span>
            <span className="metric" data-testid="room-area">{formatArea(measured.area, units)}</span>
          </div>
        )}
      </Group>

      <Group title="Material">
        <Row label="This room" hint="Applies to the walls bounding this room">
          <select
            className="field field-select"
            value={room.material ?? ''}
            onChange={(e) => run('applyMaterial' as never, [{ kind: 'room', id: room.id }, e.target.value])}
          >
            <option value="">Default</option>
            {Object.entries(DEFAULT_MATERIALS).filter(([, m]) => isWallMaterial(m)).map(([id, m]) => (
              <option key={id} value={id}>{m.label}</option>
            ))}
          </select>
        </Row>
        <Row label="All floors" hint="Every room's floor finish, across the whole building">
          <select
            className="field field-select"
            value=""
            onChange={(e) => e.target.value && run('applyMaterial' as never, [{ kind: 'floor' }, e.target.value])}
          >
            <option value="">Choose a floor finish…</option>
            {Object.entries(DEFAULT_MATERIALS).filter(([, m]) => isFloorMaterial(m)).map(([id, m]) => (
              <option key={id} value={id}>{m.label}</option>
            ))}
          </select>
        </Row>
      </Group>

      {neighbours.length > 0 && (
        <Group title="Shares a wall with">
          <div className="flex flex-wrap gap-1">
            {neighbours.map((n) => (
              <button key={n.id} className="chip" onClick={() => useProject.getState().setSelection({ kinds: ['room'], ids: [n.id] })}>
                {n.label}
              </button>
            ))}
          </div>
        </Group>
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────── wall ─────── */

function WallInspector({ wall }: { wall: Wall }) {
  const len = wallLength(wall);
  const units = useProject((s) => s.project.displayUnits ?? 'm');

  return (
    <>
      <Group
        title="Wall"
        actions={
          <button className="btn btn-ghost btn-danger h-6 px-1.5 text-[11px]" onClick={() => useProject.getState().run('removeWall', [wall.id], { actor: 'user' })}>
            Delete
          </button>
        }
      >
        <Row label="Type">
          <select className="field field-select" value={wall.type} onChange={(e) => run('moveWall' as never, [{ wallId: wall.id, type: e.target.value as never }])}>
            <option value="exterior">Exterior</option>
            <option value="interior">Interior</option>
            <option value="parapet">Parapet</option>
            <option value="railing">Railing</option>
          </select>
        </Row>
        <Row label="Thickness"><Num value={wall.thickness} step={0.01} suffix="t" onChange={(v) => run('moveWall' as never, [{ wallId: wall.id, thickness: v }], `wt:${wall.id}`)} /></Row>
        <Row label="Height"><Num value={wall.height} step={0.05} suffix="h" onChange={(v) => run('moveWall' as never, [{ wallId: wall.id, height: v }], `wh:${wall.id}`)} /></Row>
        <div className="mt-2 flex items-center justify-between rounded bg-paper px-2 py-1.5">
          <span className="text-[11px] text-inkSoft">Length</span>
          <span className="metric">{formatLength(len, units, 2)}</span>
        </div>
      </Group>

      <Group title="Openings">
        {wall.openings.length === 0 ? (
          <p className="hint mb-2">No doors or windows in this wall.</p>
        ) : (
          <ul className="mb-2 space-y-1">
            {wall.openings.map((o) => (
              <li key={o.id}>
                <button
                  className="row w-full text-left"
                  onClick={() => useProject.getState().setSelection({ kinds: ['opening'], ids: [o.id] })}
                >
                  <span className="flex-1 text-[12px] text-ink">{o.kind === 'door' || o.kind === 'doorway' ? 'Door' : 'Window'}</span>
                  <span className="metric text-inkFaint">{formatLength(o.width, units, 2)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-1">
          <button className="btn flex-1 justify-center" onClick={() => run('addOpening' as never, [{ wallId: wall.id, kind: 'door', ...OPENING_DEFAULTS.interiorDoor }])}>
            + Door
          </button>
          <button className="btn flex-1 justify-center" onClick={() => run('addOpening' as never, [{ wallId: wall.id, kind: 'window', ...OPENING_DEFAULTS.window }])}>
            + Window
          </button>
        </div>
      </Group>
    </>
  );
}

function OpeningInspector({ wall, opening }: { wall: Wall; opening: Opening }) {
  const units = useProject((s) => s.project.displayUnits ?? 'm');
  const isDoor = opening.kind === 'door' || opening.kind === 'doorway';
  const edit = (patch: Partial<Opening>, key?: string) =>
    run('moveOpening' as never, [{ wallId: wall.id, openingId: opening.id, ...patch }], key);

  return (
    <Group
      title={isDoor ? 'Door' : 'Window'}
      actions={
        <button className="btn btn-ghost btn-danger h-6 px-1.5 text-[11px]" onClick={() => useProject.getState().run('removeOpening', [wall.id, opening.id], { actor: 'user' })}>
          Delete
        </button>
      }
    >
      <Row label="Width"><Num value={opening.width} step={0.01} suffix="w" onChange={(v) => edit({ width: v }, `ow:${opening.id}`)} /></Row>
      <Row label="Height"><Num value={opening.height} step={0.01} suffix="h" onChange={(v) => edit({ height: v }, `oh:${opening.id}`)} /></Row>
      {isDoor ? (
        <Row label="Swing">
          <div className="flex gap-1">
            {(['positive', 'negative'] as const).map((s) => (
              <button key={s} className="btn flex-1 justify-center" aria-pressed={opening.swing === s} onClick={() => edit({ swing: s })}>
                {s === 'positive' ? 'Left' : 'Right'}
              </button>
            ))}
          </div>
        </Row>
      ) : (
        <Row label="Sill"><Num value={opening.sill} step={0.05} suffix="s" onChange={(v) => edit({ sill: v }, `os:${opening.id}`)} /></Row>
      )}
      <Row label="Position" hint="Distance along the wall from its start">
        <Num value={opening.offset} step={0.05} suffix="→" onChange={(v) => edit({ offset: v }, `oo:${opening.id}`)} />
      </Row>
      <p className="hint mt-1">
        Clear size {formatLength(opening.width, units, 2)} × {formatLength(opening.height, units, 2)} in a wall
        {' '}{formatLength(wall.thickness, units, 2)} thick.
      </p>
    </Group>
  );
}

/* ─────────────────────────────────────────────────────────────── furniture ────── */

function FurnitureInspector({ item }: { item: { id: string; catalogId: string; label: string; x: number; y: number; width: number; depth: number; height: number; rotation: number; color?: string; roomId: string | null } }) {
  const units = useProject((s) => s.project.displayUnits ?? 'm');
  const edit = (patch: Record<string, unknown>, key?: string) => run('moveFurniture' as never, [{ itemId: item.id, ...patch }], key);

  return (
    <Group
      title={item.label}
      actions={
        <button className="btn btn-ghost btn-danger h-6 px-1.5 text-[11px]" onClick={() => useProject.getState().run('removeFurniture', [item.id], { actor: 'user' })}>
          Delete
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-x-2">
        <Row label="Width"><Num value={item.width} step={0.05} suffix="w" onChange={(v) => edit({ width: v }, `fw:${item.id}`)} /></Row>
        <Row label="Depth"><Num value={item.depth} step={0.05} suffix="d" onChange={(v) => edit({ depth: v }, `fd:${item.id}`)} /></Row>
        <Row label="Centre X"><Num value={item.x} step={0.05} suffix="x" onChange={(v) => edit({ x: v })} /></Row>
        <Row label="Centre Y"><Num value={item.y} step={0.05} suffix="y" onChange={(v) => edit({ y: v })} /></Row>
        <Row label="Rotate"><Num value={item.rotation} step={15} suffix="°" onChange={(v) => edit({ rotation: v }, `fr:${item.id}`)} /></Row>
        <Row label="Height" hint="Taken from the catalogue — swap the piece for one of a different size">
          <span className="metric block rounded border border-line bg-paper px-2 py-1 text-right text-inkFaint">{item.height.toFixed(2)} m</span>
        </Row>
      </div>
      <Row label="Colour">
        <span className="flex items-center gap-1.5">
          <input
            type="color"
            className="h-7 w-9 cursor-pointer rounded border border-line bg-surface p-0.5"
            value={item.color ?? '#c9c2b1'}
            onChange={(e) => edit({ color: e.target.value })}
          />
          <span className="metric flex-1 text-inkFaint">{item.color ?? 'default'}</span>
        </span>
      </Row>
      <div className="mt-2 flex items-center justify-between rounded bg-paper px-2 py-1.5">
        <span className="text-[11px] text-inkSoft">Footprint</span>
        <span className="metric">{formatArea(item.width * item.depth, units)}</span>
      </div>
      {!item.roomId && <p className="hint mt-1.5 text-warn">This item is not inside a room.</p>}
    </Group>
  );
}

/* ────────────────────────────────────────────────────── outdoor and stairs ───── */

function OutdoorInspector({ id }: { id: string }) {
  const o = useProject((s) => s.project.outdoor.find((x) => x.id === id));
  const [kind, x, y, w, d, off, rail] = o ? [o.kind, o.x, o.y, o.width, o.depth, o.elevationOffset, o.railingHeight] : [];
  if (!o) return null;
  return (
    <Group title="Outdoor space">
      <Row label="Name"><input className="field" value={o.label} onChange={(e) => run('addOutdoorSpace' as never, [{ ...o, label: e.target.value }])} /></Row>
      <div className="grid grid-cols-2 gap-x-2">
        <Row label="Width"><Num value={w as number} suffix="w" onChange={(v) => run('addOutdoorSpace' as never, [{ ...o, width: v }])} /></Row>
        <Row label="Depth"><Num value={d as number} suffix="d" onChange={(v) => run('addOutdoorSpace' as never, [{ ...o, depth: v }])} /></Row>
        <Row label="Centre X"><Num value={x as number} suffix="x" onChange={(v) => run('addOutdoorSpace' as never, [{ ...o, x: v }])} /></Row>
        <Row label="Centre Y"><Num value={y as number} suffix="y" onChange={(v) => run('addOutdoorSpace' as never, [{ ...o, y: v }])} /></Row>
        <Row label="Level"><Num value={off as number} suffix="↑" onChange={(v) => run('addOutdoorSpace' as never, [{ ...o, elevationOffset: v }])} /></Row>
        <Row label="Guard"><Num value={rail as number} suffix="h" onChange={(v) => run('addOutdoorSpace' as never, [{ ...o, railingHeight: v }])} /></Row>
      </div>
      <p className="hint mt-1">{kind} · served from {o.servesRoomId ? 'an inside room' : 'nothing yet'}</p>
    </Group>
  );
}

function StairInspector({ id }: { id: string }) {
  const s = useProject((s) => s.project.stairs.find((x) => x.id === id));
  if (!s) return null;
  const riser = (s.rise ?? 3) / Math.max(1, s.riserCount);
  const going = s.run / Math.max(1, s.riserCount);
  return (
    <Group title="Staircase">
      <div className="grid grid-cols-2 gap-x-2">
        <Row label="Width"><Num value={s.width} suffix="w" onChange={(v) => run('addStaircase' as never, [{ ...s, width: v }])} /></Row>
        <Row label="Run"><Num value={s.run} step={0.05} suffix="r" onChange={(v) => run('addStaircase' as never, [{ ...s, run: v }])} /></Row>
        <Row label="Steps"><Num value={s.riserCount} step={1} min={2} suffix="n" onChange={(v) => run('addStaircase' as never, [{ ...s, riserCount: Math.round(v) }])} /></Row>
        <Row label="Centre X"><Num value={s.x} suffix="x" onChange={(v) => run('addStaircase' as never, [{ ...s, x: v }])} /></Row>
      </div>
      <div className="mt-1 space-y-1 rounded bg-paper px-2 py-1.5 text-[11px]">
        <div className="flex justify-between"><span className="text-inkSoft">Riser</span><span className="metric">{riser.toFixed(3)} m</span></div>
        <div className="flex justify-between"><span className="text-inkSoft">Going</span><span className="metric">{going.toFixed(3)} m</span></div>
        <div className="flex justify-between"><span className="text-inkSoft">Slope</span><span className="metric">{((Math.atan2(s.rise ?? 3, s.run) * 180) / Math.PI).toFixed(0)}°</span></div>
      </div>
      <p className="hint mt-1">
        {s.connectsToFloorId
          ? `Connects ${useProject.getState().project.floors.find((f) => f.id === s.connectsToFloorId)?.name ?? 'the floor above'}`
          : 'Not connected to the floor above yet.'}
      </p>
    </Group>
  );
}

/* ───────────────────────────────────────────────────────────── nothing / many ── */

function MultiInspector() {
  const selection = useProject((s) => s.selection);
  return (
    <Group title={`${selection.ids.length} objects selected`}>
      <div className="flex flex-wrap gap-1">
        {selection.ids.map((id) => (
          <button key={id} className="chip" onClick={() => useProject.getState().setSelection({ kinds: [], ids: [id] })}>
            {id}
          </button>
        ))}
      </div>
      <button className="btn btn-danger mt-2 w-full justify-center" onClick={() => {
        for (const id of selection.ids) useProject.getState().run('removeRoom' as never, [id], { actor: 'user', undoable: false });
        useProject.getState().clearSelection();
      }}>
        Delete all
      </button>
    </Group>
  );
}

function FloorPanel() {
  const project = useProject((s) => s.project);
  const activeFloorId = useProject((s) => s.activeFloorId);
  const pendingFurnitureId = useProject((s) => s.pendingFurnitureId);
  const setPendingFurniture = useProject((s) => s.setPendingFurniture);
  const setTool = useProject((s) => s.setTool);
  const tool = useProject((s) => s.tool);

  const floor = project.floors.find((f) => f.id === activeFloorId) ?? project.floors[0];
  const rooms = project.rooms.filter((r) => r.floorId === floor?.id);
  const units = project.displayUnits ?? 'm';

  const categories = useMemo(() => {
    const map = new Map<string, typeof CATALOG>();
    for (const item of CATALOG) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return [...map.entries()];
  }, []);

  return (
    <>
      <Group title="This floor">
        <Row label="Name">
          <input
            className="field"
            value={floor?.name ?? ''}
            onChange={(e) => useProject.getState().run('renameFloor', [floor?.id ?? '', e.target.value], { actor: 'user', coalesceKey: `fn:${floor?.id}` })}
          />
        </Row>
        <Row label="Floor height"><Num value={floor?.height ?? 3} step={0.05} suffix="h" onChange={(v) => useProject.getState().run('setFloorHeight', [floor?.id ?? '', v], { actor: 'user', coalesceKey: `fh:${floor?.id}` })} /></Row>
        <div className="mt-1 flex items-center justify-between rounded bg-paper px-2 py-1.5">
          <span className="text-[11px] text-inkSoft">{rooms.length} rooms</span>
          <span className="metric">{formatArea(rooms.reduce((sum, r) => sum + r.width * r.depth, 0), units)}</span>
        </div>
        {rooms.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {rooms.map((r) => (
              <li key={r.id}>
                <button className="row w-full text-left" onClick={() => useProject.getState().setSelection({ kinds: ['room'], ids: [r.id] })}>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{r.label}</span>
                  <span className="metric shrink-0 text-inkFaint">{formatArea(r.width * r.depth, units)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title="Furniture">
        <p className="hint mb-2">
          {pendingFurnitureId
            ? 'Now click inside a room to place it.'
            : 'Pick a piece, then click a room to drop it in.'}
        </p>
        {categories.map(([category, items]) => (
          <details key={category} className="mb-1.5" open={category === 'seating'}>
            <summary className="cursor-pointer list-none text-[11px] font-medium capitalize text-inkSoft hover:text-ink">
              {category}
              <span className="ml-1 font-normal text-inkFaint">{items.length}</span>
            </summary>
            <div className="mt-1 space-y-0.5">
              {items.map((item) => (
                <button
                  key={item.id}
                  className="row w-full text-left"
                  aria-pressed={pendingFurnitureId === item.id}
                  data-testid={`catalog-${item.id}`}
                  onClick={() => {
                    setPendingFurniture(pendingFurnitureId === item.id ? null : item.id);
                    setTool(pendingFurnitureId === item.id ? 'select' : 'furniture');
                  }}
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm border border-line"
                    style={{ background: item.color ?? '#c9c2b1' }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{item.label}</span>
                  <span className="metric shrink-0 text-inkFaint">{item.width}×{item.depth}</span>
                </button>
              ))}
            </div>
          </details>
        ))}
      </Group>

      {tool === 'trace' && (
        <Group title="Tracing">
          <p className="hint">
            Click two points on a wall whose real length you know, type that length, and every detection switches from
            “unknown” to a measured value. Nothing is added to the plan until you accept it.
          </p>
        </Group>
      )}
    </>
  );
}
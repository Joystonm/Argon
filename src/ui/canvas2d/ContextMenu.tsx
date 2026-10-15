/**
 * The canvas right-click menu.
 *
 * Right-clicking a drawing is what people do to a drawing; until this existed
 * the plan ignored the right mouse button entirely and showed the browser's
 * own menu. Every action here runs through the store's `run()` table — the
 * same one the mouse, the keyboard and the assistant use — so nothing offered
 * here can do something the rest of the app cannot.
 *
 * The items are chosen per element kind rather than being one generic list,
 * because "delete" is almost never what you want on a wall. A wall offers
 * doors and windows; a door offers a swing; a piece of furniture offers a
 * rotation.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useProject } from '../../store/useProject.ts';
import { formatLength, wallFrame } from '../../model/geometry.ts';
import { KIND_LABEL } from '../../model/catalog.ts';
import type { ElementKind, Id } from '../../model/types.ts';

export interface MenuTarget {
  kind: ElementKind | 'none';
  id: Id;
  /** For walls: how far along the wall the click landed, in metres. */
  along?: number;
}

interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  run(): void;
}

export function ContextMenu({ target, x, y, onClose, onFit }: {
  target: MenuTarget;
  x: number;
  y: number;
  onClose(): void;
  onFit(): void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on the next click anywhere else, or on Escape. Capture phase, so a
  // click that lands on the canvas underneath still closes the menu first.
  //
  // The handler must stay attached for the whole life of the menu. It is
  // registered once and reads `onClose` through a ref rather than depending on
  // it: Escape is also bound in the app-wide shortcut map, which runs first,
  // and its store update re-renders this component synchronously. If `onClose`
  // were a dependency, that re-render would remove this listener and add a new
  // one *while the keydown event is still being dispatched* — and the browser
  // skips a listener that was removed before its turn came. The menu then
  // stayed open on exactly the key it exists to close on.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) closeRef.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, []);

  const project = useProject((s) => s.project);
  const units = project.displayUnits ?? 'm';

  const { title, detail, items } = useMemo(
    () => build(project, target, units, onClose, onFit),
    [project, target, units, onClose, onFit],
  );

  // Keep the whole menu inside the canvas. A menu that runs off the right
  // edge on a wide-but-short plan is a menu that loses its last item.
  const style = {
    left: Math.max(4, Math.min(x, (hostRef.current?.clientWidth ?? 0) - 236)),
    top: Math.max(4, Math.min(y, (hostRef.current?.clientHeight ?? 0) - (40 + items.length * 30))),
  };

  return (
    <div
      ref={hostRef}
      className="slide-up absolute z-30 w-56 rounded border border-line bg-surface p-1 shadow-pop"
      style={style}
      role="menu"
      data-testid="context-menu"
      aria-label={title}
    >
      <div className="border-b border-line px-2 pb-1.5 pt-1">
        <p className="truncate text-[12px] font-medium text-ink" data-testid="context-menu-title">{title}</p>
        {detail && <p className="truncate text-[11px] text-inkFaint">{detail}</p>}
      </div>
      {items.map((item, i) => (
        <div key={item.id}>
          {item.id.startsWith('-') ? (
            <div className="section-rule" />
          ) : (
            <button
              className={`row w-full text-left ${item.danger ? 'text-danger' : 'text-ink'}`}
              role="menuitem"
              data-testid={`context-${item.id}`}
              onClick={() => {
                item.run();
                onClose();
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium">{item.label}</span>
                {item.hint && <span className="block truncate text-[11px] text-inkFaint">{item.hint}</span>}
              </span>
              {i === 0 && item.id === 'delete' && <kbd className="text-[10px] text-inkFaint">Del</kbd>}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Builds the header and the item list for whatever was right-clicked. */
function build(
  project: ReturnType<typeof useProject.getState>['project'],
  target: MenuTarget,
  units: 'm' | 'ft',
  onClose: () => void,
  onFit: () => void,
): { title: string; detail?: string; items: MenuItem[] } {
  const store = () => useProject.getState();
  const select = () => store().setSelection({ kinds: [target.kind as ElementKind], ids: [target.id] });

  const del = (): MenuItem => ({
    id: 'delete',
    label: 'Delete',
    danger: true,
    run: () => {
      select();
      store().deleteSelection();
    },
  });

  if (target.kind === 'room') {
    const room = project.rooms.find((r) => r.id === target.id);
    if (!room) return { title: 'Nothing here', items: [] };
    return {
      title: room.label,
      detail: `${KIND_LABEL[room.kind]} · ${formatLength(room.width * room.depth, units, 2)}`,
      items: [
        {
          id: 'duplicate',
          label: 'Duplicate room',
          hint: 'Copied 0.5 m away so you can drag it',
          run: () => {
            store().run('createRoom', [{ floorId: room.floorId, kind: room.kind, label: room.label, x: room.x + 0.5, y: room.y + 0.5, width: room.width, depth: room.depth, height: room.height }], { actor: 'user' });
          },
        },
        {
          id: 'replan',
          label: 'Rebuild walls from rooms',
          hint: 'Redraws this floor’s walls around the rooms, keeping the doors and the furniture',
          run: () => {
            const res = store().run('rebuildWalls', [room.floorId], { actor: 'user' });
            if (!res.ok) {
              store().toast('error', res.error);
              return;
            }
            const r = res.data as { openingsKept: number; openingsDropped: number; furnitureKept: number };
            const dropped = r.openingsDropped > 0 ? ` ${r.openingsDropped} opening${r.openingsDropped === 1 ? '' : 's'} had no wall left and were dropped.` : '';
            store().toast(
              r.openingsDropped > 0 ? 'info' : 'success',
              `Rebuilt this floor’s walls. Kept ${r.openingsKept} opening${r.openingsKept === 1 ? '' : 's'} and ${r.furnitureKept} piece${r.furnitureKept === 1 ? '' : 's'} of furniture.${dropped}`,
            );
          },
        },
        { id: '-1', label: '', run: () => {} },
        del(),
      ],
    };
  }

  if (target.kind === 'wall') {
    const wall = project.walls.find((w) => w.id === target.id);
    if (!wall) return { title: 'Nothing here', items: [] };
    const f = wallFrame(wall);
    const at = target.along ?? f.length / 2;
    const add = (kind: 'door' | 'window'): void => {
      const res = store().run('addOpening', [{ wallId: wall.id, kind, offset: at }], { actor: 'user' });
      if (!res.ok) store().toast('error', res.error);
      else {
        const opening = res.data.opening;
        store().setSelection({ kinds: ['opening'], ids: [opening.id] });
      }
    };
    return {
      title: `${wall.type} wall`,
      detail: `${formatLength(f.length, units, 2)} long · ${formatLength(wall.thickness, units, 2)} thick`,
      items: [
        { id: 'door', label: 'Add a door here', hint: `${formatLength(at, units, 2)} along the wall`, run: () => add('door') },
        { id: 'window', label: 'Add a window here', hint: `${formatLength(at, units, 2)} along the wall`, run: () => add('window') },
        { id: '-1', label: '', run: () => {} },
        del(),
      ],
    };
  }

  if (target.kind === 'opening') {
    const host = project.walls.find((w) => w.openings.some((o) => o.id === target.id));
    const opening = host?.openings.find((o) => o.id === target.id);
    if (!host || !opening) return { title: 'Nothing here', items: [] };
    const isDoor = opening.kind !== 'window';
    return {
      title: isDoor ? 'Door' : 'Window',
      detail: `${formatLength(opening.width, units, 2)} × ${formatLength(opening.height, units, 2)}`,
      items: [
        ...(isDoor
          ? [{
              id: 'flip',
              label: 'Flip the swing',
              hint: `Currently opens ${opening.swing === 'positive' ? 'left' : 'right'}`,
              run: () => {
                store().run('moveOpening', [{ wallId: host.id, openingId: opening.id, swing: opening.swing === 'positive' ? 'negative' : 'positive' }], { actor: 'user' });
              },
            }]
          : []),
        {
          id: 'centre',
          label: 'Move to the wall centre',
          run: () => {
            store().run('moveOpening', [{ wallId: host.id, openingId: opening.id, offset: wallFrame(host).length / 2 }], { actor: 'user' });
          },
        },
        { id: '-1', label: '', run: () => {} },
        del(),
      ],
    };
  }

  if (target.kind === 'furniture') {
    const item = project.furniture.find((f) => f.id === target.id);
    if (!item) return { title: 'Nothing here', items: [] };
    return {
      title: item.label,
      detail: `${formatLength(item.width, units, 2)} × ${formatLength(item.depth, units, 2)} · ${item.rotation}°`,
      items: [
        {
          id: 'rotate',
          label: 'Rotate 90°',
          hint: 'Face it the other way',
          run: () => {
            store().run('moveFurniture', [{ id: item.id, x: item.x, y: item.y, width: item.depth, depth: item.width, rotation: (item.rotation + 90) % 360 }], { actor: 'user' });
          },
        },
        {
          id: 'duplicate',
          label: 'Duplicate',
          run: () => {
            store().run('addFurniture', [{ floorId: item.floorId, roomId: item.roomId, catalogId: item.catalogId, x: item.x + 0.3, y: item.y + 0.3 }], { actor: 'user' });
          },
        },
        { id: '-1', label: '', run: () => {} },
        del(),
      ],
    };
  }

  if (target.kind === 'outdoor' || target.kind === 'stair') {
    const label = target.kind === 'outdoor'
      ? project.outdoor.find((o) => o.id === target.id)?.label
      : project.stairs.find((s) => s.id === target.id)?.name;
    return { title: label || (target.kind === 'outdoor' ? 'Outdoor space' : 'Stair'), items: [del()] };
  }

  return {
    title: 'Plan',
    detail: 'Nothing under the cursor',
    items: [
      { id: 'select-all', label: 'Select everything on this floor', run: () => { store().selectAllOnFloor(); onClose(); } },
      { id: 'fit', label: 'Fit the plot', run: onFit },
    ],
  };
}
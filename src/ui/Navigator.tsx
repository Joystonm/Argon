/**
 * The project and floor navigator.
 *
 * Floors are the spine of this app — the plan, the 3D, the measurements and the
 * validator are all scoped to one — so the floor list is the first thing here,
 * not an afterthought. Below it: the plot, the saved project library, and the
 * underlay used for tracing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useProject } from '../store/useProject.ts';
import { listProjects, deleteProject, loadProject, type LibraryEntry } from '../persist/library.ts';
import { formatArea, formatLength } from '../model/geometry.ts';
import type { Floor } from '../model/types.ts';

export function Navigator({ onStartOver }: { onStartOver(): void }) {
  const project = useProject((s) => s.project);
  const activeFloorId = useProject((s) => s.activeFloorId);
  const setActiveFloor = useProject((s) => s.setActiveFloor);
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const underlayInput = useRef<HTMLInputElement | null>(null);

  const refreshLibrary = useCallback(() => {
    void listProjects().then((list) => {
      // The live project is already open; listing it again would offer to
      // "reopen" the thing on screen.
      setEntries(list.filter((e) => e.id !== project.id));
    });
  }, [project.id]);

  useEffect(refreshLibrary, [refreshLibrary]);

  const floors = [...project.floors].sort((a, b) => a.order - b.order);
  const units = project.displayUnits ?? 'm';
  const sb = project.plot.setbacks;

  return (
    <nav className="rail w-[236px] shrink-0 border-r border-line" aria-label="Project navigator">
      {/* ── floors ── */}
      <div className="panel-head">
        <span className="panel-title">Floors</span>
        <button className="btn btn-ghost h-6 px-1.5 text-[11px]" data-testid="add-floor" onClick={() => {
          const res = useProject.getState().run('addFloor', [], { actor: 'user' });
          if (res.ok) setActiveFloor(res.data.id);
        }}>
          + Add
        </button>
      </div>

      <div className="scroll-y max-h-[42%] p-1">
        {floors.map((f, i) => (
          <FloorRow
            key={f.id}
            floor={f}
            index={i}
            total={floors.length}
            active={f.id === activeFloorId}
            roomCount={project.rooms.filter((r) => r.floorId === f.id).length}
            units={units}
            onSelect={() => setActiveFloor(f.id)}
          />
        ))}
      </div>

      {/* ── plot ── */}
      <div className="panel-head border-t border-line">
        <span className="panel-title">Plot</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 px-3 py-2 text-[11px]">
        <Metric label="Size" value={`${formatLength(project.plot.width, units, 2)} × ${formatLength(project.plot.depth, units, 2)}`} />
        <Metric label="Area" value={formatArea(project.plot.width * project.plot.depth, units)} />
        <Metric label="Street edge" value={({ 0: 'Top (north)', 90: 'Right (east)', 180: 'Bottom (south)', 270: 'Left (west)' } as const)[project.plot.orientation]} />
        <Metric
          label="Setbacks"
          value={`${formatLength(sb.front, units, 1)}/${formatLength(sb.rear, units, 1)}/${formatLength(sb.left, units, 1)}/${formatLength(sb.right, units, 1)}`}
          title="Front / rear / left / right"
        />
      </dl>

      <button className="btn mx-2 mb-2 justify-start" onClick={onStartOver} data-testid="change-brief">
        Change the brief
      </button>

      {/* ── underlay ── */}
      <div className="panel-head border-t border-line">
        <span className="panel-title">Blueprint underlay</span>
      </div>
      <div className="p-2">
        {project.underlays.length ? (
          <div className="space-y-1">
            {project.underlays.map((u) => (
              <div key={u.id} className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-ink">{u.name}</p>
                  <p className={u.calibration?.confirmed ? 'text-[11px] text-ok' : 'text-[11px] text-warn'}>
                    {u.calibration?.confirmed ? `Calibrated · ${formatLength(u.calibration.scale * 1000, 'm', 0)} mm/px` : 'Not calibrated — lengths unknown'}
                  </p>
                </div>
                <button
                  className="btn btn-ghost btn-icon h-6 w-6"
                  title="Remove underlay"
                  onClick={() => useProject.getState().run('removeUnderlay', [u.id], { actor: 'user' })}
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden><path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                </button>
              </div>
            ))}
            <button className="btn w-full justify-start" onClick={() => useProject.getState().setTool('trace')}>
              {project.underlays[0]?.calibration?.confirmed ? 'Open tracing' : 'Calibrate and trace'}
            </button>
          </div>
        ) : (
          <>
            <p className="hint mb-1.5">
              Drop in a photo or scan of an existing plan. You give it one real measurement; Argon proposes the walls and you
              confirm each one before it becomes geometry.
            </p>
            <input
              ref={underlayInput}
              type="file"
              accept="image/*"
              className="hidden"
              data-testid="underlay-input"
              onChange={(e) => void importUnderlay(e.target.files?.[0])}
            />
            <button className="btn w-full justify-start" onClick={() => underlayInput.current?.click()} data-testid="add-underlay">
              Upload a plan image
            </button>
          </>
        )}
      </div>

      {/* ── library ── */}
      <div className="panel-head border-t border-line">
        <span className="panel-title">This browser</span>
        <span className="hint">auto-saved</span>
      </div>
      <div className="scroll-y min-h-0 flex-1 p-1">
        {entries === null && <p className="px-2 py-1 hint">Reading…</p>}
        {entries?.length === 0 && <p className="px-2 py-1 hint">Nothing else saved yet.</p>}
        {entries?.map((e) => (
          <div key={e.id} className="row group">
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => void loadProject(e.id).then((p) => {
                if (p) useProject.getState().replace(p, 'Open ' + e.name);
                else useProject.getState().toast('error', 'That project could not be read back.');
              })}
            >
              <span className="block truncate text-[12px] font-medium text-ink">{e.name}</span>
              <span className="block text-[11px] text-inkFaint">
                {e.floorCount} floor{e.floorCount === 1 ? '' : 's'} · {e.roomCount} rooms · {formatDate(e.updatedAt)}
              </span>
            </button>
            <button
              className="btn btn-ghost btn-danger btn-icon h-6 w-6 opacity-0 group-hover:opacity-100"
              title={`Delete ${e.name} from this browser`}
              onClick={() => {
                if (!window.confirm(`Delete “${e.name}”? This cannot be undone.`)) return;
                void deleteProject(e.id).then(refreshLibrary);
              }}
            >
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden><path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </button>
          </div>
        ))}
        <p className="px-2 py-2 text-[11px] leading-snug text-inkFaint">
          Projects are stored in this browser only — nothing is uploaded. Clearing site data erases them, so export JSON if you
          need a backup.
        </p>
      </div>
    </nav>
  );
}

function FloorRow({
  floor, index, total, active, roomCount, units, onSelect,
}: {
  floor: Floor; index: number; total: number; active: boolean; roomCount: number; units: 'm' | 'ft'; onSelect(): void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(floor.name);

  const commit = () => {
    setRenaming(false);
    if (draft.trim() && draft !== floor.name) useProject.getState().run('renameFloor', [floor.id, draft.trim()], { actor: 'user' });
  };

  return (
    <div className="row" aria-selected={active} data-testid="floor-row" data-floor-id={floor.id}>
      <button className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line text-[9px] font-semibold text-inkFaint" onClick={onSelect} title="Show this floor">
        {index}
      </button>
      {renaming ? (
        <input
          autoFocus
          className="field h-6 flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <button className="min-w-0 flex-1 text-left" onClick={onSelect} onDoubleClick={() => { setDraft(floor.name); setRenaming(true); }}>
          <span className="block truncate text-[12px] font-medium text-ink">{floor.name}</span>
          <span className="block text-[11px] text-inkFaint">
            {roomCount} room{roomCount === 1 ? '' : 's'} · {formatLength(floor.height, units, 2)} high
            {floor.elevation > 0.001 && ` · +${formatLength(floor.elevation, units, 2)}`}
          </span>
        </button>
      )}
      {total > 1 && !renaming && (
        <button
          className="btn btn-ghost btn-danger btn-icon h-6 w-6 opacity-0 group-hover:opacity-100"
          title={`Delete ${floor.name}`}
          onClick={() => {
            if (window.confirm(`Delete ${floor.name} and everything on it?`)) useProject.getState().run('removeFloor', [floor.id], { actor: 'user' });
          }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden><path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      )}
    </div>
  );
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <dt className="label text-inkFaint">{label}</dt>
      <dd className="metric">{value}</dd>
    </div>
  );
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Reads the chosen image into a data URL and pins it as an underlay. */
async function importUnderlay(file: File | undefined): Promise<void> {
  if (!file) return;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });

  const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('That file is not an image Argon can open.'));
    img.src = dataUrl;
  });

  const store = useProject.getState();
  const res = store.run(
    'addUnderlay',
    [{
      name: file.name.replace(/\.[^.]+$/, ''),
      dataUrl,
      naturalWidth: dims.width,
      naturalHeight: dims.height,
      // A sensible first guess at 8 m wide so the image is visible; it is
      // explicitly marked unconfirmed until the user calibrates it.
      width: 8,
      depth: (8 * dims.height) / dims.width,
      x: 0,
      y: 0,
      opacity: 0.85,
      rotation: 0,
      calibration: null,
    }],
    { actor: 'user' },
  );

  if (res.ok) {
    store.setTool('trace');
    store.toast('info', 'Now click two points on a wall you know the length of, and type that length.');
  }
}
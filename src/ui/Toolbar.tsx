/**
 * The top toolbar.
 *
 * Compact by design: project name, drawing tools, view modes, then the
 * history/persistence group and export. Anything that needs a number to type
 * into lives in the inspector instead of up here — a toolbar with text fields
 * in it stops being compact the moment you look at it twice.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProject, type EditorTool } from '../store/useProject.ts';
import { canRedo, canUndo, nextRedoLabel, nextUndoLabel } from '../model/history.ts';
import { CATALOG, KIND_LABEL, PALETTE_KINDS, defaultRoomFootprint, type CatalogItem } from '../model/catalog.ts';

export interface ToolbarProps {
  leftOpen: boolean;
  rightOpen: boolean;
  assistantOpen: boolean;
  onToggleLeft(): void;
  onToggleRight(): void;
  onToggleAssistant(): void;
  onExportJson(): void;
  onExportSvg(): void;
  onExportPlanPng(): void;
  onExportScenePng(): void;
  onFit(): void;
  issueCount: number;
}

const TOOLS: Array<{ id: EditorTool; label: string; hint: string; key: string }> = [
  { id: 'select', label: 'Select', hint: 'Click and drag to move, resize from handles', key: 'V' },
  { id: 'room', label: 'Room', hint: 'Click to place a room, drag a handle to resize', key: 'R' },
  { id: 'wall', label: 'Wall', hint: 'Click a start point, then click again to finish', key: 'W' },
  { id: 'door', label: 'Door', hint: 'Click a wall to put a door in it', key: 'D' },
  { id: 'window', label: 'Window', hint: 'Click a wall to put a window in it', key: 'N' },
  { id: 'furniture', label: 'Furniture', hint: 'Pick an item in the inspector, then click a room', key: 'F' },
  { id: 'measure', label: 'Measure', hint: 'Click two points to read a distance', key: 'M' },
  { id: 'trace', label: 'Trace', hint: 'Calibrate an underlay image, then accept detected walls', key: 'T' },
  { id: 'pan', label: 'Pan', hint: 'Drag to pan — or hold Space / middle-drag with any tool', key: 'H' },
];

export function Toolbar(p: ToolbarProps) {
  const project = useProject((s) => s.project);
  const history = useProject((s) => s.history);
  const tool = useProject((s) => s.tool);
  const setTool = useProject((s) => s.setTool);
  const pendingRoomKind = useProject((s) => s.pendingRoomKind);
  const setPendingRoomKind = useProject((s) => s.setPendingRoomKind);
  const undo = useProject((s) => s.undo);
  const redo = useProject((s) => s.redo);
  const dirty = useProject((s) => s.dirty);
  const snap = useProject((s) => s.snapEnabled);
  const grid = useProject((s) => s.gridEnabled);
  const setSnap = useProject((s) => s.setSnap);
  const setGrid = useProject((s) => s.setGrid);
  const viewMode = useProject((s) => s.viewMode);
  const setViewMode = useProject((s) => s.setViewMode);
  const newProject = useProject((s) => s.newProject);
  const selection = useProject((s) => s.selection);
  const deleteSelection = useProject((s) => s.deleteSelection);

  const [menu, setMenu] = useState<null | 'file' | 'export'>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);

  return (
    <div className="relative z-20 shrink-0 border-b border-line bg-surface">
    <header ref={barRef} className="relative flex h-11 items-center gap-1 px-2">
      {/* ── identity + file menu ── */}
      <button className="btn btn-ghost h-8 gap-2 px-2" data-testid="file-menu" onClick={() => setMenu(menu === 'file' ? null : 'file')} aria-expanded={menu === 'file'}>
        <LogoMark />
        <span className="text-[13px] font-semibold tracking-tight text-ink">Argon</span>
        <svg width="8" height="5" viewBox="0 0 8 5" className="text-inkFaint" aria-hidden>
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {menu === 'file' && (
        <div className="slide-up absolute left-2 top-11 z-30 w-60 rounded border border-line bg-surface p-1 shadow-pop">
          <MenuItem label="New project" hint="Starts an empty plot" onClick={() => { newProject(); setMenu(null); }} />
          <MenuItem label="Rename project" hint={project.name} onClick={() => {
            const next = window.prompt('Project name', project.name);
            if (next && next.trim()) useProject.getState().run('renameProject', [next.trim()], { actor: 'user' });
            setMenu(null);
          }} />
          <div className="section-rule" />
          <MenuItem label="Save now" hint="Projects auto-save to this browser" onClick={() => { void useProject.getState().saveNow(); setMenu(null); }} />
          <MenuItem label="Open the brief again" hint="Change plot, floors, budget…" onClick={() => {
            useProject.getState().toast('info', 'Use “Change the brief” in the project navigator to re-open the wizard.');
            setMenu(null);
          }} />
        </div>
      )}

      <span className="mx-1 h-5 w-px bg-line" />

      <input
        className="h-7 w-52 rounded border border-transparent bg-transparent px-2 text-[13px] font-medium text-ink hover:border-line focus:border-line"
        value={project.name}
        aria-label="Project name"
        data-testid="project-name"
        onChange={(e) => useProject.getState().run('renameProject', [e.target.value], { actor: 'user', undoable: false })}
      />

      <span className="mx-1 h-5 w-px bg-line" />

      {/* ── tools ── */}
      <div className="flex items-center gap-0.5" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className="btn btn-ghost h-7 px-2"
            aria-pressed={tool === t.id}
            data-testid={`tool-${t.id}`}
            title={`${t.label} — ${t.hint} (${t.key})`}
            onClick={() => setTool(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <span className="mx-1 h-5 w-px bg-line" />

      {/* ── history ── */}
      <button className="btn btn-ghost btn-icon" onClick={undo} disabled={!canUndo(history)} title={`Undo — ${nextUndoLabel(history) ?? 'nothing to undo'}`} data-testid="undo">
        <UndoIcon />
      </button>
      <button className="btn btn-ghost btn-icon" onClick={redo} disabled={!canRedo(history)} title={`Redo — ${nextRedoLabel(history) ?? 'nothing to redo'}`} data-testid="redo">
        <UndoIcon flip />
      </button>

      <span className="mx-1 h-5 w-px bg-line" />

      <button
        className="btn btn-ghost"
        onClick={() => deleteSelection()}
        disabled={!selection.ids.length}
        title={selection.ids.length ? `Delete ${selection.ids.length} selected item${selection.ids.length === 1 ? '' : 's'} (Delete)` : 'Nothing selected'}
        data-testid="delete-selection"
      >
        Delete
      </button>

      <span className="mx-1 h-5 w-px bg-line" />

      <button className="btn btn-ghost" aria-pressed={snap} onClick={() => setSnap(!snap)} title="Snap to walls, room edges and the grid (S)">
        Snap
      </button>
      <button className="btn btn-ghost" aria-pressed={grid} onClick={() => setGrid(!grid)} title="Show the grid (G)">
        Grid
      </button>

      <div className="flex-1" />

      {/* ── view ── */}
      <div className="mr-1 flex overflow-hidden rounded border border-line">
        {(['plan', 'split', '3d'] as const).map((m) => (
          <button
            key={m}
            className="btn btn-ghost h-7 border-transparent rounded-none border-r border-line last:border-r-0"
            aria-pressed={viewMode === m}
            data-testid={`view-${m}`}
            onClick={() => setViewMode(m)}
          >
            {m === '3d' ? '3D' : m === 'split' ? 'Split' : 'Plan'}
          </button>
        ))}
      </div>

      <button className="btn btn-ghost" onClick={p.onFit} title="Zoom to fit the plot" data-testid="fit">
        Fit
      </button>

      <button className="btn btn-ghost btn-icon" aria-pressed={p.assistantOpen} onClick={p.onToggleAssistant} title="Design assistant" data-testid="toggle-assistant">
        <SparkIcon />
      </button>
      <button className="btn btn-ghost btn-icon" aria-pressed={p.rightOpen} onClick={p.onToggleRight} title="Properties panel">
        <PanelIcon />
      </button>
      <button className="btn btn-ghost btn-icon" aria-pressed={p.leftOpen} onClick={p.onToggleLeft} title="Project navigator">
        <PanelIcon flip />
      </button>

      {/* ── export ── */}
      <button className="btn" onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-expanded={menu === 'export'} data-testid="export-menu">
        Export
        <svg width="8" height="5" viewBox="0 0 8 5" className="text-inkFaint" aria-hidden>
          <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {menu === 'export' && (
        <div className="slide-up absolute right-2 top-11 z-30 w-72 rounded border border-line bg-surface p-1 shadow-pop">
          <MenuItem label="Project JSON" hint="The full model — reopen with File → Open, lossless" onClick={() => { p.onExportJson(); setMenu(null); }} testId="export-json" />
          <MenuItem label="Floor plan (SVG)" hint="Vector, any scale, opens in a browser or Inkscape" onClick={() => { p.onExportSvg(); setMenu(null); }} testId="export-svg" />
          <MenuItem label="Floor plan (PNG)" hint="Raster at 2× for sharing and print" onClick={() => { p.onExportPlanPng(); setMenu(null); }} testId="export-png" />
          <MenuItem label="3D capture (PNG)" hint="Exactly what the 3D view is showing" onClick={() => { void p.onExportScenePng(); setMenu(null); }} testId="export-3d" />
          <div className="section-rule" />
          <p className="px-2 py-1.5 text-[11px] leading-snug text-inkFaint">
            Projects live in this browser only. Export JSON regularly if the site data matters to you.
          </p>
        </div>
      )}

      {dirty && <span className="ml-1 chip" title="Changes are saved automatically, a moment after you stop editing">Saving…</span>}
    </header>

    {/*
      The contextual strip. A tool that needs a choice before it can act on a
      click — which room type, which catalogue item — shows that choice here,
      under the tool that needs it. It only exists while that tool is active,
      so the toolbar is not permanently wider than the tools in it.
    */}
    {tool === 'room' && (
      <div className="flex h-9 items-center gap-1 border-t border-line px-2" data-testid="room-palette" role="group" aria-label="Room type">
        <span className="panel-title mr-1 shrink-0">Room</span>
        {PALETTE_KINDS.map((k) => (
          <button
            key={k}
            className="btn btn-ghost h-6 shrink-0 px-2 text-[12px]"
            aria-pressed={pendingRoomKind === k}
            data-testid={`room-kind-${k}`}
            title={`${KIND_LABEL[k]} — ${defaultRoomFootprint(k).width.toFixed(2)} m × ${defaultRoomFootprint(k).depth.toFixed(2)} m to start from`}
            onClick={() => setPendingRoomKind(k)}
          >
            {PALETTE_LABEL[k]}
          </button>
        ))}
        <span className="hint ml-2 shrink-0">Click in the plan to place it</span>
      </div>
    )}

    {tool === 'furniture' && <FurnitureStrip />}
    </div>
  );
}

/** Short labels for the palette — KIND_LABEL is the inspector's vocabulary. */
const PALETTE_LABEL: Record<string, string> = {
  living: 'Living',
  kitchen: 'Kitchen',
  dining: 'Dining',
  bedroom: 'Bedroom',
  bathroom: 'Bath',
  hall: 'Hall',
  office: 'Study',
  utility: 'Utility',
};

/**
 * The furniture catalogue, grouped by category.
 *
 * This used to live only in the inspector's floor panel, which you could reach
 * only when nothing was selected — so picking furniture meant deselecting
 * whatever you were working on. It is here now, next to the tool that places
 * it. The strip scrolls horizontally rather than wrapping: a wrapping strip
 * would push the canvas down every time the furniture tool was armed.
 */
function FurnitureStrip() {
  const pendingId = useProject((s) => s.pendingFurnitureId);
  const setPendingFurniture = useProject((s) => s.setPendingFurniture);
  const categories = useMemo(() => {
    const byCategory = new Map<string, CatalogItem[]>();
    for (const item of CATALOG) {
      const list = byCategory.get(item.category) ?? [];
      list.push(item);
      byCategory.set(item.category, list);
    }
    return [...byCategory.entries()];
  }, []);

  return (
    <div className="flex h-9 items-center gap-2 overflow-x-auto border-t border-line px-2" data-testid="furniture-palette" role="group" aria-label="Furniture">
      <span className="panel-title shrink-0">Furniture</span>
      {categories.map(([category, items]) => (
        <div key={category} className="flex shrink-0 items-center gap-0.5">
          {items.map((item) => (
            <button
              key={item.id}
              className="btn btn-ghost h-6 shrink-0 px-2 text-[12px]"
              aria-pressed={pendingId === item.id}
              data-testid={`furniture-${item.id}`}
              title={`${item.label} — ${item.width.toFixed(2)} m × ${item.depth.toFixed(2)} m`}
              onClick={() => setPendingFurniture(item.id)}
            >
              {item.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px shrink-0 bg-line" />
        </div>
      ))}
      <span className="hint shrink-0">Pick a piece, then click a room</span>
    </div>
  );
}

function MenuItem({ label, hint, onClick, disabled, testId }: { label: string; hint?: string; onClick(): void; disabled?: boolean; testId?: string }) {
  return (
    <button className="row w-full text-left" onClick={onClick} disabled={disabled} data-testid={testId}>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium text-ink">{label}</span>
        {hint && <span className="block truncate text-[11px] text-inkFaint">{hint}</span>}
      </span>
    </button>
  );
}

function LogoMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <rect x="0.75" y="0.75" width="16.5" height="16.5" rx="3.5" fill="none" stroke="#1c1b19" strokeWidth="1.4" />
      <path d="M4 12.5V8.6l5-3.4 5 3.4v3.9" fill="none" stroke="#b4622d" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function UndoIcon({ flip }: { flip?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M5.5 3.5L2.5 6.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 6.5h6.2a2.8 2.8 0 010 5.6H6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M7 1.5l1.3 3.4 3.4 1.3-3.4 1.3L7 10.9 5.7 7.5 2.3 6.2l3.4-1.3z" fill="currentColor" />
    </svg>
  );
}

function PanelIcon({ flip }: { flip?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <rect x="1.5" y="2" width="11" height="10" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="2" width="3.5" height="10" rx="1" fill="currentColor" opacity="0.35" />
    </svg>
  );
}
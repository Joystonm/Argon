/**
 * The single client-side store.
 *
 * Everything the UI draws and everything the assistant changes flows through
 * `run()`. There is no second copy of the design: no editor-local geometry, no
 * "preview" project that later gets reconciled. A drag, a wizard answer, an
 * import and an assistant operation are all the same call, which is why 2D,
 * 3D, validation and measurements can never disagree with each other.
 *
 * Derived state (measurements, issues, circulation) is memoised against
 * `project.revision`, so a hundred pointer-move events do not re-run the
 * validator a hundred times for the same geometry.
 */
import { create } from 'zustand';
import * as ops from '../model/ops.ts';
import type { OpResult } from '../model/ops.ts';
import {
  canRedo,
  canUndo,
  commit,
  emptyHistory,
  nextRedoLabel,
  nextUndoLabel,
  push,
  redo as redoHistory,
  undo as undoHistory,
  type HistoryState,
} from '../model/history.ts';
import { measureBuilding } from '../model/measure.ts';
import { DEFAULT_RULES, validate, type ConstraintRules } from '../model/validate.ts';
import type { BuildingMeasurements, Id, Issue, Project, RoomKind, Selection } from '../model/types.ts';
import { cloneProject } from '../model/serialize.ts';
import { rebuildWallsFromRooms, replanFloor } from '../model/layout.ts';
import { saveProject } from '../persist/library.ts';

/** A named, undoable operation. Every UI affordance is one of these. */
export type OperationName =
  | 'createRoom' | 'resizeRoom' | 'moveRoom' | 'setRoomLabel' | 'removeRoom'
  | 'createWall' | 'moveWall' | 'resizeWall' | 'removeWall'
  | 'addOpening' | 'moveOpening' | 'removeOpening'
  | 'addStaircase' | 'removeStaircase'
  | 'addOutdoorSpace' | 'removeOutdoorSpace'
  | 'addFurniture' | 'moveFurniture' | 'removeFurniture'
  | 'addFloor' | 'renameFloor' | 'removeFloor' | 'setFloorHeight'
  | 'setPlot' | 'setBrief' | 'renameProject' | 'setDisplayUnits'
  | 'applyMaterial' | 'defineMaterial'
  | 'addUnderlay' | 'updateUnderlay' | 'removeUnderlay'
  | 'replanFloor' | 'rebuildWalls' | 'replaceProject' | 'importProject';

export interface RunOptions {
  label?: string;
  actor?: 'user' | 'assistant' | 'system';
  /** Consecutive runs sharing a key collapse into one undo step (drags). */
  coalesceKey?: string | null;
  /** Set false for transient changes that should not enter history. */
  undoable?: boolean;
  /** Skip the IndexedDB write — used during rapid drags. */
  deferSave?: boolean;
}

export interface RunFailure {
  ok: false;
  error: string;
  code: string;
  hint?: string;
}

export interface RunSuccess<T = any> {
  ok: true;
  data: T;
  createdIds: Id[];
  removedIds: Id[];
}

/** One line in the assistant's activity history / the user-facing action log. */
export interface ActivityEntry {
  id: Id;
  at: number;
  actor: 'user' | 'assistant' | 'system';
  label: string;
  detail?: string;
  ok: boolean;
  error?: string;
  /** Present when the change is waiting on the user. */
  approval?: 'pending' | 'approved' | 'rejected';
  opCount?: number;
}

export type EditorTool =
  | 'select' | 'room' | 'wall' | 'door' | 'window' | 'furniture' | 'measure' | 'pan' | 'trace';

export interface Toast {
  id: Id;
  kind: 'info' | 'success' | 'error';
  message: string;
  at: number;
}

interface ProjectState {
  project: Project;
  history: HistoryState;
  activity: ActivityEntry[];
  toasts: Toast[];
  selection: Selection;
  activeFloorId: Id;
  activeRoomId: Id | null;
  tool: EditorTool;
  /** Catalog id queued for the next furniture click. */
  pendingFurnitureId: string | null;
  /**
   * Room type queued for the next `room`-tool click. Unlike
   * `pendingFurnitureId` this survives a tool switch: it is the user's current
   * preference for what they are drawing, not a one-shot action.
   */
  pendingRoomKind: RoomKind;
  snapEnabled: boolean;
  gridEnabled: boolean;
  ruleOverrides: Partial<ConstraintRules>;
  dirty: boolean;
  /** Set by the AI while it is mid-turn, so the UI can show progress. */
  aiBusy: boolean;
  viewMode: 'plan' | '3d' | 'split';

  // ── actions ──────────────────────────────────────────────────────────────
  run<T = any>(name: OperationName, args: unknown[], opts?: RunOptions): RunSuccess<T> | RunFailure;
  runRaw(fn: (p: Project) => OpResult, label: string, opts?: RunOptions): { ok: true; data: unknown } | RunFailure;
  replace(project: Project, label: string, opts?: RunOptions): void;
  beginGesture(key: string): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  setSelection(sel: Partial<Selection>): void;
  toggleSelected(kind: Selection['kinds'][number], id: Id): void;
  selectAllOnFloor(): void;
  /**
   * Delete whatever is selected.
   *
   * One implementation, three callers: the Delete key, the toolbar button and
   * the canvas context menu. When it was only reachable from the keyboard,
   * "I cannot delete anything" was true of the interface even though the key
   * worked fine.
   */
  deleteSelection(): void;
  clearSelection(): void;
  setActiveFloor(id: Id): void;
  setActiveRoom(id: Id | null): void;
  setTool(t: EditorTool): void;
  setPendingFurniture(id: string | null): void;
  setPendingRoomKind(kind: RoomKind): void;
  setSnap(on: boolean): void;
  setGrid(on: boolean): void;
  setRules(r: Partial<ConstraintRules>): void;
  setViewMode(m: 'plan' | '3d' | 'split'): void;
  setAiBusy(b: boolean): void;
  log(entry: Omit<ActivityEntry, 'id' | 'at'> & { id?: Id; at?: number }): void;
  approve(id: Id): void;
  reject(id: Id): void;
  toast(kind: Toast['kind'], message: string): void;
  dismissToast(id: Id): void;
  markSaved(): void;
  /** Write the project to storage immediately, dirty or not. */
  saveNow(): Promise<void>;
  newProject(name?: string): void;
}

const DEFAULT_SELECTION: Selection = { kinds: [], ids: [] };

/** Human labels for the undo list. */
const OP_LABELS: Record<string, string> = {
  createRoom: 'Add room',
  resizeRoom: 'Resize room',
  moveRoom: 'Move room',
  setRoomLabel: 'Rename room',
  removeRoom: 'Delete room',
  createWall: 'Add wall',
  moveWall: 'Move wall',
  resizeWall: 'Resize wall',
  removeWall: 'Delete wall',
  addOpening: 'Add opening',
  moveOpening: 'Move opening',
  removeOpening: 'Delete opening',
  addStaircase: 'Add staircase',
  removeStaircase: 'Delete staircase',
  addOutdoorSpace: 'Add outdoor space',
  removeOutdoorSpace: 'Delete outdoor space',
  addFurniture: 'Add furniture',
  moveFurniture: 'Move furniture',
  removeFurniture: 'Delete furniture',
  addFloor: 'Add floor',
  renameFloor: 'Rename floor',
  removeFloor: 'Delete floor',
  setFloorHeight: 'Set floor height',
  setPlot: 'Change plot',
  setBrief: 'Update brief',
  renameProject: 'Rename project',
  setDisplayUnits: 'Change units',
  applyMaterial: 'Apply material',
  defineMaterial: 'Define material',
  addUnderlay: 'Add underlay',
  updateUnderlay: 'Move underlay',
  removeUnderlay: 'Remove underlay',
  replanFloor: 'Re-plan floor',
  rebuildWalls: 'Rebuild walls from rooms',
  replaceProject: 'Replace project',
  importProject: 'Import project',
};

/**
 * The operation table.
 *
 * Both the editor and the assistant's tool registry resolve to exactly this
 * map, which is the mechanism behind "the model must never be trusted to
 * provide arbitrary code": the assistant chooses a *name* and supplies
 * arguments that are checked here, against the current project.
 */
type OpFn = (project: Project, ...args: never[]) => OpResult<never>;

const TABLE: Record<OperationName, OpFn> = {
  createRoom: ops.createRoom as unknown as OpFn,
  resizeRoom: ops.resizeRoom as unknown as OpFn,
  moveRoom: ops.moveRoom as unknown as OpFn,
  setRoomLabel: ops.setRoomLabel as unknown as OpFn,
  removeRoom: ops.removeRoom as unknown as OpFn,
  createWall: ops.createWall as unknown as OpFn,
  moveWall: ops.moveWall as unknown as OpFn,
  resizeWall: ops.resizeWall as unknown as OpFn,
  removeWall: ops.removeWall as unknown as OpFn,
  addOpening: ops.addOpening as unknown as OpFn,
  moveOpening: ops.moveOpening as unknown as OpFn,
  removeOpening: ops.removeOpening as unknown as OpFn,
  addStaircase: ops.addStaircase as unknown as OpFn,
  removeStaircase: ops.removeStaircase as unknown as OpFn,
  addOutdoorSpace: ops.addOutdoorSpace as unknown as OpFn,
  removeOutdoorSpace: ops.removeOutdoorSpace as unknown as OpFn,
  addFurniture: ops.addFurniture as unknown as OpFn,
  moveFurniture: ops.moveFurniture as unknown as OpFn,
  removeFurniture: ops.removeFurniture as unknown as OpFn,
  addFloor: ops.addFloor as unknown as OpFn,
  renameFloor: ops.renameFloor as unknown as OpFn,
  removeFloor: ops.removeFloor as unknown as OpFn,
  setFloorHeight: ops.setFloorHeight as unknown as OpFn,
  setPlot: ops.setPlot as unknown as OpFn,
  setBrief: ops.setBrief as unknown as OpFn,
  renameProject: ops.renameProject as unknown as OpFn,
  setDisplayUnits: ops.setDisplayUnits as unknown as OpFn,
  applyMaterial: ops.applyMaterial as unknown as OpFn,
  defineMaterial: ops.defineMaterial as unknown as OpFn,
  addUnderlay: ops.addUnderlay as unknown as OpFn,
  updateUnderlay: ops.updateUnderlay as unknown as OpFn,
  removeUnderlay: ops.removeUnderlay as unknown as OpFn,
  // `replanFloor` lives with the generator rather than in ops, but it is an
  // operation like any other: whole-project, undoable, reindexed.
  replanFloor: ((_p: Project, floorId: Id) => ({
    ok: true as const,
    project: replanFloor(_p, floorId),
    data: null,
    createdIds: [],
    removedIds: [],
  })) as unknown as OpFn,
  // Same shape, different promise: this one keeps the furniture and the doors.
  rebuildWalls: ((_p: Project, floorId: Id) => {
    const { project, report } = rebuildWallsFromRooms(_p, floorId);
    return { ok: true as const, project, data: report, createdIds: [], removedIds: [] };
  }) as unknown as OpFn,
  replaceProject: ((_p: Project, next: Project | null) =>
    next
      ? { ok: true as const, project: next, data: next, createdIds: [], removedIds: [] }
      : { ok: false as const, code: 'invalid_input' as const, error: 'No project supplied.' }) as unknown as OpFn,
  importProject: ((_p: Project, next: Project | null) =>
    next
      ? { ok: true as const, project: next, data: next, createdIds: [], removedIds: [] }
      : { ok: false as const, code: 'invalid_input' as const, error: 'Import produced no project.' }) as unknown as OpFn,
};

export const operationNames = Object.keys(TABLE) as OperationName[];

const MAX_ACTIVITY = 120;

let activityCounter = 0;
const activityId = (): Id => `ac_${(activityCounter++).toString(36)}`;

export const useProject = create<ProjectState>((set, get) => ({
  project: ops.blankProject('Untitled home'),
  history: emptyHistory(),
  activity: [],
  toasts: [],
  selection: DEFAULT_SELECTION,
  activeFloorId: '',
  activeRoomId: null,
  tool: 'select',
  pendingFurnitureId: null,
  pendingRoomKind: 'living',
  snapEnabled: true,
  gridEnabled: true,
  ruleOverrides: {},
  dirty: false,
  aiBusy: false,
  viewMode: 'plan',

  run(name, args, opts = {}) {
    const fn = TABLE[name];
    if (!fn) {
      const failure: RunFailure = {
        ok: false,
        code: 'invalid_input',
        error: `Unknown operation "${name}".`,
      };
      get().log({ actor: opts.actor ?? 'user', label: `Unknown operation ${name}`, ok: false, error: failure.error });
      return failure;
    }

    const before = get().project;
    const result = (fn as (p: Project, ...a: unknown[]) => OpResult)(before, ...args);

    if (!result.ok) {
      const failure: RunFailure = { ok: false, code: result.code, error: result.error, hint: result.hint };
      get().log({
        actor: opts.actor ?? 'user',
        label: opts.label ?? OP_LABELS[name] ?? name,
        ok: false,
        error: result.error,
      });
      get().toast('error', result.error);
      return failure;
    }

    const label = opts.label ?? OP_LABELS[name] ?? name;
    const undoable = opts.undoable !== false;
    let history = get().history;
    if (undoable) {
      history = push(history, before, result.project, {
        label,
        actor: opts.actor ?? 'user',
        createdIds: result.createdIds,
        removedIds: result.removedIds,
        coalesceKey: opts.coalesceKey ?? null,
      });
    } else {
      history = commit(history);
    }

    set({
      project: result.project,
      history,
      dirty: true,
      activeFloorId: exists(result.project, get().activeFloorId)
        ? get().activeFloorId
        : (result.project.floors[0]?.id ?? ''),
    });

    get().log({
      actor: opts.actor ?? 'user',
      label,
      ok: true,
      createdIds: result.createdIds,
      removedIds: result.removedIds,
      opCount: 1,
    } as never as Omit<ActivityEntry, 'id' | 'at'>);

    if (!opts.deferSave) void persist(set, get);
    return { ok: true, data: result.data as any, createdIds: result.createdIds, removedIds: result.removedIds };
  },

  runRaw(fn, label, opts = {}) {
    const before = get().project;
    const result = fn(before);
    if (!result.ok) {
      get().log({ actor: opts.actor ?? 'user', label, ok: false, error: result.error });
      get().toast('error', result.error);
      return { ok: false as const, code: result.code, error: result.error, hint: result.hint };
    }
    let history = get().history;
    if (opts.undoable !== false) {
      history = push(history, before, result.project, {
        label,
        actor: opts.actor ?? 'user',
        createdIds: result.createdIds,
        removedIds: result.removedIds,
        coalesceKey: opts.coalesceKey ?? null,
      });
    }
    set({ project: result.project, history, dirty: true });
    get().log({ actor: opts.actor ?? 'user', label, ok: true, opCount: 1 } as never);
    if (!opts.deferSave) void persist(set, get);
    return { ok: true as const, data: result.data };
  },

  replace(project, label, opts = {}) {
    const before = get().project;
    const history =
      opts.undoable === false
        ? get().history
        : push(get().history, before, project, { label, actor: opts.actor ?? 'system' });
    set({
      project,
      history,
      activeFloorId: project.floors[0]?.id ?? '',
      selection: DEFAULT_SELECTION,
      activeRoomId: null,
      dirty: true,
    });
    get().log({ actor: opts.actor ?? 'system', label, ok: true });
    void persist(set, get);
  },

  beginGesture(key) {
    // A new gesture always starts a fresh coalescing window even if the
    // previous one was never explicitly closed.
    set({ history: { ...get().history, coalesceKey: key } });
  },

  endGesture() {
    set({ history: commit(get().history) });
    void persist(set, get);
  },

  undo() {
    const { history } = get();
    if (!canUndo(history)) return;
    const res = undoHistory<Project>(history);
    if (!res.snapshot) return;
    set({
      project: res.snapshot,
      history: res.history,
      dirty: true,
      activeFloorId: exists(res.snapshot, get().activeFloorId)
        ? get().activeFloorId
        : (res.snapshot.floors[0]?.id ?? ''),
    });
    get().log({ actor: 'user', label: `Undo ${res.entry?.label ?? 'change'}`, ok: true });
    void persist(set, get);
  },

  redo() {
    const { history } = get();
    if (!canRedo(history)) return;
    const res = redoHistory<Project>(history);
    if (!res.snapshot) return;
    set({ project: res.snapshot, history: res.history, dirty: true });
    get().log({ actor: 'user', label: `Redo ${res.entry?.label ?? 'change'}`, ok: true });
    void persist(set, get);
  },

  setSelection(sel) {
    const current = get().selection;
    const next = { kinds: sel.kinds ?? current.kinds, ids: sel.ids ?? current.ids };
    const roomId = next.kinds.includes('room') ? (next.ids[0] ?? null) : get().activeRoomId;
    set({ selection: next, activeRoomId: roomId });
  },

  toggleSelected(kind, id) {
    const cur = get().selection;
    const has = cur.kinds.includes(kind) && cur.ids.includes(id);
    if (has) {
      set({
        selection: { kinds: cur.kinds, ids: cur.ids.filter((x) => x !== id) },
      });
    } else {
      set({
        selection: { kinds: [...new Set([...cur.kinds, kind])], ids: [...new Set([...cur.ids, id])] },
        activeRoomId: kind === 'room' ? id : get().activeRoomId,
      });
    }
  },

  selectAllOnFloor() {
    const { project, activeFloorId } = get();
    const floor = project.floors.find((f) => f.id === activeFloorId);
    if (!floor) return;
    set({ selection: { kinds: ['room', 'wall', 'furniture'], ids: [...floor.roomIds, ...floor.wallIds] } });
  },

  clearSelection() {
    set({ selection: DEFAULT_SELECTION });
  },

  deleteSelection() {
    const s = get();
    const ids = [...s.selection.ids];
    if (!ids.length) return;
    for (const id of ids) {
      // Openings are not a top-level collection — they live inside a wall — so
      // they need their wall id as a second argument and must be found by
      // searching the walls. The keyboard Delete never did this, which is why
      // selecting a door and pressing Delete did nothing at all.
      const host = s.project.walls.find((w) => w.openings.some((o) => o.id === id));
      const kind: OperationName | null = s.project.rooms.some((r) => r.id === id) ? 'removeRoom'
        : s.project.walls.some((w) => w.id === id) ? 'removeWall'
        : s.project.furniture.some((f) => f.id === id) ? 'removeFurniture'
        : s.project.outdoor.some((o) => o.id === id) ? 'removeOutdoorSpace'
        : s.project.stairs.some((x) => x.id === id) ? 'removeStaircase'
        : host ? 'removeOpening'
        : null;
      if (!kind) continue;
      s.run(kind, host ? [host.id, id] : [id], { actor: 'user' });
    }
    s.clearSelection();
  },

  setActiveFloor(id) {
    if (!exists(get().project, id)) return;
    set({ activeFloorId: id, selection: DEFAULT_SELECTION, activeRoomId: null });
  },

  setActiveRoom(id) {
    set({ activeRoomId: id });
  },

  setTool(t) {
    set({ tool: t, pendingFurnitureId: t === 'furniture' ? get().pendingFurnitureId : null });
  },

  setPendingFurniture(id) {
    set({ pendingFurnitureId: id, tool: 'furniture' });
  },

  setPendingRoomKind(kind) {
    // Picking the kind that is already armed puts the room tool away again.
    // The tool staying armed after a placement is deliberate — dropping a run
    // of rooms is the normal way to lay out a floor — but without a way to
    // stand it down from the mouse, every later click on the plan is another
    // room rather than the selection you were reaching for.
    const armed = get().tool === 'room' && get().pendingRoomKind === kind;
    set({ pendingRoomKind: kind, tool: armed ? 'select' : 'room' });
  },

  setSnap(on) {
    set({ snapEnabled: on });
  },
  setGrid(on) {
    set({ gridEnabled: on });
  },
  setRules(r) {
    set({ ruleOverrides: { ...get().ruleOverrides, ...r } });
  },
  setViewMode(m) {
    set({ viewMode: m });
  },
  setAiBusy(b) {
    set({ aiBusy: b });
  },

  log(entry) {
    const e: ActivityEntry = { id: entry.id ?? activityId(), at: entry.at ?? Date.now(), ...entry } as ActivityEntry;
    set({ activity: [e, ...get().activity].slice(0, MAX_ACTIVITY) });
  },

  approve(id) {
    set({ activity: get().activity.map((a) => (a.id === id ? { ...a, approval: 'approved' } : a)) });
  },

  reject(id) {
    set({ activity: get().activity.map((a) => (a.id === id ? { ...a, approval: 'rejected' } : a)) });
  },

  toast(kind, message) {
    const t: Toast = { id: activityId(), kind, message, at: Date.now() };
    set({ toasts: [...get().toasts, t].slice(-4) });
    if (kind !== 'error') {
      setTimeout(() => get().dismissToast(t.id), 3600);
    } else {
      setTimeout(() => get().dismissToast(t.id), 7000);
    }
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  markSaved() {
    set({ dirty: false });
  },

  async saveNow() {
    await saveNow(set, get);
  },

  newProject(name) {
    // `blankProject`, not `emptyProject`: a project with no floors cannot have a
    // room put in it, so File → New project left you unable to draw anything at
    // all until you noticed "Add floor" in the sidebar.
    const p = ops.blankProject(name ?? 'Untitled home');
    set({
      project: p,
      history: emptyHistory(),
      activity: [],
      selection: DEFAULT_SELECTION,
      activeFloorId: p.floors[0]?.id ?? '',
      activeRoomId: null,
      dirty: true,
      viewMode: 'plan',
    });
    get().log({ actor: 'user', label: `New project${name ? ` "${name}"` : ''}`, ok: true });
    void persist(set, get);
  },
}));

function exists(project: Project, floorId: Id): boolean {
  return project.floors.some((f) => f.id === floorId);
}

/** Write-through persistence. Never on the critical path of a drag. */
async function persist(
  set: (partial: Partial<ProjectState>) => void,
  get: () => ProjectState,
): Promise<void> {
  const { dirty } = get();
  if (!dirty) return;
  await saveNow(set, get);
}

/**
 * Write the project to storage, whatever the dirty flag says.
 *
 * `persist` is the automatic path and correctly skips a redundant write. This
 * is the explicit one behind "Save now" and Ctrl+S: a user asking for a save
 * should get a save. Gating that button on `dirty` made it unusable rather
 * than tidy, because write-through persistence clears `dirty` within a few
 * hundred milliseconds of every edit — so the button was greyed out almost
 * always, and the one thing it was there for could not be demonstrated.
 */
async function saveNow(
  set: (partial: Partial<ProjectState>) => void,
  get: () => ProjectState,
): Promise<void> {
  try {
    await saveProject(get().project);
    set({ dirty: false });
  } catch (e) {
    get().toast('error', `Could not save locally: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─────────────────────────────────────────────────────── derived selectors ────

export const selectMeasurements = (s: ProjectState): BuildingMeasurements =>
  measureBuilding(s.project);

export const selectIssues = (s: ProjectState): Issue[] =>
  validate(s.project, { ...DEFAULT_RULES, ...s.ruleOverrides });

export const selectActiveFloor = (s: ProjectState) =>
  s.project.floors.find((f) => f.id === s.activeFloorId) ?? s.project.floors[0] ?? null;

export const selectUndoLabel = (s: ProjectState): string | null => nextUndoLabel(s.history);
export const selectRedoLabel = (s: ProjectState): string | null => nextRedoLabel(s.history);
export const selectCanUndo = (s: ProjectState): boolean => canUndo(s.history);
export const selectCanRedo = (s: ProjectState): boolean => canRedo(s.history);

/** Clone helper used by duplicate/variant, so the copy has a fresh identity. */
export const duplicateProject = (p: Project, name: string): Project => {
  const copy = cloneProject(p);
  return {
    ...copy,
    id: `pj_${Math.random().toString(36).slice(2, 10)}`,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,
  };
};
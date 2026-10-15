/**
 * Undo / redo.
 *
 * History stores whole `Project` snapshots rather than inverse operations.
 * That is the right trade for a model this size: a snapshot of a residential
 * project is tens of kilobytes, and it makes redo exact rather than
 * best-effort-replay.
 *
 * Coalescing: a drag that emits `resize_room` on every pointer move must not
 * create 200 history entries, so consecutive entries with the same coalesce key
 * replace each other until `COMMIT` is called.
 */

export interface HistoryEntry {
  label: string;
  actor: 'user' | 'assistant' | 'system';
  /** Snapshot BEFORE this change, for undo. */
  before: unknown;
  /** Snapshot AFTER this change, for redo. */
  after: unknown;
  at: number;
  createdIds: string[];
  removedIds: string[];
  /** Entries sharing a coalesce key collapse together until committed. */
  coalesceKey: string | null;
}

export interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Set while a gesture (drag, numeric scrub) is in flight. */
  coalesceKey: string | null;
}

export const MAX_HISTORY = 100;

export const emptyHistory = (): HistoryState => ({ past: [], future: [], coalesceKey: null });

/** Called when a discrete action completes; freezes any coalescing. */
export function commit(state: HistoryState): HistoryState {
  return state.coalesceKey === null ? state : { ...state, coalesceKey: null };
}

export interface PushOptions {
  label: string;
  actor?: HistoryEntry['actor'];
  createdIds?: string[];
  removedIds?: string[];
  coalesceKey?: string | null;
}

export function push(state: HistoryState, before: unknown, after: unknown, opts: PushOptions): HistoryState {
  const entry: HistoryEntry = {
    label: opts.label,
    actor: opts.actor ?? 'user',
    before,
    after,
    at: Date.now(),
    createdIds: opts.createdIds ?? [],
    removedIds: opts.removedIds ?? [],
    coalesceKey: opts.coalesceKey ?? null,
  };

  const past = [...state.past];
  const top = past[past.length - 1];
  // Coalesce only while a gesture is *open* with this key. Comparing the key to
  // the previous entry's alone is not enough: two separate drags of the same
  // room share a key, and without the `state.coalesceKey` check the second
  // drag would swallow the first and one undo would revert both.
  const gestureOpen = entry.coalesceKey !== null && state.coalesceKey === entry.coalesceKey;
  if (gestureOpen && top && entry.coalesceKey && top.coalesceKey === entry.coalesceKey) {
    // Keep the original `before`, take the newest `after`.
    past[past.length - 1] = { ...entry, before: top.before };
  } else {
    past.push(entry);
  }

  return {
    past: past.slice(-MAX_HISTORY),
    future: [], // any new edit invalidates the redo stack
    coalesceKey: opts.coalesceKey ?? null,
  };
}

export function canUndo(state: HistoryState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.future.length > 0;
}

export function undo<T>(state: HistoryState): { history: HistoryState; snapshot: T | null; entry: HistoryEntry | null } {
  const entry = state.past[state.past.length - 1] ?? null;
  if (!entry) return { history: state, snapshot: null, entry: null };
  return {
    history: {
      past: state.past.slice(0, -1),
      future: [...state.future, entry],
      coalesceKey: null,
    },
    snapshot: entry.before as T,
    entry,
  };
}

export function redo<T>(state: HistoryState): { history: HistoryState; snapshot: T | null; entry: HistoryEntry | null } {
  const entry = state.future[state.future.length - 1] ?? null;
  if (!entry) return { history: state, snapshot: null, entry: null };
  return {
    history: {
      past: [...state.past, entry],
      future: state.future.slice(0, -1),
      coalesceKey: null,
    },
    snapshot: entry.after as T,
    entry,
  };
}

/** Human-readable label for the undo/redo buttons. */
export const nextUndoLabel = (s: HistoryState): string | null => s.past[s.past.length - 1]?.label ?? null;
export const nextRedoLabel = (s: HistoryState): string | null => s.future[s.future.length - 1]?.label ?? null;
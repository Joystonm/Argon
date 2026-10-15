/**
 * Undo / redo.
 *
 * History stores whole-project snapshots. That choice only pays off if redo is
 * exact rather than best-effort, so these tests are mostly about the awkward
 * cases: an entry recorded with no net change, a coalesced drag, an undo that
 * crosses a commit boundary, and a stack that hits its ceiling.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY,
  canRedo,
  canUndo,
  commit,
  emptyHistory,
  nextRedoLabel,
  nextUndoLabel,
  push,
  redo,
  undo,
} from './history.ts';
import type { HistoryState } from './history.ts';

const snap = (n: number) => ({ count: n });

function withEntries(...counts: number[]): HistoryState {
  let h = emptyHistory();
  counts.forEach((c, i) => {
    h = push(h, snap(i), snap(c), { label: `step ${i} → ${c}` });
  });
  return h;
}

/** `undo`/`redo` return the restored snapshot alongside the new history. */
const stepBack = (h: HistoryState): HistoryState => undo(h).history;
const stepForward = (h: HistoryState): HistoryState => redo(h).history;

describe('push', () => {
  it('records the before and after snapshots with a label', () => {
    const h = withEntries(1);
    expect(h.past).toHaveLength(1);
    expect(h.past[0]!.label).toBe('step 0 → 1');
    expect(h.past[0]!.before).toEqual({ count: 0 });
    expect(h.past[0]!.after).toEqual({ count: 1 });
  });

  it('clears the redo stack — a new edit invalidates the future', () => {
    let h = withEntries(1, 2, 3);
    h = stepBack(h);
    expect(h.future).toHaveLength(1);
    h = push(h, { count: 2 }, { count: 9 }, { label: 'diverged' });
    expect(h.future).toHaveLength(0);
    expect(canRedo(h)).toBe(false);
  });

  it('defaults the actor to the human, because that is the common case', () => {
    const h = push(emptyHistory(), snap(0), snap(1), { label: 'x' });
    expect(h.past[0]!.actor).toBe('user');
  });

  it('keeps the assistant as a distinct author so the UI can attribute it', () => {
    const h = push(emptyHistory(), snap(0), snap(1), { label: 'x', actor: 'assistant' });
    expect(h.past[0]!.actor).toBe('assistant');
  });
});

describe('coalescing', () => {
  it('collapses consecutive entries sharing a key', () => {
    let h = emptyHistory();
    h = push(h, snap(0), snap(1), { label: 'drag', coalesceKey: 'room:r1' });
    h = push(h, snap(1), snap(2), { label: 'drag', coalesceKey: 'room:r1' });
    h = push(h, snap(2), snap(3), { label: 'drag', coalesceKey: 'room:r1' });
    expect(h.past).toHaveLength(1);
    expect(h.past[0]!.after).toEqual({ count: 3 });
  });

  it('keeps the earliest before-snapshot, so one undo reverts the whole drag', () => {
    let h = emptyHistory();
    h = push(h, snap(0), snap(1), { label: 'drag', coalesceKey: 'k' });
    h = push(h, snap(1), snap(2), { label: 'drag', coalesceKey: 'k' });
    // One entry for the whole drag; undoing it lands on the drag's start.
    expect(h.past).toHaveLength(1);
    const back = undo(h);
    expect(back.snapshot).toEqual({ count: 0 });
  });

  it('does not merge two separate drags of the same element', () => {
    // The bug this guards: a committed gesture must not absorb the next one
    // just because both carry the same coalesce key.
    let h = emptyHistory();
    h = push(h, snap(0), snap(1), { label: 'drag', coalesceKey: 'room:r1' });
    h = commit(h); // gesture ends
    h = push(h, snap(1), snap(2), { label: 'drag', coalesceKey: 'room:r1' });
    expect(h.past).toHaveLength(2);
    expect(undo(h).snapshot).toEqual({ count: 1 });
  });

  it('does not coalesce across different keys', () => {
    let h = emptyHistory();
    h = push(h, snap(0), snap(1), { label: 'a', coalesceKey: 'room:r1' });
    h = push(h, snap(1), snap(2), { label: 'b', coalesceKey: 'room:r2' });
    expect(h.past).toHaveLength(2);
  });

  it('commit freezes the current key so the next entry starts fresh', () => {
    let h = emptyHistory();
    h = push(h, snap(0), snap(1), { label: 'drag', coalesceKey: 'k' });
    h = commit(h);
    expect(h.coalesceKey).toBeNull();
    h = push(h, snap(1), snap(2), { label: 'drag', coalesceKey: 'k' });
    expect(h.past).toHaveLength(2);
  });

  it('commit is a no-op when nothing is being coalesced', () => {
    const h = withEntries(1);
    expect(commit(h)).toBe(h);
  });
});

describe('undo and redo', () => {
  it('walks back through snapshots in order', () => {
    let h = withEntries(1, 2, 3);
    expect(canUndo(h)).toBe(true);

    h = stepBack(h);
    expect(h.past[h.past.length - 1]!.after).toEqual({ count: 2 });
    h = stepBack(h);
    expect(h.past[h.past.length - 1]!.after).toEqual({ count: 1 });
    h = stepBack(h);
    expect(canUndo(h)).toBe(false);
    expect(h.future).toHaveLength(3);
  });

  it('hands back the restored snapshot, not just the new history', () => {
    const h = withEntries(1, 2, 3);
    const back = undo(h);
    expect(back.snapshot).toEqual({ count: 2 });
    expect(back.entry?.label).toBe('step 2 → 3');
    expect(redo(back.history).snapshot).toEqual({ count: 3 });
  });

  it('replays forward exactly, not approximately', () => {
    let h = withEntries(1, 2, 3);
    h = stepBack(h);
    h = stepBack(h);
    expect(h.past).toHaveLength(1);
    h = stepForward(h);
    expect(h.past[h.past.length - 1]!.after).toEqual({ count: 2 });
    h = stepForward(h);
    h = stepForward(h);
    expect(canRedo(h)).toBe(false);
    expect(h.past[h.past.length - 1]!.after).toEqual({ count: 3 });
  });

  it('is a no-op at either end rather than throwing', () => {
    const empty = emptyHistory();
    expect(undo(empty).history).toBe(empty);
    expect(undo(empty).snapshot).toBeNull();
    expect(redo(empty).history).toBe(empty);

    const h = withEntries(1);
    expect(stepForward(stepBack(h)).past).toHaveLength(1);
  });

  it('names the next undo and redo for the toolbar tooltip', () => {
    const h = withEntries(1, 2);
    expect(nextUndoLabel(h)).toBe('step 1 → 2');
    expect(nextRedoLabel(h)).toBeNull();
    expect(nextUndoLabel(stepBack(h))).toBe('step 0 → 1');
    expect(nextRedoLabel(stepBack(h))).toBe('step 1 → 2');
    expect(nextUndoLabel(emptyHistory())).toBeNull();
  });

  it('survives a round trip without drift', () => {
    let h = withEntries(1, 2, 3, 4);
    for (let i = 0; i < 4; i++) h = stepBack(h);
    for (let i = 0; i < 4; i++) h = stepForward(h);
    expect(h.past).toHaveLength(4);
    expect(h.future).toHaveLength(0);
    expect(h.past.map((e) => e.after)).toEqual([1, 2, 3, 4].map(snap));
  });
});

describe('the stack ceiling', () => {
  it('drops the oldest entry past MAX_HISTORY', () => {
    let h = emptyHistory();
    for (let i = 1; i <= MAX_HISTORY + 20; i++) {
      h = push(h, snap(i - 1), snap(i), { label: `s${i}` });
    }
    expect(h.past).toHaveLength(MAX_HISTORY);
    // The oldest surviving entry is the one after the first 20, not the first.
    expect(h.past[0]!.before).toEqual({ count: 20 });
  });

  it('undoes only as far as the oldest kept snapshot, not further', () => {
    // The dropped entries are genuinely gone: undoing the whole surviving stack
    // reaches `{count: 20}` and stops. Claiming a deeper undo would be a lie.
    let h = emptyHistory();
    for (let i = 1; i <= MAX_HISTORY + 20; i++) {
      h = push(h, snap(i - 1), snap(i), { label: `s${i}` });
    }
    while (canUndo(h)) h = stepBack(h);
    expect(h.future[h.future.length - 1]!.before).toEqual({ count: 20 });
  });
});
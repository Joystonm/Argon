/**
 * Application entry point.
 *
 * Three jobs, in order: mount React, restore the last session if there is one,
 * and install the keyboard map. Everything else lives in the store.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { loadProject, requestPersistence } from './persist/library.ts';
import { useProject } from './store/useProject.ts';
import './index.css';

/**
 * Restores the most recently updated project, if the browser still has it.
 *
 * This is deliberately best-effort and silent on failure: a corrupt or
 * schema-stale record must never stop the studio from opening. The user gets a
 * fresh blank project instead, and the old record stays in the library until
 * they delete it.
 */
function useRestoreSession(): 'loading' | 'ready' {
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { listProjects } = await import('./persist/library.ts');
        const entries = await listProjects();
        const latest = entries[0];
        if (latest) {
          const restored = await loadProject(latest.id);
          if (restored && !cancelled) useProject.getState().replace(restored, 'Open ' + latest.name, { undoable: false });
        }
        // Ask the browser not to evict us under storage pressure. Silently
        // ignored where the API is unsupported.
        void requestPersistence();
      } catch {
        // Nothing to restore. Start clean.
      } finally {
        if (!cancelled) setPhase('ready');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return phase;
}

/**
 * The keyboard map.
 *
 * Modelled as a lookup rather than a switch so the help sheet and the bindings
 * cannot drift apart — the same table renders the shortcuts list.
 */
export const SHORTCUTS: Array<{ keys: string; label: string; run: () => void }> = [
  { keys: 'Ctrl+Z', label: 'Undo', run: () => useProject.getState().undo() },
  { keys: 'Ctrl+Shift+Z', label: 'Redo', run: () => useProject.getState().redo() },
  { keys: 'Ctrl+S', label: 'Save', run: () => void useProject.getState().saveNow() },
  { keys: 'V', label: 'Select tool', run: () => useProject.getState().setTool('select') },
  { keys: 'R', label: 'Room tool', run: () => useProject.getState().setTool('room') },
  { keys: 'W', label: 'Wall tool', run: () => useProject.getState().setTool('wall') },
  { keys: 'D', label: 'Door tool', run: () => useProject.getState().setTool('door') },
  { keys: 'N', label: 'Window tool', run: () => useProject.getState().setTool('window') },
  { keys: 'F', label: 'Furniture tool', run: () => useProject.getState().setTool('furniture') },
  { keys: 'M', label: 'Measure tool', run: () => useProject.getState().setTool('measure') },
  { keys: 'H', label: 'Pan tool', run: () => useProject.getState().setTool('pan') },
  { keys: 'T', label: 'Trace an underlay', run: () => useProject.getState().setTool('trace') },
  { keys: 'Escape', label: 'Back to select / clear selection', run: () => {
    const s = useProject.getState();
    if (s.selection.ids.length) s.clearSelection();
    else s.setTool('select');
  } },
  { keys: 'Ctrl+A', label: 'Select everything on this floor', run: () => useProject.getState().selectAllOnFloor() },
  { keys: 'Delete', label: 'Delete selection', run: () => useProject.getState().deleteSelection() },
  { keys: '1', label: 'Plan view', run: () => useProject.getState().setViewMode('plan') },
  { keys: '2', label: 'Split view', run: () => useProject.getState().setViewMode('split') },
  { keys: '3', label: '3D view', run: () => useProject.getState().setViewMode('3d') },
  { keys: 'G', label: 'Toggle grid', run: () => useProject.getState().setGrid(!useProject.getState().gridEnabled) },
  { keys: 'S', label: 'Toggle snap', run: () => useProject.getState().setSnap(!useProject.getState().snapEnabled) },
];

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const match = SHORTCUTS.find((s) => {
        const parts = s.keys.split('+');
        const key = parts[parts.length - 1];
        const wantsMod = parts.length > 1;
        const wantsShift = parts.includes('Shift');
        if (wantsMod !== mod) return false;
        if (parts.includes('Shift') !== e.shiftKey) return false;
        void wantsShift;
        return e.key.toLowerCase() === key.toLowerCase();
      });
      if (!match) return;
      // Never steal a browser binding we do not actually own.
      if (match.keys === 'Ctrl+S' || match.keys === 'Ctrl+Z') e.preventDefault();
      match.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Root() {
  const phase = useRestoreSession();
  useShortcuts();
  if (phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-inkFaint">Restoring your last project…</p>
      </div>
    );
  }
  return <App />;
}

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
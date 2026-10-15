/**
 * Transient messages.
 *
 * Errors are worded by the operation that produced them, so the toast does not
 * need to invent anything — it just has to be readable and dismissable. Errors
 * linger longer than confirmations because they usually carry something the
 * user needs to act on.
 */
import { useEffect } from 'react';
import { useProject } from '../store/useProject.ts';

const LIFETIME = { info: 3200, success: 2600, error: 7000 } as const;

export function Toasts() {
  const toasts = useProject((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-9 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5" data-testid="toasts">
      {toasts.map((t) => (
        <ToastRow key={t.id} id={t.id} kind={t.kind} message={t.message} />
      ))}
    </div>
  );
}

function ToastRow({ id, kind, message }: { id: string; kind: 'info' | 'success' | 'error'; message: string }) {
  const dismiss = useProject((s) => s.dismissToast);

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(id), LIFETIME[kind]);
    return () => window.clearTimeout(timer);
  }, [id, kind, dismiss]);

  const tone =
    kind === 'error' ? 'border-danger/30 text-danger'
    : kind === 'success' ? 'border-ok/30 text-ok'
    : 'border-line text-inkSoft';

  return (
    <div className={`slide-up pointer-events-auto flex max-w-lg items-start gap-2 rounded border bg-surface/97 px-3 py-2 shadow-pop backdrop-blur ${tone}`}>
      <span className="min-w-0 flex-1 text-[12px] leading-snug">{message}</span>
      <button className="shrink-0 text-inkFaint transition-colors hover:text-ink" onClick={() => dismiss(id)} aria-label="Dismiss">
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
          <path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
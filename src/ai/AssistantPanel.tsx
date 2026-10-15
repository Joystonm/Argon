/**
 * The assistant panel.
 *
 * Small by design — it sits beside the canvas rather than replacing it, and it
 * never blocks manual editing. If the model is unavailable the panel says so
 * plainly and every other part of the studio keeps working; that is the whole
 * reason the orchestration layer is provider-independent.
 *
 * What the panel shows is the *result*, not the model's account of the result:
 * a step is marked applied only when the operation behind it returned success.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useProject } from '../store/useProject.ts';
import { aiHealth, runAssistantTurn, type StepReport, type TurnReport } from './orchestrator.ts';
import type { PlanStep } from './orchestrator.ts';
import { formatArea } from '../model/geometry.ts';
import { TOOLS_BY_NAME } from '../tools/registry.ts';

const SUGGESTIONS = [
  'Make the living room bigger and move the kitchen next to it',
  'Check the plan and fix anything broken',
  'Put a bed in the smallest bedroom',
  'What is the floor area and coverage?',
];

interface Turn {
  id: number;
  request: string;
  report: TurnReport | null;
  /** Steps as they resolve, so the work is visible before the turn is over. */
  liveSteps: StepReport[];
  pending: boolean;
  progress: string;
}

let turnCounter = 0;

export function AssistantPanel({ onClose }: { onClose(): void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [health, setHealth] = useState<{ aiEnabled: boolean; model: string | null; endpoint: string | null; disabledByConfig: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void aiHealth().then(setHealth);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const ask = useCallback(async (text: string) => {
    const request = text.trim();
    if (!request) return;
    setDraft('');
    const id = ++turnCounter;
    setTurns((t) => [...t, { id, request, report: null, liveSteps: [], pending: true, progress: 'Starting…' }]);

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (p: Partial<Turn>) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, ...p } : x)));

    const report = await runAssistantTurn(request, {
      signal: controller.signal,
      onProgress: (progress) => patch({ progress }),
      // Each step is listed the moment it resolves rather than at the end, so
      // the panel and the canvas move together instead of the whole design
      // appearing at once when the turn closes.
      onStep: (step) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, liveSteps: [...x.liveSteps, step] } : x))),
      // Destructive operations stop and ask. The approval arrives as a promise
      // resolved by the dialog below.
      approve: (step) => confirmDestructive(step),
    });

    patch({ report, pending: false, progress: '' });
    abortRef.current = null;
  }, []);

  const pending = turns.some((t) => t.pending);

  return (
    <aside className="flex w-[336px] shrink-0 flex-col border-l border-line bg-surface" aria-label="Design assistant" data-testid="assistant-panel">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="panel-title">Assistant</span>
        {health && (
          <span className={`chip ${health.aiEnabled ? 'chip-ok' : ''}`} title={health.endpoint ? `MiniMax at ${health.endpoint}` : 'No model configured'}>
            {health.aiEnabled ? health.model ?? 'ready' : health.disabledByConfig ? 'turned off' : 'no key'}
          </span>
        )}
        <div className="flex-1" />
        {pending && (
          <button className="btn btn-ghost h-6 px-1.5 text-[11px]" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        )}
        <button className="btn btn-ghost btn-icon h-6 w-6" onClick={onClose} aria-label="Close the assistant">
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden><path d="M1 1l9 9M10 1l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </header>

      {/* ── health notice ── */}
      {health && !health.aiEnabled && (
        <div className="shrink-0 border-b border-line bg-paper px-3 py-2">
          <p className="text-[11px] leading-snug text-inkSoft">
            {health.disabledByConfig
              ? 'The assistant is switched off with ARGON_DISABLE_AI. Everything else in Argon works as normal.'
              : 'No MiniMax API key is configured, so the assistant is unavailable. You can still draw, measure, validate, walk and export — the studio does not depend on it.'}
          </p>
          {!health.disabledByConfig && (
            <p className="hint mt-1">Set MINIMAX_API_KEY in the server environment; see .env.example.</p>
          )}
        </div>
      )}

      {/* ── transcript ── */}
      <div ref={logRef} className="scroll-y min-h-0 flex-1 space-y-3 p-3" data-testid="assistant-log">
        {turns.length === 0 && (
          <div className="py-4">
            <p className="text-[12px] leading-snug text-inkSoft">
              Ask for a change in plain language. Argon turns the request into typed operations, checks them against the current
              model, applies them one at a time, and re-measures the result.
            </p>
            <p className="hint mt-2">
              It cannot invent object ids or measure anything for you — if a change would not fit, it is refused and told why.
            </p>
            <div className="mt-3 space-y-1">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="row w-full text-left" onClick={() => void ask(s)} data-testid="suggestion">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </div>

      {/* ── composer ── */}
      <div className="shrink-0 border-t border-line p-2">
        <textarea
          className="field h-16 resize-none py-1.5 text-[12px] leading-snug"
          placeholder={health?.aiEnabled ? 'Make the living room bigger…' : 'The assistant needs an API key to answer.'}
          value={draft}
          disabled={!health?.aiEnabled || pending}
          data-testid="assistant-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(draft);
            }
          }}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="hint flex-1">Enter to send · Shift+Enter for a new line</span>
          <button className="btn btn-accent" onClick={() => void ask(draft)} disabled={!draft.trim() || pending || !health?.aiEnabled} data-testid="assistant-send">
            {pending ? 'Working…' : 'Send'}
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ──────────────────────────────────────────────────────────────── a turn ────── */

function TurnView({ turn }: { turn: Turn }) {
  const report = turn.report;
  const highlightIds = (report?.steps ?? []).flatMap((s) => s.createdIds ?? []);
  // Before the turn closes, show the steps that have already landed. They are
  // the same objects the final report carries, so nothing is displayed twice
  // and nothing is displayed that did not run.
  const shownSteps = report?.steps ?? turn.liveSteps;

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-lg bg-ink px-2.5 py-1.5 text-[12px] leading-snug text-paper">{turn.request}</p>
      </div>

      {turn.pending && (
        <div className="flex items-center gap-2 px-1 py-1">
          <Spinner />
          <span className="text-[11px] text-inkFaint">{turn.progress}</span>
        </div>
      )}

      {shownSteps.length > 0 && (
        <ul className="space-y-1" data-testid="assistant-steps">
          {shownSteps.map((s, i) => (
            // `s.index` alone is not unique: it is the step's position
            // within one round's plan, and a turn may run up to six rounds,
            // so the same index recurs. The live model calls the same tool
            // twice in one turn often enough to make that visible as React's
            // duplicate-key warning. Position within this list is enough:
            // steps are only ever appended to a report, never reordered.
            <StepRow key={`${s.index}:${i}`} step={s} />
          ))}
        </ul>
      )}

      {report && (
        <>
          {report.reply && (
            <p className="whitespace-pre-wrap rounded-lg border border-line bg-paper px-2.5 py-2 text-[12px] leading-snug text-ink" data-testid="assistant-reply">
              {report.reply}
            </p>
          )}

          {/* The model may have written a layout. Argon draws from operations,
              not from words — so when nothing ran, the reply above is an
              intention, not a description of the plan on screen, and it is
              labelled as such rather than left to be read as a change. */}
          {report.changedNothing && (
            <p className="rounded-lg border border-warn/30 bg-warn/[0.07] px-2.5 py-2 text-[12px] leading-snug text-ink" data-testid="assistant-nothing-changed">
              Nothing on the plan changed. The assistant described a design in words but ran no operations, and Argon draws
              the plan from operations only. Ask it again, or draw the rooms yourself with the room tool.
            </p>
          )}

          {report.error && !report.reply.includes(report.error) && (
            <p className="rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-2 text-[12px] leading-snug text-danger">
              {report.error}
            </p>
          )}

          {/* Step 10: the numbers are ours, not the model's. */}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded border border-line px-2.5 py-2 text-[11px]" data-testid="assistant-after">
            <Stat label="Net indoor" value={formatArea(report.after.netIndoorArea, 'm')} />
            <Stat label="Coverage" value={`${(report.after.plotCoverage * 100).toFixed(1)}%`} />
            <Stat label="FAR" value={report.after.floorAreaRatio.toFixed(2)} />
            <Stat
              label="Checks"
              value={report.after.errorCount === 0 ? 'pass' : `${report.after.errorCount} error${report.after.errorCount === 1 ? '' : 's'}`}
              tone={report.after.errorCount === 0 ? 'ok' : 'danger'}
            />
          </dl>

          {highlightIds.length > 0 && <HighlightBridge ids={highlightIds} />}
        </>
      )}
    </div>
  );
}

function StepRow({ step }: { step: StepReport }) {
  const tone =
    step.status === 'applied' ? 'text-ok'
    : step.status === 'failed' ? 'text-danger'
    : step.status === 'rejected' || step.status === 'skipped' ? 'text-inkFaint'
    : 'text-inkSoft';

  return (
    <li className="flex items-start gap-1.5 px-1 text-[11px] leading-snug">
      <span className={`mt-[3px] shrink-0 ${tone}`} aria-hidden>
        {step.status === 'applied' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'rejected' ? '–' : '·'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-inkSoft">{step.label}</span>
        {step.status === 'applied' && step.summary && <span className="text-inkFaint"> — {step.summary}</span>}
        {step.status === 'failed' && step.error && <span className="block text-danger">{step.error}</span>}
        {step.status === 'failed' && step.hint && <span className="block text-inkFaint">{step.hint}</span>}
        {step.status === 'rejected' && <span className="text-inkFaint"> — declined, nothing changed</span>}
      </span>
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'danger' }) {
  return (
    <div className="flex justify-between">
      <dt className="text-inkFaint">{label}</dt>
      <dd className={`font-mono ${tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

/** Selects whatever the assistant just made, so the eye follows the change. */
function HighlightBridge({ ids }: { ids: string[] }) {
  useEffect(() => {
    const store = useProject.getState();
    store.setSelection({ kinds: [], ids });
    const timer = window.setTimeout(() => {
      const s = useProject.getState();
      if (s.selection.ids === ids) s.setSelection({ kinds: [], ids: [] });
    }, 2600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);
  return null;
}

function Spinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" className="animate-spin" aria-hidden>
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="#e7e5e1" strokeWidth="2" />
      <path d="M6 1.5a4.5 4.5 0 014.5 4.5" fill="none" stroke="#b4622d" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Asks before a destructive operation runs.
 *
 * This is a real gate: the operation does not start until the answer arrives,
 * and declining leaves the model free to do something else instead. The prompt
 * names what would be lost, in the terms of the object involved.
 */
function confirmDestructive(step: PlanStep): Promise<boolean> {
  if (!('tool' in step)) return Promise.resolve(true);
  const spec = TOOLS_BY_NAME.get(step.tool);
  const input = step.input;

  const describe = Object.entries(input)
    .filter(([, v]) => v !== undefined && typeof v !== 'object')
    .slice(0, 3)
    .map(([k, v]) => `${k.replace(/Id$/, ' id')} ${JSON.stringify(v)}`)
    .join(', ');

  const question =
    step.tool === 'remove_element'
      ? `Delete ${describe || 'that element'}? This can be undone with Ctrl+Z, but anything hanging off it goes too.`
      : step.tool === 'regenerate_floor'
        ? 'Re-plan this floor from the brief? Every room, wall and opening on it is replaced.'
        : `Run ${spec?.title.toLowerCase() ?? step.tool}? This cannot be undone from here.`;

  return Promise.resolve(window.confirm(question));
}
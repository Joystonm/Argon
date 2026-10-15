/**
 * The tracing overlay.
 *
 * Owns the interaction that makes an image useful: pick a calibration line,
 * type its real length, then review every detection the vectoriser found and
 * accept only the ones that are right. Detections are drawn as an underlay
 * preview; accepting them creates real walls through the same `createWall`
 * operation the toolbar uses, so a traced plan is indistinguishable from a
 * drawn one afterwards.
 *
 * The blocking message is shown in the panel, not hidden: until the image is
 * calibrated, every detection says its length is unknown rather than
 * displaying a plausible-looking number.
 */
import { useCallback, useRef, useState } from 'react';
import { useProject } from '../../store/useProject.ts';
import { parseLengthToMetres, pixelToPlan, recalibrate, type PixelPoint } from '../../trace/calibrate.ts';
import { collectAccepted, trace, type GreyImage, type TraceProposal, type TraceResult } from '../../trace/vectorize.ts';
import type { Underlay } from '../../model/types.ts';
import type { ViewTransform } from './view.ts';

export interface TraceOverlayProps {
  view: ViewTransform;
  size: { width: number; height: number };
  toPlan: (clientX: number, clientY: number) => { x: number; y: number };
}

interface CalibPicks {
  a: PixelPoint | null;
  b: PixelPoint | null;
}

/** Plan coordinates → underlay image pixels, for the calibration pick line. */
function planToUnderlayPx(u: Underlay, plan: { x: number; y: number }): PixelPoint | null {
  if (!u.calibration?.confirmed || u.depth <= 0) return null;
  return {
    px: (plan.x - u.calibration.offX) / u.calibration.scale,
    py: (plan.y - u.calibration.offY) / u.calibration.scale,
  };
}

export function TraceOverlay({ view, toPlan }: TraceOverlayProps) {
  const project = useProject((s) => s.project);
  const tool = useProject((s) => s.tool);
  const setTool = useProject((s) => s.setTool);

  const underlay = project.underlays[project.underlays.length - 1] ?? null;
  const [picks, setPicks] = useState<CalibPicks>({ a: null, b: null });
  const [lengthText, setLengthText] = useState('');
  const [result, setResult] = useState<TraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [grey, setGrey] = useState<GreyImage | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const active = tool === 'trace';

  const onUpload = useCallback(
    async (file: File) => {
      if (!underlay) return;
      setBusy(true);
      try {
        const { loadImage, toGrey, pixelScaleFor, DEFAULT_TRACE_SETTINGS } = await import('../../trace/vectorize.ts');
        const bitmap = await loadImage(file);
        const g = await toGrey(bitmap, DEFAULT_TRACE_SETTINGS.workWidth);
        setGrey(g);

        const calibrated = project.underlays.find((u) => u.id === underlay.id)?.calibration ?? null;
        setResult(
          trace({
            image: g,
            calibration: calibrated,
            pixelScale: pixelScaleFor(bitmap.width, DEFAULT_TRACE_SETTINGS.workWidth),
          }),
        );
      } catch (e) {
        useProject.getState().toast('error', e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [underlay, project.underlays],
  );

  const recalc = useCallback(
    (calibration: Underlay['calibration'], image: GreyImage | null) => {
      if (!image || !underlay) return;
      setResult(
        trace({
          image,
          calibration,
          pixelScale: (underlay.naturalWidth || image.width) / image.width,
        }),
      );
    },
    [underlay],
  );

  const onCanvasClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!active || !underlay) return;
    const plan = toPlan(e.clientX, e.clientY);
    const px = planToUnderlayPx(underlay, plan);
    if (!px) {
      useProject.getState().toast('info', 'Calibrate the image first — its pixel scale is unknown.');
      return;
    }
    setPicks((prev) => (prev.a && prev.b ? { a: px, b: null } : prev.a ? { a: prev.a, b: px } : { a: px, b: null }));
  };

  if (!active || !underlay) return null;

  const applyCalibration = () => {
    const metres = parseLengthToMetres(lengthText);
    if (!metres) {
      useProject.getState().toast('error', 'Enter a length like 4.2, 4.2m, 4.2 cm, or 14\'1".');
      return;
    }
    if (!picks.a || !picks.b) {
      useProject.getState().toast('info', 'Click two points on the wall you measured.');
      return;
    }
    // Anchor the line's first point where it currently sits, so recalibrating
    // never walks the drawing across the plot.
    const next = recalibrate(underlay.calibration, picks.a, picks.b, metres);
    if (!next) {
      useProject.getState().toast('error', 'Those two points are too close together to calibrate from.');
      return;
    }
    useProject.getState().run('updateUnderlay', [underlay.id, { calibration: next }], { label: 'Calibrate underlay', actor: 'user' });
    setPicks({ a: null, b: null });
    setLengthText('');
    recalc(next, grey);
    useProject.getState().toast('success', `Calibrated: 1 px = ${next.scale.toFixed(4)} m.`);
  };

  const toggleAccept = (id: string) => {
    if (!result) return;
    setResult({
      ...result,
      proposals: result.proposals.map((p) => (p.id === id ? { ...p, accepted: !p.accepted } : p)),
    });
  };

  const acceptAllConfident = () => {
    if (!result) return;
    setResult({
      ...result,
      proposals: result.proposals.map((p) => ({ ...p, accepted: p.confidence >= 0.5 && p.plan !== null })),
    });
  };

  const acceptNone = () => {
    if (!result) return;
    setResult({ ...result, proposals: result.proposals.map((p) => ({ ...p, accepted: false })) });
  };

  const commitWalls = () => {
    if (!result) return;
    const walls = collectAccepted(result.proposals);
    if (!walls.length) {
      useProject.getState().toast('info', 'Tick at least one detection first.');
      return;
    }
    const floorId = useProject.getState().activeFloorId;
    let created = 0;
    for (const w of walls) {
      const res = useProject.getState().run('createWall', [{ floorId, type: 'interior', a: w.a, b: w.b, thickness: w.thickness }], {
        label: 'Trace wall',
        actor: 'user',
        deferSave: true,
      });
      if (res.ok) created++;
    }
    useProject.getState().toast(
      created === walls.length ? 'success' : 'error',
      created === walls.length
        ? `Created ${created} wall${created === 1 ? '' : 's'} from the trace.`
        : `Created ${created} of ${walls.length} — the rest did not fit; check the plot.`,
    );
    setResult({ ...result, proposals: result.proposals.map((p) => ({ ...p, accepted: false })) });
  };

  const pickLine = (() => {
    if (!picks.a || !picks.b || !underlay.calibration) return null;
    const a = pixelToPlan(underlay.calibration, picks.a);
    const b = pixelToPlan(underlay.calibration, picks.b);
    return { ax: a.x * view.scale + view.offsetX, ay: a.y * view.scale + view.offsetY, bx: b.x * view.scale + view.offsetX, by: b.y * view.scale + view.offsetY };
  })();

  const accepted = result?.proposals.filter((p) => p.accepted).length ?? 0;

  return (
    <>
      <svg className="pointer-events-auto absolute inset-0" width="100%" height="100%" onClick={onCanvasClick} style={{ cursor: 'crosshair' }} data-testid="trace-overlay">
        {/* Accepted detections preview */}
        {result?.proposals
          .filter((p) => p.plan !== null && p.accepted)
          .map((p) => {
            const plan = p.plan!;
            return (
              <line
                key={p.id}
                x1={plan.a.x * view.scale + view.offsetX}
                y1={plan.a.y * view.scale + view.offsetY}
                x2={plan.b.x * view.scale + view.offsetX}
                y2={plan.b.y * view.scale + view.offsetY}
                stroke="#16a34a"
                strokeWidth={Math.max(2, plan.thickness * view.scale)}
                strokeLinecap="square"
                opacity={0.7}
              />
            );
          })}

        {/* Calibration pick line */}
        {pickLine && (
          <g data-testid="calibration-line">
            <line x1={pickLine.ax} y1={pickLine.ay} x2={pickLine.bx} y2={pickLine.by} stroke="#dc2626" strokeWidth={2} strokeDasharray="5 3" />
            <circle cx={pickLine.ax} cy={pickLine.ay} r={4} fill="#dc2626" />
            <circle cx={pickLine.bx} cy={pickLine.by} r={4} fill="#dc2626" />
          </g>
        )}
        {picks.a && underlay.calibration?.confirmed && (
          <circle
            cx={pixelToPlan(underlay.calibration, picks.a).x * view.scale + view.offsetX}
            cy={pixelToPlan(underlay.calibration, picks.a).y * view.scale + view.offsetY}
            r={4}
            fill="#dc2626"
          />
        )}
      </svg>

      <aside className="absolute right-3 top-3 z-20 w-72 rounded-lg border border-stone-200 bg-white/95 shadow-lg backdrop-blur" data-testid="trace-panel">
        <header className="flex items-center justify-between border-b border-stone-200 px-3 py-2">
          <h3 className="text-[13px] font-semibold text-stone-800">Trace “{underlay.name}”</h3>
          <button onClick={() => setTool('select')} className="rounded px-1.5 py-0.5 text-[11px] text-stone-500 hover:bg-stone-100">
            Done
          </button>
        </header>

        <div className="space-y-3 px-3 py-3 text-[12px] text-stone-600">
          {!underlay.calibration?.confirmed ? (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
              <p className="font-medium">No scale yet</p>
              <p className="mt-0.5">
                Click the two ends of a wall you know the real length of, then type that length below. Until then no
                detection can be given a dimension in metres.
              </p>
            </div>
          ) : (
            <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-emerald-800">
              Calibrated: <strong>1 px = {underlay.calibration.scale.toFixed(4)} m</strong> (from a{' '}
              {underlay.calibration.source.realDistance.toFixed(2)} m length).
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <input
              value={lengthText}
              onChange={(e) => setLengthText(e.target.value)}
              placeholder="4.20 m or 14 ft 1 in"
              className="w-full rounded border border-stone-300 px-2 py-1 text-[12px] outline-none focus:border-stone-500"
              onKeyDown={(e) => e.key === 'Enter' && applyCalibration()}
              data-testid="calibration-length"
            />
            <button
              onClick={applyCalibration}
              disabled={!picks.a || !picks.b}
              className="shrink-0 rounded bg-stone-800 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
              data-testid="calibration-apply"
            >
              Set
            </button>
          </div>
          <p className="text-[11px] text-stone-500">
            {picks.a && !picks.b ? 'Now click the far end of the same wall.' : 'Click two points on a known-length wall.'}
          </p>

          <div>
            <input
              type="file"
              accept="image/*"
              ref={fileRef}
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="w-full rounded border border-stone-300 px-2 py-1.5 text-[12px] font-medium hover:bg-stone-50 disabled:opacity-50"
              data-testid="trace-analyse"
            >
              {busy ? 'Analysing…' : 'Re-analyse image'}
            </button>
          </div>

          {result && (
            <div>
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-stone-700">{result.proposals.length} walls detected</span>
                <span className="tabular-nums text-stone-500">{accepted} accepted</span>
              </div>
              {!result.calibrated && <p className="mt-1 text-[11px] text-amber-700">{result.blocker}</p>}
              <div className="mt-1.5 flex gap-1">
                <button onClick={acceptAllConfident} className="flex-1 rounded border border-stone-300 px-1 py-0.5 text-[11px] hover:bg-stone-50">
                  Accept likely
                </button>
                <button onClick={acceptNone} className="flex-1 rounded border border-stone-300 px-1 py-0.5 text-[11px] hover:bg-stone-50">
                  Clear
                </button>
              </div>
              <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
                {result.proposals.slice(0, 60).map((p: TraceProposal) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-stone-50">
                    <input type="checkbox" checked={p.accepted} onChange={() => toggleAccept(p.id)} disabled={!p.plan} />
                    <span className="w-11 shrink-0 tabular-nums text-stone-700">{p.measured === null ? '—' : `${p.measured.toFixed(2)}m`}</span>
                    <span className="truncate text-stone-500">{p.reason}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-stone-400">{Math.round(p.confidence * 100)}%</span>
                  </label>
                ))}
              </div>
              <button
                onClick={commitWalls}
                disabled={accepted === 0}
                className="mt-2 w-full rounded bg-stone-800 px-2 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                data-testid="trace-commit"
              >
                Create {accepted} wall{accepted === 1 ? '' : 's'}
              </button>
              {result.proposals.length > 60 && (
                <p className="mt-1 text-[10px] text-stone-400">Showing the 60 highest-confidence detections of {result.proposals.length}.</p>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
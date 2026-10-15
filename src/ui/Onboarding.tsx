/**
 * Guided onboarding — one screen.
 *
 * It used to be six, and the complaint it drew was fair: every question in it
 * was defensible and none of them was needed in order to *see* a plan. Someone
 * opening this wants a floor plan, not a survey. So the screen now asks the two
 * things that actually change the geometry — how big the plot is and which
 * rooms are wanted — and puts everything else behind one disclosure, defaulted
 * and untouched. The three starts sit on the same screen, because choosing
 * between "generate it", "give me a grid" and "just the plot" is a decision,
 * not a step.
 *
 * Nothing here talks to a model. The wizard produces a `DesignBrief`, and
 * `generateFromBrief` turns that into geometry with deterministic code. If the
 * assistant is switched off entirely, the whole flow still works.
 */
import { useState } from 'react';
import { useProject } from '../store/useProject.ts';
import { emptyFromBrief, generateFromBrief, gridFromBrief } from '../model/layout.ts';
import { DEFAULT_ROOM_AREA, KIND_LABEL } from '../model/catalog.ts';
import { formatArea } from '../model/geometry.ts';
import { DEFAULT_PLOT } from '../model/ops.ts';
import type { DesignBrief, DesignStyle, RoomKind } from '../model/types.ts';

/** Room kinds worth offering, in the order a house is usually described. */
const OFFERED: RoomKind[] = [
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'guest',
  'office', 'prayer', 'storage', 'utility', 'garage', 'balcony', 'terrace',
];

const STYLE_LABEL: Record<DesignStyle, string> = {
  modern: 'Modern',
  contemporary: 'Contemporary',
  traditional: 'Traditional',
  minimalist: 'Minimalist',
  japandi: 'Japandi',
};

const STYLE_NOTE: Record<DesignStyle, string> = {
  modern: 'Open plans, big glazing, clean lines.',
  contemporary: 'Soft neutrals, generous light, simple volumes.',
  traditional: 'Separate rooms, a defined entrance, warmer materials.',
  minimalist: 'Few rooms, each one generous. Nothing decorative.',
  japandi: 'Low furniture, natural materials, calm and uncluttered.',
};

function initialBrief(): DesignBrief {
  return {
    plot: { ...DEFAULT_PLOT, setbacks: { ...DEFAULT_PLOT.setbacks } },
    floorCount: 1,
    // 80 m² of rooms against a 99 m² envelope. This is a real three-bedroom
    // house, and it is deliberately chosen so the untouched screen opens with
    // nothing flagged: a warning about a brief the user has not written yet is
    // the wrong first impression of a form that is meant to feel easy.
    rooms: [
      { kind: 'living', count: 1 },
      { kind: 'kitchen', count: 1 },
      { kind: 'bedroom', count: 3 },
      { kind: 'bathroom', count: 1 },
    ],
    preferredAreas: {},
    style: 'contemporary',
    budgetUsd: undefined,
    preferences: { accessibility: false, ventilation: true, privacy: false, daylight: true },
  };
}

export function Onboarding({ onDone }: { onDone(): void }) {
  const project = useProject((s) => s.project);
  const [brief, setBrief] = useState<DesignBrief>(initialBrief);
  const [units, setUnits] = useState<'m' | 'ft'>('m');
  const [more, setMore] = useState(false);

  const patch = (p: Partial<DesignBrief>) => setBrief((b) => ({ ...b, ...p }));
  const sb = brief.plot.setbacks;
  const setSetback = (side: keyof typeof sb, v: number) =>
    setBrief((b) => ({ ...b, plot: { ...b.plot, setbacks: { ...b.plot.setbacks, [side]: v } } }));

  const buildableW = brief.plot.width - sb.left - sb.right;
  const buildableD = brief.plot.depth - sb.front - sb.rear;
  const targetArea = brief.rooms.reduce((sum, r) => sum + (r.targetArea ?? DEFAULT_ROOM_AREA[r.kind] ?? 14) * r.count, 0);
  const storeys = brief.floorCount;
  const tight = buildableW < 4 || buildableD < 4;
  const overBudgetArea = targetArea > buildableW * buildableD * storeys * 0.82;

  const generate = () => {
    const store = useProject.getState();
    const res = generateFromBrief(project, brief);
    if (!res.ok) {
      store.toast('error', res.error);
      return;
    }
    store.replace(res.data.project, 'Generate from brief');
    store.setSelection({ kinds: [], ids: [] });
    store.setActiveFloor(res.data.project.floors[0]?.id ?? '');
    const w = res.data.report.warnings;
    store.toast(
      w.length ? 'info' : 'success',
      w.length
        ? `Planned ${storeyCount(brief.floorCount)} storey${brief.floorCount === 1 ? '' : 's'} — ${w[0]}${w.length > 1 ? ` (+${w.length - 1} more)` : ''}. See the Checks panel.`
        : `Planned ${storeyCount(brief.floorCount)} ${brief.floorCount === 1 ? 'storey' : 'storeys'} with ${res.data.project.rooms.length} rooms. Drag anything you want to change.`,
    );
    onDone();
  };

  /**
   * The two blank starts.
   *
   * Not everyone who opens this wants a plan generated for them. These two
   * take the same answers and use only the parts that are not an opinion about
   * the house: the plot and the rooms you ticked.
   */
  const startGrid = () => {
    const store = useProject.getState();
    const res = gridFromBrief(project, brief);
    if (!res.ok) {
      store.toast('error', res.error);
      return;
    }
    store.replace(res.data.project, 'Start from a room grid');
    store.setSelection({ kinds: [], ids: [] });
    store.setActiveFloor(res.data.project.floors[0]?.id ?? '');
    const r = res.data.report;
    const w = r.warnings;
    store.toast(
      w.length ? 'info' : 'success',
      w.length
        ? `Laid the ${res.data.project.rooms.length} rooms out in a ${r.columns} × ${r.rows} grid — ${w[0]}`
        : `Laid the ${res.data.project.rooms.length} rooms out in a ${r.columns} × ${r.rows} grid. Drag them into whatever shape you want.`,
    );
    onDone();
  };

  const startEmpty = () => {
    const store = useProject.getState();
    const res = emptyFromBrief(project, brief);
    if (!res.ok) {
      store.toast('error', res.error);
      return;
    }
    const floors = res.data.floorCount;
    store.replace(res.data.project, 'Start from an empty plot');
    store.setSelection({ kinds: [], ids: [] });
    store.setActiveFloor(res.data.project.floors[0]?.id ?? '');
    store.toast(
      'info',
      `A ${brief.plot.width.toFixed(1)} × ${brief.plot.depth.toFixed(1)} m plot with ${storeyCount(floors)} empty ${floors === 1 ? 'floor' : 'floors'}. Drag a room out of the toolbar to start.`,
    );
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-6" role="dialog" aria-modal="true" aria-label="Plan your home">
      <div className="slide-up flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-pop" data-testid="onboarding">
        {/* ── header ── */}
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-semibold tracking-tight text-ink">Plan your home</h1>
            <p className="hint mt-0.5">Everything has a sensible default. Change what matters, ignore the rest.</p>
          </div>
          <button className="btn btn-ghost" onClick={onDone} data-testid="onboarding-skip">
            {project.rooms.length ? 'Close' : 'Start empty'}
          </button>
        </header>

        {/* ── body ── */}
        <div className="scroll-y min-h-0 flex-1 px-5 py-4">
          {/* Plot and storeys, side by side. These two and the room list below
              are the whole of what changes the geometry on first run. */}
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
            <Field label="Plot" hint="Across the street, and street to back." className="w-[188px]">
              <div className="flex items-center gap-1.5">
                <Num value={brief.plot.width} units={units} onChange={(v) => patch({ plot: { ...brief.plot, width: v } })} testId="plot-width" />
                <span className="text-[11px] text-inkFaint">×</span>
                <Num value={brief.plot.depth} units={units} onChange={(v) => patch({ plot: { ...brief.plot, depth: v } })} testId="plot-depth" />
              </div>
            </Field>

            <Field label="Storeys" className="w-auto">
              <Segmented
                value={String(brief.floorCount)}
                onChange={(v) => patch({ floorCount: Number(v) })}
                options={[
                  { id: '1', label: 'One' },
                  { id: '2', label: 'Two' },
                  { id: '3', label: 'Three' },
                ]}
              />
            </Field>

            <p className="min-w-0 flex-1 text-[11px] leading-snug text-inkFaint">
              Room to build on: <span className="metric text-inkSoft">{formatArea(buildableW * buildableD, 'm')}</span> per floor
              {tight && <span className="ml-1 text-danger">— the setbacks leave almost nothing. Set them to zero below.</span>}
            </p>
          </div>

          {/* Rooms. */}
          <Field label="What do you need?" hint="Argon fits these to your plot. Sizes come afterwards if you want them.">
            <div className="grid grid-cols-3 gap-x-5">
              {OFFERED.map((kind) => {
                const entry = brief.rooms.find((r) => r.kind === kind);
                const on = Boolean(entry);
                return (
                  <div key={kind} className="flex items-center gap-2 border-b border-line py-1.5">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-[#b4622d]"
                      checked={on}
                      data-testid={`room-${kind}`}
                      onChange={(e) =>
                        setBrief((b) => ({
                          ...b,
                          rooms: e.target.checked
                            ? [...b.rooms, { kind, count: 1 }]
                            : b.rooms.filter((r) => r.kind !== kind),
                        }))
                      }
                    />
                    <span className={on ? 'min-w-0 flex-1 text-[12px] text-ink' : 'min-w-0 flex-1 text-[12px] text-inkFaint'}>{KIND_LABEL[kind]}</span>
                    {on && (
                      <input
                        type="number"
                        min={1}
                        max={9}
                        className="field h-6 w-11 text-center font-mono"
                        value={entry?.count ?? 1}
                        data-testid={`room-count-${kind}`}
                        onChange={(e) => {
                          const count = Math.max(1, Math.min(9, Math.round(Number(e.target.value) || 1)));
                          setBrief((b) => ({ ...b, rooms: b.rooms.map((r) => (r.kind === kind ? { ...r, count } : r)) }));
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {brief.rooms.length === 0 && <p className="hint mt-2 text-warn">Pick at least a living room so there is something to plan.</p>}
            {overBudgetArea && (
              <p className="mt-2 text-[11px] leading-snug text-warn">
                That is more than fits comfortably. Argon will scale the rooms down rather than overflow your plot — or add a
                storey, or drop a room.
              </p>
            )}
          </Field>

          {/* ── everything else, on request ── */}
          <div className="mt-4 border-t border-line pt-3">
            <button
              className="flex items-center gap-1.5 text-[12px] text-inkSoft"
              aria-expanded={more}
              onClick={() => setMore((m) => !m)}
              data-testid="wizard-more"
            >
              <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden className={`transition-transform ${more ? 'rotate-90' : ''}`}>
                <path d="M2 1l4 3.5L2 8z" fill="currentColor" />
              </svg>
              {more ? 'Hide the rest' : 'More options — units, street edge, setbacks, room sizes, style, comfort'}
            </button>

            {more && (
              <div className="mt-3" data-testid="wizard-more-body">
                <Field label="Units" hint="Everything is stored in metres. This only changes how numbers are displayed and typed.">
                  <Segmented
                    value={units}
                    onChange={(v) => setUnits(v as 'm' | 'ft')}
                    options={[{ id: 'm', label: 'Metric (m)' }, { id: 'ft', label: 'Imperial (ft)' }]}
                  />
                </Field>

                <Field label="Street on the" hint="Which edge the front door faces. Argon treats that side as the entrance and gives it the biggest windows.">
                  <Segmented
                    value={String(brief.plot.orientation)}
                    onChange={(v) => patch({ plot: { ...brief.plot, orientation: Number(v) as 0 | 90 | 180 | 270 } })}
                    options={[
                      { id: '0', label: 'Top' },
                      { id: '90', label: 'Right' },
                      { id: '180', label: 'Bottom' },
                      { id: '270', label: 'Left' },
                    ]}
                  />
                </Field>

                <Field label="Setbacks" hint="How far the building must stay from each edge. Set them to zero if there is no rule you need to respect.">
                  <div className="grid grid-cols-4 gap-2">
                    {(['front', 'rear', 'left', 'right'] as const).map((side) => (
                      <label key={side} className="block">
                        <span className="label mb-1 capitalize">{side}</span>
                        <Num value={sb[side]} units={units} onChange={(v) => setSetback(side, v)} testId={`setback-${side}`} />
                      </label>
                    ))}
                  </div>
                </Field>

                <Field
                  label="Room sizes"
                  hint="Target areas in m². The generator scales everything by one factor so the whole plan fits — so a number that ends up smaller than this is the fit talking, not a bug."
                >
                  <div className="grid grid-cols-2 gap-x-5">
                    {brief.rooms.map((r, i) => (
                      <div key={`${r.kind}-${i}`} className="flex items-center gap-2 border-b border-line py-1.5">
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                          {r.count > 1 && <span className="text-inkFaint">{r.count}× </span>}
                          {KIND_LABEL[r.kind]}
                        </span>
                        <input
                          type="number"
                          min={1}
                          step={0.5}
                          className="field h-6 w-16 text-right font-mono"
                          value={r.targetArea ?? DEFAULT_ROOM_AREA[r.kind] ?? 14}
                          data-testid={`area-${r.kind}`}
                          onChange={(e) => {
                            const targetArea = Number(e.target.value);
                            setBrief((b) => ({ ...b, rooms: b.rooms.map((x, j) => (j === i ? { ...x, targetArea } : x)) }));
                          }}
                        />
                        <span className="w-6 text-[10px] text-inkFaint">m²</span>
                      </div>
                    ))}
                  </div>
                </Field>

                <Field label="Style">
                  <div className="grid grid-cols-2 gap-1.5">
                    {(Object.keys(STYLE_LABEL) as DesignStyle[]).map((s) => (
                      <button key={s} className="issue-row block w-full" aria-pressed={brief.style === s} onClick={() => patch({ style: s })}>
                        <span className="block text-[12px] font-medium text-ink">{STYLE_LABEL[s]}</span>
                        <span className="mt-0.5 block text-[11px] text-inkFaint">{STYLE_NOTE[s]}</span>
                      </button>
                    ))}
                  </div>
                </Field>

                <Field label="Rough budget" hint="Optional. Argon does not price anything — this is recorded with the brief so material and area decisions stay proportionate to it.">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-inkFaint">$</span>
                    <input
                      type="number"
                      min={0}
                      step={5000}
                      className="field text-right font-mono"
                      placeholder="150000"
                      value={brief.budgetUsd ?? ''}
                      data-testid="wizard-budget"
                      onChange={(e) => patch({ budgetUsd: e.target.value ? Number(e.target.value) : undefined })}
                    />
                  </div>
                </Field>

                <Field label="Comfort" hint="These shape the layout rules the generator follows. All of them are preferences Argon applies deterministically — none is a statement about building regulations.">
                  <div className="space-y-1.5">
                    <Toggle
                      on={brief.preferences.accessibility}
                      title="Step-free access"
                      note="Widens doors to at least 900 mm clear, keeps corridors wide, and puts the entrance and any bedroom on the ground floor."
                      onChange={(v) => patch({ preferences: { ...brief.preferences, accessibility: v } })}
                      testId="pref-accessibility"
                    />
                    <Toggle
                      on={brief.preferences.ventilation}
                      title="Cross ventilation"
                      note="Places rooms so air can pass through the plan rather than dead-ending, and gives each side of the house openings."
                      onChange={(v) => patch({ preferences: { ...brief.preferences, ventilation: v } })}
                      testId="pref-ventilation"
                    />
                    <Toggle
                      on={brief.preferences.daylight}
                      title="Daylight"
                      note="Biases living spaces and bedrooms toward the sunniest edges and widens their glazing."
                      onChange={(v) => patch({ preferences: { ...brief.preferences, daylight: v } })}
                      testId="pref-daylight"
                    />
                    <Toggle
                      on={brief.preferences.privacy}
                      title="Privacy"
                      note="Keeps bedrooms off the street elevation and buffers them with hall space, at the cost of some daylight."
                      onChange={(v) => patch({ preferences: { ...brief.preferences, privacy: v } })}
                      testId="pref-privacy"
                    />
                  </div>
                </Field>
              </div>
            )}
          </div>
        </div>

        {/* ── footer ── */}
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <p className="hint min-w-0 flex-1 leading-snug">
            Generating runs deterministic layout code, no model involved — you get a real plan with rooms, walls, doors, windows
            and furniture to drag. Not a promise of buildability or code compliance.
          </p>
          <button className="btn" onClick={startGrid} data-testid="wizard-grid" title="The rooms you ticked, tiled edge to edge on the ground floor. A starting point to rearrange, not a finished layout.">
            Start from a grid
          </button>
          <button className="btn" onClick={startEmpty} data-testid="wizard-empty" title="The plot, the storeys and the brief. No rooms, walls or furniture — you draw those yourself.">
            Empty plot
          </button>
          <button className="btn btn-accent" onClick={generate} data-testid="wizard-generate">
            Generate the plan
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────── pieces ───── */

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className ?? 'mt-4 first:mt-0'}>
      <label className="label mb-1">{label}</label>
      {hint && <p className="hint mb-1.5">{hint}</p>}
      {children}
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange(v: string): void; options: Array<{ id: string; label: string }> }) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-line">
      {options.map((o, i) => (
        <button
          key={o.id}
          className={`btn h-7 rounded-none border-transparent ${i > 0 ? 'border-l border-line' : ''}`}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, title, note, onChange, testId }: { on: boolean; title: string; note: string; onChange(v: boolean): void; testId: string }) {
  return (
    <button className="issue-row flex items-start gap-3" aria-pressed={on} onClick={() => onChange(!on)} data-testid={testId}>
      <span className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${on ? 'bg-accent' : 'bg-line'}`}>
        <span className={`h-3 w-3 rounded-full bg-white transition-transform ${on ? 'translate-x-3' : ''}`} />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[12px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-inkFaint">{note}</span>
      </span>
    </button>
  );
}

function Num({ value, units, onChange, testId }: { value: number; units: 'm' | 'ft'; onChange(v: number): void; testId?: string }) {
  return (
    <span className="relative block flex-1">
      <input
        type="number"
        step={0.5}
        min={0}
        className="field pr-9 text-right font-mono"
        value={Number(value.toFixed(2))}
        data-testid={testId}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v > 0) onChange(units === 'm' ? v : v * 0.3048);
        }}
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-inkFaint">{units}</span>
    </span>
  );
}

const storeyCount = (n: number): string => ['zero', 'one', 'two', 'three', 'four'][n] ?? String(n);
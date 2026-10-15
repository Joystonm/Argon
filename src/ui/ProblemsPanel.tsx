/**
 * The validation panel.
 *
 * This is the same engine the assistant reads. Showing the user the identical
 * list — the identical codes, the identical sentences — is what makes the AI
 * trustworthy: it cannot tell the user something is fine when this panel says
 * otherwise, because there is only one answer.
 *
 * Issues are click-to-fix where the engine could produce a deterministic
 * correction, and click-to-select where the fix needs a judgement.
 */
import { useMemo, useState } from 'react';
import { useProject } from '../store/useProject.ts';
import { runTool } from '../tools/registry.ts';
import { DEFAULT_RULES, errorsOnly, validate } from '../model/validate.ts';
import type { Issue, Severity } from '../model/types.ts';

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function ProblemsPanel({ onOpenRoom }: { onOpenRoom(id: string): void }) {
  const project = useProject((s) => s.project);
  const ruleOverrides = useProject((s) => s.ruleOverrides);
  const [showRules, setShowRules] = useState(false);

  const issues = useMemo(
    () => validate(project, { ...DEFAULT_RULES, ...ruleOverrides }).slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    [project, ruleOverrides],
  );
  const errorCount = errorsOnly(issues).length;

  return (
    <div className="p-2">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[12px] text-inkSoft">
          {issues.length === 0 ? (
            <span className="text-ok">No problems found in this plan.</span>
          ) : errorCount ? (
            <><span className="text-danger">{errorCount} error{errorCount === 1 ? '' : 's'}</span>{issues.length - errorCount > 0 && <>, {issues.length - errorCount} warning{issues.length - errorCount === 1 ? '' : 's'}</>}</>
          ) : (
            <><span className="text-warn">{issues.length} thing{issues.length === 1 ? '' : 's'} to look at</span></>
          )}
        </p>
        <button className="btn btn-ghost ml-auto h-6 px-1.5 text-[11px]" onClick={() => setShowRules((v) => !v)}>
          {showRules ? 'Hide' : 'Constraints'}
        </button>
      </div>

      {showRules && <ConstraintRules />}

      {issues.length === 0 ? (
        <div className="rounded border border-line bg-paper px-3 py-6 text-center">
          <p className="text-[12px] text-inkSoft">Everything checks out.</p>
          <p className="mt-1 text-[11px] leading-snug text-inkFaint">
            Walls connect, openings fit, every room has a door, nothing overlaps and the footprint sits inside the setbacks.
          </p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} onOpenRoom={onOpenRoom} />
          ))}
        </ul>
      )}

      <p className="mt-3 px-1 text-[11px] leading-snug text-inkFaint">
        These are geometric checks computed from your model, not rules from a jurisdiction. Setbacks and limits below are
        configurable and are a starting point, not a compliance certificate.
      </p>
    </div>
  );
}

function IssueCard({ issue, onOpenRoom }: { issue: Issue; onOpenRoom(id: string): void }) {
  const tone =
    issue.severity === 'error' ? 'border-danger/30' : issue.severity === 'warning' ? 'border-warn/30' : 'border-line';

  const focus = () => {
    const roomId = issue.elements.find((id) => useProject.getState().project.rooms.some((r) => r.id === id));
    if (roomId) onOpenRoom(roomId);
    else if (issue.elements.length) useProject.getState().setSelection({ kinds: [], ids: issue.elements });
  };

  return (
    <li className={`issue-row ${tone}`}>
      <button className="block w-full text-left" onClick={focus}>
        <div className="flex items-start gap-2">
          <Dot severity={issue.severity} />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] leading-snug text-ink">{issue.message}</p>
            <code className="mt-1 inline-block text-[10px] text-inkFaint">{issue.code}</code>
          </div>
        </div>
      </button>
      {issue.fixes && issue.fixes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-5">
          {issue.fixes.map((fix, i) => (
            <button
              key={`${fix.tool}-${i}`}
              className="btn h-6 border-dashed px-2 text-[11px]"
              onClick={() => {
                // Through the registry, not the store directly: these tool names
                // are the model's vocabulary, and the registry is the only place
                // that knows how to turn one into an operation. Going straight
                // to `run` silently did nothing at all.
                const res = runTool(fix.tool, fix.input, 'user');
                if (res.ok) {
                  useProject.getState().toast('success', fix.label);
                } else {
                  // A correction that cannot be applied must say so. Staying
                  // quiet here would tell the user it worked when it did not.
                  useProject.getState().toast('error', res.error ?? 'That correction could not be applied.');
                }
              }}
            >
              {fix.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function Dot({ severity }: { severity: Severity }) {
  const colour = severity === 'error' ? '#b3402f' : severity === 'warning' ? '#b5842b' : '#8a8580';
  return <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colour }} aria-label={severity} />;
}

/**
 * Constraint overrides.
 *
 * Building regulations are not universal and Argon does not know the user's
 * jurisdiction, so nothing here is hard-coded as law. Every threshold is a
 * number the user can see and change, and the default is a plain sanity bound
 * rather than a citation.
 */
function ConstraintRules() {
  const overrides = useProject((s) => s.ruleOverrides);
  const setRules = useProject((s) => s.setRules);
  const effective = { ...DEFAULT_RULES, ...overrides };

  const fields: Array<{ key: keyof typeof DEFAULT_RULES; label: string; hint: string; step: number }> = [
    { key: 'maxPlotCoverage', label: 'Maximum plot coverage', hint: 'fraction', step: 0.05 },
    { key: 'maxFloorAreaRatio', label: 'Maximum floor-area ratio', hint: 'ratio', step: 0.1 },
    { key: 'minCorridorWidth', label: 'Minimum corridor width', hint: 'm', step: 0.05 },
    { key: 'minWindowRatio', label: 'Minimum window area per floor area', hint: 'fraction', step: 0.01 },
    { key: 'minBathroomClearance', label: 'Minimum bathroom clearance', hint: 'm', step: 0.05 },
  ];

  return (
    <div className="mb-2.5 rounded border border-line bg-paper p-2">
      <p className="hint mb-2">
        Defaults are geometric sanity bounds, not a building code. Adjust them to your local rules.
      </p>
      <div className="space-y-1.5">
        {fields.map((f) => (
          <label key={String(f.key)} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[11px] text-inkSoft">{f.label}</span>
            <input
              type="number"
              step={f.step}
              className="field h-6 w-20 text-right font-mono"
              value={effective[f.key] as number}
              onChange={(e) => setRules({ [f.key]: Number(e.target.value) } as never)}
            />
            <span className="w-12 shrink-0 text-[10px] text-inkFaint">{f.hint}</span>
          </label>
        ))}
      </div>
      <button className="btn mt-2 h-6 w-full justify-start text-[11px]" onClick={() => setRules({ ...DEFAULT_RULES })}>
        Reset to defaults
      </button>

      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          className="h-3 w-3 accent-[#b4622d]"
          checked={effective.enforcePlotRules}
          onChange={(e) => setRules({ enforcePlotRules: e.target.checked })}
        />
        <span className="text-[11px] text-inkSoft">Check setbacks, coverage and floor-area ratio</span>
      </label>
    </div>
  );
}
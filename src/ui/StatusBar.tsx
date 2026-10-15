/**
 * The measurement strip.
 *
 * Every number here is computed by `measureBuilding` from real geometry — no
 * estimates, and no model involvement. That is the whole point of putting them
 * in a status bar: they are the ground truth the assistant is measured against.
 */
import { useMemo } from 'react';
import { useProject } from '../store/useProject.ts';
import { formatArea, formatLength } from '../model/geometry.ts';
import { validate, errorsOnly } from '../model/validate.ts';
import type { BuildingMeasurements } from '../model/types.ts';

export function StatusBar({ measurements }: { measurements: BuildingMeasurements }) {
  const project = useProject((s) => s.project);
  const dirty = useProject((s) => s.dirty);
  const units = project.displayUnits ?? 'm';

  const { errors, warnings } = useMemo(() => {
    const list = validate(project);
    return { errors: errorsOnly(list).length, warnings: list.filter((i) => i.severity === 'warning').length };
  }, [project]);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-[11px] text-inkSoft" data-testid="status-bar">
      <Stat label="Net indoor" value={formatArea(measurements.netIndoorArea, units)} testId="stat-net" />
      <Stat label="Footprint" value={formatArea(measurements.footprintArea, units)} testId="stat-footprint" />
      <Stat label="Gross covered" value={formatArea(measurements.grossCoveredArea, units)} testId="stat-gross" />
      <Stat label="Open site" value={formatArea(measurements.openSiteArea, units)} />
      <Divider />
      <Stat label="Coverage" value={`${(measurements.plotCoverage * 100).toFixed(1)}%`} testId="stat-coverage" />
      <Stat label="FAR" value={measurements.floorAreaRatio.toFixed(2)} testId="stat-far" />
      <Divider />

      <span className="flex items-center gap-1.5" title="Live count from the constraint engine">
        {errors > 0 ? (
          <span className="chip chip-error">{errors} error{errors === 1 ? '' : 's'}</span>
        ) : (
          /* "No errors", not "checks pass": this chip sits next to the warning
             count, and two chips reading "pass" and "6 warnings" at the same
             time told the reader the engine had found nothing while it had
             found six things. */
          <span className="chip chip-ok" data-testid="checks-clean">No errors</span>
        )}
        {warnings > 0 && <span className="chip chip-warn">{warnings} warning{warnings === 1 ? '' : 's'}</span>}
      </span>

      <div className="flex-1" />
      <span className="text-inkFaint">
        {units === 'm' ? 'Metric' : 'Imperial'} · {dirty ? 'unsaved changes' : 'saved to this browser'}
      </span>
    </footer>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-inkFaint">{label}</span>
      <span className="metric" data-testid={testId}>{value}</span>
    </span>
  );
}

function Divider() {
  return <span className="h-3.5 w-px bg-line" />;
}

/** Exported for the tests: the exact figures the status bar reports. */
export function summaryLines(m: BuildingMeasurements, units: 'm' | 'ft'): string[] {
  return [
    `Net indoor   ${formatArea(m.netIndoorArea, units)}`,
    `Footprint    ${formatArea(m.footprintArea, units)}`,
    `Gross covered${formatArea(m.grossCoveredArea, units)}`,
    `Open site    ${formatArea(m.openSiteArea, units)}`,
    `Coverage     ${(m.plotCoverage * 100).toFixed(1)}%`,
    `FAR          ${m.floorAreaRatio.toFixed(2)}`,
    `Plot         ${formatLength(m.plotArea, units === 'm' ? 'm' : 'ft')}`,
  ];
}
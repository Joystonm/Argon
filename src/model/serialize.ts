/**
 * Project serialization: JSON round-trip with validation.
 *
 * Import is deliberately strict. A file that does not describe a real Argon
 * project is rejected with a readable reason rather than half-loaded — a
 * half-loaded architectural model produces confidently wrong geometry, which is
 * worse than a clear failure.
 */
import { SCHEMA_VERSION, type Project } from './types.ts';
import { DEFAULT_MATERIALS } from './catalog.ts';

export interface SerializedProject {
  format: 'argon.project';
  schemaVersion: number;
  exportedAt: string;
  project: Project;
}

export interface ImportResult {
  ok: boolean;
  project?: Project;
  error?: string;
}

export function toJSON(project: Project, pretty = true): string {
  const payload: SerializedProject = {
    format: 'argon.project',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    project: project,
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';

function needArray(v: unknown, path: string): unknown[] | string {
  return Array.isArray(v) ? v : `${path} must be an array`;
}

export function fromJSON(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `That file is not valid JSON (${e instanceof Error ? e.message : 'parse error'}).` };
  }

  if (!isObj(raw)) return { ok: false, error: 'That file does not contain a project object.' };
  if (raw.format !== 'argon.project') {
    return { ok: false, error: `Unrecognised file format. Expected an Argon project export ("format": "argon.project").` };
  }
  if (num(raw.schemaVersion) && raw.schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This project was saved by a newer version of Argon (schema v${raw.schemaVersion}, this build supports v${SCHEMA_VERSION}). Update Argon to open it.`,
    };
  }
  if (!isObj(raw.project)) return { ok: false, error: 'The export is missing its "project" field.' };

  const p = raw.project;
  const problems: string[] = [];

  if (!str(p.id) || !str(p.name)) problems.push('id and name must be strings');
  if (!isObj(p.plot) || !num(p.plot.width) || !num(p.plot.depth)) problems.push('plot.width and plot.depth must be numbers');

  const floors = needArray(p.floors, 'floors');
  if (typeof floors === 'string') problems.push(floors);
  const rooms = needArray(p.rooms ?? [], 'rooms');
  if (typeof rooms === 'string') problems.push(rooms);
  const walls = needArray(p.walls ?? [], 'walls');
  if (typeof walls === 'string') problems.push(walls);
  const stairs = needArray(p.stairs ?? [], 'stairs');
  if (typeof stairs === 'string') problems.push(stairs);
  const outdoor = needArray(p.outdoor ?? [], 'outdoor');
  if (typeof outdoor === 'string') problems.push(outdoor);
  const furniture = needArray(p.furniture ?? [], 'furniture');
  if (typeof furniture === 'string') problems.push(furniture);
  const underlays = needArray(p.underlays ?? [], 'underlays');
  if (typeof underlays === 'string') problems.push(underlays);

  if (problems.length) {
    return { ok: false, error: `This project file is incomplete or damaged: ${problems.join('; ')}.` };
  }

  const project = p as unknown as Project;

  // Fill in anything a newer/older export may have omitted, so the rest of the
  // app can assume a complete shape.
  project.materials = { ...DEFAULT_MATERIALS, ...(project.materials ?? {}) };
  project.brief = project.brief ?? null;
  project.displayUnits = project.displayUnits === 'ft' ? 'ft' : 'm';
  project.revision = num(project.revision) ? project.revision : 0;
  project.stairs = project.stairs ?? [];
  project.outdoor = project.outdoor ?? [];
  project.furniture = project.furniture ?? [];
  project.underlays = project.underlays ?? [];
  for (const f of project.floors) {
    f.roomIds = f.roomIds ?? [];
    f.wallIds = f.wallIds ?? [];
    f.stairIds = f.stairIds ?? [];
    f.outdoorIds = f.outdoorIds ?? [];
  }
  for (const w of project.walls) w.openings = w.openings ?? [];

  return { ok: true, project };
}

/** A deep, independent copy — used for duplicate-project and for snapshots. */
export const cloneProject = (p: Project): Project => structuredClone(p);

/**
 * Strip underlay image data for a "geometry only" export, so the JSON stays
 * small enough to email.
 */
export function toJSONLight(project: Project): string {
  return toJSON(
    {
      ...project,
      underlays: project.underlays.map((u) => ({ ...u, dataUrl: '' })),
    },
    true,
  );
}
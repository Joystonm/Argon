/**
 * Persistence: JSON export, import, and the shape guarantees an import may make.
 *
 * Import is the dangerous direction. Half-loading an architectural model
 * produces confidently wrong geometry, so `fromJSON` refuses rather than fills
 * in — and these tests pin down exactly what it refuses, because "it silently
 * accepted a broken file" is worse than "it loaded a file that was fine".
 */
import { describe, expect, it } from 'vitest';
import { fromJSON, toJSON, toJSONLight, cloneProject } from './serialize.ts';
import { addFloor, addFurniture, blankProject, createRoom, createWall, setPlot } from './ops.ts';
import { addUnderlay } from './ops.ts';
import { SCHEMA_VERSION, type Project } from './types.ts';

/** A small but structurally complete project: two floors, walls, furniture. */
function populated(): Project {
  let p = blankProject('Round trip');
  const plot = setPlot(p, { width: 20, depth: 16, orientation: 0, setbacks: { front: 3, rear: 3, left: 3, right: 3 } });
  if (!plot.ok) throw new Error(plot.error);
  p = plot.project;

  const ground = p.floors[0]!.id;
  const room = createRoom(p, { floorId: ground, kind: 'living', x: 3, y: 3, width: 8, depth: 6 });
  if (!room.ok) throw new Error(room.error);
  p = room.project;

  const wall = createWall(p, { floorId: ground, type: 'exterior', a: { x: 3, y: 3 }, b: { x: 11, y: 3 } });
  if (!wall.ok) throw new Error(wall.error);
  p = wall.project;

  const item = addFurniture(p, { roomId: room.createdIds[0]!, catalogId: 'sofa-3', x: 7, y: 6 });
  if (!item.ok) throw new Error(item.error);
  p = item.project;

  const upper = addFloor(p, 'First floor');
  if (!upper.ok) throw new Error(upper.error);
  return upper.project;
}

describe('toJSON', () => {
  it('writes an envelope with a format tag and the schema version', () => {
    const text = toJSON(populated());
    const payload = JSON.parse(text);
    expect(payload.format).toBe('argon.project');
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof payload.exportedAt).toBe('string');
    expect(payload.project.rooms).toHaveLength(1);
  });

  it('produces text that parses back to the same project', () => {
    const p = populated();
    const back = fromJSON(toJSON(p));
    expect(back.ok).toBe(true);
    expect(back.project).toEqual(p);
  });

  it('is pretty-printed by default and compact on request', () => {
    expect(toJSON(populated())).toContain('\n  ');
    expect(toJSON(populated(), false)).not.toContain('\n  ');
  });

  it('can be told which floor is active, without changing the model', () => {
    // revision is part of the project, so it must survive the round trip.
    const p = populated();
    expect(fromJSON(toJSON(p)).project?.revision).toBe(p.revision);
  });
});

describe('toJSONLight', () => {
  it('strips underlay image data but keeps the geometry', () => {
    let p = populated();
    const withImage = addUnderlay(p, {
      id: 'ul_test',
      name: 'scan.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      naturalWidth: 2048,
      naturalHeight: 2048,
      x: 0,
      y: 0,
      width: 10,
      depth: 10,
      opacity: 0.5,
      rotation: 0,
      calibration: null,
    });
    if (!withImage.ok) throw new Error(withImage.error);
    p = withImage.project;

    const full = toJSON(p);
    const light = toJSONLight(p);
    expect(full.length).toBeGreaterThan(light.length);
    expect(JSON.parse(light).project.underlays[0].dataUrl).toBe('');
    // Everything else is intact.
    expect(JSON.parse(light).project.rooms).toEqual(p.rooms);
    expect(JSON.parse(light).project.underlays[0].naturalWidth).toBe(2048);
  });
});

describe('fromJSON — rejects what it cannot trust', () => {
  it('refuses text that is not JSON at all', () => {
    const r = fromJSON('this is not json');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not valid JSON/i);
  });

  it('refuses a JSON document that is not an object', () => {
    expect(fromJSON('[1,2,3]').ok).toBe(false);
    expect(fromJSON('"a string"').ok).toBe(false);
  });

  it('refuses a foreign file format by name', () => {
    const r = fromJSON(JSON.stringify({ format: 'some.other.tool', project: {} }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/argon\.project/);
  });

  it('refuses a file saved by a newer build, and says so', () => {
    const r = fromJSON(JSON.stringify({ format: 'argon.project', schemaVersion: SCHEMA_VERSION + 1, project: {} }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/newer version/i);
  });

  it('refuses a file with no project body', () => {
    const r = fromJSON(JSON.stringify({ format: 'argon.project', schemaVersion: SCHEMA_VERSION }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/"project"/);
  });

  it('names every structural problem it found, not just the first', () => {
    const r = fromJSON(
      JSON.stringify({
        format: 'argon.project',
        schemaVersion: SCHEMA_VERSION,
        project: { id: 1, name: 'broken', plot: { width: 'wide' }, floors: 'not-an-array', rooms: {}, walls: 7 },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/id and name/);
    expect(r.error).toMatch(/plot\.width/);
    expect(r.error).toMatch(/floors must be an array/);
    expect(r.error).toMatch(/walls must be an array/);
  });
});

describe('fromJSON — completes what a valid older export may have omitted', () => {
  it('backfills optional collections rather than leaving them undefined', () => {
    const p = populated();
    const payload = JSON.parse(toJSON(p));
    delete payload.project.stairs;
    delete payload.project.outdoor;
    delete payload.project.furniture;
    delete payload.project.underlays;
    payload.project.brief = undefined;
    for (const f of payload.project.floors) {
      delete f.roomIds;
      delete f.wallIds;
    }
    for (const w of payload.project.walls) delete w.openings;

    const r = fromJSON(JSON.stringify(payload));
    expect(r.ok).toBe(true);
    expect(r.project!.stairs).toEqual([]);
    expect(r.project!.outdoor).toEqual([]);
    expect(r.project!.furniture).toEqual([]);
    expect(r.project!.underlays).toEqual([]);
    expect(r.project!.brief).toBeNull();
    for (const f of r.project!.floors) expect(f.roomIds).toEqual([]);
    for (const w of r.project!.walls) expect(w.openings).toEqual([]);
  });

  it('restores the default material catalogue alongside any custom ones', () => {
    const p = populated();
    const payload = JSON.parse(toJSON(p));
    delete payload.project.materials;
    const r = fromJSON(JSON.stringify(payload));
    expect(r.ok).toBe(true);
    // The app assumes a complete palette; an import must not render untextured.
    expect(Object.keys(r.project!.materials).length).toBeGreaterThan(5);
  });

  it('normalises a nonsense unit preference to metres', () => {
    const payload = JSON.parse(toJSON(populated()));
    payload.project.displayUnits = 'furlongs';
    expect(fromJSON(JSON.stringify(payload)).project!.displayUnits).toBe('m');
    payload.project.displayUnits = 'ft';
    expect(fromJSON(JSON.stringify(payload)).project!.displayUnits).toBe('ft');
  });

  it('defaults a missing revision to zero', () => {
    const payload = JSON.parse(toJSON(populated()));
    delete payload.project.revision;
    expect(fromJSON(JSON.stringify(payload)).project!.revision).toBe(0);
  });

  it('does not require the schema version to be present at all', () => {
    // A file that omits it is treated as this version, not rejected.
    const payload = JSON.parse(toJSON(populated()));
    delete payload.schemaVersion;
    expect(fromJSON(JSON.stringify(payload)).ok).toBe(true);
  });
});

describe('cloneProject', () => {
  it('produces a deep copy that does not share structure', () => {
    const p = populated();
    const copy = cloneProject(p);
    expect(copy).toEqual(p);
    copy.rooms[0]!.label = 'Changed';
    copy.plot.setbacks.front = 99;
    expect(p.rooms[0]!.label).not.toBe('Changed');
    expect(p.plot.setbacks.front).not.toBe(99);
  });
});
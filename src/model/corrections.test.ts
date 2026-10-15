/**
 * Every correction the validation panel offers must actually work.
 *
 * This file exists because none of them ever did. The panel called the store's
 * operation dispatch with the model's tool vocabulary (`resize_room`), while
 * that dispatch is keyed by operation name (`resizeRoom`), so every click
 * silently changed nothing and reported nothing. Two of the offered corrections
 * named a tool that was not registered at all, and three more carried arguments
 * their tools would have rejected. Nothing caught it because nothing had ever
 * applied a suggested fix.
 *
 * So each case below is driven the way the panel drives it — through
 * `runTool`, against the live store — and then re-validated. A correction that
 * does not execute, or that executes without clearing the message it was
 * attached to, fails here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runTool, TOOLS_BY_NAME } from '../tools/registry.ts';
import { useProject } from '../store/useProject.ts';
import { emptyHistory } from './history.ts';
import { validate } from './validate.ts';
import {
  addFurniture,
  addOpening,
  blankProject,
  createRoom,
  createWall,
  setBrief,
  setPlot,
} from './ops.ts';
import { OPENING_DEFAULTS } from './catalog.ts';
import type { Issue, Project } from './types.ts';

/** A 24 × 18 plot with 3 m setbacks, built through the real operations. */
function site(): Project {
  const res = setPlot(blankProject('Corrections'), {
    width: 24,
    depth: 18,
    orientation: 0,
    setbacks: { front: 3, rear: 3, left: 3, right: 3 },
  });
  if (!res.ok) throw new Error(res.error);
  return res.project;
}

/** Shallow-override, for states the operations refuse to create. */
const patch = (p: Project, part: Partial<Project>): Project => ({ ...p, ...part });

const ground = (p: Project): string => p.floors[0]!.id;

/** Put the project into the live store, the way loading a file would. */
function load(project: Project): void {
  useProject.setState({ project, history: emptyHistory(), activity: [] });
}

const issues = (p: Project, code?: Issue['code']): Issue[] =>
  validate(p).filter((i) => (code ? i.code === code : true) && (i.fixes?.length ?? 0) > 0);

/**
 * Apply every correction attached to `code`, through the registry, and require
 * that each one both executes and removes the message it was offered for.
 */
function expectCorrectionsWork(project: Project, code: Issue['code']): void {
  load(project);
  const offered = issues(project, code);
  expect(offered.length, `expected ${code} to offer at least one correction`).toBeGreaterThan(0);

  for (const issue of offered) {
    for (const fix of issue.fixes!) {
      load(project);

      const result = runTool(fix.tool, fix.input, 'user');
      expect(result.ok, `the correction "${fix.label}" was rejected: ${result.error}`).toBe(true);

      const after = useProject.getState().project;
      const stillThere = validate(after).some((i) => i.message === issue.message);
      expect(stillThere, `"${fix.label}" ran but "${issue.message}" is still reported`).toBe(false);
    }
  }
}

beforeEach(() => {
  load(site());
});

describe('corrections for rooms', () => {
  it('clears two rooms that overlap', () => {
    let p = site();
    const floorId = ground(p);
    const a = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 5, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId, kind: 'office', x: 7, y: 4, width: 3.2, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    expectCorrectionsWork(b.project, 'room_overlap');
  });

  it('clears a room that is too small to be a room', () => {
    const p = site();
    const r = createRoom(p, { floorId: ground(p), kind: 'storage', x: 4, y: 4, width: 3, depth: 3 });
    if (!r.ok) throw new Error(r.error);
    // No operation will produce this, but a save file or a bad edit can.
    const broken = patch(r.project, {
      rooms: r.project.rooms.map((room) => ({ ...room, width: 0.05 })),
    });

    expectCorrectionsWork(broken, 'room_degenerate');
  });

  it('clears a corridor that is too narrow to walk down', () => {
    let p = site();
    const r = createRoom(p, { floorId: ground(p), kind: 'corridor', x: 4, y: 4, width: 3, depth: 0.5 });
    if (!r.ok) throw new Error(r.error);

    expectCorrectionsWork(r.project, 'dimension_implausible');
  });
});

describe('corrections for walls and openings', () => {
  /** An interior wall with one door in it. */
  function doorway(): { project: Project; wallId: string; openingId: string } {
    const p = site();
    const w = createWall(p, { floorId: ground(p), type: 'interior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const withDoor = addOpening(w.project, {
      wallId: w.createdIds[0]!,
      kind: 'door',
      offset: 3,
      width: OPENING_DEFAULTS.interiorDoor.width,
      swing: 'positive',
      hinge: 'start',
    });
    if (!withDoor.ok) throw new Error(withDoor.error);
    return { project: withDoor.project, wallId: w.createdIds[0]!, openingId: withDoor.createdIds[0]! };
  }

  it('clears a door that runs off the end of its wall', () => {
    const { project, wallId } = doorway();
    // Offset 5.4 on a 6 m wall with a 0.9 m leaf puts it at 4.95..5.85,
    // which fits — so push it right off the end.
    const stuck = patch(project, {
      walls: project.walls.map((w) =>
        w.id === wallId
          ? { ...w, openings: w.openings.map((o) => ({ ...o, offset: 5.9 })) }
          : w,
      ),
    });

    expectCorrectionsWork(stuck, 'opening_overflows_wall');
  });

  it('clears a window whose head is above the wall', () => {
    const p = site();
    const w = createWall(p, { floorId: ground(p), type: 'interior', a: { x: 4, y: 6 }, b: { x: 10, y: 6 } });
    if (!w.ok) throw new Error(w.error);
    const win = addOpening(w.project, { wallId: w.createdIds[0]!, kind: 'window', offset: 3, width: 1.2, height: 1.4, sill: 0.9 });
    if (!win.ok) throw new Error(win.error);

    // `addOpening` refuses to hang a window above the wall, so the broken
    // state has to arrive the way a bad import would bring it.
    const wallHeight = win.project.walls.find((x) => x.id === w.createdIds[0])!.height;
    const broken = patch(win.project, {
      walls: win.project.walls.map((wall) =>
        wall.id === w.createdIds[0]
          ? {
              ...wall,
              openings: wall.openings.map((o) => ({
                ...o,
                sill: wallHeight,
                height: 1.4,
              })),
            }
          : wall,
      ),
    });

    expectCorrectionsWork(broken, 'opening_overflows_wall');
  });

  it('clears a wall that has no length', () => {
    const p = site();
    const w = createWall(p, { floorId: ground(p), type: 'interior', a: { x: 5, y: 5 }, b: { x: 9, y: 5 } });
    if (!w.ok) throw new Error(w.error);
    // As above: the operation refuses, an import might not.
    const broken = patch(w.project, {
      walls: w.project.walls.map((wall) =>
        wall.id === w.createdIds[0] ? { ...wall, b: { x: wall.a.x, y: wall.a.y } } : wall,
      ),
    });

    expectCorrectionsWork(broken, 'wall_zero_length');
  });
});

describe('corrections for furniture', () => {
  it('moves furniture out of a door swing', () => {
    const p = site();
    const floorId = ground(p);
    const w = createWall(p, { floorId, type: 'interior', a: { x: 4, y: 4 }, b: { x: 10, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const withDoor = addOpening(w.project, {
      wallId: w.createdIds[0]!,
      kind: 'door',
      offset: 3,
      width: OPENING_DEFAULTS.interiorDoor.width,
      swing: 'positive',
      hinge: 'start',
    });
    if (!withDoor.ok) throw new Error(withDoor.error);
    const room = createRoom(withDoor.project, { floorId, kind: 'living', x: 3, y: 4, width: 12, depth: 5 });
    if (!room.ok) throw new Error(room.error);
    const chair = addFurniture(room.project, { catalogId: 'armchair', x: 7, y: 4.6 });
    if (!chair.ok) throw new Error(chair.error);

    expectCorrectionsWork(chair.project, 'door_swing_blocked');
  });

  it('moves furniture off a wall it is crossing', () => {
    const p = site();
    const floorId = ground(p);
    const room = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 8, depth: 6 });
    if (!room.ok) throw new Error(room.error);
    const chair = addFurniture(room.project, { catalogId: 'armchair', x: 4, y: 7 });
    if (!chair.ok) throw new Error(chair.error);
    // The room has no walls of its own here, so give it one it is sitting on.
    const w = createWall(chair.project, { floorId, type: 'interior', a: { x: 3, y: 7 }, b: { x: 13, y: 7 } });
    if (!w.ok) throw new Error(w.error);

    expectCorrectionsWork(w.project, 'furniture_crosses_wall');
  });

  it('resolves two pieces of furniture in the same place', () => {
    let p = site();
    const floorId = ground(p);
    const room = createRoom(p, { floorId, kind: 'living', x: 4, y: 4, width: 8, depth: 6 });
    if (!room.ok) throw new Error(room.error);
    const one = addFurniture(room.project, { catalogId: 'armchair', x: 7, y: 6 });
    if (!one.ok) throw new Error(one.error);
    const two = addFurniture(one.project, { catalogId: 'armchair', x: 7, y: 6 });
    if (!two.ok) throw new Error(two.error);

    expectCorrectionsWork(two.project, 'furniture_overlap');
  });
});

describe('corrections for circulation and the brief', () => {
  it('adds an entrance to a floor that has none', () => {
    const p = site();
    const w = createWall(p, { floorId: ground(p), type: 'exterior', a: { x: 4, y: 4 }, b: { x: 12, y: 4 } });
    if (!w.ok) throw new Error(w.error);
    const room = createRoom(w.project, { floorId: ground(p), kind: 'living', x: 4, y: 4, width: 8, depth: 5 });
    if (!room.ok) throw new Error(room.error);

    expectCorrectionsWork(room.project, 'no_entrance');
  });

  it('places a room the brief asked for and the plan does not have', () => {
    let p = site();
    const room = createRoom(p, { floorId: ground(p), kind: 'living', x: 4, y: 4, width: 5, depth: 4 });
    if (!room.ok) throw new Error(room.error);
    const brief = setBrief(room.project, {
      plot: { width: 24, depth: 18, orientation: 0, setbacks: { front: 3, rear: 3, left: 3, right: 3 } },
      floorCount: 1,
      rooms: [{ kind: 'bedroom', count: 1, targetArea: 12 }],
      preferredAreas: {},
      style: 'modern',
      preferences: { accessibility: false, ventilation: false, daylight: false, privacy: false },
    });
    if (!brief.ok) throw new Error(brief.error);

    expectCorrectionsWork(brief.project, 'brief_room_missing');
  });
});

describe('the corrections the panel offers are the ones the registry knows', () => {
  it('never names a tool that does not exist', () => {
    // Typing `SuggestedFix.tool` as the registry's own `ToolName` union makes
    // this a compile-time guarantee for corrections written from now on; this
    // test covers the rest of the surface by asking the same question of
    // every fix a representative plan produces.
    const base = site();
    const a = createRoom(base, { floorId: ground(base), kind: 'living', x: 4, y: 4, width: 5, depth: 3 });
    if (!a.ok) throw new Error(a.error);
    const b = createRoom(a.project, { floorId: ground(base), kind: 'office', x: 7, y: 4, width: 3.2, depth: 3 });
    if (!b.ok) throw new Error(b.error);

    const offered = validate(b.project).flatMap((i) => i.fixes ?? []);
    expect(offered.length).toBeGreaterThan(0);
    for (const fix of offered) {
      expect(TOOLS_BY_NAME.has(fix.tool), `"${fix.label}" offers the unknown tool "${fix.tool}"`).toBe(true);
    }
  });
});
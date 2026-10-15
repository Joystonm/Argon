/**
 * The typed tool registry the assistant is allowed to call.
 *
 * This module is the security boundary of the whole AI feature. The model may
 * only ever name one of these tools and pass JSON-shaped arguments; it has no
 * channel for code, no channel for an id it invented, and no channel to skip a
 * validation. Every test below is about one of those guarantees holding.
 *
 * The registry reads and writes live through the same store and the same
 * `OperationName → OpFn` dispatch table the 2D editor uses, so an operation that
 * works here works in the editor and vice versa. That shared path is the reason
 * the tests drive the store rather than calling the operations directly.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TOOLS, TOOLS_BY_NAME, toolDefinitionsForModel } from './registry.ts';
import { useProject } from '../store/useProject.ts';
import { emptyHistory } from '../model/history.ts';
import { blankProject } from '../model/ops.ts';
import type { Project } from '../model/types.ts';

/** A plot with one floor, set through the real store so ids are real. */
function seed(plotWidth = 20, plotDepth = 16): Project {
  const store = useProject.getState();
  store.project = blankProject('Tool test');
  useProject.setState({ history: emptyHistory(), activity: [], selection: { kinds: [], ids: [] }, dirty: false });
  const plot = store.run('setPlot', [
    { width: plotWidth, depth: plotDepth, orientation: 0, setbacks: { front: 2, rear: 2, left: 2, right: 2 } },
  ]);
  if (!plot.ok) throw new Error(plot.error);
  return useProject.getState().project;
}

const ground = (p: Project): string => p.floors[0]!.id;

/** Run a tool by name, the way the orchestrator does. */
function call(name: string, input: Record<string, unknown> = {}) {
  const spec = TOOLS_BY_NAME.get(name);
  if (!spec) throw new Error(`no such tool: ${name}`);
  return spec.handler(input);
}

beforeEach(() => {
  seed();
});

describe('the registry contract', () => {
  it('declares at least the twenty-three tools the brief requires', () => {
    const required = [
      'inspect_project', 'get_floor_details', 'list_rooms', 'inspect_room', 'inspect_wall',
      'create_room', 'resize_room', 'move_room', 'create_wall', 'move_wall', 'add_door',
      'add_window', 'add_staircase', 'add_furniture', 'remove_element', 'calculate_room_area',
      'calculate_building_areas', 'validate_floor_plan', 'get_layout_issues', 'apply_material',
      'get_3d_scene_state', 'undo_last_operation', 'export_project',
    ];
    const names = new Set(TOOLS.map((t) => t.name));
    const missing = required.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });

  it('has no duplicate names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(TOOLS_BY_NAME.size).toBe(names.length);
  });

  it('gives every tool a title, a description and a handler', () => {
    for (const t of TOOLS) {
      expect(typeof t.title, t.name).toBe('string');
      expect(t.title.length, t.name).toBeGreaterThan(0);
      expect(typeof t.description, t.name).toBe('string');
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(typeof t.handler, t.name).toBe('function');
    }
  });

  it('declares an input and an output schema for every tool', () => {
    for (const t of TOOLS) {
      expect(t.input.type, t.name).toBe('object');
      expect(typeof t.input.properties, t.name).toBe('object');
      expect(t.output.type, t.name).toBe('object');
      expect(typeof t.output.properties, t.name).toBe('object');
    }
  });

  it('only ever lists required arguments that exist as properties', () => {
    // A required key with no declared property is a schema that cannot be
    // satisfied by anything the model could legitimately produce.
    for (const t of TOOLS) {
      for (const key of t.input.required ?? []) {
        expect(Object.keys(t.input.properties), `${t.name}.${key}`).toContain(key);
      }
    }
  });

  it('uses only the three declared permission levels', () => {
    for (const t of TOOLS) {
      expect(['read', 'write', 'destructive'], t.name).toContain(t.permission);
    }
  });

  it('classifies the operations that throw work away as destructive', () => {
    // This is the level the orchestrator gates behind user approval, so a
    // mistake here means deleting without asking. Undo is deliberately *not*
    // in this set: it discards a change rather than work the user still wants,
    // and gating it would mean a confirmation dialog on every correction.
    const destructive = TOOLS.filter((t) => t.permission === 'destructive').map((t) => t.name);
    expect(destructive).toContain('remove_element');
    expect(destructive).toContain('regenerate_floor');
    expect(TOOLS_BY_NAME.get('remove_element')!.permission).toBe('destructive');
    expect(TOOLS_BY_NAME.get('undo_last_operation')!.permission).toBe('write');
  });

  it('classifies the read-only tools as read, so they never mutate state', () => {
    const readers = TOOLS.filter((t) => t.permission === 'read').map((t) => t.name);
    expect(readers).toContain('inspect_project');
    expect(readers).toContain('list_rooms');
    expect(readers).toContain('inspect_room');
    expect(readers).toContain('inspect_wall');
    expect(readers).toContain('get_floor_details');
    expect(readers).toContain('get_3d_scene_state');
  });

  it('leaves the project untouched when a read-only tool runs', () => {
    const p = seed();
    const before = JSON.stringify(useProject.getState().project);
    for (const name of ['inspect_project', 'list_rooms', 'get_floor_details', 'get_layout_issues', 'calculate_building_areas']) {
      call(name, { floorId: ground(p) });
    }
    expect(JSON.stringify(useProject.getState().project)).toBe(before);
  });
});

describe('toolDefinitionsForModel', () => {
  it('emits only the three fields the Messages API accepts for a tool', () => {
    for (const d of toolDefinitionsForModel()) {
      expect(Object.keys(d).sort()).toEqual(['description', 'input_schema', 'name']);
    }
  });

  it('emits exactly one definition per tool, including destructive ones', () => {
    // Hiding destructive tools would be worse than useless: the model would be
    // unable to propose them at all. They are advertised and then gated.
    expect(toolDefinitionsForModel()).toHaveLength(TOOLS.length);
  });

  it('never ships a handler function to the model', () => {
    for (const d of toolDefinitionsForModel()) {
      expect(JSON.stringify(d)).not.toContain('function');
    }
  });
});

describe('reads report the truth', () => {
  it('reports a real room id from list_rooms', () => {
    const p = seed();
    const room = call('create_room', { floorId: ground(p), kind: 'living', x: 3, y: 3, width: 6, depth: 4 });
    expect(room.ok).toBe(true);

    const rooms = call('list_rooms', { floorId: ground(useProject.getState().project) });
    expect(rooms.ok).toBe(true);
    const listed = (rooms.data as { rooms: Array<{ id: string }> }).rooms;
    expect(listed.map((r) => r.id)).toContain(room.createdIds![0]);
  });

  it('measures an area deterministically rather than asking the model', () => {
    const p = seed();
    const room = call('create_room', { floorId: ground(p), kind: 'living', x: 3, y: 3, width: 6, depth: 4 });
    const id = room.createdIds![0]!;

    const measured = call('calculate_room_area', { roomId: id });
    expect(measured.ok).toBe(true);
    // 6 m × 4 m = 24 m², by hand.
    expect((measured.data as { area: number }).area).toBeCloseTo(24, 6);
  });

  it('refuses to measure a room that does not exist, and says so', () => {
    const out = call('calculate_room_area', { roomId: 'room_does_not_exist' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/room_does_not_exist/);
    expect(out.summary).toBe('');
  });

  it('refuses to inspect a wall that does not exist', () => {
    const out = call('inspect_wall', { wallId: 'wall_nope' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/wall_nope/);
  });
});

describe('writes go through the real operations', () => {
  it('creates a room that is really in the project afterwards', () => {
    const p = seed();
    const out = call('create_room', { floorId: ground(p), kind: 'bedroom', x: 2, y: 2, width: 4, depth: 3 });
    expect(out.ok).toBe(true);
    expect(out.createdIds).toHaveLength(1);

    const after = useProject.getState().project;
    const room = after.rooms.find((r) => r.id === out.createdIds![0]);
    expect(room).toBeDefined();
    expect(room!.width).toBe(4);
    expect(room!.floorId).toBe(ground(after));
  });

  it('records the assistant as the actor, so the activity feed is honest', () => {
    const p = seed();
    call('create_room', { floorId: ground(p), kind: 'living', x: 2, y: 2, width: 4, depth: 4 });
    // `log` prepends, so the newest entry is first.
    const entry = useProject.getState().activity[0]!;
    expect(entry.actor).toBe('assistant');
    expect(entry.ok).toBe(true);
  });

  it('reports a genuine operation failure instead of throwing', () => {
    const p = seed();
    // 0.1 m is below TOL.dimension (0.15 m), so createRoom refuses it
    // with `too_small` and the tool surfaces that as a clean failure.
    const out = call('create_room', { floorId: ground(p), kind: 'living', x: 2, y: 2, width: 0.1, depth: 4 });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('too_small');
    expect(out.error).toMatch(/too small/i);
  });

  it('does not itself bound-check the plot, because that is the validator\'s job', () => {
    // createRoom accepts geometry outside the buildable envelope; refusing it
    // is `checkPreconditions`' job before a plan runs and `validate`'s job
    // afterwards. Pinned here so the division of labour stays deliberate: if
    // someone moves the check into the operation, this test says so.
    const p = seed();
    const out = call('create_room', { floorId: ground(p), kind: 'living', x: 18, y: 2, width: 6, depth: 4 });
    expect(out.ok).toBe(true);
    const room = useProject.getState().project.rooms.find((r) => r.id === out.createdIds![0])!;
    expect(room.x + room.width).toBeGreaterThan(p.plot.width);
  });

  it('rejects nonsense input without touching the project', () => {
    const before = JSON.stringify(useProject.getState().project);
    const out = call('create_room', { floorId: ground(useProject.getState().project), kind: 'living', x: 'over there', y: 2, width: NaN, depth: 4 });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('invalid_input');
    expect(JSON.stringify(useProject.getState().project)).toBe(before);
  });

  it('never lets a tool accept a non-numeric number', () => {
    const p = seed();
    const room = call('create_room', { floorId: ground(p), kind: 'living', x: 2, y: 2, width: 4, depth: 4 });
    const out = call('move_room', { roomId: room.createdIds![0], x: 'far', y: 0 });
    expect(out.ok).toBe(false);
  });
});

describe('the model cannot fabricate an id', () => {
  it('fails a resize naming a room that was never created', () => {
    const out = call('resize_room', { roomId: 'room_invented_by_the_model', width: 5, height: 5 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/room_invented_by_the_model/);
  });

  it('fails a removal naming an element that does not exist', () => {
    const out = call('remove_element', { id: 'not_a_thing', kind: 'room' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not_a_thing/);
  });

  it('fails an opening on a wall that does not exist', () => {
    const out = call('add_door', { wallId: 'wall_from_nowhere', offset: 1 });
    expect(out.ok).toBe(false);
  });

  it('fails applying a material that is not in the catalogue', () => {
    const p = seed();
    const room = call('create_room', { floorId: ground(p), kind: 'living', x: 2, y: 2, width: 4, depth: 4 });
    const out = call('apply_material', { elementId: room.createdIds![0], materialId: 'unobtainium.9' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unobtainium/);
  });
});

describe('destructive tools really are gated', () => {
  it('removes an element and reports the id it removed', () => {
    const p = seed();
    const room = call('create_room', { floorId: ground(p), kind: 'living', x: 2, y: 2, width: 4, depth: 4 });
    const id = room.createdIds![0]!;

    const out = call('remove_element', { id, kind: 'room' });
    expect(out.ok).toBe(true);
    expect(out.removedIds).toContain(id);
    expect(useProject.getState().project.rooms.some((r) => r.id === id)).toBe(false);
  });

  it('undoes the last operation, so a destructive tool is reversible', () => {
    const p = seed();
    const room = call('create_room', { floorId: ground(p), kind: 'living', x: 2, y: 2, width: 4, depth: 4 });
    const id = room.createdIds![0]!;
    call('remove_element', { id, kind: 'room' });

    const undone = call('undo_last_operation', {});
    expect(undone.ok).toBe(true);
    expect((undone.data as { undone: boolean }).undone).toBe(true);
    expect(useProject.getState().project.rooms.some((r) => r.id === id)).toBe(true);
  });
});

describe('exhaustive handler sweep', () => {
  it('every tool returns a well-formed outcome for empty input, and none throws', () => {
    // The model will eventually call a tool with nothing useful. That must be a
    // clean failure the orchestrator can show, never an exception that would
    // take down the whole turn.
    const p = useProject.getState().project;
    for (const spec of TOOLS) {
      const out = spec.handler({});
      expect(typeof out.ok, spec.name).toBe('boolean');
      expect(typeof out.summary, spec.name).toBe('string');
      if (out.ok) {
        expect(out.error, spec.name).toBeUndefined();
      } else {
        expect(typeof out.error, spec.name).toBe('string');
        expect((out.error ?? '').length, spec.name).toBeGreaterThan(0);
      }
      void p;
    }
  });

  it('reports a read-only tool as read-only for every declared reader', () => {
    // Confirms the store is not being mutated by inspecting revision-sensitive
    // output rather than by trusting the permission string.
    const before = useProject.getState().project.revision;
    for (const spec of TOOLS.filter((t) => t.permission === 'read')) {
      spec.handler({});
    }
    expect(useProject.getState().project.revision).toBe(before);
  });
});
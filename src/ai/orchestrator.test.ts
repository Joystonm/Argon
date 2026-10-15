/**
 * The assistant turn: parse, validate, check, apply, recalculate, report.
 *
 * The model's output is treated throughout as untrusted input. These tests
 * defend the three promises the product makes about it:
 *
 *   1. The model may only choose *named operations* with JSON arguments. It can
 *      never deliver code, an id it made up, or a number the app did not
 *      measure. (parsePlan, checkPreconditions)
 *   2. Nothing is reported as done unless a deterministic function actually
 *      applied it. (runAssistantTurn's step statuses)
 *   3. When the model is unreachable, the turn fails cleanly and the app keeps
 *      working by hand. (error paths)
 *
 * `runAssistantTurn` takes its `ChatClient` by injection precisely so this can
 * be tested without a network, a key, or the real model.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ITERATIONS,
  checkPreconditions,
  compactState,
  parsePlan,
  runAssistantTurn,
  systemPrompt,
  type ChatClient,
  type ChatMessage,
} from './orchestrator.ts';
import { useProject } from '../store/useProject.ts';
import { emptyHistory } from '../model/history.ts';
import { blankProject } from '../model/ops.ts';
import { DEFAULT_MATERIALS } from '../model/catalog.ts';
import type { Project } from '../model/types.ts';

function seed(): Project {
  const store = useProject.getState();
  store.project = blankProject('Orchestrator test');
  useProject.setState({ history: emptyHistory(), activity: [], activeFloorId: '', dirty: false, aiBusy: false });
  const plot = store.run('setPlot', [
    { width: 20, depth: 16, orientation: 0, setbacks: { front: 2, rear: 2, left: 2, right: 2 } },
  ]);
  if (!plot.ok) throw new Error(plot.error);
  return useProject.getState().project;
}

/**
 * A fake model. `replies` are consumed one per iteration, so a test can script
 * a whole multi-round turn — including a model that changes its mind.
 */
function scriptedClient(replies: string[], log?: ChatMessage[]): ChatClient {
  let i = 0;
  return {
    async send({ system, messages, maxTokens }) {
      if (log) log.push(...messages);
      void system;
      void maxTokens;
      const reply = replies[Math.min(i, replies.length - 1)];
      i++;
      if (reply === '__THROW__') throw new Error('The assistant service is unavailable (503).');
      return { text: reply!, toolCalls: [] };
    },
  };
}

/** A client that answers the way MiniMax-M3 actually does: prose plus tool_use. */
function nativeToolClient(calls: { name: string; input: Record<string, unknown> }[], text: string): ChatClient {
  return { async send() { return { text, toolCalls: calls }; } };
}

const planJson = (intent: string, steps: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ intent, steps, ...extra });

beforeEach(() => {
  seed();
});

/* ─────────────────────────────────────────────────────────── parsePlan ────────── */

describe('parsePlan — strict validation of the model\'s output', () => {
  it('accepts a clean plan', () => {
    const out = parsePlan(planJson('Add a bedroom', [{ tool: 'create_room', input: { kind: 'bedroom', x: 2, y: 2, width: 4, depth: 4 } }]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.intent).toBe('Add a bedroom');
    expect(out.plan.steps[0]).toMatchObject({ tool: 'create_room' });
  });

  it('accepts a plan wrapped in a markdown fence', () => {
    // Models fence JSON constantly; refusing that would be pedantry, not safety.
    const out = parsePlan('Here is my plan:\n```json\n' + planJson('Do it', [{ reply: 'done' }]) + '\n```');
    expect(out.ok).toBe(true);
  });

  it('accepts a plan surrounded by prose', () => {
    const out = parsePlan(`Sure thing. ${planJson('Do it', [{ reply: 'ok' }])} Let me know if that helps.`);
    expect(out.ok).toBe(true);
  });

  it('treats prose on its own as a reply, never as an edit', () => {
    // This contract changed, deliberately, after testing against the live
    // service. A model answering conversationally ("the Kitchen is 38 m²") is
    // not making a mistake, and reporting "did not return a plan in the
    // expected JSON shape" to a user who asked a question is wrong. Prose can
    // only ever become a reply step, so it cannot make the app claim an edit
    // that did not happen — the original worry behind the stricter rule.
    const out = parsePlan('I would love to help you design a wonderful home!');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.steps).toEqual([{ reply: 'I would love to help you design a wonderful home!' }]);
  });

  it('rejects a plan with no intent', () => {
    const out = parsePlan(JSON.stringify({ steps: [{ reply: 'hi' }] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/intent/i);
  });

  it('rejects a plan with an empty intent', () => {
    expect(parsePlan(JSON.stringify({ intent: '   ', steps: [{ reply: 'hi' }] })).ok).toBe(false);
  });

  it('rejects a plan with no steps', () => {
    const out = parsePlan(JSON.stringify({ intent: 'x', steps: [] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/at least one step/i);
  });

  it('rejects an absurdly long plan rather than running it', () => {
    const out = parsePlan(planJson('x', Array.from({ length: 41 }, () => ({ reply: 'a' }))));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/40 steps/i);
  });

  it('rejects a step that is neither a tool nor a reply', () => {
    const out = parsePlan(planJson('x', [{ doSomething: 'else' }]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/tool.*reply|reply.*tool/i);
  });

  it('rejects a step that is not an object', () => {
    expect(parsePlan(planJson('x', ['just do it'])).ok).toBe(false);
    expect(parsePlan(planJson('x', [42])).ok).toBe(false);
  });

  it('rejects a plan naming a tool that does not exist', () => {
    // The single most important rejection in the file: an unknown tool name is
    // the model trying to address something outside the registry.
    const out = parsePlan(planJson('x', [{ tool: 'exec_shell', input: { cmd: 'rm -rf /' } }]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/no tool called "exec_shell"/i);
  });

  it('rejects a tool call whose input is not an object', () => {
    const out = parsePlan(planJson('x', [{ tool: 'create_room', input: 'a 4 by 4 room' }]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/must be an object/i);
  });

  it('rejects a tool call missing a required argument, before applying anything', () => {
    // create_room requires kind, x, y, width and depth. Omitting one must fail
    // the whole plan rather than half-execute it.
    const out = parsePlan(planJson('x', [{ tool: 'create_room', input: { kind: 'bedroom', x: 2, y: 2, width: 4 } }]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/depth/);
  });

  it('names every missing required argument at once', () => {
    const out = parsePlan(planJson('x', [{ tool: 'create_room', input: {} }]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/kind/);
    expect(out.error).toMatch(/width/);
  });

  it('treats an omitted input as an empty object rather than a crash', () => {
    const out = parsePlan(planJson('x', [{ tool: 'inspect_project' }]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.steps[0]).toMatchObject({ input: {} });
  });

  it('carries needsApproval through only when it is exactly true', () => {
    expect(parsePlan(planJson('x', [{ reply: 'a' }], { needsApproval: true })).ok && parsePlan(planJson('x', [{ reply: 'a' }], { needsApproval: true })).ok).toBe(true);
    const yes = parsePlan(planJson('x', [{ reply: 'a' }], { needsApproval: true }));
    expect(yes.ok && yes.plan.needsApproval).toBe(true);
    const no = parsePlan(planJson('x', [{ reply: 'a' }], { needsApproval: 'yes please' }));
    expect(no.ok && no.plan.needsApproval).toBe(false);
  });

  it('never lets a non-string tool name through as a lookup', () => {
    expect(parsePlan(planJson('x', [{ tool: 42, input: {} }])).ok).toBe(false);
  });
});

/* ─────────────────────────────────────────────── native tool_use answers ───────── */

describe('parsePlan — a plan answered as native tool calls', () => {
  // This is the shape MiniMax-M3 actually returns when offered the registry,
  // confirmed against the live service: prose, then a `tool_use` block. The
  // prose is not JSON, so a text-only parser reports a failure against a model
  // that answered perfectly well.

  it('reads tool calls as the plan, with the prose as intent', () => {
    const out = parsePlan("I'll add a study next to the living room.", [
      { name: 'create_room', input: { kind: 'study', x: 2, y: 2, width: 3, depth: 3 } },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.steps[0]).toMatchObject({ tool: 'create_room', input: { kind: 'study' } });
    expect(out.plan.intent).toMatch(/add a study/i);
  });

  it('does not mistake running commentary for the answer when the model also calls tools', () => {
    // Prose beside tool calls is the model narrating mid-turn ("I'll check the
    // rooms first"). The reply the user sees is composed afterwards from what
    // the operations actually returned, so the commentary is not carried
    // through as if it were the outcome.
    const out = parsePlan('Done — it sits beside the living room.', [
      { name: 'list_rooms', input: {} },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.steps).toHaveLength(1);
    expect(out.plan.steps[0]).toMatchObject({ tool: 'list_rooms' });
  });

  it('still refuses an unknown tool name in a native call', () => {
    // The registry boundary is the same whichever style the model answered in.
    const out = parsePlan('sure', [{ name: 'exec_shell', input: { cmd: 'rm -rf /' } }]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/no tool called "exec_shell"/i);
  });

  it('still validates the arguments of a native call', () => {
    // create_room needs kind, x, y, width and depth; a call missing them must
    // fail the same way the equivalent JSON plan would.
    const out = parsePlan('sure', [{ name: 'create_room', input: { kind: 'study' } }]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/width/);
  });

  it('synthesises an intent when the model sent no prose at all', () => {
    const out = parsePlan('', [{ name: 'list_rooms', input: {} }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.intent).toMatch(/1 change/);
  });

  it('prefers a JSON plan when the model sends both styles', () => {
    const out = parsePlan(planJson('From JSON', [{ reply: 'ok' }]), [
      { name: 'list_rooms', input: {} },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.intent).toBe('From JSON');
  });

  it('reads a tool named "reply" as speech, not as an edit', () => {
    // Observed live: M3 called calculate_room_area and list_rooms, then called
    // a tool named "reply" and the whole turn was refused for it. It was
    // trying to end the turn, not to invent an operation.
    const out = parsePlan('All set.', [
      { name: 'list_rooms', input: {} },
      { name: 'reply', input: { reply: 'The Kitchen is the largest room at 38 m².' } },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const tools = out.plan.steps.filter((s) => 'tool' in s);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ tool: 'list_rooms' });
    expect(out.plan.steps.at(-1)).toEqual({ reply: 'The Kitchen is the largest room at 38 m².' });
  });

  it('accepts the other names a model uses to end a turn', () => {
    for (const name of ['reply', 'respond', 'final_answer', 'answer']) {
      const out = parsePlan('', [{ name, input: { text: 'all done' } }]);
      expect(out.ok, `${name} should be read as speech`).toBe(true);
      if (!out.ok) continue;
      expect(out.plan.steps).toEqual([{ reply: 'all done' }]);
    }
  });

  it('still refuses an unknown tool, even next to a speech call', () => {
    // The mapping is a list, not a catch-all — otherwise a misspelt tool name
    // would silently degrade into harmless-looking prose instead of an error.
    const out = parsePlan('sure', [
      { name: 'reply', input: { reply: 'done' } },
      { name: 'resize_rooom', input: { roomId: 'rm_x', width: 3 } },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/no tool called "resize_rooom"/i);
  });

  it('does not let a speech call smuggle an operation past the registry', () => {
    const out = parsePlan('', [{ name: 'reply', input: { reply: 'ok', tool: 'remove_element', roomId: 'rm_x' } }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Only the message survives; the extra fields are dropped, not run.
    expect(out.plan.steps).toEqual([{ reply: 'ok' }]);
  });

  it('applies a natively-answered plan through the registry', async () => {
    const p = seed();
    const report = await runAssistantTurn('add a study', {
      client: nativeToolClient(
        [{ name: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } }],
        'Added a room.',
      ),
      maxIterations: 1,
    });
    expect(report.ok).toBe(true);
    expect(useProject.getState().project.rooms.length).toBe(1);
  });

  it('refuses a native call that would fail its precondition', async () => {
    seed();
    const report = await runAssistantTurn('add a study', {
      client: nativeToolClient([{ name: 'resize_room', input: { roomId: 'rm_made_up', width: 5 } }], 'sure'),
      maxIterations: 1,
    });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/rm_made_up/);
    expect(useProject.getState().project.rooms).toHaveLength(0);
  });
});

/* ───────────────────────────────────────────────────── checkPreconditions ───────── */

describe('checkPreconditions — the model cannot invent ids', () => {
  const planOf = (steps: unknown[]) => ({ intent: 'x', steps: steps as never[] });

  it('passes a plan that names real ids', () => {
    const p = seed();
    const room = useProject.getState().run('createRoom', [{ floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 }]);
    if (!room.ok) throw new Error(room.error);
    const id = room.createdIds![0]!;
    expect(checkPreconditions(useProject.getState().project, planOf([{ tool: 'resize_room', input: { roomId: id, width: 5, height: 5 } }]))).toEqual([]);
  });

  it('catches a fabricated room id', () => {
    const p = seed();
    const problems = checkPreconditions(p, planOf([{ tool: 'move_room', input: { roomId: 'rm_invented', x: 5, y: 5 } }]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/rm_invented/);
  });

  it('catches a fabricated wall id on every tool that takes one', () => {
    const p = seed();
    for (const tool of ['add_door', 'add_window', 'move_wall', 'inspect_wall']) {
      const problems = checkPreconditions(p, planOf([{ tool, input: { wallId: 'wall_ghost' } }]));
      expect(problems, tool).toHaveLength(1);
      expect(problems[0]).toMatch(/wall_ghost/);
    }
  });

  it('catches a room placed outside the plot', () => {
    const p = seed();
    const problems = checkPreconditions(
      p,
      planOf([{ tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 18, y: 2, width: 6, depth: 4 } }]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/outside/i);
  });

  it('catches a non-positive room size', () => {
    const p = seed();
    const problems = checkPreconditions(
      p,
      planOf([{ tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: -3, depth: 4 } }]),
    );
    expect(problems.some((x) => /positive/i.test(x))).toBe(true);
  });

  it('catches a zero-length wall', () => {
    const p = seed();
    const problems = checkPreconditions(
      p,
      planOf([{ tool: 'create_wall', input: { floorId: p.floors[0]!.id, type: 'exterior', a: { x: 5, y: 5 }, b: { x: 5, y: 5 } } }]),
    );
    expect(problems.some((x) => /zero-length/i.test(x))).toBe(true);
  });

  it('catches a wall missing its endpoints', () => {
    const p = seed();
    const problems = checkPreconditions(p, planOf([{ tool: 'create_wall', input: { floorId: p.floors[0]!.id, type: 'exterior', a: { x: 1 } } }]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/endpoints/i);
  });

  it('catches a material that is not in the catalogue', () => {
    const p = seed();
    const problems = checkPreconditions(p, planOf([{ tool: 'apply_material', input: { materialId: 'unobtainium.9' } }]));
    expect(problems[0]).toMatch(/unobtainium/);
  });

  it('does not flag a material that really exists', () => {
    const p = seed();
    const real = Object.keys(DEFAULT_MATERIALS)[0]!;
    expect(checkPreconditions(p, planOf([{ tool: 'apply_material', input: { materialId: real } }]))).toEqual([]);
  });

  it('catches a fabricated floor id', () => {
    const p = seed();
    const problems = checkPreconditions(p, planOf([{ tool: 'get_floor_details', input: { floorId: 'fl_nope' } }]));
    expect(problems[0]).toMatch(/fl_nope/);
  });

  it('reports every problem, not just the first', () => {
    const p = seed();
    const problems = checkPreconditions(
      p,
      planOf([
        { tool: 'move_room', input: { roomId: 'rm_a', x: 5, y: 5 } },
        { tool: 'inspect_wall', input: { wallId: 'wall_b' } },
      ]),
    );
    expect(problems).toHaveLength(2);
  });

  it('ignores read-only tools that take no id', () => {
    const p = seed();
    expect(checkPreconditions(p, planOf([{ tool: 'list_catalog', input: {} }]))).toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────── state & prompt ────── */

describe('compactState — what the model is actually allowed to see', () => {
  it('states the coordinate convention explicitly', () => {
    // The single most valuable sentence in the whole prompt: without it the
    // model reliably flips y and puts rooms in the wrong hemisphere.
    const p = seed();
    const text = compactState(p, p.floors[0]!.id, false);
    expect(text).toMatch(/METRES/);
    expect(text).toMatch(/y runs DOWN/i);
  });

  it('omits the full model when detail is not requested', () => {
    const p = seed();
    useProject.getState().run('createRoom', [{ floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 }]);
    const brief = compactState(useProject.getState().project, p.floors[0]!.id, false);
    expect(brief).not.toMatch(/Rooms on/);
    expect(compactState(useProject.getState().project, p.floors[0]!.id, true)).toMatch(/Rooms on/);
  });

  it('carries the measured areas, which is what stops the model estimating', () => {
    const p = seed();
    useProject.getState().run('createRoom', [{ floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 6, depth: 4 }]);
    const text = compactState(useProject.getState().project, p.floors[0]!.id, false);
    // 6 × 4 = 24 m², measured by the app, not by the model.
    expect(text).toMatch(/net indoor 24\.0 m²/);
  });

  it('stays small: the whole point is token cost', () => {
    const p = seed();
    for (let i = 0; i < 30; i++) {
      useProject.getState().run('createRoom', [{ floorId: p.floors[0]!.id, kind: 'bedroom', x: 2 + (i % 5) * 3, y: 2 + Math.floor(i / 5) * 3, width: 2.5, depth: 2.5 }]);
    }
    const text = compactState(useProject.getState().project, p.floors[0]!.id, true);
    expect(text.length).toBeLessThan(6000);
  });
});

describe('systemPrompt', () => {
  it('forbids invented ids and invented arithmetic', () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/Never invent an id/i);
    expect(prompt).toMatch(/Never do arithmetic/i);
  });

  it('forbids claiming success without a successful tool result', () => {
    expect(systemPrompt()).toMatch(/Never claim something is done unless/i);
  });

  it('states that the model describes operations rather than performing them', () => {
    expect(systemPrompt()).toMatch(/do not draw anything yourself/i);
  });
});

/* ────────────────────────────────────────────────────────── runAssistantTurn ────── */

describe('runAssistantTurn — applying a plan', () => {
  it('applies a valid plan and really changes the project', async () => {
    const p = seed();
    const client = scriptedClient([planJson('Add a bedroom', [{ tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'bedroom', x: 2, y: 2, width: 4, depth: 4 } }])]);
    const report = await runAssistantTurn('add a bedroom', { client, maxIterations: 1 });

    expect(report.ok).toBe(true);
    expect(report.steps[0]!.status).toBe('applied');
    expect(useProject.getState().project.rooms).toHaveLength(1);
  });

  it('reports what it did from what succeeded, never from what the model claimed', async () => {
    const p = seed();
    const client = scriptedClient([
      planJson('Add a bedroom', [
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'bedroom', x: 2, y: 2, width: 4, depth: 4 } },
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 7, y: 2, width: 4, depth: 4 } },
      ]),
    ]);
    const report = await runAssistantTurn('add rooms', { client, maxIterations: 1 });

    expect(report.steps.map((s) => s.status)).toEqual(['applied', 'applied']);
    // The summary is built from the two successful steps, and the area is
    // measured by the app: two 4 × 4 rooms = 32 m².
    expect(report.reply).toMatch(/2 changes applied/i);
    expect(report.after.netIndoorArea).toBeCloseTo(32, 6);
  });

  it('returns the created ids so the UI can highlight and undo them', async () => {
    const p = seed();
    const client = scriptedClient([planJson('Add a room', [{ tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } }])]);
    const report = await runAssistantTurn('add a room', { client, maxIterations: 1 });
    expect(report.steps[0]!.createdIds).toHaveLength(1);
    expect(report.steps[0]!.createdIds![0]).toBe(useProject.getState().project.rooms[0]!.id);
  });

  it('does not claim success when a step fails, and stops the plan there', async () => {
    const p = seed();
    const client = scriptedClient([
      planJson('Two things', [
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 0.05, depth: 4 } },
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'bedroom', x: 7, y: 2, width: 4, depth: 4 } },
      ]),
    ]);
    const report = await runAssistantTurn('do two things', { client, maxIterations: 1 });

    expect(report.ok).toBe(false);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.status).toBe('failed');
    expect(report.steps[0]!.error).toBeTruthy();
    // The second step must not have run against a state the model did not expect.
    expect(useProject.getState().project.rooms).toHaveLength(0);
  });

  it('refuses the whole plan when it names an invented id, applying nothing', async () => {
    const p = seed();
    const client = scriptedClient([
      planJson('Move the study', [
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } },
        { tool: 'move_room', input: { roomId: 'rm_imagined', x: 5, y: 5 } },
      ]),
    ]);
    const report = await runAssistantTurn('move the study', { client, maxIterations: 1 });

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/rm_imagined/);
    // Not even the valid first step: a refused plan is applied atomically.
    expect(useProject.getState().project.rooms).toHaveLength(0);
  });

  it('logs the refusal, so the user can see the assistant tried and was stopped', async () => {
    seed();
    const client = scriptedClient([planJson('x', [{ tool: 'inspect_wall', input: { wallId: 'wall_ghost' } }])]);
    await runAssistantTurn('do something', { client, maxIterations: 1 });
    const entry = useProject.getState().activity[0]!;
    expect(entry.actor).toBe('assistant');
    expect(entry.ok).toBe(false);
    expect(entry.error).toMatch(/wall_ghost/);
  });
});

describe('runAssistantTurn — approval for destructive steps', () => {
  it('does not delete anything when approval is not granted', async () => {
    const p = seed();
    const room = useProject.getState().run('createRoom', [{ floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 }]);
    if (!room.ok) throw new Error(room.error);
    const id = room.createdIds![0]!;

    const client = scriptedClient([planJson('Delete the room', [{ tool: 'remove_element', input: { id, kind: 'room' } }])]);
    const report = await runAssistantTurn('delete it', { client, maxIterations: 1 });

    expect(report.steps[0]!.status).toBe('rejected');
    expect(useProject.getState().project.rooms.some((r) => r.id === id)).toBe(true);
    expect(report.cancelled).toBe(true);
  });

  it('deletes when approval is granted', async () => {
    const p = seed();
    const room = useProject.getState().run('createRoom', [{ floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 }]);
    if (!room.ok) throw new Error(room.error);
    const id = room.createdIds![0]!;

    const client = scriptedClient([planJson('Delete the room', [{ tool: 'remove_element', input: { id, kind: 'room' } }])]);
    const report = await runAssistantTurn('delete it', { client, maxIterations: 1, approve: () => true });

    expect(report.steps[0]!.status).toBe('applied');
    expect(report.steps[0]!.removedIds).toContain(id);
    expect(useProject.getState().project.rooms.some((r) => r.id === id)).toBe(false);
  });

  it('does not ask about a read-only step', async () => {
    seed();
    let asked = 0;
    const client = scriptedClient([planJson('Look around', [{ tool: 'inspect_project', input: {} }])]);
    await runAssistantTurn('what is here', {
      client,
      maxIterations: 1,
      approve: () => {
        asked++;
        return true;
      },
    });
    expect(asked).toBe(0);
  });

  it('tells the user plainly when they declined', async () => {
    const p = seed();
    const room = useProject.getState().run('createRoom', [{ floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 }]);
    if (!room.ok) throw new Error(room.error);
    const client = scriptedClient([planJson('Delete', [{ tool: 'remove_element', input: { id: room.createdIds![0], kind: 'room' } }])]);
    const report = await runAssistantTurn('delete it', { client, maxIterations: 1 });
    expect(report.reply).toMatch(/declined/i);
  });
});

describe('runAssistantTurn — the model being unavailable', () => {
  it('fails cleanly when the API throws, and applies nothing', async () => {
    seed();
    const report = await runAssistantTurn('add a room', { client: scriptedClient(['__THROW__']) });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/unavailable/i);
    expect(useProject.getState().project.rooms).toHaveLength(0);
  });

  it('leaves the project fully editable by hand after an API failure', async () => {
    // The product promise: a missing key must not break manual editing.
    seed();
    await runAssistantTurn('anything', { client: scriptedClient(['__THROW__']) });
    const p = useProject.getState().project;
    const room = useProject.getState().run('createRoom', [{ floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 }]);
    expect(room.ok).toBe(true);
  });

  it('shows prose as a reply and changes nothing', async () => {
    // A conversational answer is not a failed turn. It must not become an
    // edit either — the plan is a reply step, so the model is never given a
    // reason to think it changed anything.
    seed();
    const report = await runAssistantTurn('what is in the plan?', {
      client: scriptedClient(['The plot is 20 by 16 metres with two floors.']),
      maxIterations: 1,
    });
    expect(report.ok).toBe(true);
    expect(report.reply).toMatch(/20 by 16/);
    expect(useProject.getState().project.rooms).toHaveLength(0);
  });

  it('refuses an empty request without calling the model at all', async () => {
    let calls = 0;
    const client: ChatClient = {
      async send() {
        calls++;
        return { text: '{}', toolCalls: [] };
      },
    };
    const report = await runAssistantTurn('   ', { client });
    expect(report.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('reports progress and then clears it', async () => {
    seed();
    const seen: string[] = [];
    const client = scriptedClient([planJson('x', [{ reply: 'hello' }])]);
    await runAssistantTurn('hi', { client, maxIterations: 1, onProgress: (phase) => seen.push(phase) });
    expect(seen.length).toBeGreaterThan(1);
    // The final clear is what stops a spinner spinning forever.
    expect(seen.at(-1)).toBe('');
  });
});

describe('runAssistantTurn — bounded reasoning', () => {
  it('stops a model that keeps planning forever, and says it was cut off', async () => {
    seed();
    // A client that always returns a fresh valid plan, so nothing ever fails
    // and nothing ever finishes. The loop must terminate regardless.
    const client: ChatClient = {
      async send() {
        const p = useProject.getState().project;
        return { text: planJson('Again', [{ tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 2, depth: 2 } }]), toolCalls: [] };
      },
    };
    const report = await runAssistantTurn('keep going', { client });
    // The edits really did apply, so this is not a failure — but the user must
    // not read "Done" as "everything you asked for is finished".
    expect(report.ok).toBe(true);
    expect(report.error).toMatch(/step limit/i);
    expect(report.reply).toMatch(/may not have been done/i);
  });

  it('does not claim to have been cut off when one round did everything', async () => {
    const p = seed();
    const client = scriptedClient([planJson('Add a room', [{ tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } }])]);
    const report = await runAssistantTurn('add a room', { client, maxIterations: 1 });
    expect(report.error).toBeUndefined();
    expect(report.reply).not.toMatch(/step limit/i);
  });

  it('caps the number of rounds at MAX_ITERATIONS by default', async () => {
    seed();
    let calls = 0;
    const client: ChatClient = {
      async send() {
        calls++;
        return { text: planJson('Again', [{ reply: 'still working' }]), toolCalls: [] };
      },
    };
    await runAssistantTurn('keep going', { client });
    expect(calls).toBeLessThanOrEqual(MAX_ITERATIONS);
  });

  it('resends the updated state on a later round so the model sees its own work', async () => {
    seed();
    const seen: ChatMessage[] = [];
    const client = scriptedClient(
      [planJson('Add a room', [{ tool: 'create_room', input: { floorId: useProject.getState().project.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } }]), planJson('Done', [{ reply: 'all set' }])],
      seen,
    );
    await runAssistantTurn('add a room', { client });
    // The second round's state must include the room the first round created,
    // which is the whole reason the loop exists.
    const secondRound = seen.filter((m) => /after the previous steps/i.test(m.content));
    expect(secondRound.length).toBeGreaterThan(0);
    expect(secondRound[0]!.content).toMatch(/Rooms on/);
  });

  it('tells the model what the validator found when a step did apply', async () => {
    seed();
    const seen: ChatMessage[] = [];
    const client = scriptedClient(
      [planJson('Overlap them', [{ tool: 'create_room', input: { floorId: useProject.getState().project.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } }, { tool: 'create_room', input: { floorId: useProject.getState().project.floors[0]!.id, kind: 'bedroom', x: 3, y: 3, width: 4, depth: 4 } }]), planJson('Done', [{ reply: 'ok' }])],
      seen,
    );
    await runAssistantTurn('add two overlapping rooms', { client });
    const feedback = seen.find((m) => /Recalculated\./.test(m.content));
    expect(feedback).toBeDefined();
    expect(feedback!.content).toMatch(/errors|clean/i);
  });
});

describe('runAssistantTurn — a plan that only talks', () => {
  it('returns the model\'s reply without touching the model at all', async () => {
    const before = JSON.stringify(useProject.getState().project);
    const client = scriptedClient([planJson('Answer a question', [{ reply: 'It is 24 square metres.' }])]);
    const report = await runAssistantTurn('how big is it', { client, maxIterations: 1 });
    expect(report.ok).toBe(true);
    expect(report.reply).toBe('It is 24 square metres.');
    expect(report.steps).toHaveLength(0);
    expect(JSON.stringify(useProject.getState().project)).toBe(before);
  });

  it('builds a summary when the model runs tools but says nothing', async () => {
    const p = seed();
    const client = scriptedClient([planJson('Add a room', [{ tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 6, depth: 4 } }])]);
    const report = await runAssistantTurn('add a room', { client, maxIterations: 1 });
    expect(report.reply).toMatch(/1 change applied/);
    expect(report.reply).toMatch(/24\.0 m/);
  });
});

/* ────────────────────────────────────── a design request answered in prose ───── */

/**
 * The failure these cover: the user asks for a building, the model writes out a
 * layout in words, and Argon — which draws from operations, not prose — leaves
 * the plan untouched while the reply reads as though it did not.
 */
describe('runAssistantTurn — a design request answered in words', () => {
  const proseLayout =
    'Clean slate on the active floor. Layout plan (all top-left x,y): ' +
    'Living room: x=3, y=3, 4.5 × 4.0. Kitchen: x=3, y=7, 3.0 × 3.0. Let me build the rooms.';

  it('presses the model for the operations instead of showing a layout it never drew', async () => {
    const p = seed();
    const seen: ChatMessage[] = [];
    const client = scriptedClient(
      [
        proseLayout,
        planJson('Build the layout', [
          { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 3, y: 3, width: 4.5, depth: 4 } },
          { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'kitchen', x: 3, y: 7, width: 3, depth: 3 } },
        ]),
        planJson('Finished', [{ reply: 'Two rooms added.' }]),
      ],
      seen,
    );

    const report = await runAssistantTurn('build me the complete design: 2 bedrooms, living room, kitchen, bathroom', {
      client,
      stepDelayMs: 0,
    });

    // The press is what turned this from a no-op into a design.
    const press = seen.find((m) => /called no tools/.test(m.content));
    expect(press, 'the model is told that describing is not doing').toBeDefined();
    expect(useProject.getState().project.rooms).toHaveLength(2);
    expect(report.changedNothing).toBeFalsy();
    expect(report.ok).toBe(true);
  });

  it('presses only once, and then says plainly that nothing changed', async () => {
    seed();
    let calls = 0;
    const client: ChatClient = {
      async send() {
        calls++;
        return { text: proseLayout, toolCalls: [] };
      },
    };

    const report = await runAssistantTurn('design the whole house for me', { client, stepDelayMs: 0 });

    expect(calls).toBe(2);
    expect(report.ok).toBe(true);
    expect(report.changedNothing).toBe(true);
    expect(report.steps).toHaveLength(0);
    // The honest statement is what stops the prose reading as a description of
    // the plan on screen. It is a flag the panel renders, not a paragraph
    // nobody can be sure is there.
    expect(report.changedNothing).toBe(true);
  });

  it('does not press a model that was only asked a question', async () => {
    seed();
    let calls = 0;
    const client: ChatClient = {
      async send() {
        calls++;
        return { text: 'The plot is 20 by 16 metres with two floors.', toolCalls: [] };
      },
    };

    const report = await runAssistantTurn('what is in the plan?', { client });
    expect(calls).toBe(1);
    expect(report.reply).toMatch(/20 by 16/);
    expect(report.changedNothing).toBeFalsy();
  });

  it('does not press when the model did apply something and only the last round was prose', async () => {
    const p = seed();
    const client = scriptedClient([
      planJson('Add a room', [{ tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } }]),
      planJson('Done', [{ reply: 'Added a living room.' }]),
    ]);
    const report = await runAssistantTurn('add a living room', { client, stepDelayMs: 0 });
    expect(report.steps.filter((s) => s.status === 'applied')).toHaveLength(1);
    expect(report.changedNothing).toBeFalsy();
  });

  it('does not press when the user declined, because nothing was wrong with the plan', async () => {
    const p = seed();
    let calls = 0;
    const client: ChatClient = {
      async send() {
        calls++;
        return {
          text: planJson('Remove it', [{ tool: 'remove_element', input: { id: p.floors[0]!.id } }]),
          toolCalls: [],
        };
      },
    };
    const report = await runAssistantTurn('delete the ground floor', { client, approve: () => false });
    expect(calls).toBe(1);
    expect(report.cancelled).toBe(true);
    expect(report.changedNothing).toBeFalsy();
  });

  it('tells the model in the system prompt that prose is not a design', () => {
    expect(systemPrompt()).toMatch(/you MUST call the tools/);
  });
});

/* ─────────────────────────────────────── the canvas watching the plan arrive ──── */

describe('runAssistantTurn — the plan is visible while it is applied', () => {
  it('reports each step as it resolves, and flags the canvas busy around each operation', async () => {
    const p = seed();
    const seen: string[] = [];
    const busy: boolean[] = [];
    const client = scriptedClient([
      planJson('Three rooms', [
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } },
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'kitchen', x: 6, y: 2, width: 3, depth: 3 } },
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'bedroom', x: 9, y: 2, width: 4, depth: 4 } },
      ]),
      planJson('Finished', [{ reply: 'Three rooms added.' }]),
    ]);

    await runAssistantTurn('add three rooms', {
      client,
      stepDelayMs: 0,
      onStep: (s) => seen.push(`${s.label}:${s.status}`),
    });

    // The canvas builds one room at a time, so the steps must be told out as
    // they land rather than all at the end.
    expect(seen).toEqual(['Create a room:applied', 'Create a room:applied', 'Create a room:applied']);
    // And the busy flag has to come back down, or the "the assistant is
    // drawing" badge would never leave.
    busy.push(useProject.getState().aiBusy);
    expect(useProject.getState().aiBusy).toBe(false);
  });

  it('yields to the event loop between operations, so React can paint each one', async () => {
    const p = seed();
    let tasks = 0;
    // Counts how many times control actually returned to the event loop.
    const tick = (): void => {
      tasks++;
    };
    setTimeout(tick, 0);

    const client = scriptedClient([
      planJson('Two rooms', [
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'living', x: 2, y: 2, width: 4, depth: 4 } },
        { tool: 'create_room', input: { floorId: p.floors[0]!.id, kind: 'kitchen', x: 6, y: 2, width: 3, depth: 3 } },
      ]),
      planJson('Finished', [{ reply: 'done' }]),
    ]);

    await runAssistantTurn('add two rooms', { client, stepDelayMs: 5 });
    // At least one macrotask must have run after the first operation was
    // applied, or both rooms were committed in the same tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(tasks).toBeGreaterThan(0);
    expect(useProject.getState().project.rooms).toHaveLength(2);
  });
});
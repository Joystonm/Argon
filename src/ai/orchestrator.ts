/**
 * The orchestration pipeline.
 *
 * Ten steps, run as a bounded loop:
 *
 *   1. collect      the user's request
 *   2. retrieve     the current project state, compacted to what a model needs
 *   3. compact      a system prompt that states the units, the id rule and the ban on arithmetic
 *   4. plan         ask the model for a structured plan
 *   5. validate     strict schema validation of the plan itself
 *   6. preconditions check every id, dimension and reference against the live model
 *   7. apply        run the operations through the deterministic registry
 *   8. recalculate  re-run validation and measurement after every change
 *   9. report       structured success/failure back to the UI
 *  10. update       the UI shows what actually happened — and only that
 *
 * The loop repeats when the model asks for more tools, up to `maxIterations`.
 *
 * Three things it deliberately never does:
 *   · never sends the whole project on every turn (see `compactState`)
 *   · never asks the model for a number it can compute itself
 *   · never reports an edit as applied unless the operation succeeded
 */
import { measureBuilding } from '../model/measure.ts';
import { validate } from '../model/validate.ts';
import { formatArea } from '../model/geometry.ts';
import { DEFAULT_MATERIALS } from '../model/catalog.ts';
import { TOOLS_BY_NAME, runTool, toolDefinitionsForModel, type ToolOutcome } from '../tools/registry.ts';
import { useProject } from '../store/useProject.ts';
import type { Project } from '../model/types.ts';

export type PlanStep =
  | { tool: string; input: Record<string, unknown>; why?: string }
  | { reply: string };

export interface Plan {
  /** What the model intends to do, in its own words. */
  intent: string;
  steps: PlanStep[];
  /** True when the model believes the user must approve first. */
  needsApproval?: boolean;
}

export type StepStatus =
  | 'pending' | 'running' | 'applied' | 'failed' | 'skipped' | 'rejected' | 'awaiting-approval';

export interface StepReport {
  index: number;
  tool: string | null;
  label: string;
  status: StepStatus;
  summary?: string;
  error?: string;
  hint?: string;
  createdIds?: string[];
  removedIds?: string[];
}

export interface TurnReport {
  ok: boolean;
  /** The model's reply to show the user. Empty when it only ran tools. */
  reply: string;
  intent: string;
  steps: StepReport[];
  /** Measurements and issues measured after the last change — never by the model. */
  after: {
    netIndoorArea: number;
    footprintArea: number;
    plotCoverage: number;
    floorAreaRatio: number;
    errorCount: number;
    warningCount: number;
  };
  /** True when nothing ran because the user rejected the confirmation. */
  cancelled?: boolean;
  /**
   * True when the turn finished without a single operation being applied to a
   * design request.
   *
   * The model may still have written a perfectly good prose layout. Argon draws
   * from operations, not from words, so that layout is not on screen and the
   * panel says so rather than letting the reply read as a description of a
   * change that never happened.
   */
  changedNothing?: boolean;
  error?: string;
}

export type ProgressListener = (phase: string, detail?: string) => void;

/** The hard ceiling on tool-calling rounds in one turn. */
export const MAX_ITERATIONS = 6;

/* ───────────────────────────────────────────────────────── step 2 + 3 ────────── */

/**
 * The project state the model is allowed to see.
 *
 * This is the single biggest lever on token cost and on the model's honesty.
 * It is NOT the project: it is a compact summary plus, on request, the detail
 * of one floor. The full model is re-read from the store every turn anyway —
 * what this controls is what gets *sent*.
 *
 * A `revision` counter lets the client skip the round trip entirely when
 * nothing changed, which is what stops every small drag becoming a model call.
 */
export function compactState(project: Project, activeFloorId: string, includeFloorDetail: boolean): string {
  const floor = project.floors.find((f) => f.id === activeFloorId) ?? project.floors[0];
  const rooms = project.rooms.filter((r) => r.floorId === floor?.id);
  const walls = project.walls.filter((w) => w.floorId === floor?.id);
  const furniture = project.furniture.filter((f) => f.floorId === floor?.id);

  const sb = project.plot.setbacks;
  const m = measureBuilding(project);

  const head = [
    `Project "${project.name}". Units: METRES. Origin: the plot's north-west corner, x runs right, y runs DOWN (south).`,
    `Plot ${project.plot.width} × ${project.plot.depth}. Street on the ${{ 0: 'top (north)', 90: 'right (east)', 180: 'bottom (south)', 270: 'left (west)' }[project.plot.orientation]} edge.`,
    `Setbacks front/rear/left/right = ${sb.front}/${sb.rear}/${sb.left}/${sb.right}.`,
    `Floors: ${project.floors.map((f) => `${f.name}=${f.id} (storey ${f.order}, elevation ${f.elevation}, height ${f.height})`).join('; ')}.`,
    `Active floor: ${floor ? `${floor.name} = ${floor.id}` : 'none'}.`,
    `On the active floor: ${rooms.length} rooms, ${walls.length} walls, ${furniture.length} furniture items.`,
    `Measured now: net indoor ${m.netIndoorArea.toFixed(1)} m², footprint ${m.footprintArea.toFixed(1)} m², coverage ${(m.plotCoverage * 100).toFixed(1)}%, FAR ${m.floorAreaRatio.toFixed(2)}.`,
  ];

  if (!includeFloorDetail) return head.join('\n');

  const detail = [
    '',
    `Rooms on ${floor?.name}:`,
    ...rooms.map((r) => `  ${r.id}  ${r.label} (${r.kind})  x=${r.x} y=${r.y} w=${r.width} d=${r.depth}  ${(r.width * r.depth).toFixed(1)} m²`),
    `Walls on ${floor?.name}:`,
    ...walls.map((w) => {
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const ops = w.openings.map((o) => `${o.kind}@${o.offset.toFixed(2)}w${o.width}`).join(',');
      return `  ${w.id}  ${w.type}  (${w.a.x},${w.a.y})→(${w.b.x},${w.b.y})  ${len.toFixed(2)} m  ${w.thickness} thick${ops ? `  openings: ${ops}` : ''}`;
    }),
  ];

  return [...head, ...detail].join('\n');
}

/**
 * The system prompt.
 *
 * Short on purpose. It states the four things that actually stop the model
 * producing nonsense: the coordinate convention, the id rule, the ban on
 * arithmetic, and the fact that it is describing operations rather than
 * performing them.
 */
export function systemPrompt(): string {
  return [
    'You are the design assistant inside Argon, an architectural drafting tool.',
    'You do not draw anything yourself. You choose operations from the tools you are given, with real arguments, and Argon applies them to a real model and validates the result.',
    '',
    'Units are METRES throughout. The plan origin is the plot\'s north-west corner; x increases to the right, y increases DOWNWARD (south).',
    '',
    'Rules:',
    '1. Never invent an id. Every room, wall and item has an id that appears in the state you are shown. If you need one you have not seen, call list_rooms, get_floor_details or list_catalog first.',
    '2. Never do arithmetic to invent a measurement. If you need an area, a length, a total or a check, call calculate_room_area, calculate_building_areas or validate_floor_plan. Do not estimate and do not round into something you did not measure.',
    '3. Prefer editing an existing element over adding a duplicate.',
    '4. After a run of edits, call validate_floor_plan and read the result. If it reports errors, fix them rather than declaring success.',
    '5. Never claim something is done unless the tool result for it succeeded. If a tool returns an error, say what failed and what you would do instead.',
    '6. If the request needs something destructive or ambiguous, say so in your reply and stop — do not plan the destructive part.',
    '7. If the user asks for the building to be built, designed, laid out, extended or changed in any way, you MUST call the tools. Writing the layout out in words — "living room at x=3, 4.5 by 4.0", "here is my plan" — changes nothing, because Argon only redraws the plan from operations that actually ran. Prose belongs in "reply", alongside the tool steps that do the work, never instead of them.',
    '',
    'Respond with JSON only, matching this shape:',
    '{"intent":"one sentence","steps":[{"tool":"tool_name","input":{...},"why":"short reason"}],"reply":"what you will tell the user, in plain language"}',
    'Use exactly one step of {"reply":"..."} on its own ONLY when the user asked a question and no change is wanted. Every request to change the building is answered with tool steps.',
  ].join('\n');
}

/**
 * True when the request asks for the building to change rather than for
 * information about it.
 *
 * This is a heuristic and it is only ever used to decide whether a turn which
 * applied nothing should be pressed once more for the operations it failed to
 * call. The bias is toward "yes" for the verbs that only ever mean editing, and
 * toward "no" for the ones that also turn up in questions — "what should I
 * make the bedroom?" must not cost a wasted round trip, while "build me the
 * complete design" must not be allowed to answer in prose and change nothing.
 */
const EDIT_VERB =
  /\b(build|design|redesign|re-?design|lay\s?out|arrange|re-?arrange|fix|add|create|insert|place|put|move|shift|slide|resize|enlarge|shrink|extend|stretch|rotate|swap|delete|remove|open|connect|link|fill|split|merge|convert|draw)\b/i;
/** Words that describe a building but are also ordinary English questions. */
const AMBIGUOUS_EDIT = /\b(plan|layout|change|set|make|redesign)\b/i;

export function isDesignRequest(request: string): boolean {
  const text = request.trim();
  if (EDIT_VERB.test(text)) return true;
  return AMBIGUOUS_EDIT.test(text) && !looksLikeAQuestion(text);
}

function looksLikeAQuestion(text: string): boolean {
  return (
    /\?\s*$/.test(text) ||
    /^(what|which|how|why|who|when|where|is|are|was|were|can|could|does|do|did|has|have|will|would|should|tell me|explain|describe)\b/i.test(text)
  );
}

/* ────────────────────────────────────────────────────────── step 5 ──────────── */

/**
 * Strict validation of the model's plan.
 *
 * Parsing is attempted from the text first because models wrap JSON in prose
 * and fences. If no JSON plan is found, native `tool_use` calls are read as the
 * plan instead — see below. Anything that is neither is an error, not a guess.
 *
 * Both styles arrive in practice. MiniMax-M3, offered the typed tool registry,
 * answers in tool calls rather than JSON; that was confirmed against the live
 * service, not assumed.
 */
export function parsePlan(
  text: string,
  toolCalls: ToolCall[] = [],
): { ok: true; plan: Plan } | { ok: false; error: string } {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  if (text.trim().startsWith('{')) candidates.push(text.trim());

  // Candidates are ordered most-specific first, so the first *shape* failure is
  // the most useful one to report. It must not be thrown away: "no tool called
  // X" is the difference between a fixable prompt bug and a mystery.
  let shapeError: string | null = null;
  let sawJson = false;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    sawJson = true;
    const validated = validatePlanShape(parsed);
    if (validated.ok) return validated;
    shapeError ??= validated.error;
  }

  // No JSON plan — but the model may have answered natively, in tool calls.
  // That is a plan, not a failure, and it goes through the identical shape
  // validator, so an unknown tool name, a missing required argument or a
  // malformed call is refused exactly as it would be in JSON.
  //
  // Speech calls are not filtered out here: `validatePlanShape` maps them, and
  // one implementation is easier to keep honest than two.
  if (toolCalls.length) {
    const operations = toolCalls.filter((c) => !SPEECH_TOOLS.has(c.name.toLowerCase()));
    const steps: unknown[] = toolCalls.map((c) => ({ tool: c.name, input: c.input }));
    // Prose alongside tool calls is the model narrating mid-turn, not the
    // turn's answer — the reply is composed afterwards from what the operations
    // actually returned. With no operations at all, the prose is all there is.
    if (!operations.length && text) steps.push({ tool: 'reply', input: { reply: text } });

    const assembled = {
      intent: text ? firstSentence(text) : `Apply ${operations.length} change${operations.length === 1 ? '' : 's'}.`,
      steps,
    };
    return validatePlanShape(assembled);
  }

  // Neither JSON nor tool calls: the model answered in prose. Prose can only
  // ever become a reply, never an edit, so accepting it cannot make the app
  // claim a change that did not happen — it only stops a conversational turn
  // ("how many bedrooms?") from being reported as a failure to understand.
  //
  // Not reached when JSON *was* parsed and rejected: a model that emitted a
  // malformed plan should be told what was wrong with it, not have its plan
  // quietly reinterpreted as small talk.
  if (!sawJson && text.trim()) {
    return validatePlanShape({ intent: firstSentence(text), steps: [{ reply: text.trim() }] });
  }

  return { ok: false, error: shapeError ?? 'The assistant did not return a plan in the expected JSON shape.' };
}

/**
 * Tool names the model uses to speak rather than to act. Mapped to a reply
 * step; anything outside this set is still an unknown tool and still refused.
 */
const SPEECH_TOOLS = new Set(['reply', 'respond', 'final_answer', 'say', 'answer']);

/** The message inside a speech-shaped call, whatever the model called the field. */
function speechText(input: Record<string, unknown>): string {
  for (const key of ['reply', 'text', 'message', 'content', 'answer', 'response']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** The model's opening sentence, trimmed to something that reads as an intent. */
function firstSentence(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  const stop = clean.search(/[.!?](\s|$)/);
  const first = stop > 0 ? clean.slice(0, stop + 1) : clean;
  return (first || clean).slice(0, 200);
}

function validatePlanShape(value: unknown): { ok: true; plan: Plan } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'A plan must be a JSON object.' };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.intent !== 'string' || !obj.intent.trim()) return { ok: false, error: 'A plan needs an "intent".' };
  if (!Array.isArray(obj.steps)) return { ok: false, error: 'A plan needs a "steps" array.' };
  if (obj.steps.length === 0) return { ok: false, error: 'A plan needs at least one step.' };
  if (obj.steps.length > 40) return { ok: false, error: 'A plan may not exceed 40 steps.' };

  const steps: PlanStep[] = [];
  for (const raw of obj.steps) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Every step must be an object.' };
    const s = raw as Record<string, unknown>;

    if (typeof s.tool === 'string' && s.tool.length > 0) {
      // Speech is mapped here, in the one validator both answer styles pass
      // through, rather than in the parser above — because the model puts a
      // tool named "reply" in JSON as readily as it emits a tool_use block for
      // one, and it was the JSON route that kept failing.
      if (SPEECH_TOOLS.has(s.tool.toLowerCase())) {
        const said = speechText((s.input ?? {}) as Record<string, unknown>);
        if (said) steps.push({ reply: said });
        continue;
      }
      const spec = TOOLS_BY_NAME.get(s.tool);
      if (!spec) return { ok: false, error: `There is no tool called "${s.tool}".` };
      const input = s.input === undefined ? {} : s.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: `The input for "${s.tool}" must be an object.` };
      }
      // Required arguments are checked here, before anything is applied, so a
      // malformed plan fails as a whole rather than half-executing.
      const missing = (spec.input.required ?? []).filter((k) => (input as Record<string, unknown>)[k] === undefined);
      if (missing.length) {
        return { ok: false, error: `"${s.tool}" is missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` };
      }
      steps.push({ tool: s.tool, input: input as Record<string, unknown>, why: typeof s.why === 'string' ? s.why : undefined });
      continue;
    }

    if (typeof s.reply === 'string' && s.reply.trim()) {
      steps.push({ reply: s.reply });
      continue;
    }

    return { ok: false, error: 'Every step must be either {tool,input} or {reply}.' };
  }

  return {
    ok: true,
    plan: { intent: obj.intent, steps, needsApproval: obj.needsApproval === true },
  };
}

/* ────────────────────────────────────────────────────────── step 6 ──────────── */

/**
 * Preconditions, checked against the live project before anything runs.
 *
 * This is where "the model invented an id" becomes a clean refusal instead of
 * a half-applied edit. It also catches the cheap mistakes worth catching
 * early: a room placed outside the plot, a door in a wall too short for it.
 */
export function checkPreconditions(project: Project, plan: Plan): string[] {
  const problems: string[] = [];

  for (const step of plan.steps) {
    if (!('tool' in step)) continue;
    const { tool, input } = step;
    switch (tool) {
      case 'create_room': {
        const b = project.plot;
        const w = Number(input.width);
        const d = Number(input.depth);
        const x = Number(input.x);
        const y = Number(input.y);
        if (x < 0 || y < 0 || x + w > b.width || y + d > b.depth) {
          problems.push(`create_room: a room at (${x}, ${y}) sized ${w}×${d} would fall outside the ${b.width}×${b.depth} plot.`);
        }
        if (w <= 0 || d <= 0) problems.push(`create_room: width and depth must be positive.`);
        break;
      }
      case 'create_wall': {
        const a = input.a as { x?: number; y?: number } | undefined;
        const b2 = input.b as { x?: number; y?: number } | undefined;
        if (!a || !b2 || !Number.isFinite(Number(a?.x)) || !Number.isFinite(Number(b2?.x))) {
          problems.push('create_wall: both endpoints a and b are required as {x,y}.');
          break;
        }
        const len = Math.hypot(Number(b2!.x) - Number(a!.x), Number(b2!.y) - Number(a!.y));
        if (len < 0.05) problems.push(`create_wall: a zero-length wall (${len.toFixed(3)} m) is not a wall.`);
        break;
      }
      case 'add_door':
      case 'add_window':
      case 'inspect_wall':
      case 'move_wall':
      case 'add_staircase':
      case 'move_furniture':
      case 'remove_element': {
        // Which argument carries the id differs per tool, and getting this
        // wrong silently refuses every plan that uses the tool — so it is
        // spelled out per tool rather than derived.
        const idField: Record<string, string> = {
          move_wall: 'wallId',
          move_furniture: 'itemId',
          add_staircase: 'floorId',
          remove_element: 'id',
          add_door: 'wallId',
          add_window: 'wallId',
          inspect_wall: 'wallId',
        };
        const id = String(input[idField[tool] ?? 'id'] ?? '');
        const exists =
          project.walls.some((w) => w.id === id) ||
          project.floors.some((f) => f.id === id) ||
          project.furniture.some((f) => f.id === id) ||
          project.rooms.some((r) => r.id === id) ||
          project.outdoor.some((o) => o.id === id) ||
          project.stairs.some((s) => s.id === id);
        if (!exists) problems.push(`${tool}: no element has id "${id}". It may not exist — list what is there first.`);

        // An opening is identified by its own id but lives inside a wall, so
        // removing one genuinely needs both.
        if (tool === 'remove_element' && String(input.kind) === 'opening') {
          const wallId = String(input.wallId ?? '');
          if (!project.walls.some((w) => w.id === wallId)) {
            problems.push(`remove_element: removing an opening also needs "wallId", and there is no wall "${wallId}".`);
          }
        }
        break;
      }
      case 'resize_room':
      case 'move_room':
      case 'inspect_room':
      case 'calculate_room_area': {
        const id = String(input.roomId ?? '');
        if (!project.rooms.some((r) => r.id === id)) problems.push(`${tool}: no room has id "${id}".`);
        break;
      }
      case 'apply_material': {
        const materialId = String(input.materialId ?? '');
        if (!DEFAULT_MATERIALS[materialId]) problems.push(`apply_material: there is no material called "${materialId}".`);
        const elementId = String(input.elementId ?? '');
        if (elementId) {
          const found =
            project.rooms.some((r) => r.id === elementId) || project.walls.some((w) => w.id === elementId);
          if (!found) problems.push(`apply_material: no room or wall has id "${elementId}".`);
        }
        break;
      }
      case 'regenerate_floor':
      case 'get_floor_details':
      case 'list_rooms': {
        if (input.floorId && !project.floors.some((f) => f.id === String(input.floorId))) {
          problems.push(`${tool}: no floor has id "${String(input.floorId)}".`);
        }
        break;
      }
      default:
        break;
    }
  }
  return problems;
}

/* ────────────────────────────────────────────────────────── step 4 ──────────── */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool call the model made natively, as opposed to one it wrote into JSON. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * One turn's worth of content.
 *
 * Both halves matter. A model that has been offered the tool registry may
 * answer in either style: a JSON plan in text, or `tool_use` blocks. MiniMax-M3
 * does the latter — verified against the live service, where a request carrying
 * the registry came back as prose plus a `tool_use` block, and the prose alone
 * was not the plan. Keeping only the text is what made the assistant report
 * "did not return a plan in the expected JSON shape" against a model that had
 * in fact answered perfectly well.
 */
export interface ChatReply {
  text: string;
  toolCalls: ToolCall[];
}

export interface ChatClient {
  send(payload: {
    system: string;
    messages: ChatMessage[];
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<ChatReply>;
}

/**
 * The client for this app's own `/api/chat`.
 *
 * The API key never appears here, in this module, or anywhere else in the
 * bundle — the browser cannot see it, and this request goes to the same origin
 * as the app.
 */
export const browserChatClient: ChatClient = {
  async send({ system, messages, maxTokens, signal }) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        system,
        messages,
        max_tokens: maxTokens,
        tools: toolDefinitionsForModel(),
        // The prompt asks for JSON and the registry is offered alongside it, so
        // either style of answer is accepted — see `parsePlan`. What is *not*
        // offered is the ability to skip validation: whatever comes back is
        // parsed into the same Plan, checked by the same shape validator, and
        // applied through the same registry as a click-to-fix correction.
        effort: 'medium',
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `The assistant request failed with HTTP ${res.status}.`);
    }

    const message = (await res.json()) as {
      content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
    };
    const blocks = message.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();

    // An unknown block type is ignored rather than trusted: only `tool_use`
    // blocks with a name become calls.
    const toolCalls: ToolCall[] = [];
    for (const b of blocks) {
      if (b.type !== 'tool_use' || typeof b.name !== 'string' || !b.name) continue;
      const input = b.input;
      toolCalls.push({
        name: b.name,
        input: input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
      });
    }

    if (!text && toolCalls.length === 0) {
      throw new Error('The assistant returned an empty response.');
    }
    return { text, toolCalls };
  },
};

/* ─────────────────────────────────────────────────────── the turn itself ────── */

/**
 * Runs one assistant turn: collect, plan, validate, check, apply, recalculate,
 * report.
 */
export async function runAssistantTurn(
  request: string,
  options: {
    client?: ChatClient;
    signal?: AbortSignal;
    onProgress?: ProgressListener;
    /** Called as each step resolves, so the panel can list work while it lands. */
    onStep?(step: StepReport): void;
    /** When false, destructive steps are reported as needing approval, not run. */
    approve?(step: PlanStep, plan: Plan): boolean | Promise<boolean>;
    maxIterations?: number;
    /** Milliseconds the plan pauses between operations so the canvas can show it. */
    stepDelayMs?: number;
  } = {},
): Promise<TurnReport> {
  const client = options.client ?? browserChatClient;
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const store = useProject.getState();
  const progress = options.onProgress ?? (() => {});
  const onStep = options.onStep ?? (() => {});
  const stepDelay = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
  const steps: StepReport[] = [];
  const transcript: ChatMessage[] = [{ role: 'user', content: request }];
  let pressedForTools = false;
  let reply = '';
  let intent = '';

  progress('Reading the project…');
  const after = () => measureAndCount();
  const emptyReport = (over: Partial<TurnReport> = {}): TurnReport => ({
    ok: false,
    reply: '',
    intent,
    steps,
    after: after(),
    ...over,
  });

  if (!request.trim()) return emptyReport({ error: 'Say what you would like changed.' });

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    progress('Asking the assistant for a plan…');

    // ── steps 2 + 3: state and prompt ──
    const project = useProject.getState().project;
    const state = compactState(project, useProject.getState().activeFloorId, true);
    const userContent =
      iteration === 0
        ? `CURRENT PROJECT STATE\n${state}\n\nREQUEST\n${request}`
        : `CURRENT PROJECT STATE (after the previous steps)\n${state}\n\nReport on what you have done so far, call further tools if something is still wrong, or reply with your final answer.`;

    let answer: ChatReply;
    try {
      answer = await client.send({
        system: systemPrompt(),
        messages: [...transcript, { role: 'user', content: userContent }],
        maxTokens: 2048,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      progress('The assistant is unavailable.');
      return emptyReport({ error: message });
    }

    // The transcript is plain text by design — the app does not replay tool
    // blocks — so the model's words are what goes back into history.
    transcript.push({ role: 'assistant', content: answer.text });

    // ── step 5: strict validation ──
    progress('Checking the plan…');
    const parsed = parsePlan(answer.text, answer.toolCalls);
    if (!parsed.ok) {
      progress('');
      return emptyReport({ error: parsed.error });
    }
    intent = parsed.plan.intent;

    // ── step 6: preconditions ──
    progress('Checking the plan against the model…');
    const problems = checkPreconditions(project, parsed.plan);
    if (problems.length) {
      progress('');
      const message = `The plan was not applied because it would not have worked:\n• ${problems.join('\n• ')}`;
      store.log({ actor: 'assistant', label: 'Plan refused', ok: false, error: problems[0] });
      return emptyReport({ error: message, reply: message });
    }

    // ── step 7: apply ──
    let ranAnything = false;
    let failed = false;

    for (const [index, step] of parsed.plan.steps.entries()) {
      if (!('tool' in step)) {
        reply = step.reply;
        continue;
      }

      const spec = TOOLS_BY_NAME.get(step.tool)!;

      if (spec.permission === 'destructive') {
        const approved = options.approve ? await options.approve(step, parsed.plan) : false;
        if (!approved) {
          steps.push({ index, tool: step.tool, label: spec.title, status: 'rejected', summary: 'Declined by you.' });
          store.log({ actor: 'user', label: `Declined ${spec.title.toLowerCase()}`, ok: true });
          continue;
        }
      }

      progress(`Applying ${spec.title.toLowerCase()}…`);
      useProject.setState({ aiBusy: true });

      // The wait goes *before* the operation, not after it. Setting the flag and
      // clearing it around a synchronous call puts both in one task, so React
      // commits the room and the clearing together and neither the "the
      // assistant is drawing" badge nor the pause is ever painted. Pausing first
      // is what lets the badge appear, the canvas settle, and the next room
      // arrive somewhere the eye can follow it.
      await nextFrame(stepDelay);

      let outcome: ToolOutcome;
      try {
        outcome = runTool(step.tool, step.input, 'assistant');
      } finally {
        useProject.setState({ aiBusy: false });
      }

      // ── step 9: structured result ──
      const report: StepReport = outcome.ok
        ? {
            index,
            tool: step.tool,
            label: spec.title,
            status: 'applied',
            summary: outcome.summary,
            createdIds: outcome.createdIds,
            removedIds: outcome.removedIds,
          }
        : {
            index,
            tool: step.tool,
            label: spec.title,
            status: 'failed',
            error: outcome.error ?? 'Unknown failure.',
            hint: outcome.hint,
          };
      steps.push(report);
      onStep(report);

      if (outcome.ok) {
        ranAnything = true;
        transcript.push({ role: 'user', content: `${step.tool} succeeded: ${outcome.summary}` });
      } else {
        failed = true;
        transcript.push({ role: 'user', content: `${step.tool} failed: ${outcome.error}. ${outcome.hint ?? ''}` });
        // Stop the plan here. Continuing after a failed step would apply the
        // rest against a state the model did not expect.
        break;
      }
    }

    // ── step 8: recalculate ──
    progress('Recalculating…');
    const measurements = after();

    if (failed) {
      progress('');
      const failedStep = steps.find((s) => s.status === 'failed');
      const message = failedStep?.error ?? 'An operation failed.';
      store.log({ actor: 'assistant', label: 'Turn failed', ok: false, error: message });
      return { ok: false, reply: reply || `I could not finish that: ${message}`, intent, steps, after: measurements, error: message };
    }

    if (ranAnything) {
      // Let the model check its own work — this is the loop that makes the
      // assistant reliable rather than merely fluent.
      if (iteration < maxIterations - 1) {
        const issues = validate(useProject.getState().project);
        transcript.push({
          role: 'user',
          content:
            `Recalculated. ${measurements.errorCount} errors, ${measurements.warningCount} warnings. ` +
            (issues.length
              ? `Issues: ${issues.slice(0, 10).map((i) => i.message).join(' ')}`
              : 'The plan is clean.') +
            ' Fix anything outstanding, or give your final reply.',
        });
        continue;
      }

      // The budget ran out while the model was still editing on a *later*
      // round, which means it had not reached a stopping point of its own
      // accord. Say so rather than letting "Done —" imply the whole request
      // was finished. A first round that does everything is not a cut-off, so
      // it is not flagged.
      progress('');
      const cutOff = iteration > 0;
      const note = cutOff
        ? `The assistant reached its step limit of ${maxIterations} rounds while still making changes. Everything it did apply is listed above, but some of what you asked for may not have been done.`
        : '';
      store.log({ actor: 'assistant', label: intent || 'Assistant turn', ok: true, opCount: steps.filter((s) => s.status === 'applied').length });
      return {
        ok: true,
        reply: [reply, defaultReply(steps, measurements), note].filter(Boolean).join('\n\n'),
        intent,
        steps,
        after: measurements,
        ...(cutOff ? { error: note } : {}),
      };
    }

    const cancelled = steps.some((s) => s.status === 'rejected') && !ranAnything;
    const appliedCount = steps.filter((s) => s.status === 'applied').length;
    // A design request answered in prose has changed nothing at all. Rather
    // than hand the panel a layout the app never drew, press once — firmly, and
    // naming the failure — for the tool calls. One press only: a model that
    // answers in prose twice is answering in prose, and a third round would
    // only spend money on the same sentence.
    //
    // It also needs a round left to spend. Pressing on the last iteration would
    // fall straight out of the loop and be reported as "reached the step limit",
    // which is a different and untrue thing to say.
    if (iteration < maxIterations - 1 && !cancelled && !pressedForTools && appliedCount === 0 && isDesignRequest(request)) {
      pressedForTools = true;
      progress('Nothing was changed — asking for the operations…');
      transcript.push({
        role: 'user',
        content:
          'Nothing has been changed: you described a design in words but called no tools, and Argon only redraws the plan from operations that actually ran. ' +
          'Call the tools now — one per room, wall, opening or item — and put your explanation in "reply" alongside them. ' +
          'If the request genuinely cannot be turned into operations, say which part and why.',
      });
      reply = '';
      continue;
    }

    progress('');
    const changedNothing = !cancelled && appliedCount === 0 && isDesignRequest(request);
    store.log({
      actor: 'assistant',
      label: intent || 'Assistant turn',
      ok: true,
      opCount: appliedCount,
    });
    return {
      ok: true,
      reply: reply || defaultReply(steps, measurements),
      intent,
      steps,
      after: measurements,
      ...(cancelled ? { cancelled: true } : {}),
      ...(changedNothing ? { changedNothing: true } : {}),
    };
  }

  progress('');
  return emptyReport({ error: 'The assistant reached the step limit without finishing. Nothing further was applied.' });
}

/** How long a plan pauses before each operation when the caller sets no delay. */
export const DEFAULT_STEP_DELAY_MS = 110;

/**
 * Waits for a painted frame, then for `ms`.
 *
 * The animation frame is what lets React commit whatever the last operation
 * changed; the timeout is what makes the pause long enough to read. Both are
 * skipped when they do not exist — the orchestrator's unit tests run in node,
 * where there is no frame to wait for.
 */
async function nextFrame(ms: number): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/* ───────────────────────────────────────────────────────── step 10 ─────────── */

/**
 * The reply shown when the model ran tools but said nothing itself.
 *
 * It is built from what actually succeeded and from numbers the app measured —
 * never from anything the model asserted. If a step failed, it is named.
 */
function defaultReply(steps: StepReport[], measurements: ReturnType<typeof measureAndCount>): string {
  const applied = steps.filter((s) => s.status === 'applied');
  const failed = steps.filter((s) => s.status === 'failed');
  const rejected = steps.filter((s) => s.status === 'rejected');

  const lines: string[] = [];
  if (applied.length) {
    lines.push(`Done — ${applied.length} change${applied.length === 1 ? '' : 's'} applied:`);
    for (const s of applied) lines.push(`· ${s.label}: ${s.summary ?? 'applied'}`);
  }
  if (rejected.length) lines.push(`You declined ${rejected.length} destructive step${rejected.length === 1 ? '' : 's'}, so nothing was changed for ${rejected.length === 1 ? 'it' : 'those'}.`);
  if (failed.length) lines.push(`Stopped after ${failed[0].label} failed: ${failed[0].error}`);

  lines.push(
    `The plan now measures ${formatArea(measurements.netIndoorArea, 'm')} net indoor, ${(measurements.plotCoverage * 100).toFixed(1)}% coverage and FAR ${measurements.floorAreaRatio.toFixed(2)}. ` +
      (measurements.errorCount === 0
        ? 'No errors in the checks.'
        : `${measurements.errorCount} error${measurements.errorCount === 1 ? '' : 's'} still open in the Checks panel.`),
  );

  return lines.join('\n');
}

/** Step 8, made once: measurements and check counts straight from the model. */
export function measureAndCount() {
  const project = useProject.getState().project;
  const m = measureBuilding(project);
  const issues = validate(project);
  return {
    netIndoorArea: m.netIndoorArea,
    footprintArea: m.footprintArea,
    plotCoverage: m.plotCoverage,
    floorAreaRatio: m.floorAreaRatio,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
  };
}

/** Health of the AI backend, for the panel's status line. */
export async function aiHealth(): Promise<{ aiEnabled: boolean; model: string | null; endpoint: string | null; disabledByConfig: boolean }> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return { aiEnabled: false, model: null, endpoint: null, disabledByConfig: false };
    const body = (await res.json()) as { aiEnabled: boolean; model: string | null; endpoint: string | null; disabledByConfig: boolean };
    return body;
  } catch {
    return { aiEnabled: false, model: null, endpoint: null, disabledByConfig: false };
  }
}
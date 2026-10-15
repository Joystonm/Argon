# Argon

**AI Home Design Studio.** Describe a plot and what you need; get a real,
editable 2D floor plan; walk the building in 3D; check it against geometric
constraints; and let a language model propose changes that are validated and
applied through the same code the mouse uses.

Argon is not a viewer. Every room, wall, opening and piece of furniture is
project data, editable by hand or by the assistant, in one canonical model
that both the 2D plan and the 3D building are derived from.

> **Scope.** Argon produces early-design geometry. Generated plans are **not**
> construction-ready and are not professionally certified. Constraint
> thresholds are configurable sanity bounds, **not** rules from any
> jurisdiction — the app does not know where you are and does not pretend to.

---

## Quick start

Requires **Node 22.16 or newer** (the production server runs TypeScript
directly via `--experimental-strip-types`).

```bash
npm install
cp .env.example .env      # optional — the studio works with no API key
npm run dev               # http://127.0.0.1:5173
```

Without a key the studio is fully usable for manual editing; only the assistant
is disabled, and the UI says so rather than failing silently.

To run it the way it is meant to be run — as a production build behind the
Express server, which is what serves the MiniMax API:

```bash
npm start                 # build, then serve on http://localhost:8787
```

### Enabling the assistant

1. Get an API key from <https://platform.minimax.io> (Account → API keys).
2. Put it in `.env`:

   ```
   MINIMAX_API_KEY=your-key-here
   MINIMAX_BASE_URL=https://api.minimax.io/anthropic
   MINIMAX_MODEL=MiniMax-M3
   ```

3. `npm start` (or `npm run dev` — both load `.env`), then look at the **AI**
   indicator in the toolbar.

The key is read from a server-side environment variable and **never reaches
browser code**. It is not in the bundle, not in any client request, and not in
this repository. `.env` is gitignored; `.env.example` contains placeholders
only.

To run the studio with no AI at all, set `ARGON_DISABLE_AI=true`.

> **Honest status of the integration.** The live service **has** now been
> exercised end to end against a real key: text, tool calls, and full
> assistant turns driving the real registry. What that exercise found was that
> MiniMax-M3, offered the tool registry, answers in `tool_use` blocks rather
> than the JSON plan the prompt asks for — so the client reads both styles and
> validates them identically. See `scripts/live-assistant-check.mjs`, which
> reproduces it. It costs money, so it is a tool rather than a test; the
> automated suite uses a scripted stand-in and never calls the network.

---

## Verifying it works

```bash
npm run verify
```

That runs, in order:

| Step | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | clean |
| Unit tests | `npm test` | **508 passed**, 14 files |
| Production build | `npm run build` | 1,304 kB, 374 kB gzip |
| End-to-end | `npm run e2e` | **29 passed** |

`npm run e2e` drives a real Chromium against the real built bundle: it reads the
DOM, hashes rendered pixels, and opens the files the browser downloaded. Run it
headed with `npm run e2e:headed`.

The twenty-nine are the twelve-step demonstration, `e2e/pointer-lock.spec.ts`
(a regression test for an unhandled rejection that came from a third-party
control and only appeared in roughly one run in three),
`e2e/inside.spec.ts` — two tests for the inside camera: the view must open in a
named room, move to another when a room is chosen, and leave on Escape; and a
drag to look around must not be delivered to the room underneath as a click —
`e2e/editor.spec.ts` — ten tests for the editing gestures themselves: picking a
wall that sits inside two rooms and deleting it, a door showing as selected,
the right-click menu addressing the wall under the cursor, a room type placed
from the palette and then picked up again rather than duplicated, the upright
label in a corridor, and the empty-plot and grid starts — and
`e2e/assistant.spec.ts`, which drives the assistant through the browser and
the server to a scripted endpoint: a design request answered in words must say
on screen that the plan did not change, and a six-room plan must be *watched*
arriving on the canvas one room at a time.

---

## Demo script

Twelve steps, about 45 seconds, end to end. This is also `e2e/demo.spec.ts`,
so the script below and the automated check are the same thing.

**1 · Open the app.** You land on one screen that asks what you want, because a
project with nothing in it should ask rather than show an empty grid. Plot size,
storeys and the rooms you need are all on that screen, with a sensible default
already filled in; units, street edge, setbacks, room sizes, style, budget and
comfort are under **More options**. There is no Next, no Back and no review step —
a plan should not cost a questionnaire to ask for.

**2 · Describe the home.** Plot 18 × 14 m, two storeys, one living room and one
bedroom, step-free access (that last one is under **More options**). Everything
here feeds the generator as a structured brief — not as a prompt.

**3 · Generate.** Press Generate. A real plan appears: rooms, walls, openings,
doors and starting furniture, all as project data. The status strip shows net
indoor area, footprint, coverage and floor-area ratio, each from an explicit
formula.

**4 · Select and resize a room.** Click a room. Handles appear. Drag one. The
net area in the status strip changes as you drag, and the 3D view changes with
it, because there is only one model.

**5 · Ask the assistant.** Open the assistant panel and type:

> Add a small study next to the largest room.

Watch the progress line move through the pipeline: reading the project, asking
for a plan, checking the plan, checking preconditions, applying, recalculating.

**6 · See it land.** The new room is in the 2D plan, selected, with its id and
area in the inspector. Net indoor area has gone up by the room's area.

**7 · Switch to 3D.** The building is there, from the same model. Orbit it.

**8 · Stand inside it.** Click **inside**. The camera drops into a room — the
living room, or whatever room you select in the plan or from the row of chips
along the bottom — standing in a corner and looking across at the opposite one.
Drag to look; W A S D walks; scroll steps forward; Q and E turn; Escape leaves.
Walls and furniture stop you. Click **walk** instead and you get the
pointer-locked walk on the pavement, which is unchanged.

**9 · Run the checks.** Open the **Checks** tab. The assistant placed the study
over another room, and the engine says so, names both rooms, and quantifies it:

> "Kitchen" and "Home office" overlap by 4.50 m².

Nine other findings appear too — disconnected floors, a room with no door,
furniture in a door swing, setback crossings. Each is computed from the model,
not asserted by the model.

**10 · Correct it.** Press **Shrink Kitchen to 6.10 m wide**. The overlap
clears, the room count is unchanged (it shrank, it did not delete), and the
area updates. Every correction the panel offers is executed through the same
tool registry the assistant uses and is re-validated by a test.

**11 · Save and reload.** Rename the project, then **File → Save now**.
Reload the page. The design is there — the wizard does not come back, because
the project was loaded, not reset.

**12 · Export and verify.** **Export → JSON**: a self-describing file with a
format tag and schema version, which is checked by putting it back through the
app's own importer. **Export → SVG**: a complete document with real geometry in
millimetres. **Export → PNG**, and a **3D capture** taken from the live canvas.

Then the thirteenth check runs: no uncaught errors anywhere in the run.

---

## How it works, briefly

Full detail in [ARCHITECTURE.md](ARCHITECTURE.md).

- **One model.** Rooms are rectangles in metres, `y` growing south. Walls are
  segments; openings and furniture are derived. The 2D canvas, the 3D scene,
  the measurements and the checks are all pure functions of it, so there is no
  synchronisation bug to have.
- **Pure operations.** Every edit is `(Project, input) => OpResult` — it returns
  a new project or a typed error, and never touches the store. A single
  dispatch table serves the mouse, the keyboard, undo and the assistant.
- **The tool registry is the boundary.** The model can name one of 28 typed
  tools and pass JSON arguments. It cannot return code, invent an id, or skip a
  validation. Destructive tools ask first.
- **The model never measures.** Areas and FAR come from formulas. The assistant
  can *request* a calculation; the number shown is recomputed afterwards from
  the store.
- **A reply is not a change.** Argon draws the plan from operations, not from
  words. Asked to build something and handed a layout written in prose, the
  assistant is pressed once for the operations behind it; if it still runs
  nothing, the panel says so under the reply rather than letting a described
  design read as a drawn one.
- **The work is visible.** Operations are applied across painted frames, not in
  one commit, so the canvas builds room by room under a *the assistant is
  drawing* badge, and each step is listed in the panel as it lands.
- **Checks are deterministic.** 23 emitted issue codes with stable names, the
  numbers behind them, and — where one can be computed — a correction you can
  click.

---

## Project layout

```
src/
  model/      canonical model, operations, geometry, measures, validation
  store/      the single operation dispatch table, history, persistence hooks
  tools/      the 28-tool registry — the assistant's security boundary
  ai/         orchestrator (10-step pipeline) and the assistant panel
  ui/         shell, navigator, inspector, checks panel, toolbar, status bar
  ui/canvas2d/  the 2D editor and the trace overlay
  three/      scene model, R3F scene, four cameras, collision, surfaces
  trace/      image tracing, vectorising, calibration
  export/     SVG, PNG and JSON writers
  persist/    IndexedDB library
server/       Express: /api/chat, /api/health, MiniMax client, .env loader
e2e/          the twelve-step demonstration, the pointer-lock regression, the
              editing and assistant gesture suites, the scripted model stand-in
scripts/      live-assistant-check.mjs — drives the real service once
```

## Documents

| File | What it is |
|---|---|
| [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md) | what Alza and ArchMorph do, and what Argon took from them |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how Argon is built and why |
| [FEATURE_MATRIX.md](FEATURE_MATRIX.md) | what is done, what is verified, and what is not |

`_research/alza` and `_research/archmorph` are third-party checkouts made while
studying those projects. They are under their own licences, they are not part
of this deliverable, and they are gitignored. `_research/alza-notes.md` is my
own analysis and is kept.
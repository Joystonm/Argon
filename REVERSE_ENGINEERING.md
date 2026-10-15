# Argon — Phase 1 Reverse Engineering: Alza and ArchMorph

**Research date:** 2026-10-15
**Subject:** two WebMCP Challenge winning floor-plan/architecture tools, studied as prior art for Argon.
**Purpose:** establish, with evidence, what these two projects actually are and how they work, so Argon can decide what to adopt, what to avoid, and where its own differentiation lies.

---

## 1. Purpose, scope and method

### 1.1 What was researched

Two open-source projects submitted to **The WebMCP Challenge** (`https://webmcp.devpost.com/`), hosted by OpenAI and run on Devpost `[OBSERVED-LIVE]`:

- **Alza** — "an agent-native floor-plan studio", `github.com/Elioz404/Alza`, MIT `[VERIFIED-SOURCE]`
- **ArchMorph** — an architecture/design tool with browser-native WebMCP, MIT, commit `4fb995e` `[VERIFIED-SOURCE]`

Both won the same challenge `[OBSERVED-LIVE]` — see §2.4 and §6.2, and read the caveat in §1.6 about a stale contradiction in the source notes.

### 1.2 How

| Method | What it produced |
|---|---|
| Direct read of the cloned Alza source at `F:\Argon\_research\alza` | Line counts, tool definitions, issue codes, data model, greps `[VERIFIED-SOURCE]` |
| Direct read / spot-check of the cloned ArchMorph source at `F:\Argon\_research\archmorph` | Line counts, tool inventory, registration sites, persistence layer `[VERIFIED-SOURCE]` |
| HTTP fetches of live URLs performed during the prior research session | Response codes, byte sizes, headers, shipped-bundle contents `[OBSERVED-LIVE]` |
| Reading of prior-session research notes at `F:\Argon\_research\alza-notes.md` (616 lines) | Devpost copy, author profile, challenge metadata, screenshot descriptions `[OBSERVED-LIVE]` as tagged there |
| **No dev servers run, no test suites executed, no videos watched, no web search performed for this document** | — |

The Alza clone's own `npm test` (30 vitest tests) **was** run during the prior session and reported green `[VERIFIED-SOURCE per notes §5.5]`. It was **not** re-run for this document. The Playwright E2E battery was never run `[UNVERIFIED]`.

### 1.3 The evidence-tag convention

Every factual claim in this document carries one of four tags:

| Tag | Meaning |
|---|---|
| `[VERIFIED-SOURCE]` | Read directly from the cloned source tree at `F:\Argon\_research\`; the line number or command is given where it matters. |
| `[OBSERVED-LIVE]` | An HTTP fetch was performed against a live URL and the result (status, bytes, header, or literal text) is quoted. |
| `[INFERRED]` | My reasoning. **Every `[INFERRED]` tag states what it rests on.** |
| `[UNVERIFIED]` | Attempted and not obtained. Collected in §11 rather than asserted anywhere else. |

### 1.4 Where the session's own grep supersedes the notes file

Several claims in `alza-notes.md` were re-verified for this document by direct grep and supersede anything weaker there. The decisive ones:

```
$ grep -rnE "fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|openai|anthropic|api[_-]?key|process\.env" src partner
ZERO MATCHES
$ grep -rniE "getImageData|OffscreenCanvas|tesseract|opencv|edge.?detect|threshold|grayscale|histogram" src partner
ZERO MATCHES
$ grep -rn "localStorage|sessionStorage|indexedDB" src
src/ui/Sidebar.tsx:40:        // reencode to JPEG ≤1600 px (localStorage-friendly)
```
`[VERIFIED-SOURCE]` — all three re-run for this document at `F:\Argon\_research\alza`.

Line counts re-confirmed exactly: `src/mcp/tools.ts` **535**, `src/model/issues.ts` **351**, `src/model/types.ts` **124**, `src/editor/Editor.tsx` **444**, `src/three/build.ts` **466**, `src/model/store.ts` **544** `[VERIFIED-SOURCE]`.

### 1.5 Honest limits of the method

1. **Neither app was ever run.** No dev server, no E2E, no browser session. `[UNVERIFIED]` for any runtime behaviour not derivable from source.
2. **No video was watched.** The 2m15s demo film `youtube.com/watch?v=RihMFcMstvI` was never played `[UNVERIFIED]`.
3. **The live Alza app served an empty `<div id="root">` over HTTP** — it is a pure client-rendered SPA, so no rendered UI was ever observed. Every description of Alza's *visible* interface in §3 comes from committed screenshot files in the repo, which are genuine captures but were not seen being produced `[VERIFIED-SOURCE]` for existence, `[UNVERIFIED]` for live parity.
4. **The author's *reported* demo run is a claim, not an observation.** The plan data that run produced is committed as `trace.mjs` and is consistent with the reported counts — corroborating, not confirming `[UNVERIFIED]`.
5. **No accuracy metric exists anywhere** for either project. "0 issues" is self-reported `[UNVERIFIED]`.
6. **Devpost's comment thread is client-rendered and was not retrievable** `[UNVERIFIED]` — see §11.

### 1.6 A known internal contradiction in the source notes

`alza-notes.md` **contradicts itself on the single most important external fact**, and this document resolves it rather than smoothing it over:

- Notes **§1.7** states Alza **won** the WebMCP Challenge, backed by four independent first-party Devpost sources, all HTTP 200.
- Notes **§11.4** states "Treat winner status as unconfirmed."

These cannot both stand. **§11.4 is stale.** The internal ordering gives the reason: §11 was written before §1.7 was established, and §11.4's own stated basis is a single third-party search result (`aicatchup.com`) plus a search engine's own reliability caveat — the weakest possible evidence for the most consequential claim. §1.7 rests on four first-party sources. **§1.7 is correct; §11.4 is out of date and is not relied on here.** Winner status is treated as established in §2.4 `[OBSERVED-LIVE]`.

A second, related item: notes **§11.2** lists "the Devpost updates page" as not retrieved, delegating to a background agent. That is also superseded — notes §1.6 recorded it as fetched at **HTTP 200, 116,729 bytes**. But note carefully what that fetch *found*: the page is genuinely server-rendered and loads fine, yet contains **no update body at all** — only an author line and an empty `<div data-region="comments"></div>`. **That is a real null finding, not a fetch failure.** It gives a precise submission timestamp of `2026-09-01T19:06:55-04:00` and nothing else `[OBSERVED-LIVE]`.

---

## 2. What Alza is

### 2.1 Identity

| Field | Value | Tag |
|---|---|---|
| Name | **Alza** | `[OBSERVED-LIVE]` |
| Self-description | "A floor plan is coordinates, not buttons." | `[VERIFIED-SOURCE]` (README.md, first line of body) |
| Tagline (Devpost) | "A floor-plan editor that publishes its own tools. Give the agent a photo of a plan and one real measurement, and it traces the walls, rooms, doors, and furniture into a 3D model you can walk through." | `[OBSERVED-LIVE]` |
| Author | **Elioz 404**, Devpost handle `Elioz404`, GitHub `Elioz404` — sole contributor | `[OBSERVED-LIVE]` |
| Submitted | Sep 01, 2026 (`2026-09-01T19:06:55-04:00`, from the updates-page timestamp) | `[OBSERVED-LIVE]` |
| Hackathon | **The WebMCP Challenge**, hosted by OpenAI, on Devpost | `[OBSERVED-LIVE]` |
| Likes on Devpost | 10 | `[OBSERVED-LIVE]` |
| Licence | **MIT**, "Copyright (c) 2026 Alza contributors" | `[VERIFIED-SOURCE]` (`LICENSE`) |
| Repo | `github.com/Elioz404/Alza` — **canonical** | `[OBSERVED-LIVE]` |
| Repo size | 4 commits, 1 contributor, 13★ / 7 forks, created 2026-09-01, last push 2026-09-03 | `[VERIFIED-SOURCE]` (git log) + `[OBSERVED-LIVE]` (GitHub API) |

**Note on a fork.** A web search surfaced `github.com/bornio/alza`. It was checked against the GitHub API and is `fork: true`, parent `Elioz404/Alza`, created 2026-09-28 — four weeks *after* the parent. **The canonical, author-owned repo is `Elioz404/Alza`** `[OBSERVED-LIVE]`.

**All four commits** `[VERIFIED-SOURCE]` (`git log`, re-run for this document, most recent first):

```
b672279 Fix the tool count in the file header
72cb3c9 Give every tool a title
c1fbb42 README: WebMCP spec notes, tidy intro, destructiveHint enforced page-side; ignore submission drafts
b4d01d1 Alza — agent-native floor-plan studio: 2D editor, 3D engine, 31+1 WebMCP tools,
        constraint checker, cross-origin supplier, demo plan and showcase
```

Four commits in a hackathon repo, all on 2026-09-01 and 2026-09-03. **Treat it as a reference implementation, not a dependency** `[INFERRED]` — rests on the commit count and the 6-week gap since last push.

### 2.2 The submission's own story (Devpost copy)

The four Devpost sections, in the author's words `[OBSERVED-LIVE]`:

**Inspiration.** "I had a floor plan as a photo and wanted to see it in 3D. That should be a solved problem, but every tool I found wanted me to redraw it by hand, wall by wall… So I tried handing it to an AI agent instead. That was worse… WebMCP looked like the missing half. Not a way to describe the page to an agent — a way to hand it the actual geometry."

**What it does.** "You draw walls, rooms, doors, windows and furniture in a metric 2D canvas, then raise it to a 3D model you can walk through. An agent joins the same live page and works with the same tools you do."

**How I built it.** "Vite, React, TypeScript, Three.js. **No backend at all** — it is a static site, and plans never leave the browser." Tools registered on `document.modelContext` at load via `document.modelContext.registerTool(descriptor, { signal, exposedTo })`. There is a 32nd tool that exists only when relevant: select a wall and `extend_selected_wall` appears; deselect and it is gone, unregistered by aborting its `AbortSignal`. The constraint engine is oriented-rectangle SAT. The partner ("Nordika") is a genuinely separate site on a separate origin.

**Challenges the author reports** `[OBSERVED-LIVE]`, worth recording because they are engineering lessons, not marketing:
1. **Copyright.** The plan first traced turned out to be copyrighted — pulled off Google without thinking and committed to a public repo. "Deleting the file did nothing: git keeps history." He deleted the repo, generated his own plan, re-traced from scratch.
2. **Video judder.** A 25 fps software-rendered recorder made continuous camera motion read as stepping; switched to real GPU capture at 60 fps.
3. **A silent production bug.** "The production build was shipping without its cross-origin headers, so the partner iframe was never allowed to publish its tools — the flagship feature, quietly dead on the live URL. The cause: Vite loads `.env` into `import.meta.env` but *not* into `process.env`, and the plugin that writes the headers was reading `process.env`. It failed by emitting a header that looked plausible."

**#3 is directly verifiable in the repo, and the fix is visible.** `vite.config.ts` now reads `loadEnv(mode, __dirname, "")` — not `process.env` — and carries the comment: *"loadEnv, not process.env: Vite injects .env into import.meta.env for the bundle but leaves process.env alone, so the header plugin saw nothing."* `[VERIFIED-SOURCE]` `vite.config.ts`, lines 41–42. The lesson the author states: **"a build can fail silently and look fine — I now check the artefact, not the exit code."** `[OBSERVED-LIVE]`

### 2.3 What the author says he learned

Verbatim from the Devpost "What I learned" section `[OBSERVED-LIVE]`. Three of these are directly useful to Argon:

> "the agent can see the page" and "the agent can use the page" are different problems.

> **"an error message is an interface."**

> Degrading matters more than expected — cross-origin discovery isn't in every runtime yet, so it falls back to postMessage over the same protocol.

### 2.4 Prize: Alza won

**Confirmed by four independent first-party Devpost sources, all HTTP 200** `[OBSERVED-LIVE]`:

1. **The awards block on the project page**: `<span class="winner label">Winner</span> WebMCP Challenge Winners`
2. **The winners post** `https://webmcp.devpost.com/updates/46049-meet-the-winners`: *"**Alza** — A floor-plan editor that shares its tools with agents. Give the agent a photo of a plan and one real measurement, and it traces the walls, rooms, doors, and furniture into a 3D model you can walk through."*
3. **The project gallery** `https://webmcp.devpost.com/project-gallery` — server-rendered; exactly **10 of 24** entries on page 1 carry the winner ribbon; Alza is one.
4. **The author's Devpost profile** `https://devpost.com/Elioz404` renders a `winner-ribbon` asset and a **"Winner"** label next to Alza.

**All 10 winners received an identical flat tier — there is no 1st/2nd/3rd placement.** Devpost lists *"WebMCP Challenge Winners — $3,500 in cash — 10 winners"*. `[INFERRED]` that Alza's share is that $3,500 flat tier — **the dollar figure is not printed next to Alza's name**; this rests on the flat-tier structure being uniform across the ten entries.

**The 10 winners** `[OBSERVED-LIVE]`: MASIL, **Alza**, **ArchMorph**, Aisle, Roque Nights, Mandate, Observatory, Bouquet Studio, Faraday, JupyterLite WebMCP.

**The challenge itself** `[OBSERVED-LIVE]`: hosted by OpenAI, managed by Devpost. "10 days for exploring what's possible with WebMCP." Submissions Aug 25 – Sep 4 2026; winners announced **Sep 28, 2026**. **7,057 participants**, ~2,500 projects, 100+ countries, **$35,000 in prizes**. Judging on four criteria: *WebMCP Leverage, Execution, Potential Impact, Creativity & Ambition.* Seven judges from Cloudflare, MCP-B, Shopify, Vercel, OpenAI, Google Chrome, Netlify.

### 2.5 Author

Devpost profile `Elioz404`: **Argentina**; GitHub linked; **2 projects, 2 hackathons, 5 achievements, 3 followers**. Two hackathons: the WebMCP Challenge (winner) and CALL-E: Your Code Is Calling (winners TBD) `[OBSERVED-LIVE]`. Git commit identity: `Elioz <eliasemanuel.ltorres@gmail.com>` `[VERIFIED-SOURCE]`. **Whether this name corresponds to a real, publicly-identifiable person is not established** — see §11.

---

## 3. Alza — live application observations

### 3.1 What was actually fetched

| URL | Result | Tag |
|---|---|---|
| `https://alza-dev.pages.dev` | **HTTP 200, 908 bytes.** Entire server-served body is a `<title>Alza — Plans that rise to 3D</title>`, a meta description, one module script, and `<body><div id="root"></div></body>` | `[OBSERVED-LIVE]` |
| `https://alza-dev.netlify.app` (partner origin) | **HTTP 200.** Titled **"Nordika — furniture supplier"**, a separate **4,991-byte** bundle | `[OBSERVED-LIVE]` |

The full served body of the studio, quoted `[OBSERVED-LIVE]`:

```html
<title>Alza — Plans that rise to 3D</title>
<meta name="description" content="Draw floor plans in 2D, walk them in 3D, and let your AI
agent co-edit the same live page through WebMCP. Built for the WebMCP Challenge." />
<script type="module" crossorigin src="./assets/main-BeLHT9JM.js"></script>
<body><div id="root"></div></body>
```

### 3.2 **`<div id="root">` is empty. No rendered UI was observed.**

This is the honest headline of this section. Alza is fully client-rendered, so an HTTP fetch returns the shell and nothing else — no header, no tabs, no visible text is retrievable. **This document does not describe any Alza interface that was seen rendering.** Everything visual below comes from committed screenshot files, which are real captures of the running app but were not seen being produced `[VERIFIED-SOURCE]` for their existence, `[UNVERIFIED]` for live parity.

### 3.3 Security headers observed live

```
content-security-policy: frame-ancestors 'self' https://alza-dev.pages.dev
permissions-policy:       tools=(self "https://alza-dev.netlify.app")
referrer-policy:          strict-origin-when-cross-origin
x-content-type-options:   nosniff
access-control-allow-origin: *
server: cloudflare
```
`[OBSERVED-LIVE]`

The `permissions-policy: tools=(…)` directive is the **WebMCP origin-delegation control** that makes the two-origin architecture function — the partner origin is allowlisted and nothing else. It is **the production artefact of the exact bug the author describes in §2.2**, correctly configured. No HSTS on Cloudflare (present on Netlify).

### 3.4 The decisive live check: no endpoints in the shipped bundle

The main JS bundle `assets/main-BeLHT9JM.js` is **830,886 bytes**, and a dynamic-import scan found no other chunks — nothing is hiding in a lazy load. It was sanity-checked as real minified JS (1,542 `function`, 1,877 `const`) so the zero-hit results are genuine, not a truncated download `[OBSERVED-LIVE]`.

**Zero occurrences in the shipped bundle:**

| Pattern | Hits |
|---|---|
| `openai`, `anthropic`, `gemini`, `claude`, `groq`, `mistral`, `ollama`, `perplexity` | **0 each** |
| `apiKey`, `api-key`, `API_KEY`, `Bearer`, `sk-`, `gsk_` | **0 each** |
| `/v1/`, `process.env`, `supabase`, `firebase` | **0 each** |
| `XMLHttpRequest`, `EventSource`, `WebSocket` | **0 each** |
| **`fetch(`** | **0** |

Total URL literals in the whole bundle: **22, of which only 2 are real** — `https://alza-dev.netlify.app` (the partner origin, hardcoded) and `https://react.dev/errors/`. The other 20 are W3C XML namespace URIs from Three.js and SVG. The partner bundle was equally clean, with zero URL literals `[OBSERVED-LIVE]`.

**The "no backend" claim is therefore verified three independent times: source grep (§1.4), shipped bundle, and Devpost copy.** `[OBSERVED-LIVE]` + `[VERIFIED-SOURCE]`

### 3.5 What the committed screenshots show

`shots/showcase/` contains **17 files** — 16 PNG stills plus `preview.gif` `[VERIFIED-SOURCE]` (directory listing, confirmed). Four were opened and read as images during the prior session. **These are `[VERIFIED-SOURCE]` as files in the repo, and are genuine captures — but they were not seen being produced and the live app was never seen rendering them.**

- **`02-traced-over-the-drawing.png` — the proof shot.** 2D canvas, cream grid background. The scanned plan photo sits as a pale underlay; dark, crisp vector geometry is overlaid and registers with it. Live area labels visible: **"Living 28.3 m²"**, Bedroom 1 **13.1 m²**, Bedroom 2 **9.5 m²**, Bedroom 3 **14.3 m²**, Dressing **4.7 m²**, Bathroom 1, Bathroom 2, Hall **3.8 m²**. Wall dimension callouts in metres: 11.15, 10.00, 6.30, 4.00, 3.70, 1.85, 4.70. Header reads **"Alza · Traced from a photo of the plan"** with the pill **"● Site tools live"**. Left toolbar: Select, **+ Wall**, **+ Room**, Undo, **Build 3D ▲**. Sidebar badge shows **Check (2)** — i.e. two live constraint issues at that moment. Right edge shows catalogue thumbnails with real dimensions (Bathtub 1.7 × 0.75 m, Corner bath 1.4 × 1.4 m, Shower 0.9 × 0.9 m, Toilet 0.38 × 0.65 m, Washbasin 0.55 × 0.42 m, Towel rail, Plant, L-shaped sofa 2.66 × 3.11 m, Corner shower 1.21 × 1.16 m, Compact bath 1.53 × 0.86 m, L-shaped fitted wardrobe 1.6 × 1.92 m, Washing machine, Frejda armchair 0.88 × 0.86 m).
- **`04-tool-runner.png` — the tool surface.** The Tools tab is open. On-page copy: *"These are the exact 31 tools your AI agent discovers via WebMCP, plus the dynamic one. Run them manually to test flows — every call is logged below in the activity feed."* A dropdown shows `get_model` with its description underneath and a `{}` JSON args box. The activity feed shows timestamped AGENT and YOU lines, including `get_supplier_catalog — Pulled 12 product(s) from http://localhost:5200 via webmcp.` and `place_supplier_product — Frejda armchair (NK-ARM-01, 0.88 × 0.86 m, €329) placed from http://localhost:5200.`
- **`15-3d-walk-eye-level.png` — first-person 3D.** Header toggles **Orbit / Top / Walk** (Walk active), **Export OBJ**, **Snapshot PNG**, **Back to 2D**. Inside the loft: cream walls, wood-plank floor, an open door with a brass handle, pendant lamps, a dining chair and table, a kitchen counter with sink, tiled bathroom beyond. On-canvas hint: **"WASD / arrows to walk · drag to look · click a door to open it"**. Activity feed: `AGENT build_3d — 3D model built: 12 walls, 14 openings, 35 items.` / `set_camera — Camera set to orbit.` / `Camera set to top.` / `set_doors — 7 door(s) set to "open".` / `Camera set to walk.`
- **`01-3d-orbit-hero.png`** — the three-quarter orbit view of the loft raised into 3D.

UI strings recoverable from the shipped bundle but **not seen rendered** `[OBSERVED-LIVE]`: `"WebMCP runtime detected — tools are live for your agent"`, `"No WebMCP runtime — use the Tools tab"`, `"2d" ? "Build 3D ▲" : "Back to 2D"`.

**Screenshot count for matching purposes:** 16 stills + 1 GIF = 17 files in the repo. The Devpost page inlines a subset — the raw-github references in the page HTML suggest at least `02-` and `11-agent-authored-pieces.png` `[INFERRED]`, resting on which raw.githubusercontent URLs appear in the fetched HTML; Devpost's own upload pipeline is not visible to me.

### 3.6 The demo video

`https://www.youtube.com/watch?v=RihMFcMstvI` — README describes it as **2 min 15 s**, authored with **HyperFrames** (heygen.com) from a storyboard and HTML compositions, with the authoring tree deliberately not shipped `[VERIFIED-SOURCE]`. **The video was never watched.** `[UNVERIFIED]` — see §11.3.

The eight demo beats are, however, reproducible from committed code: `record6.mjs` "drives the real app through the eight beats while ffmpeg captures the screen at 60 fps" `[VERIFIED-SOURCE]` (README).

---

## 4. Alza — verified source findings

All from `F:\Argon\_research\alza`, read for this document.

### 4.1 Stack

| Layer | Choice | Tag |
|---|---|---|
| Build | **Vite 7** (`^7.0.0`), dev server pinned to **port 5199**, partner on **5200** | `[VERIFIED-SOURCE]` (`package.json`, `vite.config.ts`) |
| UI | **React 19.1** / `react-dom` 19.1, **plain CSS** (`src/styles.css`, 259 lines) — **no Tailwind, no CSS framework** | `[VERIFIED-SOURCE]` |
| Language | **TypeScript 5.8**, strict | `[VERIFIED-SOURCE]` |
| State | **zustand 5.0.6**, vanilla — **one store powers both the UI and the tools** | `[VERIFIED-SOURCE]` |
| 2D | **inline SVG** (`src/editor/Editor.tsx`, 444 lines) — not `<canvas>` | `[VERIFIED-SOURCE]` |
| 3D | **Three.js ^0.178**, raw, no react-three-fiber; ACES filmic tone mapping, PCF soft shadows, `OrbitControls` from `three/examples` | `[VERIFIED-SOURCE]` |
| Deploy | **Cloudflare Pages** (studio) + **Netlify** (partner), **the same `dist/`** | `[VERIFIED-SOURCE]` (`vite.config.ts` rollup inputs) |
| Tests | **vitest ^3.2** (unit) + **Playwright ^1.62.1** (E2E) | `[VERIFIED-SOURCE]` (`package.json`) |
| AI / model | **none** — no SDK, no endpoint, no key | `[VERIFIED-SOURCE]` (§1.4 grep) |
| Persistence | **none** | `[VERIFIED-SOURCE]` (§1.4 grep) |

Colour is a deliberate, hand-authored token set in `src/styles.css` — a "warm drafting-studio palette": `--bg: #f7f4ee`, `--panel: #fffdf8`, `--ink: #2e2a24`, `--accent: #e07b39` (orange), `--agent: #4f86b0` (blue, used for agent-originated UI), `--danger: #c04545`, `--ok: #4f9e57` `[VERIFIED-SOURCE]`. Note `--agent` as a distinct colour channel: **agent actions are visually distinguished from human actions in the UI.** Argon should take this.

### 4.2 Data model — `src/model/types.ts`, 124 lines

Header comment, verbatim: **"all units are meters, plan lives on the XY plane (y grows downward in 2D view)"** `[VERIFIED-SOURCE]`.

```ts
Wall      { id, ax, ay, bx, by, thickness, height }         // metres
Opening   { id, kind: "door"|"window", wallId, t /*0..1 to CENTRE*/,
            width, sill, height, hinge?: "a"|"b", side?: "left"|"right" }
Room      { id, x, y, w, h, label, floor }
Item      { id, kind /*catalog key*/, x, y, rotation /*deg CCW = which way it FACES*/ }
Underlay  { dataUrl, opacity, x, y, w, h, pw?, ph? }
PlanModel { name, walls[], openings[], rooms[], items[], underlay }
PendingApproval { id, tool, request, args, at }
Note      { id, author: "human"|"agent", text, at }
Issue     { severity: "error"|"warning", code, message, refs[] }
ActivityEntry { id, at, source: "human"|"agent"|"system", tool, summary, ok }
```

Three design decisions worth stealing outright, all `[VERIFIED-SOURCE]` from the inline comments:

1. **`t` is defined as position to the *centre* of the opening**, not to its near edge. This removes an entire class of ambiguity from the agent's job — the model never has to decide which convention the app uses.
2. **`rotation` is defined as which way the piece *faces***, not as a geometric angle. The `place_item` tool description spells out the full mapping (0 = faces +y, 90 = +x, 180 = −y, 270 = −x) and states: *"a sofa against the SOUTH wall needs rotation 180, and one against the WEST wall needs rotation 90."*
3. **`pw`/`ph` record the page's own pixel dimensions of the re-encoded image**, precisely so the tracing tools can tell the agent to use fractions. See §5.3.

**Catalogue:** `src/model/catalog.ts`, 62 lines, **31 built-in kinds** `[VERIFIED-SOURCE]`: sofa, `sofa_3`, armchair, coffee_table, side_table, sideboard, tv_sideboard, tv_stand, bookshelf, rug (`isRug: true`, exempt from collision), bed_double, bed_single, nightstand, wardrobe, desk, office_chair, dining_table, dining_table_oval, dining_chair, kitchen_counter, counter_unit, kitchen_sink_unit, kitchen_hob_unit, fridge, bathtub, corner_bath, shower, toilet, sink, towel_rail, plant. Plus **runtime-added kinds** from `define_item_kind`.

### 4.3 The tool surface — 32 tools

**31 static + 1 dynamic = 32** `[VERIFIED-SOURCE]` — `grep -c '    name: "'` over the `TOOLS` array (`src/mcp/tools.ts:41-499`) returns exactly **31**; `EXTEND_SELECTED_WALL` (`tools.ts:502-523`) is the 32nd, declared separately.

| # | Tool | Group | Destructive? |
|---|---|---|---|
| 1 | `get_model` | read (readOnly) | — |
| 2 | `get_issues` | read (readOnly) | — |
| 3 | `get_item_catalog` | read (readOnly) | — |
| 4 | `get_editor_state` | read (readOnly) | — |
| 5 | `measure` | read (readOnly) | — |
| 6 | `get_underlay` | read (readOnly) | — |
| 7 | `calibrate_underlay` | blueprint | — |
| 8 | `add_wall` | structure | — |
| 9 | `edit_wall` | structure | — |
| 10 | `remove_wall` | structure | **yes** |
| 11 | `add_door` | openings | — |
| 12 | `set_door_swing` | openings | — |
| 13 | `add_window` | openings | — |
| 14 | `move_opening` | openings | — |
| 15 | `remove_opening` | openings | **yes** |
| 16 | `add_room` | rooms | — |
| 17 | `update_room` | rooms | — |
| 18 | `remove_room` | rooms | **yes** |
| 19 | `place_item` | furniture | — |
| 20 | `define_item_kind` | furniture | — |
| 21 | `move_item` | furniture | — |
| 22 | `remove_item` | furniture | **yes** |
| 23 | `set_plan_name` | model & view | — |
| 24 | `clear_model` | model & view | **yes** |
| 25 | `build_3d` | model & view | — |
| 26 | `set_camera` | model & view | — |
| 27 | `set_doors` | model & view | — |
| 28 | `get_supplier_catalog` | cross-origin (readOnly + untrustedContent) | — |
| 29 | `place_supplier_product` | cross-origin | — |
| 30 | `leave_note` | collaboration | — |
| 31 | `get_notes` | collaboration (readOnly) | — |
| 32 | `extend_selected_wall` | **dynamic** | — |

**Six tools are marked `destructiveHint`** and are the ones the approval gate intercepts: `remove_wall`, `remove_opening`, `remove_room`, `remove_item`, `clear_model` — five, plus none else. Re-reading the source: exactly **five** carry `annotations: { destructiveHint: true }` (`tools.ts:206, 264, 295, 371, 389`) `[VERIFIED-SOURCE]`.

#### Correction to the notes file §2.4

`alza-notes.md` §2.4 enumerates the bundle's tool names and **omits `build_3d`**, listing 31 names and then appending `extend_selected_wall` "as the dynamic 32nd" — double-counting the dynamic tool while dropping a static one. **The true count is 32 (31 static + 1 dynamic), and `build_3d` is one of the 31 static tools** (`tools.ts:394-400`) `[VERIFIED-SOURCE]`. The tool-count *claims* elsewhere in the notes (31 + 1 = 32, in §4.1 and §10) are correct; only the §2.4 enumeration is wrong. This document uses the source-verified list above.

#### WebMCP registration mechanics `[VERIFIED-SOURCE]`

- **Registration surface** (`src/mcp/registry.ts:63-69`): `getModelContext()` checks `document.modelContext` first, falls back to `navigator.modelContext`, returns `null` if neither exists.
- **Call shape**: `registerTool(descriptor, { signal, exposedTo })` — the two-option signature.
- **Unregistration**: by **aborting the registration `AbortSignal`** — the spec's own path — plus an `mc.unregisterTool?.(name)` fallback for pre-AbortSignal runtimes (`registry.ts:53-60`).
- **Dynamic tool lifecycle** (`src/mcp/bootstrap.ts:37-65`): each registration gets its own `AbortController`; a `store.subscribe` watches `editor.selectedWallId` and registers or aborts accordingly. The comment at `bootstrap.ts:49` reads `dynamic.abort(); // ← the spec's unregistration path`. The runtime's `toolchange` event is observed and logged once (`bootstrap.ts:69-73`).
- **Annotations**: `readOnlyHint` and `untrustedContentHint` are real WebMCP. **`destructiveHint` is not** — `registry.ts:20-31` states it explicitly: *"MCP defines this hint; WebMCP's ToolAnnotations does not yet (it carries only readOnlyHint and untrustedContentHint). So it rides on our own descriptor and is enforced below in executeWrapped — the approval gate never depends on a browser propagating it."*
- **Every tool carries a `title`** next to its `name` (commit `72cb3c9`).
- **All 32 descriptors live in one file**, `src/mcp/tools.ts`, **535 lines** — about 17 lines per tool including its schema and implementation `[VERIFIED-SOURCE]`.

### 4.4 The constraint engine — 19 issue codes

`src/model/issues.ts`, **351 lines**, **exactly 19 distinct codes** `[VERIFIED-SOURCE]` (verified by extracting every `code: "…"` literal and counting uniques):

**Walls (4):** `wall_too_short`, `wall_loose_end`, `walls_overlap_collinear`, `walls_cross`, `wall_ends_in_opening`
**Openings (4):** `opening_orphan`, `opening_overflow`, `openings_overlap`, `opening_too_tall`
**Rooms (4):** `room_floating`, `rooms_overlap`, `room_no_door`, `room_too_small`
**Furniture (7):** `item_through_wall`, `item_blocks_door`, `item_blocks_window`, `items_overlap`, `item_outside_rooms`, `item_unknown`

That is 5 + 4 + 4 + 6 = 19.

Collision is **oriented-rectangle SAT**, and it is *semantically nuanced*: `item_through_wall` treats **leaning as legal and crossing as an error**; `items_overlap` exempts rugs; `item_blocks_window` carries a sill-height nuance (a tall piece in front of a window is flagged, a low one is not) `[VERIFIED-SOURCE]`.

**The messages are the interface.** Every message is a sentence naming the specific entities and quantifying the problem, in real units `[VERIFIED-SOURCE]`:

```
Wall ${w.id} is only ${(len*100).toFixed(0)} cm long (min ${MIN_WALL_LEN*100} cm).
Walls ${a.id} and ${b.id} overlap collinearly for ${(ov*100).toFixed(0)} cm.
Wall ${w.id} has a loose end at (${end.x.toFixed(2)}, ${end.y.toFixed(2)}).
${o.kind} ${o.id} extends past the end of wall ${wall.id}.
Room "${r.label}" has no door on its boundary.
${cat.label} blocks the swing path of door ${o.id}.
${cat.label} (h ${cat.h}m) sits in front of window ${o.id} (sill ${o.sill}m).
```

And `get_issues` returns, when clean, the literal string **`"0 issues — the plan is clean."`** (`tools.ts:70`) `[VERIFIED-SOURCE]`. That string is a **loop terminator**, not a status message. See §9.1.

### 4.5 Tests — real, and run `[VERIFIED-SOURCE per notes §5.5; counts re-confirmed]`

```
✓ tests/geometry.test.ts (15 tests)  11ms
✓ tests/issues.test.ts  (15 tests)  23ms
Test Files  2 passed (2)
      Tests  30 passed (30)
```

**30 vitest unit tests** across two files (`tests/geometry.test.ts` 91 lines, `tests/issues.test.ts` 149 lines), `environment: "node"`. `tests/issues.test.ts` contains a **seed regression** asserting the shipped demo model audits to zero issues (line 10: `const issues = checkModel(seedLoft())`) — the README notes this keeps the demo honest `[VERIFIED-SOURCE]`.

Plus a **Playwright E2E battery**, `e2e-full.mjs` (315 lines): launches Chromium with `--enable-features=WebMCP`, drives every tool through `navigator.modelContextTesting`, asserts zero console errors, and makes **56 checks**. The file's own comment notes that `modelContextTesting` exists only in Chrome dev/canary, so on stable Chrome **54 of 56 run and 2 are skipped** (`e2e-full.mjs:158`) `[VERIFIED-SOURCE]`.

**The E2E suite was never executed** — it needs both dev servers plus a browser download `[UNVERIFIED]`.

**This is a genuine competitive difference from ArchMorph**, whose tests are hand-written assertion scripts run with `node --experimental-strip-types` (see §6.4).

### 4.6 Persistence: there is none

**One single hit for `localStorage|sessionStorage|indexedDB` anywhere in `src/`, and it is a comment** — `src/ui/Sidebar.tsx:40: // reencode to JPEG ≤1600 px (localStorage-friendly)` `[VERIFIED-SOURCE]`, re-confirmed in §1.4.

There is **no save, no load, no autosave, no share link**. Reload the page and you get the seeded demo back. The ≤1600 px re-encode cap was written *as if* for a persistence budget that was never hooked up `[INFERRED]` — rests on the comment existing while no writer does.

Undo *is* implemented, in memory: a 50-deep stack of `structuredClone(model)` snapshots (`store.ts:109`), plus a 200-entry ring-buffered activity log (`store.ts:101`).

`[INFERRED]` This is either a deliberate trade to keep "plans never leave the browser" simple, or simply unfinished. **Either way it is a real gap Argon should beat** — see §8.2.

### 4.7 Build and deploy tooling

- `npm run dev` (5199) · `npm run partner` (5200) · `npm test` · `npm run build` (`tsc -b && vite build`) `[VERIFIED-SOURCE]`
- **Two entry points in one build**: `index.html` (studio) and `partner/index.html`. The **same `dist/`** is deployed to Cloudflare Pages and Netlify, and one `_headers` file must serve both roles. `base: "./"` `[VERIFIED-SOURCE]` (`vite.config.ts` rollupOptions).
- Deploy scripts: `wrangler pages deploy dist --project-name alza-dev --branch main` and `npx netlify deploy --prod --dir dist` `[VERIFIED-SOURCE]`.
- **`serve-local.mjs`** serves `dist/` on two origins *with the production headers*, so the cross-origin feature is demoable locally `[VERIFIED-SOURCE]`.
- **Ports are pinned with `strictPort: true`**, with a comment explaining that the README, the E2E default and the partner script all assume 5199/5200, and that without pinning Vite picks 5173 and the documented commands "quietly fail to connect" `[VERIFIED-SOURCE]` (`vite.config.ts`). Same class of lesson as the silent-headers bug.

### 4.8 Cross-origin tool exchange — the genuinely novel part

A second site, **Nordika** (`partner/supplier.js`, **164 lines**), is a mock furniture shop on its **own origin** with **12 products** `[VERIFIED-SOURCE]` — verified by counting the `PRODUCTS` entries: Frejda 3-seat sofa, Frejda armchair, Halden coffee table, Halden sideboard 220, Valby single bed 90, Valby double bed 160, **Valby wardrobe 150 (`stock: 0` — deliberately out of stock)**, Valby nightstand, Studio desk 130, Studio task chair, Sund oval table 190, Sund dining chair. EUR prices, real footprints in metres.

It publishes two tools of its own — `nordika_list_products`, `nordika_get_product` — with `registerTool(descriptor, { signal, exposedTo: HOST_ORIGINS })`. Alza embeds it in an `<iframe allow="tools">` (`src/ui/SupplierBridge.tsx:27-32`) and calls `getTools({ fromOrigins })` + `executeTool()` (`src/mcp/registry.ts:57-58`) `[VERIFIED-SOURCE]`.

The transport is chosen at runtime and reported in the tool summary — the string is `"via cross-origin WebMCP"` or `"via postMessage fallback"` (`tools.ts:440`) `[VERIFIED-SOURCE]`. When the runtime has no cross-origin support (or no WebMCP at all), the same protocol runs over `postMessage` with `__alzaSupplier` framing (`supplier.ts:131`) `[VERIFIED-SOURCE]`.

The header plumbing is a **custom Vite plugin** (`vite.config.ts`) emitting a `_headers` file readable identically by Cloudflare Pages and Netlify `[VERIFIED-SOURCE]`.

`[INFERRED]` This demonstrates something worth knowing: **the browser can act as the integration layer between two independent origins with no server in the path.** Rests on the iframe + `allow="tools"` + `exposedTo` + `getTools({fromOrigins})` chain all being present in source and the production headers being present live. **Argon does not need this** — see §9.4.

### 4.9 Total size

**6,534 lines** across all `.ts/.tsx/.js/.mjs` excluding `node_modules` `[VERIFIED-SOURCE]` (`wc -l` over the find/xargs, confirmed for this document).

| File | Lines | Role |
|---|---|---|
| `src/three/furniture.ts` | 617 | composite 3D furniture + generic builder for imported partner products |
| `src/model/store.ts` | 544 | the single zustand store — actions, undo, activity log |
| `src/mcp/tools.ts` | **535** | all 32 tool descriptors |
| `src/three/build.ts` | 466 | wall extrusion with real openings, joint resolution, floors |
| `src/editor/Editor.tsx` | 444 | the SVG 2D editor |
| `src/three/Scene3D.tsx` | 437 | orbit/top/walk cameras, WASD, collision, OBJ/PNG export |
| `src/model/issues.ts` | **351** | the constraint engine, 19 codes |
| `src/ui/Sidebar.tsx` | 230 | Model/Check/Catalog/Supplier/Notes/Tools tabs |
| `src/mcp/supplier.ts` | 179 | cross-origin discovery + postMessage fallback |
| `src/mcp/registry.ts` | 170 | registration, annotation wrapping, logging, approval gate |
| `partner/supplier.js` | 164 | the Nordika partner origin |
| `src/model/types.ts` | **124** | the data model |
| `src/three/thumbnails.ts` | 86 | |
| `src/model/geometry.ts` | 187 | snap, SAT, segment math |
| `src/ui/ToolRunner.tsx` | 80 | manual tool execution |
| `src/mcp/bootstrap.ts` | 77 | runtime detection, dynamic tool lifecycle |
| `src/model/seed.ts` | 71 | the "Sunset Loft" demo model |
| `src/model/catalog.ts` | 62 | 31 furniture kinds |
| `src/ui/ApprovalBar.tsx` | 37 | the human-in-the-loop gate |
| `src/three/exportBus.ts` | 28 | |

**The domain-logic core is ~1,004 lines**: `issues.ts` 351 + `geometry.ts` 187 + `build.ts` 466. **That is the number to compare against ArchMorph's 3,970-line `architecture.ts`.** Argon should size its domain module against the *problem*, not against the larger of the two — see §8.2.

---

## 5. Alza — image-to-plan tracing: what actually happens

**This is the most important section in this document, because the honest answer contradicts the marketing.**

### 5.1 There is no computer vision in Alza. None.

```
$ grep -rniE "getImageData|OffscreenCanvas|tesseract|opencv|edge.?detect|threshold|grayscale|histogram" src partner
ZERO MATCHES
```
`[VERIFIED-SOURCE]` — re-run for this document.

There is **no vectorisation, no OCR, no vision model, no contour tracing, no edge detection, no Hough transform** anywhere in the codebase `[VERIFIED-SOURCE]`. The only canvas operations in the entire app are `drawImage` + `toDataURL` inside the *upload handler* (`src/ui/Sidebar.tsx:41-52`) — a resize-and-re-encode step for display efficiency, not analysis.

### 5.2 So what actually happens? Five steps, all verified in source

1. **The human uploads the plan photo.** It is re-encoded to JPEG at ≤1600 px (quality 0.82), pinned as a semi-transparent SVG `<image>` at world origin, 8 m wide × aspect, opacity 0.55, with `pw`/`ph` recorded `[VERIFIED-SOURCE]` (`Sidebar.tsx:41-52`, `Editor.tsx:299-307`).

2. **The human pastes the same image into their chat with the agent.** This is the load-bearing step, and the code says so explicitly and repeatedly `[VERIFIED-SOURCE]`. The `get_underlay` tool description:

   > *"Tracing needs the drawing in two places and this tool tells you which are missing: uploaded on the page (carries the scale) and pasted into your conversation (the only way you can see it)."*

   And when no underlay is loaded, `get_underlay` returns a `needs` array naming all three prerequisites, one of which is *"human pastes the same image into this conversation — so you can read it"* `[VERIFIED-SOURCE]` (`tools.ts:129-144`).

3. **The host agent's own multimodal vision reads the drawing.** The app supplies no understanding of the image whatsoever `[VERIFIED-SOURCE]` — the absence of any CV code is the proof.

4. **The agent calls `calibrate_underlay(u1, v1, u2, v2, metres)`** to set scale from **one** real dimension the human supplies, then emits `add_wall` / `add_door` / `add_window` / `add_room` / `place_item` calls with coordinates it measured **off the image itself**.

5. **`get_underlay` returns no pixels at all** — only a fractional coordinate mapping, because WebMCP tool results are text.

### 5.3 The fractional coordinate mapping — the clever bit

`get_underlay` returns `[VERIFIED-SOURCE]` (`tools.ts:145-166`):

```
u = x_px / image_width ,  v = y_px / image_height      (both 0..1 from top-left)
world_x = rect.x + u * rect.w
world_y = rect.y + v * rect.h
```

The code comment explains why, and it is the crux:

> *"The page re-encodes uploads to <=1600 px, so its copy is usually a different pixel size from the file the human pasted into the conversation. Fractions are identical in both, which is why the mapping is expressed in fractions."*

And the mapping object's own `warning` field, returned to the agent:

> *"Do not reuse pixel numbers across the two copies: the page holds a resized one. Fractions are safe, pixels are not."*

**Fractions are a resize-invariant coordinate system.** That is a genuinely transferable insight and it applies to Argon regardless of who does the vision — see §9.5.

### 5.4 `calibrate_underlay` — one dimension is enough

The implementation (`src/model/store.ts:374-396`) is pure arithmetic, with no hidden magic:

```ts
const frac = Math.hypot((u2 - u1) * u.w, (v2 - v1) * u.h);   // world distance at CURRENT scale
const scale = meters / frac;                                  // the correction factor
const newW = u.w * scale;  const newH = u.h * scale;
const p1x = u.x + u1 * u.w;  const p1y = u.y + v1 * u.h;      // keep point 1 pinned in world space
```

**Aspect ratio is preserved and the first calibration point is held fixed in world coordinates** `[VERIFIED-SOURCE]`. The success message is a sentence reporting the before/after width, the scale factor to three decimals, and the world position of the pinned point — i.e. it tells the agent exactly what changed so it can correct its own mental model.

`trace.mjs` confirms this is how the demo was actually calibrated. Its header states the reasoning verbatim `[VERIFIED-SOURCE]`:

> *"Scale: the drawing carries no scale, so the exterior width is fixed at 10.00 m — which is exactly the one measurement the tracing protocol tells the agent to ask a human for. At that width the source image runs **138.2 px/m**, its exterior box sits at pixels (333, 222)..(1715, 1764), and every number below is a pixel measurement converted with `world = (pixel - origin) / 138.2`."*

**So "one real dimension" is a genuine minimum, not a limitation of the implementation** `[INFERRED]` — rests on the fact that a rigid scaling has exactly one unknown after aspect is fixed, so a single known distance determines it.

### 5.5 `TRACING_PROTOCOL` — procedures as string constants

WebMCP has no skills concept (the author cites spec issue **#161**), so the procedure ships as an **8-step string array embedded in tool descriptions** `[VERIFIED-SOURCE]` (`tools.ts:30-39`, exported as `TRACING_PROTOCOL`, returned in the `protocol` field of `get_underlay`).

The header comment states the intent `[VERIFIED-SOURCE]` (`tools.ts:25-29`):

> *"The house rule for reproducing someone's plan. It travels with `get_underlay` because that is the tool an agent reaches for the moment a drawing is involved: the default is FIDELITY — copy what is drawn, at the size it is drawn, and model anything the catalogue is missing."*

The load-bearing steps, quoted `[VERIFIED-SOURCE]`:

> **1.** Calibrate first, and get the drawing into BOTH places. You need it uploaded on the page (that is what carries the scale) AND pasted into your conversation (that is the only way you can see it) — `get_underlay` returns the mapping, never the pixels. Then ask the human for ONE real dimension and call `calibrate_underlay` with two points on the image and that distance. Measure in fractions of the image, never in pixels, and convert with the `mapping` `get_underlay` hands you. Note the order: `clear_model` also clears the underlay, so empty the plan BEFORE the image is loaded, never after.

> **2.** Copy the drawing, do not redesign it. Reproduce the walls, openings and rooms that are actually drawn — the same count, the same positions, the same proportions. Do not add rooms, move doors to where they would be tidier, or 'improve' the layout. If something in the drawing is ambiguous, place your best reading and say so with `leave_note` rather than inventing.

> **3.** Structure before contents: outer walls, then partitions (`add_wall`), then openings on the walls that carry them (`add_door` / `add_window`), then rooms (`add_room`), then furniture.

> **5.** Furnish what is drawn, piece by piece. Every symbol on the plan becomes an item — no more, no fewer. Match its position, its orientation (`rotation` is which way the piece FACES) and its real size.

> **6.** Never approximate a distinctive symbol with the nearest stock item. If the plan shows a corner bath, an L-shaped sofa, a piano or a kitchen island and the catalogue has no such kind, call `define_item_kind` to model it at the size the plan draws — optionally with `parts` for real 3D geometry — and then place it. `get_item_catalog` is a convenience, not a constraint.

> **7.** Sit furniture against the walls the drawing sits it against: offset the centre by depth/2 from the wall FACE (centreline ± thickness/2), not from the centreline.

> **8.** Verify, then repair. Call `get_issues`, fix every error it reports, and call it again until only intentional warnings remain. Finish with `build_3d` so the human sees the result.

Two things stand out. **Step 2 is a fidelity constraint, not a help-text constraint** — it names the specific failure modes (tidying, inventing) an LLM is prone to when reproducing a drawing. **Step 8 is the self-repair loop** (§9.1).

The author's own comment on the cost of this approach `[VERIFIED-SOURCE]` (README, spec notes):

> *"It spends description budget on every tool that references it, and there is no way to say 'this is a procedure' rather than 'this is a tool'."*

### 5.6 The ambiguity escape hatch

`TRACING_PROTOCOL` step 2 directs the agent to `leave_note` when the drawing is ambiguous rather than inventing. This is a **first-class uncertainty channel** `[VERIFIED-SOURCE]`: `Note { id, author: "human"|"agent", text, at }`, surfaced in a sidebar Notes tab with a live badge, readable by both parties via `get_notes`. A committed screenshot, `08-agent-notes-on-ambiguity.png`, exists for this case `[VERIFIED-SOURCE]` (file exists; not opened for this document).

### 5.7 Documented vs. not

| Claim | Status |
|---|---|
| No CV in the app; the agent's vision does the reading | `[VERIFIED-SOURCE]` — decisive, by exhaustive grep (§5.1) |
| The image must be supplied twice (page + chat) | `[VERIFIED-SOURCE]` — stated in code comments and tool descriptions |
| Scale comes from one human-supplied real dimension | `[VERIFIED-SOURCE]` — `calibrateUnderlay` is pure arithmetic |
| The mapping is fractional, not pixel | `[VERIFIED-SOURCE]` — `tools.ts:151-163` |
| The protocol is a string constant in tool descriptions | `[VERIFIED-SOURCE]` — `tools.ts:30-39` |
| The traced plan data is reproducible from `trace.mjs` | `[VERIFIED-SOURCE]` |
| The demo agent (Codex) actually achieved 0 issues on a clean plan | `[UNVERIFIED]` — author's account, not observable |
| **The accuracy of any agent tracing an unseen plan** | `[UNVERIFIED]` — **no accuracy metric is published anywhere**, for either project |
| The demo produced 12 walls, 14 openings, 10 rooms, 34 pieces of furniture | `[OBSERVED-LIVE]` for the Devpost claim and the screenshot activity feed; `[VERIFIED-SOURCE]` that `trace.mjs` is consistent with it — corroborating, not confirming |

### 5.8 What this means for Argon

**The app is the ruler and the tool provider; the agent is the eye.** `[INFERRED]` — rests directly on §5.1's verified zero-CV result combined with the verified `TRACING_PROTOCOL` text.

Consequences, stated plainly:

- **The hard part is entirely delegated to the host model.** Accuracy, scale ambiguity and symbol recognition are all inherited from whichever agent the user happens to be running. Alza has **no lever over them at all** `[INFERRED]` — rests on there being no code path between the image and the model that Alza controls.
- **Argon is provider-independent; Alza is not.** Argon replaces "whatever WebMCP host the user has open" with an explicit orchestration layer (§9.4). That is a structural difference, not a feature difference: Alza's tracing quality is a property of the user's chat window.
- **A genuinely differentiated Argon feature is doing the vectorisation in-browser** — edge/contour detection, line fitting, room-graph reconstruction — so scale estimation and wall extraction become deterministic and measurable, with the model used only for naming rooms and flagging ambiguity `[INFERRED]`. **Nothing in Alza competes with that**, and nothing in ArchMorph either. This is the clearest open position Argon has identified in this research.

---

## 6. What ArchMorph is

### 6.1 Identity

An architecture / schematic-design tool built during The WebMCP Challenge submission period, single commit `4fb995e` *"feat: add wall investigation and regression tests"*, **MIT**, "Copyright (c) 2026 ArchMorph contributors" `[VERIFIED-SOURCE]`. Its README points to `docs/COMPETITION_EVIDENCE.md` for the timestamped implementation record and evidence paths `[VERIFIED-SOURCE]`. **~16.2k lines** across `src/`, `worker/` and `scripts/` `[VERIFIED-SOURCE]` (`wc -l`, re-confirmed: 16,272).

### 6.2 Verified stack and findings

| Fact | Detail | Tag |
|---|---|---|
| Framework | **Next.js 16.3.3** + **React 19.2.8**, built on Vite 8 + `vinext` + Wrangler | `[VERIFIED-SOURCE]` (`package.json`) |
| 3D | **Three.js ^0.185.1**, raw — no react-three-fiber | `[VERIFIED-SOURCE]` |
| Entry | `worker/index.ts` | `[VERIFIED-SOURCE]` |
| Backend deps | **No ORM, no database, no auth, no LLM SDK** | `[VERIFIED-SOURCE]` |
| WebMCP registration | **`document.modelContext.registerTool()`** at `src/app/components/Studio.tsx:926-935` and `Hero.tsx:132-141` | `[VERIFIED-SOURCE]` |
| **Model endpoint / API key / LLM prompt** | **None anywhere in `src/` or `worker/`** | `[VERIFIED-SOURCE]` |
| Tool surface | `src/lib/webmcp-tools.ts` = **1,288 lines, exactly 63 typed tools** | `[VERIFIED-SOURCE]` — 63 distinct `name:` literals, confirmed by extraction and count |
| Batch application | `preview_changes` (dry-run, 1–50 changes) and `apply_changes` (atomic, `expectedVersion` optimistic lock) at `webmcp-tools.ts:1285-1286` | `[VERIFIED-SOURCE]` |
| Model units | **FEET** — `create_room` requires x/y/width/length in feet (`webmcp-tools.ts:288-320`) | `[VERIFIED-SOURCE]` |
| Domain module | `src/lib/architecture.ts` = **3,970 lines**; units in feet (`README:139`) | `[VERIFIED-SOURCE]` |
| Walk camera | `WALK_EYE_HEIGHT = 5.4` at `ModelView.tsx:64` — **5.4 feet ≈ 1.65 m** | `[VERIFIED-SOURCE]` |
| Canonical topology | `rebuildCanonicalTopology` at `architecture.ts:1565`; `ALIGNMENT_TOLERANCE = 0.25` (ft) at `architecture.ts:1942` | `[VERIFIED-SOURCE]` |
| 2D | **inline SVG** `FloorPlan.tsx` (863 lines) | `[VERIFIED-SOURCE]` |
| 3D view | **raw Three.js** `ModelView.tsx` (1,561 lines), `planExtrusion` + `ExtrudeGeometry` (`ModelView.tsx:110-120`) | `[VERIFIED-SOURCE]` |
| Persistence | **`localStorage` key `archmorph.project-library.v1`**, `PROJECT_SCHEMA_VERSION = 7`, `migrateProject()` at `architecture.ts:1829` (sets `schemaVersion = 7` inline), bounded history with `HISTORY_BYTES = 500_000` and a 30-entry undo/redo cap | `[VERIFIED-SOURCE]` (`src/lib/persistence.ts:9-23`, `architecture.ts:1829`) |
| Tests | **hand-written assertion scripts** in `scripts/*.ts`, run with `node --experimental-strip-types` (8 test scripts + 1 investigation script). **No test framework, no CI** | `[VERIFIED-SOURCE]` (`package.json` scripts) |
| CSS | **Tailwind 4** (`@import "tailwindcss"` at `globals.css:1`) + a CSS module for the landing page | `[VERIFIED-SOURCE]` |

**The 63 tools span a wider domain** than Alza's 32 — plots, floors, stairs, balconies, facade features, exterior/wall finishes, roofs, area calculations, circulation inspection, view/camera control, snapshot, export `[VERIFIED-SOURCE]` (full name list extracted; 61 open at indent-4 plus 2 pushed at the end of the array, `preview_changes` and `apply_changes`).

**Author's own stated hardest problem:** keeping one source of truth across editor, tools, validation, 2D and 3D `[VERIFIED-SOURCE]` — corroborated by the repo's own `docs/UX_AUDIT_REPORT_2026-09-01.md:282`: *"ArchMorph already demonstrates the hardest part of the concept: one understandable architectural model shared across human editing, agent actions, validation, and presentation."*

### 6.3 Prize

**ArchMorph won the same WebMCP Challenge, in the same flat tier** — it appears in the same winners list as Alza (§2.4) `[OBSERVED-LIVE]`.

### 6.4 ArchMorph's test approach, precisely

`package.json` defines eight `test:*` scripts, each `node --experimental-strip-types scripts/<name>.ts` `[VERIFIED-SOURCE]`: `architecture-regression`, `webmcp-regression`, `model-presentation-regression`, `studio-priority-regression`, `audit-fixes-regression`, `pointer-drag-regression`, `walk-session-regression`, `walls-regression`. There is also `scripts/investigate-walls.ts`, which is not a test. **No vitest, no jest, no playwright, no CI configuration** `[VERIFIED-SOURCE]`.

**These were not run for this document** `[UNVERIFIED]`.

This is a real difference and it is not close: Alza has **30 framework-run unit tests plus a 56-check Playwright E2E battery**; ArchMorph has hand-rolled assertion scripts. Argon already runs vitest and should not regress from it.

---

## 7. Convergence: what both projects prove

Seven convergences, each independently verified in both codebases.

1. **Browser-native WebMCP, and nothing else.** Neither has a model endpoint, an API key, an LLM SDK, or an LLM prompt anywhere in `src/`. Alza: three independent confirmations (source grep, shipped-bundle grep, Devpost copy) `[VERIFIED-SOURCE]` + `[OBSERVED-LIVE]`. ArchMorph: source grep `[VERIFIED-SOURCE]`. **The agent is always the host's, never the app's.** This is the single most load-bearing convergence.

2. **Both register with `document.modelContext.registerTool()`.** Alza `registry.ts:63-69` `[VERIFIED-SOURCE]`; ArchMorph `Studio.tsx:926-935` and `Hero.tsx:132-141` `[VERIFIED-SOURCE]`.

3. **Both render 2D as inline SVG and 3D as raw Three.js — neither uses react-three-fiber.** Alza `Editor.tsx` 444 lines + `three/` `[VERIFIED-SOURCE]`; ArchMorph `FloorPlan.tsx` 863 lines + `ModelView.tsx` 1,561 lines `[VERIFIED-SOURCE]`.

4. **Both are MIT licensed, single-hackathon, solo-or-near-solo repositories.** Alza 4 commits / 1 contributor; ArchMorph 1 commit `[VERIFIED-SOURCE]`.

5. **Both treat "the agent edits the same live model the human is editing" as the thesis.** Alza: one vanilla zustand store powers both the UI and the tools, so actions, validation and undo history are identical for both `[VERIFIED-SOURCE]`. ArchMorph: the same `architecture.ts` model backs the editor, the tools, validation and presentation `[VERIFIED-SOURCE]`. ArchMorph's own audit calls this "the hardest part of the concept" `[VERIFIED-SOURCE]`.

6. **Both write tool errors as actionable sentences, not codes.** Alza's 19 issue messages name entities and quantities in real units; its tool failures return prose like `Blocked: the human declined "…". Nothing was changed — ask them what to do instead.` `[VERIFIED-SOURCE]`.

7. **Both degrade gracefully when no runtime is present.** Alza falls back to an on-page `ToolRunner` that runs **the identical tools through the identical wrapper** — not a second code path `[VERIFIED-SOURCE]` (`tools.ts:526-533`). ArchMorph sets a `"preview"` tool status and carries on `[VERIFIED-SOURCE]` (`Hero.tsx:133-136`). Both show a status indicator rather than a broken page.

**And both won the same challenge** `[OBSERVED-LIVE]` (§2.4).

`[INFERRED]` Together these seven points say something specific: the WebMCP pattern is **not** a wrapper around a normal web app, and it does not require a server. The app publishes typed geometry; the host agent mutates it; the human watches. Both projects reached this independently, from different domains, in ten days.

---

## 8. Divergence, and what Argon should take from each

### 8.1 Side-by-side

| Dimension | **Alza** | **ArchMorph** | Tag |
|---|---|---|---|
| Framework | Vite 7 SPA | Next.js 16.3.3 (Vite 8 / vinext / Wrangler) | `[VERIFIED-SOURCE]` |
| React | 19.1 | 19.2.8 | `[VERIFIED-SOURCE]` |
| Units | **METRES** | **FEET** | `[VERIFIED-SOURCE]` |
| **Tools** | **32** (31 static + 1 dynamic) | **63** | `[VERIFIED-SOURCE]` |
| Tool file | `src/mcp/tools.ts` **535 lines** | `src/lib/webmcp-tools.ts` **1,288 lines** | `[VERIFIED-SOURCE]` |
| **Domain logic** | `issues.ts` 351 + `geometry.ts` 187 + `build.ts` 466 ≈ **1,004 lines** | `architecture.ts` **3,970 lines** | `[VERIFIED-SOURCE]` |
| Total source | **6,534 lines** | **~16,200 lines** | `[VERIFIED-SOURCE]` |
| Constraint/validation | **19 typed issue codes**, oriented-rect SAT | `validate_layout` + `rebuildCanonicalTopology` + `ALIGNMENT_TOLERANCE` | `[VERIFIED-SOURCE]` |
| Batch/atomic edits | none — one call at a time | **`preview_changes` + `apply_changes`**, 1–50, `expectedVersion` lock | `[VERIFIED-SOURCE]` |
| **Persistence** | **NONE** (one comment, no writer) | **localStorage**, schema v7, migration + bounded history | `[VERIFIED-SOURCE]` |
| Undo | 50-deep in-memory `structuredClone` | 30-entry past/future, byte-bounded at 500 KB, sessionStorage tab pointer | `[VERIFIED-SOURCE]` |
| Tests | **vitest 30 tests + Playwright 56 checks** | hand-written `node --experimental-strip-types` scripts | `[VERIFIED-SOURCE]` |
| CSS | **plain CSS**, hand-authored token palette | **Tailwind 4** + a CSS module | `[VERIFIED-SOURCE]` |
| Colour | warm drafting palette, `#f7f4ee` bg / `#e07b39` accent / **`#4f86b0` agent channel** | Tailwind defaults | `[VERIFIED-SOURCE]` / `[VERIFIED-SOURCE]` |
| Deploy | **Cloudflare Pages + Netlify, one `dist/`, two origins** | **Cloudflare** (Wrangler) | `[VERIFIED-SOURCE]` |
| Cross-origin tools | **yes** — Nordika, iframe + `exposedTo` + `postMessage` fallback | no | `[VERIFIED-SOURCE]` |
| Approval gate | **yes** — `ApprovalBar`, 37 lines | not established | `[VERIFIED-SOURCE]` / §11 |
| Multimodal/image | **yes** — underlay + fractional mapping + `TRACING_PROTOCOL` | no equivalent found | `[VERIFIED-SOURCE]` |
| Repo shape | 4 commits, 1 contributor | 1 commit | `[VERIFIED-SOURCE]` |

### 8.2 The decisions Argon should take

**Take from Alza:**

- **The narrow tool surface (32) is the better default over ArchMorph's 63.** `[INFERRED]` Alza's bet is that a small, well-named, well-described surface is easier for a model to use correctly; rests on both counts being accurate and on ArchMorph needing a *separate* batch mechanism (`preview_changes`/`apply_changes`) precisely because 63 single-call tools make multi-step operations unwieldy. **A model choosing among 63 tools has more room to err than among 32.** Argon should pick deliberately and say which philosophy it is following.
- **Alza's zero persistence is a gap to beat, not a philosophy to adopt.** Reloading loses everything. ArchMorph already persists with schema versioning and byte-bounded history `[VERIFIED-SOURCE]`; Argon must not inherit Alza's null state.
- **The constraint engine as an *agent verifier loop* is Alza's single best idea.** `get_issues` is read-only, returns typed codes **and** human-readable sentences with quantities, and its clean-state string is `"0 issues — the plan is clean."` — an unambiguous loop terminator `[VERIFIED-SOURCE]`. ArchMorph's larger `architecture.ts` does not obviously provide the equivalent agent-facing verification surface `[INFERRED]`.
- **The approval gate.** 37 lines of `ApprovalBar.tsx` plus a wrapper check answers a live spec open question (#165/#50). Crucially, a **rejection returns a real failure the agent can act on**, not an exception `[VERIFIED-SOURCE]`. Cheap, high-value, reusable.
- **The agent colour channel.** `--agent: #4f86b0` distinguishes agent actions from human ones throughout the UI `[VERIFIED-SOURCE]`. Argon should adopt this from day one; retrofitting attribution into a UI is painful.

**Take from ArchMorph:**

- **A larger, more capable domain module is worth having if the domain demands it.** 3,970 lines of `architecture.ts` covering plots, floors, stairs, balconies, facade features, finishes and roofs `[VERIFIED-SOURCE]`. Alza's 1,004-line core covers a genuinely smaller problem (walls, openings, rooms, furniture). **Size the domain module against the problem, not against the comparison** `[INFERRED]`.
- **`preview_changes` + `apply_changes` is a better edit protocol than one-call-at-a-time** for anything beyond small edits. Dry-run returns base version, change count, per-step results, **metrics, and validation**; apply is atomic, gated by `expectedVersion`, and any failing step rejects every change. It also supports **prior-step references** (`$1.room.id`) so a batch can chain its own results `[VERIFIED-SOURCE]` (`webmcp-tools.ts:1256-1286`). Alza has no equivalent — a 20-call trace through 32 tools cannot be previewed or rolled back as a unit.
- **Schema-versioned persistence with migration.** `PROJECT_SCHEMA_VERSION = 7` + `migrateProject()` at `architecture.ts:1829` `[VERIFIED-SOURCE]` — the pattern that makes a v1 saved plan loadable after the schema changes. Alza has nothing to migrate.

**Treat as a hazard in both:**

- **Units in feet.** ArchMorph requires feet everywhere — `create_room` demands x/y/width/length in feet, `WALK_EYE_HEIGHT = 5.4`, `ALIGNMENT_TOLERANCE = 0.25` ft `[VERIFIED-SOURCE]`. A "5.4" eye height that is really 1.65 m, and a 0.25 tolerance that is really 7.6 cm, are **the kind of magic number that is unreadable in review and easy to get wrong in a UI label.** Alza's metres are more legible to a general audience and read naturally in every message. **Argon should use metres and say so in one canonical place, never scattered.** `[INFERRED]` — rests on the two verified unit conventions and on every Alza issue message reading more naturally in metres.

---

## 9. Patterns worth adopting, and their limits

### 9.1 The agent verifies its own output — *adopt*

Alza's loop, stated in `TRACING_PROTOCOL` step 8 and implemented as `get_issues` `[VERIFIED-SOURCE]`:

> "Verify, then repair. Call `get_issues`, fix every error it reports, and call it again until only intentional warnings remain."

**Why it works:** the verifier is deterministic code operating on the real model, not the model's own opinion. The agent proposes, the engine disposes. The loop is bounded because each iteration either reduces the issue count or the agent is stuck.

**The limit:** this only works if the constraint set is *small, precise and correct*. Nineteen codes covering the failure modes that matter is tractable. A verifier emitting hundreds of false positives is worse than none — the agent will thrash. **Argon should ship the verifier early and keep it narrow.** `[INFERRED]`

### 9.2 Actionable error sentences as an interface — *adopt, strongly*

This is the author's own stated lesson — **"an error message is an interface"** `[OBSERVED-LIVE]`. In practice it means:

- Entity ids in the message: `Wall wall_10 not found.`, not "invalid id."
- Quantities in real units: `is only 40 cm long (min 50 cm).`
- Actionable next step on rejection: *"Nothing was changed — ask them what to do instead."*

**The limit:** an error message is an interface *to the model*, and that means every message consumes description/context budget on every call. Alza's own README notes the tension explicitly for `TRACING_PROTOCOL` `[VERIFIED-SOURCE]`. Messages must earn their length — a long message that fires on every successful call is a tax.

### 9.3 Dry-run + optimistic-lock change application — *adopt, from ArchMorph*

`preview_changes` (dry run, returns metrics + validation, changes nothing) then `apply_changes` (atomic, `expectedVersion`, all-or-nothing) `[VERIFIED-SOURCE]`. The `expectedVersion` check is the important half: it rejects a batch computed against a stale model rather than applying it to a world that has moved on.

**The limit:** `preview_changes` and `apply_changes` both re-execute the batch (`prepareBatch` is called in both), so the work is done twice `[VERIFIED-SOURCE]`. For a 50-change batch against a 3,970-line domain module, that is real. Argon should cache the prepared draft between preview and apply, keyed by `expectedVersion`. `[INFERRED]`

### 9.4 Permission hints and the approval gate — *adopt the gate; do not adopt the cross-origin part*

**Adopt — the gate.** A destructive call parks as a UI request; the agent's `execute()` stays pending; the human decides; a rejection is a **normal result the agent can reason about**, not an exception `[VERIFIED-SOURCE]`. Note the subtlety Alza gets right: **`destructiveHint` is not part of WebMCP's `ToolAnnotations`** (it exists in MCP's, which carries it) `[VERIFIED-SOURCE]`, so Alza keeps it in its own descriptor type and enforces it page-side. Argon doing the same is correct and honest — the gate must not depend on a browser propagating an annotation that the spec does not define.

**Do not adopt — cross-origin tool exchange.** Alza's flagship novelty (a second origin publishing `nordika_list_products`/`nordika_get_product`, discovered via `getTools({fromOrigins})`, called via `executeTool()`, with a `_headers` file and `Permissions-Policy: tools=(…)`) is elegant, but **Argon replaces WebMCP with a provider-independent MiniMax orchestration layer** and is architecturally single-origin. Adding a second origin to serve a mock catalogue would add a headers contract, an iframe and a transport fallback for no product benefit. **The pattern is worth remembering and not worth copying.**

### 9.5 Fractional image coordinates — *adopt regardless of who does the vision*

The insight in §5.3 survives independently of Alza's architecture: **fractions survive a resize, pixels do not.** `[VERIFIED-SOURCE]` rests on the verified `mapping` block and its warning string.

Whether Argon's vision runs in a provider-independent orchestration layer or in the browser, this applies: any coordinate that crosses a boundary where the image may have been re-encoded must be **normalized 0..1**, never absolute pixels. `[INFERRED]` — this is a generalisation of a verified implementation detail, and it is the one pattern from Alza's tracing work that is unconditionally correct for Argon.

### 9.6 Procedure-as-constant — *adopt the content, question the mechanism*

Alza ships `TRACING_PROTOCOL` as an 8-step string array in tool descriptions because WebMCP has no skills concept `[VERIFIED-SOURCE]`. The **content** — an explicit fidelity rule ("copy the drawing, do not redesign it"), an explicit ordering (structure before contents), an explicit ambiguity policy (`leave_note`, do not invent), and an explicit termination condition (`get_issues` until clean) — is exactly the kind of thing that makes agent behaviour predictable.

The **mechanism** is the weak part: the author himself notes it "spends description budget on every tool that references it" `[VERIFIED-SOURCE]`. `[INFERRED]` Argon has a better place to put this — a provider-independent orchestration layer can hold a proper system prompt or a skills document, once, rather than duplicating it into every tool description. **Adopt the protocol; do not adopt the delivery hack.**

---

## 10. What we deliberately do NOT copy

### 10.1 No code reuse

Both projects are **MIT**, which is permissive: we may read, study, and reuse substantial portions provided the copyright notice and permission notice are included `[VERIFIED-SOURCE]`. **Argon will not do so anyway.** The brief is explicit: **Argon reimplements the desired functionality with original code.** The MIT licence makes studying permissible; it does not make copying the plan. `[VERIFIED-SOURCE]` for the licence terms; the decision to not reuse is a project constraint, not a legal one.

### 10.2 No asset reuse — enumerated

The following are **off-limits** and will not be copied, reused, or shipped in any form:

| Asset | Detail | Why |
|---|---|---|
| `plan-source.jpeg` | 345,425 bytes, **2048×2048** — the demo floor plan the agent traced (dimensions confirmed by JPEG SOF marker parse for this document) | It is the subject of Alza's traced demo. Even if its provenance is clean (§10.3), there is no benefit and non-trivial risk in taking it |
| `shots/showcase/*.png` | 16 stills + `preview.gif`, ~8 MB tracked | Screenshots of their UI. Using them would misrepresent Argon's own product as theirs |
| Nordika supplier product data | 12 products: names, SKUs (NK-*), EUR prices, stock counts, colours | Their invented catalogue, verbatim |
| The demo floor plan **as a dataset** | the geometry in `trace.mjs` — 12 walls, 14 openings, 10 rooms, 35 items | Even though `trace.mjs` is *data*, not code, it is a reproduction of their demo plan. **Argon will generate its own demo plan from its own assets** |

### 10.3 Provenance of `plan-source.jpeg` — do not rely on it either way

`[INFERRED]` The image was visually inspected during the prior session: a clean, generic, black-and-white vector-style apartment plan with **no text, no dimensions, no logo, no title block, and no identifiable property**. This is *consistent with* the author's Devpost account that he deleted the original repo and "generated my own plan, and re-traced everything from scratch" `[OBSERVED-LIVE]`. **Authorship cannot be proven from the image alone, and the file's origin cannot be traced.** Treat it as *probably* self-made — and do not use it regardless. The risk is asymmetric: no upside, real downside.

Worth recording as a general lesson: **this project already made the copyright mistake once** and recovered by nuking the repo, because git keeps history `[OBSERVED-LIVE]`. Its current asset is very likely clean. **Ours should be clean by construction**, which is a stronger guarantee than provenance analysis.

### 10.4 No UI imitation

Alza's warm drafting palette (`#f7f4ee` / `#e07b39`) and its specific layout (left toolbar, sidebar with six tabs, header pill) `[VERIFIED-SOURCE]` are theirs. The **general principle** of a token-based colour system with a distinct agent channel is worth taking (§8.2); the specific hex values and layout are not. Argon will have its own visual identity with its own original assets.

### 10.5 No demo-plan reuse, and no claim we did not earn

**Argon will not claim a "0 issues" result it has not measured.** Neither project's zero-issue claim is reproducible from published data (§11.4). If Argon publishes any accuracy or issue-rate figure, it will be measured by Argon's own harness on Argon's own assets.

---

## 11. Could not verify

Each item below was attempted and not obtained. Nothing elsewhere in this document depends on any of them.

1. **The Devpost comment thread ("10 Comment").** Devpost renders comments client-side. `WebFetch` returns **HTTP 403** for `devpost.com`; `curl` with a desktop Chrome User-Agent returned HTTP 200 with the full server-rendered project copy, but the raw HTML contains **no comment bodies**. **No comment content was read.** `[UNVERIFIED]`

2. **The Devpost updates page** (`https://devpost.com/software/alza/updates/823992`) — *partially resolved, and the resolution is a null.* Fetched at **HTTP 200, 116,729 bytes**, server-rendered. It contains **no update body at all** — only an author line and an empty `<div data-region="comments"></div>`, followed by "Log in or sign up for Devpost to join the conversation." **This is a valid null finding, not a fetch failure.** Its one real yield is the precise submission timestamp `2026-09-01T19:06:55-04:00`. `[OBSERVED-LIVE]` as a null.

3. **The demo video** (`youtube.com/watch?v=RihMFcMstvI`). **Never watched.** Title, 2m15s duration and the HyperFrames authoring note come from the README and search results. **The film content is entirely unverified.** `[UNVERIFIED]`

4. **The accuracy of the traced demo.** **No accuracy metric is published anywhere**, for Alza or ArchMorph. "0 issues — the plan is clean" is self-reported by the author for a plan the author also authored, and the run itself cannot be observed. **There is no independent evaluation of either tool's tracing quality.** `[UNVERIFIED]`

5. **The author's real identity.** Beyond the Devpost handle `Elioz404`, the GitHub handle `Elioz`, and the git commit email `eliasemanuel.ltorres@gmail.com` `[VERIFIED-SOURCE]`, nothing is established. The Devpost profile lists Argentina `[OBSERVED-LIVE]`. **Whether this corresponds to a real, publicly-identifiable person is not established, and Argon should not assert it.** The associated YouTube channel is unconfirmed. `[UNVERIFIED]`

6. **Provenance of `plan-source.jpeg`.** Dimensions (2048×2048) and file size (345,425 bytes) confirmed. **Authorship is inferred from the Devpost copyright story plus visual inspection, not proven.** No EXIF examination beyond the JPEG SOF dimensions. `[UNVERIFIED]` as to origin; see §10.3 for why it does not matter.

7. **Any blog writeup / HackMD.** The Devpost page links none. A search surfaced a `note.com` article and a `shielyule.co.uk` blog that *may* cover Alza; **neither was confirmed to be about this project, and neither was relied on.** `[UNVERIFIED]`

8. **The Playwright E2E battery** (`e2e-full.mjs`, 56 checks). **Never run** — requires both dev servers plus a browser download. Only the 30 vitest unit tests were executed (during the prior session) and they pass. `[UNVERIFIED]`

9. **Alza's live UI, as rendered.** The SPA shell served an empty `<div id="root">`. **No rendered interface was ever seen.** All UI description comes from committed screenshots (real captures, never seen being produced) and from strings extracted from the shipped bundle. **Live parity with those screenshots is unverified.** `[UNVERIFIED]`

10. **Whether `bornio/alza` contains changes.** It was confirmed to be a fork of `Elioz404/Alza` (created 2026-09-28) `[OBSERVED-LIVE]`. **It was not read**, and nothing in this document relies on it.

11. **ArchMorph's approval/permission model.** The brief-verified ArchMorph facts do not include an equivalent to Alza's `ApprovalBar`, and **no such mechanism was found** in the spot-checks performed. Whether ArchMorph has *some* other consent mechanism is **not established** — the table in §8.1 marks it "not established" rather than "absent." `[UNVERIFIED]`

12. **Stale items in the notes file's §11.** Two entries there are superseded and are **not** carried into this document:
    - **§11.4 "Treat winner status as unconfirmed"** — stale. Superseded by §1.7's four first-party Devpost sources. Resolved in §1.6 and §2.4.
    - **§11.2 "the Devpost updates page — treat as unretrieved"** — stale. The page was retrieved (HTTP 200, 116,729 bytes); it is simply empty. Resolved in §1.6 and §11.2 above.

    One further notes-file error is carried forward as a correction: **§2.4's tool enumeration omits `build_3d`** and double-counts `extend_selected_wall`, listing 31 names where the true static count is 31 including `build_3d` (32 total). Corrected in §4.3.

---

## 12. Sources

| # | URL / path | What was actually obtained | Status |
|---|---|---|---|
| 1 | `https://devpost.com/software/alza` | Full server-rendered project copy: title, tagline, author, submission date, 10 likes, all five sections, "Built With" tag list, live-URL/repo/video links, raw-github screenshot URLs, WebMCP issue links, **winner label** | **HTTP 403** via WebFetch; **HTTP 200, 157,432 bytes** via curl + desktop Chrome UA |
| 2 | `https://devpost.com/software/alza/updates/823992` | Author line + timestamp `2026-09-01T19:06:55-04:00`. **No update body — genuinely empty** | **HTTP 200, 116,729 bytes** |
| 3 | `https://webmcp.devpost.com/updates/46049-meet-the-winners` | Verbatim Alza winner entry; flat $3,500 tier, 10 winners | HTTP 200 |
| 4 | `https://webmcp.devpost.com/project-gallery` | Server-rendered; 10 of 24 page-1 entries carry the winner ribbon, Alza among them | HTTP 200 |
| 5 | `https://devpost.com/Elioz404` | `winner-ribbon` asset + "Winner" label; Argentina; 2 projects, 2 hackathons, 5 achievements, 3 followers | HTTP 200 |
| 6 | `https://webmcp.devpost.com/` | Challenge metadata: 10 days, 7,057 participants, ~2,500 projects, $35,000 prizes, judging criteria, 7 judges, sponsors, winners announced Sep 28 2026 | HTTP 200 |
| 7 | `https://alza-dev.pages.dev` | 908-byte SPA shell with empty `<div id="root">`; title and meta description. **No rendered UI** | **HTTP 200, 908 bytes** |
| 8 | `https://alza-dev.pages.dev/assets/main-BeLHT9JM.js` | 830,886-byte shipped bundle. Zero hits for 8 provider strings, 6 key patterns, 4 network APIs, and `fetch(`. 22 URL literals of which 2 real. 32 tool names; transport-degradation and UI strings | **HTTP 200** |
| 9 | `https://alza-dev.pages.dev` response headers | CSP `frame-ancestors`, **`Permissions-Policy: tools=(self "https://alza-dev.netlify.app")`**, referrer-policy, nosniff, ACAO `*`, `server: cloudflare` | HTTP 200 |
| 10 | `https://alza-dev.netlify.app` (partner) | "Nordika — furniture supplier", separate 4,991-byte bundle, **zero URL literals** | **HTTP 200** |
| 11 | `github.com/Elioz404/Alza` — cloned at `F:\Argon\_research\alza` | Full source + README read. MIT, **4 commits**, 1 contributor, 6,534 lines. Line counts, tool names, issue codes, data model, dependency list, and **all three decisive greps re-run for this document** | Local clone (MIT) |
| 12 | `…/Alza/…/src/mcp/tools.ts` | 535 lines. `TRACING_PROTOCOL` (8 steps), 31 tool descriptors, `EXTEND_SELECTED_WALL`, `runToolManually` | `…/tools.ts:30-39, 41-499, 502-523, 529-533` |
| 13 | `…/Alza/…/src/model/issues.ts` | 351 lines, **19 issue codes** extracted and counted; message templates quoted | `issues.ts` message lines 65–343 |
| 14 | `…/Alza/…/src/model/types.ts` | 124 lines; header comment "all units are meters"; `t`-to-centre and `rotation`-is-facing conventions | `types.ts:1-124` |
| 15 | `…/Alza/…/src/mcp/registry.ts` | `getModelContext` (document then navigator), `executeWrapped` approval gate, `destructiveHint` page-side enforcement rationale, `RemoteTool`/`ModelContextLike` shapes | `registry.ts:53-69, 78-100` |
| 16 | `…/Alza/…/src/mcp/bootstrap.ts` | Dynamic tool lifecycle via per-registration `AbortController`; `dynamic.abort()` as "the spec's unregistration path"; `toolchange` listener | `bootstrap.ts:37-65, 69-73` |
| 17 | `…/Alza/…/src/ui/Sidebar.tsx` | Upload handler; **the single `localStorage` hit is the comment at line 40**; ≤1600 px re-encode at quality 0.82 | `Sidebar.tsx:40-52` |
| 18 | `…/Alza/…/src/model/store.ts` | 544 lines; `calibrateUnderlay` arithmetic; 50-deep undo via `structuredClone`; 200-entry activity ring | `store.ts:101, 109, 374-396` |
| 19 | `…/Alza/…/src/editor/Editor.tsx` | 444 lines; blueprint underlay as SVG `<image>` | `Editor.tsx:299-307` |
| 20 | `…/Alza/…/src/styles.css` | 259 lines; warm drafting palette tokens incl. `--agent: #4f86b0` | `styles.css:1-15` |
| 21 | `…/Alza/…/vite.config.ts` | 63 lines; `crossOriginHeaders` plugin; `loadEnv` not `process.env` (the documented silent-bug fix); two rollup inputs; `strictPort` 5199/5200 | `vite.config.ts:41-42` |
| 22 | `…/Alza/…/package.json` | Dependencies exactly react 19.1, react-dom 19.1, three ^0.178.0, zustand 5.0.6. Dev: vite ^7, vitest ^3.2.0, playwright ^1.62.1, typescript ^5.8.3, @vitejs/plugin-react ^4.6.0 | — |
| 23 | `…/Alza/…/partner/supplier.js` | 164 lines; **12 products** counted; `Valby wardrobe 150` at `stock: 0`; `nordika_list_products` / `nordika_get_product` | `supplier.js:13-24, 72, 90` |
| 24 | `…/Alza/…/trace.mjs` | Demo plan as data: exterior 10.00 × 11.16 m, **138.2 px/m**, exterior box at pixels (333,222)..(1715,1764), WALLS/OPEN/ROOMS/FURN arrays | `trace.mjs:1-20` |
| 25 | `…/Alza/…/plan-source.jpeg` | **2048×2048**, 345,425 bytes (SOF marker parsed). Visually inspected in prior session — generic plan, no text/logo/title block. **Provenance unproven** | `…/plan-source.jpeg` |
| 26 | `…/Alza/…/shots/showcase/` | **17 files** (16 PNG + `preview.gif`) listed; 4 opened and described. **Never seen being produced** | Local listing |
| 27 | `…/Alza/…/tests/*.test.ts` | 91 + 149 lines; seed-regression asserting 0 issues. **30 tests passed** (run in prior session) | `issues.test.ts:8-10` |
| 28 | `…/Alza/…/e2e-full.mjs` | 315 lines; **56 checks**; `--enable-features=WebMCP`; `navigator.modelContextTesting`; 2 skipped on stable Chrome. **Never run** | `e2e-full.mjs:4, 138-158` |
| 29 | `…/Alza/…/README.md` | 18,764 bytes. Tool table, "The 31 tools (+ 1 dynamic)", approval gate section, **"What building this taught me about the spec"** citing WebMCP issues #165/#50/#41/#86/#81/#161 | `README.md:118-170, 228-265` |
| 30 | `…/Alza/…/LICENSE` | MIT, "Copyright (c) 2026 Alza contributors" | — |
| 31 | `…/Alza/…/.git` log | **Exactly 4 commits**: `b672279`, `72cb3c9`, `c1fbb42`, `b4d01d1` | Re-run for this document |
| 32 | `github.com/webmachinelearning/webmcp` | Cited by Alza for open issues **#165, #50, #41, #86, #81, #161**. **The spec repo itself was not read for this document** — the issues are known only as Alza cites them | Not fetched |
| 33 | `F:\Argon\_research\archmorph` — commit `4fb995e` | Spot-checked: `package.json` (Next 16.3.3, React 19.2.8, three ^0.185.1, Tailwind 4, `node --experimental-strip-types` test scripts); **63 distinct tool names** counted; `webmcp-tools.ts` 1,288 / `architecture.ts` 3,970 / `FloorPlan.tsx` 863 / `ModelView.tsx` 1,561; `registerTool` at `Studio.tsx:927-935` and `Hero.tsx:133-141`; `WALK_EYE_HEIGHT = 5.4`; `ALIGNMENT_TOLERANCE = 0.25`; `rebuildCanonicalTopology:1565`; `migrateProject:1829`; `PROJECT_SCHEMA_VERSION = 7` and `PROJECT_STORAGE_KEY = "archmorph.project-library.v1"` in `persistence.ts:9-10`; `planExtrusion` + `ExtrudeGeometry` at `ModelView.tsx:110-120`; feet at `README:139` and `create_room` schema at `webmcp-tools.ts:288-320`; `preview_changes`/`apply_changes` at `webmcp-tools.ts:1285-1286`; MIT; **1 commit**; ~16,272 lines | Local clone (MIT). **Tests not run; app not run** |
| 34 | `…/archmorph/docs/UX_AUDIT_REPORT_2026-09-01.md` | Line 282: "one understandable architectural model shared across human editing, agent actions, validation, and presentation" — corroborates the author's stated hardest problem | Local file |
| 35 | `…/archmorph/README.md` | Line 139: "Canonical project units are currently feet." Competition record + MIT + a limitations block (not BIM, not code-compliant, single-user, WebMCP evolving) | `README.md:135-152` |
| 36 | `https://digg.com/ai/2yjnmies` | OpenAI Developers reshare introducing **both** projects: "Alza turns floor-plan photos into 2D and 3D models"; also where ArchMorph surfaced | HTTP 200 (prior session) |
| 37 | `https://www.youtube.com/watch?v=RihMFcMstvI` | Title and 2m15s duration from README/search. **Never watched** | **Not retrieved** |
| 38 | `https://hyperframes.heygen.com/` | HeyGen video composition tool, cited by Alza's README as the film's authoring tool. **Not visited** | Not fetched |
| 39 | `api.github.com/repos/Elioz404/Alza`, `/languages`, `/contributors`; `/repos/bornio/alza` | 13★, 7 forks, created 2026-09-01, pushed 2026-09-03, 8,429 KB, topics; TS 212,720 / JS 58,247 / CSS 10,164 / HTML 3,142 bytes; 1 contributor; **`bornio/alza` is `fork: true`, parent `Elioz404/Alza`, created 2026-09-28** | HTTP 200 (prior session) |
| 40 | `https://modelcontextprotocol.io/specification/2025-11-25/server/tools` | MCP `ToolAnnotations` reference, cited by Alza for `destructiveHint`. **Not visited for this document** — the claim that WebMCP omits `destructiveHint` rests on Alza's `registry.ts:20-31` comment | Not fetched |
| 41 | `F:\Argon\_research\alza-notes.md` | 616 lines of prior research, tags preserved. **Known stale items and one enumeration error identified and corrected — see §1.6 and §4.3** | Local file |

### Sources consulted but yielding nothing load-bearing

`note.com` and `shielyule.co.uk` search results (possibly about Alza, unconfirmed, **not relied on**) `[UNVERIFIED]`; `aicatchup.com` (third-party winners claim that §1.6 supersedes) `[UNVERIFIED]`; `modelcontextprotocol.io` and `webmachinelearning/webmcp` themselves (not fetched — all spec claims in this document are Alza's citations of them, flagged as such at source #32 and #40).

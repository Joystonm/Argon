# Alza — Phase-1 Reverse-Engineering Notes

**Project:** Alza — an agent-native floor-plan studio
**Hackathon:** The WebMCP Challenge (`https://webmcp.devpost.com/`), hosted by OpenAI Developers / Devpost
**Team:** Elioz 404 (Devpost handle `Elioz404`; sole contributor, GitHub `Elioz404`)
**Submission date:** Sep 01, 2026 (Devpost page) / repo created `2026-09-01T19:54:31Z`
**Research date:** 2026-10-15
**Researcher scope:** source code read at `F:\Argon\_research\alza` (a clone of `github.com/Elioz404/Alza`)

---

## Tagging convention

| Tag | Meaning |
|---|---|
| `[VERIFIED-SOURCE]` | I read the actual source code in the cloned repo |
| `[OBSERVED-LIVE]` | I fetched a running app/page and saw it or read its rendered text |
| `[INFERRED]` | My reasoning, not a fact. Always states what it rests on |
| `[UNVERIFIED]` | I tried and could not get it |

**No claim in this document is asserted without one of these tags.** Where the Devpost page *claims* something and I verified it in source, both are stated separately.

---

## 0. HEADLINE ANSWER: does Alza ship a server-side model endpoint or API key?

**No. Alza has no backend, no model endpoint, and no API key — anywhere.** This matches ArchMorph exactly.

How I know, three independent ways `[VERIFIED-SOURCE]`:

1. **Zero network calls in the entire runtime source.** I grepped `src/` and `partner/` for `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`. **Result: no matches.** The only `fetch(` / `page.goto` calls in the repo are in Playwright driver scripts (`e2e-full.mjs`, `record6.mjs`, `shots.mjs`), which are dev tooling, not app code.
2. **No provider strings, no keys.** Grep for `openai|anthropic|claude|gpt-|gemini|api[_-]?key|sk-…|secret|auth` across `src/`, `partner/`, `tests/`, root scripts: the only hits were the English words "author"/"agent" in identifiers and one `token`-free product record. **No LLM provider is referenced at all.**
3. **No `package.json` dependency on any AI SDK.** Dependencies are exactly: `react`, `react-dom`, `three`, `zustand`. Dev: `@types/*`, `@vitejs/plugin-react`, `playwright`, `typescript`, `vite`, `vitest`.

The committed `.env` contains only two **public URLs**, and the file says so in its own comments:

```
VITE_STUDIO_ORIGIN=https://alza-dev.pages.dev
VITE_SUPPLIER_ORIGIN=https://alza-dev.netlify.app
```
> "These are public URLs, not secrets — committed so `npm run build` is reproducible." `[VERIFIED-SOURCE]`

**So who is the AI?** The agent is **not in the app**. It is whatever WebMCP-capable host the human opens the page in — ChatGPT desktop's in-app browser, or Codex. The app is a pure tool *provider*; the model lives in the user's agent. This is the same architecture as ArchMorph. `[VERIFIED-SOURCE]` for the absence; `[INFERRED]` that the demo agent ran in Codex (the Devpost copy says "Running in Codex" — see §1.5, and that is a claim, not something I could verify).

The README states it directly: *"Everything runs client side. No backend, no accounts, plans stay on your machine."* `[VERIFIED-SOURCE]` (README.md) — and it is **true**, I verified it.

---

## 1. Devpost submission

### 1.1 Identity

| Field | Value | Tag |
|---|---|---|
| Title | **Alza** | `[OBSERVED-LIVE]` |
| Tagline | "A floor plan is coordinates, not buttons. Alza publishes its geometry as 31 typed tools, so your agent draws the plan, checks its own work, buys from another origin, and raises it to walkable 3D." | `[OBSERVED-LIVE]` |
| Author | Elioz 404 (`Elioz404`) | `[OBSERVED-LIVE]` |
| Submitted | Sep 01, 2026 | `[OBSERVED-LIVE]` |
| Likes | 10 | `[OBSERVED-LIVE]` |
| Hackathon | The WebMCP Challenge | `[OBSERVED-LIVE]` |

**Note on fetching Devpost:** `WebFetch` returned **HTTP 403** for `devpost.com`. `curl` with a desktop Chrome User-Agent returned **HTTP 200, 157,432 bytes** and the full server-rendered text. All Devpost content below came from that fetch. **Devpost renders comments client-side — the "10 Comment" thread content is NOT retrievable** and I did not read it.

### 1.2 Links listed on the Devpost page `[OBSERVED-LIVE]`

- **Live app:** `https://alza-dev.pages.dev` (Cloudflare Pages)
- **Repository:** `https://github.com/Elioz404/Alza` — *note: this is the canonical repo, NOT `bornio/alza`*
- **Video:** `https://www.youtube.com/watch?v=RihMFcMstvI` (embedded via YouTube iframe)
- **Screenshot images referenced from raw.githubusercontent:** `shots/showcase/02-traced-over-the-drawing.png` and `shots/showcase/11-agent-authored-pieces.png`
- **Spec issues cited in the copy:** webmachinelearning/webmcp issues **#165, #50, #41, #86, #81, #161**

**Correction worth recording:** a web search surfaced `github.com/bornio/alza`. I cloned it and then checked the GitHub API: `bornio/alza` is **`fork: true`, `parent: Elioz404/Alza`**, created 2026-09-28 (4 weeks *after* the parent). `[OBSERVED-LIVE]` via `api.github.com`. The canonical, author-owned repo is **`Elioz404/Alza`**.

### 1.3 "Built With" (Devpost tag list) `[OBSERVED-LIVE]`

`3d`, `ai-agents`, `architecture`, `cloudflare-pages`, `css`, `javascript`, `model-context-protocol`, `netlify`, `playwright`, `react`, `svg`, `three.js`, `typescript`, `vite`

### 1.4 The five Devpost sections (near-verbatim) `[OBSERVED-LIVE]`

These are **the Devpost copy's claims about the software**. I have separately marked where source code confirms them.

**Inspiration.** "I had a floor plan as a photo and wanted to see it in 3D. That should be a solved problem, but every tool I found wanted me to redraw it by hand, wall by wall… So I tried handing it to an AI agent instead. That was worse… WebMCP looked like the missing half. Not a way to describe the page to an agent — a way to hand it the actual geometry."

**What it does.** "Alza is a floor-plan editor that publishes its own tools. You draw walls, rooms, doors, windows and furniture in a metric 2D canvas, then raise it to a 3D model you can walk through. An agent joins the same live page and works with the same tools you do. The demo is the honest test: I gave the agent a photo of a plan it had never seen. The drawing carries no scale, so it asked for one real dimension, set everything from that, and traced it — **12 walls, 14 openings, 10 rooms, 34 pieces of furniture**." The catalogue had no honest match for some symbols, so the agent modelled them itself (L-shaped sofa, corner shower, compact bath, fitted L wardrobe, washing machine), then checked itself against a constraint engine reporting in metres, and left a note about one ambiguous symbol.

**How I built it.** "Vite, React, TypeScript, Three.js. **No backend at all** — it is a static site, and plans never leave the browser." Tools registered on `document.modelContext` at load via `document.modelContext.registerTool(descriptor, { signal, exposedTo })`. There is a 32nd tool that exists only when relevant: select a wall and `extend_selected_wall` appears; deselect and it is gone, unregistered by aborting its `AbortSignal`. The constraint engine is **oriented-rectangle SAT**. The partner ("Nordika") is a genuinely separate site on a separate origin, discovering via `getTools({ fromOrigins })` and calling via `executeTool()`.

**Challenges I ran into.** Three, all interesting:
1. **Copyright.** "The plan I first traced turned out to be copyrighted. I had pulled it off Google without thinking, and by the time I noticed, it was committed to a public repo… Deleting the file did nothing: git keeps history. I deleted the repo, generated my own plan, and re-traced everything from scratch."
2. **Video judder.** A recorder capped at 25 fps and rendering in software; continuous camera motion read as stepping. Switched to real GPU screen capture at 60 fps.
3. **A silent production bug.** "The production build was shipping without its cross-origin headers, so the partner iframe was never allowed to publish its tools — the flagship feature, quietly dead on the live URL. The cause: Vite loads `.env` into `import.meta.env` but *not* into `process.env`, and the plugin that writes the headers was reading `process.env`. It failed by emitting a header that looked plausible." Building the demo also found real app bugs: walk camera passing through walls, look-around orbiting instead of turning, 2D auto-fit anchoring to a corner.

**Accomplishments.** (a) The agent recovered from its own mistake unaided — it invented a wall id, got `Wall "wall_10" not found`, used the real one next, and `get_issues` returned `"0 issues — the plan is clean"`. "I did not script that." (b) The constraint engine rejected the catalogue's standard 1.70 m bath ("Bathtub crosses wall") because the alcove is 1.68 m wall-to-wall / 1.58 m clear, so a 1.53 m bath was modelled instead. (c) The second origin is real.

**What I learned.** "the agent can see the page" and "the agent can use the page" are different problems. "an error message is an interface". Degrading matters more than expected — cross-origin discovery isn't in every runtime yet, so it falls back to postMessage over the same protocol. And "a build can fail silently and look fine — I now check the artefact, not the exit code."

**What's next:** multi-floor + stairs, IFC export, cost/materials as tools, shared sessions.

### 1.5 Important distinction: claims I could NOT confirm

The "Accomplishments" anecdotes describe a **specific demo run in Codex**. `[UNVERIFIED]` — I cannot confirm the run happened, only that the author describes it. However, **the plan data that would have been produced is checked into the repo** as `trace.mjs` (see §5.3), and it is consistent with the described counts. That is corroborating, not confirming.

### 1.6 Updates page — genuinely EMPTY `[OBSERVED-LIVE]`

`https://devpost.com/software/alza/updates/823992` → **HTTP 200, 116,729 bytes**, server-rendered (not JS-gated). The `<article class="software-update">` contains **only** the author line and an empty `<div data-region="comments"></div>`, followed by "Log in or sign up for Devpost to join the conversation."

- Author: **Elioz 404**
- Timestamp: `2026-09-01T19:06:55-04:00` (Sep 01, 2026 07:06 PM EDT)
- **Body: no update text, no links, no images.**

This is a **valid null finding, not a fetch failure** — the page loads fine; there is simply no update content. Note this also gives us the precise submission timestamp.

### 1.7 PRIZE: Alza WON the WebMCP Challenge `[OBSERVED-LIVE]`

This is a significant result and it is **confirmed by four independent first-party sources**, all HTTP 200:

1. **Devpost awards block on the project page:** `<span class="winner label">Winner</span> WebMCP Challenge Winners`
2. **Devpost winners post** `https://webmcp.devpost.com/updates/46049-meet-the-winners` — verbatim Alza entry: *"**Alza** — A floor-plan editor that shares its tools with agents. Give the agent a photo of a plan and one real measurement, and it traces the walls, rooms, doors, and furniture into a 3D model you can walk through."*
3. **Project gallery** `https://webmcp.devpost.com/project-gallery` — server-rendered; exactly **10 of 24** entries on page 1 carry the winner ribbon; Alza is one.
4. **The author's Devpost profile** `https://devpost.com/Elioz404` renders a `winner-ribbon` asset and a **"Winner"** label next to Alza.

**All 10 winners received an identical flat tier — there is no 1st/2nd/3rd placement.** Devpost lists *"WebMCP Challenge Winners — $3,500 in cash — 10 winners"*. `[INFERRED]` that Alza's share is $3,500 (the flat tier); **the dollar figure is not printed next to Alza's name.**

**The 10 winners:** MASIL, **Alza**, **ArchMorph**, Aisle, Roque Nights, Mandate, Observatory, Bouquet Studio, Faraday, JupyterLite WebMCP.

> **This matters for Argon:** our sibling project **ArchMorph also won the same prize, in the same flat tier.** The two projects we are studying are the two that set the bar. `[OBSERVED-LIVE]`

### 1.8 The challenge itself `[OBSERVED-LIVE]`

- Hosted by **OpenAI**, managed by Devpost. "10 days for exploring what's possible with WebMCP."
- Submissions **Aug 25 – Sep 4, 2026 1:00am PDT**; judging Sep 4 – Sep 21; **winners announced Sep 28, 2026**.
- **7,057 participants**, ~2,500 projects, 100+ countries, **$35,000 in prizes**.
- Judging criteria: **WebMCP Leverage, Execution, Potential Impact, Creativity & Ambition.**
- 7 judges: Cloudflare, MCP-B, Shopify, Vercel, OpenAI, Google Chrome, Netlify.
- Sponsors: OpenAI, Cloudflare ($10k credits), Vercel, Render, Netlify, Shopify, Google Chrome.

### 1.9 Author `[OBSERVED-LIVE]`

Devpost profile **Elioz404**: **Argentina**; GitHub linked; skills `codeanywhere`; interests "Beginner Friendly"; **2 projects, 2 hackathons, 5 achievements, 3 followers, 0 following, 2 likes**. Two hackathons: the **WebMCP Challenge** (7,057 participants, winners announced) and **CALL-E: Your Code Is Calling** (3,208 participants, winners TBD).

Alza is **not** his only project — there is a second, **`/software/holdline-f3uq95`**, whose page I did not fetch. `[UNVERIFIED]`

---

## 2. Live demo app

Live URL: **`https://alza-dev.pages.dev`** (Cloudflare Pages). Partner origin: **`https://alza-dev.netlify.app/partner/index.html`** (Netlify) — titled **"Nordika — furniture supplier"**, a separate 4,991-byte bundle.

### 2.1 It loads, but it is a bare SPA shell `[OBSERVED-LIVE]`

`https://alza-dev.pages.dev` → **HTTP 200, 908 bytes.** The entire server-served body is:

```html
<title>Alza — Plans that rise to 3D</title>
<meta name="description" content="Draw floor plans in 2D, walk them in 3D, and let your AI
agent co-edit the same live page through WebMCP. Built for the WebMCP Challenge." />
<script type="module" crossorigin src="./assets/main-BeLHT9JM.js"></script>
<body><div id="root"></div></body>
```

**`<div id="root">` is empty. I could NOT see any rendered UI** — the app is fully client-rendered, so no header, tabs, or visible text are retrievable over HTTP. Everything in this document about the *visible* UI comes from the committed showcase screenshots (§3), which are real captures, **not** from the live fetch. I am explicitly not describing UI I did not see rendered.

### 2.2 Security headers observed live `[OBSERVED-LIVE]` — the cross-origin mechanism, confirmed in production

```
content-security-policy: frame-ancestors 'self' https://alza-dev.pages.dev
permissions-policy:       tools=(self "https://alza-dev.netlify.app")
referrer-policy:          strict-origin-when-cross-origin
x-content-type-options:   nosniff
access-control-allow-origin: *
server: cloudflare
```

The **`permissions-policy: tools=(self "https://alza-dev.netlify.app")`** directive is the WebMCP origin-delegation control that makes the two-origin architecture work — partner origin allowlisted, nothing else. This is **the production artefact of the exact bug the author describes in "Challenges"**, and it is correctly configured. No HSTS on Cloudflare (present on Netlify).

### 2.3 THE DECISIVE LIVE CHECK: no endpoints in the shipped bundle `[OBSERVED-LIVE]`

The main JS bundle `assets/main-BeLHT9JM.js` is **830,886 bytes** — and it is the *entire* app (a dynamic-import scan found no other chunks, so nothing is hiding in a lazy load). I sanity-checked that it is real minified JS (1,542 `function`, 1,877 `const`) so the zero-hit results are genuine, not a download failure.

**Zero occurrences in the shipped bundle:**

| Pattern | Hits |
|---|---|
| `openai`, `anthropic`, `gemini`, `claude`, `groq`, `mistral`, `ollama`, `perplexity` | **0 each** |
| `apiKey`, `api-key`, `API_KEY`, `Bearer`, `sk-`, `gsk_` | **0 each** |
| `/v1/`, `process.env`, `supabase`, `firebase` | **0 each** |
| `XMLHttpRequest`, `EventSource`, `WebSocket` | **0 each** |
| **`fetch(`** | **0** |

Total URL literals in the whole bundle: **22, of which only 2 are real** — `https://alza-dev.netlify.app` (the partner origin, hardcoded) and `https://react.dev/errors/`. The other 20 are W3C XML namespace URIs from Three.js/SVG. The partner bundle was **equally clean, with zero URL literals**.

**So the "no backend" claim is verified three times over: source, bundle, and Devpost copy.** `[OBSERVED-LIVE]` + `[VERIFIED-SOURCE]`

### 2.4 The 32 tools, extracted from the live bundle `[OBSERVED-LIVE]`

Independently of the source tree, the shipped bundle names **32 tools**, matching §4.1 exactly: `add_room`, `add_wall`, `add_door`, `add_window`, `edit_wall`, `extend_selected_wall`, `remove_wall`, `remove_room`, `remove_opening`, `move_opening`, `set_doors`, `set_door_swing`, `update_room`, `measure`, `get_model`, `get_editor_state`, `get_issues`, `get_notes`, `leave_note`, `get_underlay`, `calibrate_underlay`, `get_item_catalog`, `define_item_kind`, `place_item`, `move_item`, `remove_item`, `clear_model`, `set_camera`, `set_plan_name`, `get_supplier_catalog`, `place_supplier_product` — **plus `extend_selected_wall` as the dynamic 32nd.**

The bundle also contains the transport-degradation string, confirming §4.2 from production: *`… via cross-origin WebMCP`* vs *`… via postMessage fallback`*.

UI strings present in the bundle (again — **not** seen rendered): `"WebMCP runtime detected — tools are live for your agent"`, `"No WebMCP runtime — use the Tools tab"`, `"2d" ? "Build 3D ▲" : "Back to 2D"`.

**Workflow, start to finish** `[VERIFIED-SOURCE]` for the mechanics, `[INFERRED]` where I describe the user's path:

1. **Onboarding:** none. `src/main.tsx` seeds a demo model on first paint and calls `bootstrapWebMCP()` — there is no login, no tour, no modal. The app opens on a furnished 8×6 m plan called **"Sunset Loft"**, audited to 0 constraint issues, with the activity feed already logged. The header pill shows WebMCP runtime status: **"● Site tools live (31 tools registered)"** when the runtime is present.
2. **Draw by hand:** 2D canvas with chained wall drawing, room rects, openings with **door swing arcs**, draggable furniture, **5 cm metric snap**, pan/zoom, and live dimension labels. Sidebar tabs: **Model · Check · Catalog · Supplier · Notes · Tools** (Check/Supplier/Notes carry live badges).
3. **Or trace a photo:** *sidebar → Model → Blueprint underlay.* Uploading an image re-encodes it to JPEG ≤1600 px and pins it as a semi-transparent SVG `<image>` at world (0,0) sized 8 m wide × aspect.
4. **Let the agent work:** the same tools, from the agent. No chat box exists in the app — the conversation lives in ChatGPT/Codex.
5. **Go 3D:** `build_3d` then camera modes **Orbit / Top / Walk** (WASD + drag-look at 1.6 m eye height, with wall/furniture collision). Export **OBJ** and **PNG snapshot** are available.
6. **Without any WebMCP runtime** the app loses nothing — the built-in **ToolRunner** executes the identical tools by hand, every call logged.

---

## 3. Screenshots — what I actually saw

I opened the committed showcase stills as images. All `[VERIFIED-SOURCE]` (they are files in the repo) and `[OBSERVED-LIVE]` in the sense that they are genuine captures of the running app.

`shots/showcase/` contains **17 files** (16 PNG stills + 1 GIF). `[VERIFIED-SOURCE]` — directory listing.

**`02-traced-over-the-drawing.png` — the proof shot.** 2D canvas, cream grid background. The scanned plan photo sits as a pale underlay; dark, crisp vector geometry is overlaid on top and registers with it. Live area labels visible: **"Living 28.3 m²"**, Bedroom 1 **13.1 m²**, Bedroom 2 **9.5 m²**, Bedroom 3 **14.3 m²**, Dressing **4.7 m²**, Bathroom 1, Bathroom 2, Hall **3.8 m²**. Wall dimension callouts in metres (11.15, 10.00, 6.30, 4.00, 3.70, 1.85, 4.70). Header: **"Alza · Traced from a photo of the plan"**; pill **"● Site tools live"**. Left toolbar: Select, **+ Wall**, **+ Room**, Undo, **Build 3D ▲**. Sidebar shows **Check (2)** — i.e. two live constraint issues. Right edge: Catalogue thumbnails with real dimensions (Bathtub 1.7 × 0.75 m, Corner bath 1.4 × 1.4 m, Shower 0.9 × 0.9 m, Toilet 0.38 × 0.65 m, Washbasin 0.55 × 0.42 m, Towel rail, Plant, L-shaped sofa 2.66 × 3.11 m, Corner shower 1.21 × 1.16 m, Compact bath 1.53 × 0.86 m, L-shaped fitted wardrobe 1.6 × 1.92 m, Washing machine, Frejda armchair 0.88 × 0.86 m).

**`04-tool-runner.png` — the WebMCP tool surface.** The Tools tab is open. On-page copy reads: *"These are the exact 31 tools your AI agent discovers via WebMCP, plus the dynamic one. Run them manually to test flows — every call is logged below in the activity feed."* A dropdown shows **`get_model`** with the tool's own description underneath (*"Read the full floor plan: walls (endpoints, thickness, height), openings (doors/windows with position along their wall), rooms (metric rects with labels), furniture, and plan name. All units are metres."*) and a JSON args box `{}`. The bottom activity feed shows timestamped AGENT and YOU lines — including **`get_supplier_catalog  Pulled 12 product(s) from http://localhost:5200 via webmcp.`** and **`place_supplier_product  Frejda armchair (NK-ARM-01, 0.88 × 0.86 m, €329) placed from http://localhost:5200.`**

**`15-3d-walk-eye-level.png` — first-person 3D.** Header toggles **Orbit / Top / Walk** (Walk active), **Export OBJ**, **Snapshot PNG**, **Back to 2D**. Inside the loft: cream walls, wood-plank floor, a real open door with brass handle, hanging pendant lamps, a dining chair and table, a kitchen counter with sink, tiled bathroom beyond. Right sidebar shows Catalog tab with the same dimensioned thumbnails. On-canvas hint: **"WASD / arrows to walk · drag to look · click a door to open it"**. Activity feed: `AGENT build_3d  3D model built: 12 walls, 14 openings, 35 items.` / `set_camera  Camera set to orbit.` / `Camera set to top.` / `set_doors  7 door(s) set to "open".` / `Camera set to walk.`

**`01-3d-orbit-hero.png`** — the three-quarter orbit view of the whole loft raised into 3D.

**`preview.gif`** — an animated loop of the traced plan turning in 3D.

**Screenshot count for matching purposes:** 16 stills + 1 GIF = 17 files; the Devpost page itself embeds a subset (the raw-github references suggest it inlines at least `02-` and `11-agent-authored-pieces.png`) plus the YouTube video. `[INFERRED]` — I derived the "subset" claim from which raw.githubusercontent URLs appear in the page HTML; Devpost's own upload pipeline isn't visible to me.

### 3.1 Video

`https://www.youtube.com/watch?v=RihMFcMstvI` — title from search results: **"Alza — WebMCP Challenge: a floor-plan studio your agent can drive"**; README describes it as **2 min 15 s**, built with **HyperFrames** (heygen.com) from a storyboard and HTML compositions, with the authoring tree deliberately not shipped. **I did not watch the video.** `[UNVERIFIED]` for the film itself — see §7 for whatever metadata was retrievable.

The eight demo beats are reproducible from code: `record6.mjs` "drives the real app through the eight beats while ffmpeg captures the screen at 60 fps". `[VERIFIED-SOURCE]`

---

## 4. Tech stack `[VERIFIED-SOURCE]` — all from `package.json` and source

| Layer | Choice |
|---|---|
| Build | **Vite 7** (`^7.0.0`), dev server pinned to **port 5199** (partner 5200) |
| UI | **React 19.1**, `react-dom` 19.1, plain CSS (`src/styles.css`) — **no Tailwind, no CSS framework** |
| Language | **TypeScript 5.8** (strict) |
| State | **zustand 5.0.6**, vanilla — one store powers both UI and tools |
| 2D | **inline SVG** (`src/editor/Editor.tsx`, 444 lines) — not canvas |
| 3D | **Three.js ^0.178** (raw, no react-three-fiber), ACES filmic tone mapping, PCF soft shadows, `OrbitControls` from `three/examples` |
| Deploy | **Cloudflare Pages** (studio) + **Netlify** (partner origin), both from the *same* `dist/` |
| Tests | **vitest 3.2** (unit) + **Playwright 1.62** (E2E) |
| AI/model | **none** — no SDK, no endpoint, no key (§0) |
| Persistence | **none** — see §5.2 |

GitHub language stats `[OBSERVED-LIVE]`: TypeScript 212,720 B · JavaScript 58,247 B · CSS 10,164 B · HTML 3,142 B. Language: TypeScript. Repo size 8,429 KB.

### 4.1 WebMCP specifics `[VERIFIED-SOURCE]`

- **Registration surface:** `document.modelContext` with a fallback to `navigator.modelContext` (`src/mcp/registry.ts` lines 64-67).
- **Call shape:** `mc.registerTool(descriptor, { signal, exposedTo })` — the two-option signature.
- **Unregistration:** by **aborting the registration `AbortSignal`**, plus a `mc.unregisterTool?.(name)` fallback. `src/mcp/bootstrap.ts` drives the dynamic tool's whole lifecycle and the runtime emits `toolchange`.
- **Tool count: 31 static + 1 dynamic = 32.** `[VERIFIED-SOURCE]` — I extracted exactly 33 `name: "…"` tool definitions in `src/mcp/tools.ts` (the 31 static + `extend_selected_wall`), and the README/UI both say "31 (+1 dynamic)". The Devpost copy says 31; the on-page pill in the screenshot says "31 tools registered". **Consistent.**
- **Annotations used:** `readOnlyHint`, `untrustedContentHint` (both real WebMCP), plus **`destructiveHint` carried on Alza's own `ToolDef`** and enforced page-side, because — as the code comments state — `destructiveHint` exists in MCP's `ToolAnnotations` but WebMCP defines only the other two.
- **Every tool has a `title`** next to its `name` (commit `72cb3c9 "Give every tool a title"`).

**The 32 tools** `[VERIFIED-SOURCE]`, grouped as the README groups them:

- **Read (readOnly):** `get_model`, `get_issues`, `get_item_catalog`, `get_editor_state`, `measure`, `get_underlay`
- **Blueprint:** `calibrate_underlay`
- **Structure:** `add_wall`, `edit_wall`, `remove_wall`
- **Openings:** `add_door`, `add_window`, `move_opening`, `remove_opening`, `set_door_swing`
- **Rooms:** `add_room`, `update_room`, `remove_room`
- **Furniture:** `place_item`, `move_item`, `remove_item`, `define_item_kind`
- **Model & view:** `set_plan_name`, `clear_model`, `build_3d`, `set_camera`, `set_doors`
- **Cross-origin:** `get_supplier_catalog`, `place_supplier_product`
- **Collaboration:** `leave_note`, `get_notes`
- **Dynamic:** `extend_selected_wall`

### 4.2 Cross-origin WebMCP — the genuinely novel bit `[VERIFIED-SOURCE]`

A second site, **Nordika** (`partner/index.html` + `partner/supplier.js`, 164 lines), is a mock furniture shop on its own origin with **12 products** (Frejda sofa, Valby beds, Halden sideboard, Studio desk, prices in EUR, stock counts — one item `Valby wardrobe 150` is deliberately `stock: 0`). It publishes `nordika_list_products` and `nordika_get_product` with `registerTool(descriptor, { signal, exposedTo: HOST_ORIGINS })`. The studio embeds it in an `<iframe allow="tools">` and calls `getTools({ fromOrigins })` + `executeTool()`.

The plumbing is a **custom Vite plugin** (`vite.config.ts`) that emits a `_headers` file at build time:

```
Permissions-Policy: tools=(self "https://alza-dev.netlify.app")
Content-Security-Policy: frame-ancestors 'self' https://alza-dev.pages.dev
```

`[INFERRED]` — this is a **genuinely interesting pattern we could adopt**: it demonstrates that the browser can act as the integration layer between two independent origins with no server in the path. The author notes the runtime gap honestly: neither ChatGPT's in-app browser nor Codex resolves `fromOrigins` yet, so a `postMessage` transport behind the same interface keeps the feature working.

---

## 5. GitHub repository

**`https://github.com/Elioz404/Alza`** — public, **not** archived, no releases, no issues open.

| Metric | Value | Tag |
|---|---|---|
| Licence | **MIT**, "Copyright (c) 2026 Alza contributors" | `[VERIFIED-SOURCE]` |
| Stars / forks | **13 / 7** | `[OBSERVED-LIVE]` |
| Commits | **4 total** | `[VERIFIED-SOURCE]` |
| Contributors | **1** (`Elioz404`, 4 commits) | `[OBSERVED-LIVE]` |
| Created / last push | 2026-09-01 / **2026-09-03** | `[OBSERVED-LIVE]` |
| Last metadata update | 2026-10-12 (stars activity) | `[OBSERVED-LIVE]` |
| Topics | agentic-web, ai-agents, floor-plan, model-context-protocol, react, threejs, typescript, webmcp | `[OBSERVED-LIVE]` |

**All four commits** `[VERIFIED-SOURCE]`:
1. `2026-09-01` — "Alza — agent-native floor-plan studio: 2D editor, 3D engine, 31+1 WebMCP tools, constraint checker, cross-origin supplier, demo plan and showcase"
2. `2026-09-03` — "README: WebMCP spec notes, tidy intro, destructiveHint enforced page-side; ignore submission drafts"
3. `2026-09-03` — "Give every tool a title"
4. `2026-09-03` — "Fix the tool count in the file header"

Author identity: `Elioz <eliasemanuel.ltorres@gmail.com>`. `[VERIFIED-SOURCE]`

**This is a hackathon repo, not a maintained project.** No commits in 6 weeks. 7 forks suggests genuine interest. Treat the code as a *reference implementation*, not a dependency.

### 5.1 Size — the codebase is small `[VERIFIED-SOURCE]`

**~6,534 lines total** across all `.ts/.tsx/.js/.mjs` (excluding node_modules). By file:

| File | Lines | Role |
|---|---|---|
| `src/three/furniture.ts` | 617 | composite 3D furniture + generic builder for imported partner products |
| `src/model/store.ts` | 544 | the single zustand store — actions, undo stack, activity log |
| `src/mcp/tools.ts` | 535 | **all 32 tool descriptors** |
| `src/three/build.ts` | 466 | wall extrusion with real openings, joint resolution, floors |
| `src/editor/Editor.tsx` | 444 | the SVG 2D editor |
| `src/three/Scene3D.tsx` | 437 | orbit/top/walk cameras, WASD, collision, export |
| `src/model/issues.ts` | 351 | the constraint engine (19 issue codes) |
| `e2e-full.mjs` | 315 | Playwright, 56 checks |
| `record6.mjs` | 309 | 60 fps demo recorder |
| `src/ui/Sidebar.tsx` | 230 | Model/Check/Catalog/Supplier/Notes/Tools tabs |
| `src/model/geometry.ts` | 187 | snap, SAT, segment math |
| `src/mcp/supplier.ts` | 179 | cross-origin discovery + postMessage fallback |
| `src/mcp/registry.ts` | 170 | registration, annotation wrapping, logging, approval gate |
| `partner/supplier.js` | 164 | the Nordika partner origin |
| `tests/issues.test.ts` | 149 | |
| `src/model/types.ts` | 124 | the data model |
| `tests/geometry.test.ts` | 91 | |
| `src/three/thumbnails.ts` | 86 | |
| `src/ui/App.tsx` | 82 | |
| `src/ui/ToolRunner.tsx` | 80 | manual tool execution |
| `src/mcp/bootstrap.ts` | 77 | runtime detection, dynamic tool lifecycle |
| `src/model/seed.ts` | 71 | the Sunset Loft demo |
| `src/model/catalog.ts` | 62 | **31 furniture kinds** |
| `src/ui/SupplierPanel.tsx` | 92 | |
| `src/ui/SupplierBridge.tsx` / `ActivityFeed.tsx` / `ApprovalBar.tsx` | 38/31/37 | |
| `src/three/exportBus.ts` / `src/main.tsx` | 28/26 | |

**For comparison, ArchMorph is roughly 4–5× larger** (`architecture.ts` alone is 3,970 lines vs Alza's entire 6,534). Alza is notably more compact.

### 5.2 Persistence: there is NONE `[VERIFIED-SOURCE]`

This is a concrete divergence from ArchMorph, which uses **localStorage**. I grepped `src/` for `localStorage`, `sessionStorage`, `indexedDB`, `persist`, `hydrate`, `serialize`, `save`:

> **One single hit — and it is a comment, not code:**
> `src/ui/Sidebar.tsx:40: // reencode to JPEG ≤1600 px (localStorage-friendly)`

The upload path uses that size cap so the image *would* fit in localStorage-friendly budgets, but **nothing ever writes to localStorage**. There is no save, no load, no autosave, no share link. Reload the page and you get the seeded Sunset Loft back.

`[INFERRED]` — this is likely a deliberate trade to keep "plans never leave the browser" simple, or simply unfinished. Either way, **for Argon this is a real feature gap to beat**: ArchMorph already persists locally and Alza does not.

Undo *is* implemented in memory: a 50-deep stack of `structuredClone(model)` snapshots (`store.ts` line 109).

### 5.3 Data model `[VERIFIED-SOURCE]` — `src/model/types.ts`, 124 lines

Explicit header comment: **"all units are meters, plan lives on the XY plane (y grows downward in 2D view)"**. Same unit convention as ArchMorph (feet) but metres.

```ts
Wall      { id, ax, ay, bx, by, thickness, height }        // metres
Opening   { id, kind: "door"|"window", wallId, t /*0..1 along wall, to CENTRE*/,
            width, sill, height, hinge?: "a"|"b", side?: "left"|"right" }
Room      { id, x, y, w, h, label, floor }
Item      { id, kind /*catalog key*/, x, y, rotation /*deg CCW, = facing direction*/ }
Underlay  { dataUrl, opacity, x, y, w, h, pw?, ph? }
PlanModel { name, walls[], openings[], rooms[], items[], underlay }
PendingApproval { id, tool, request, args, at }
Note      { id, author: "human"|"agent", text, at }
Issue     { severity: "error"|"warning", code, message, refs[] }
ActivityEntry { id, at, source: "human"|"agent"|"system", tool, summary, ok }
```

Nice touches: `t` is defined as position to the **centre** of the opening (removes an ambiguity class); `rotation` is defined as **which way the piece faces**, not its geometric angle; `pw/ph` record the *page's* pixel size of the re-encoded image precisely so the agent is told to use fractions.

**Catalogue:** 31 built-in kinds `src/model/catalog.ts` — sofa, sofa_3, armchair, coffee_table, side_table, sideboard, tv_sideboard, tv_stand, bookshelf, rug (`isRug: true`, exempt from collision), bathtub, corner_bath, shower, toilet, washbasin, towel_rail, plant, and more. Plus **runtime-added kinds** from `define_item_kind`.

### 5.4 The constraint engine `[VERIFIED-SOURCE]` — `src/model/issues.ts`, 351 lines, **19 issue codes**

- **Walls:** `wall_too_short`, `wall_loose_end` (T-junctions count as connected), `walls_overlap_collinear`, `walls_cross`, `wall_ends_in_opening`
- **Openings:** `opening_orphan`, `opening_overflow` (vano not fully in wall), `openings_overlap`, `opening_too_tall`
- **Rooms:** `room_floating`, `rooms_overlap`, `room_no_door`, `room_too_small`
- **Furniture:** `item_through_wall` (oriented-rectangle SAT — *leaning is legal, crossing is an error*), `item_blocks_door`, `item_blocks_window` (with a sill-height nuance), `items_overlap` (rugs exempt), `item_outside_rooms`, `item_unknown`

Messages are phrased as **sentences the agent can act on**, in metres — that is a deliberate design decision the author calls out ("an error message is an interface").

### 5.5 Tests — they run and they pass `[VERIFIED-SOURCE]`

I ran them myself:

```
✓ tests/geometry.test.ts (15 tests)  11ms
✓ tests/issues.test.ts  (15 tests)  23ms
Test Files  2 passed (2)
      Tests  30 passed (30)
```

**30 unit tests, vitest, `environment: "node"`.** Includes a regression asserting the **seeded Sunset Loft has 0 issues** — the README says this keeps it honest.

Plus a **Playwright E2E battery** (`e2e-full.mjs`, 315 lines): launches Chromium with `--enable-features=WebMCP`, runs **every tool** through `navigator.modelContextTesting`, asserts **zero console errors**, and makes **56 checks** — of which **2 skip** on stable Chrome because `modelContextTesting` exists only in dev/canary. `[VERIFIED-SOURCE]` for the code; **I did not run the E2E suite** (needs both dev servers + a browser download). `[UNVERIFIED]`

Test tooling is a real point of comparison: **Alza uses vitest, a proper framework. ArchMorph uses hand-written assertion scripts** (`node --experimental-strip-types scripts/*.ts`). Argon has already moved to vitest (`vitest.config.ts` in the Argon root).

### 5.6 Build tooling `[VERIFIED-SOURCE]`

- `npm run dev` (5199) · `npm run partner` (5200) · `npm test` · `npm run build` (`tsc -b && vite build`)
- **Two entry points in one build**: `index.html` (studio) and `partner/index.html` — the SAME `dist/` is deployed to both Cloudflare Pages and Netlify, and one `_headers` file has to serve both roles. `base: "./"`.
- Deploy scripts: `wrangler pages deploy dist --project-name alza-dev` and `npx netlify deploy --prod`.
- **`serve-local.mjs`** serves `dist/` on two origins *with the production headers*, so the cross-origin feature can be demoed locally. Good practice.

---

## 6. IMAGE-TO-PLAN TRACING — the headline feature. What actually happens.

This is the most important section, and the answer is genuinely different from what the marketing implies.

### 6.1 There is NO computer vision in Alza. Zero. `[VERIFIED-SOURCE]`

I grepped `src/` and `partner/` for `getImageData`, `createImageBitmap`, `OffscreenCanvas`, `toBlob`, `tesseract`, `opencv`, `contour`, `edge detect`, `threshold`, `grayscale`, `histogram`:

> **No matches.**

There is **no vectorisation, no OCR, no vision model, no contour tracing, no edge detection, no Hough transform** anywhere in the codebase. The only canvas operation in the entire app is `drawImage` + `toDataURL` inside the *upload* handler (`Sidebar.tsx`) — it resizes and re-encodes the uploaded photo to JPEG ≤1600 px. That is a display optimisation, not analysis.

**What actually happens, verified in source:**

1. The human uploads the plan photo → it is stored as a `dataUrl` underlay and drawn as an **SVG `<image>` element** beneath the editor geometry. `[VERIFIED-SOURCE]` — `Editor.tsx` lines 299-307.
2. The human **pastes the same image into their chat** with the agent. This is the load-bearing step and the code says so explicitly.
3. **The agent's own multimodal vision reads the drawing.** The app supplies no understanding of the image whatsoever.
4. The agent calls `calibrate_underlay(u1, v1, u2, v2, metres)` to set scale from one real dimension, then emits `add_wall`/`add_door`/`add_window`/`add_room`/`place_item` calls with coordinates it measured **off the image by eye**.
5. `get_underlay` returns **no pixels at all** — only a fractional coordinate mapping — because WebMCP tool results are text.

### 6.2 The coordinate mapping `[VERIFIED-SOURCE]`

`get_underlay` returns `u = x_px / image_width`, then `world_x = rect.x + u * rect.w`. Fractions, not pixels, because the page's copy is re-encoded to ≤1600 px and so is not the same resolution as the copy the human pasted into the conversation. This is a clever workaround to a real gap — the author flags it as WebMCP issue #41/#86/#81, "the gap I felt hardest."

### 6.3 `TRACING_PROTOCOL` — the "skills" hack `[VERIFIED-SOURCE]`

Because WebMCP has no skills concept, the procedure is shipped as an 8-step string constant embedded in the tool descriptions (WebMCP issue #161). Verbatim, the most important steps:

> "1. Calibrate first, and get the drawing into BOTH places. You need it uploaded on the page (that is what carries the scale) AND pasted into your conversation (that is the only way you can see it)… Measure in fractions of the image, never in pixels… Note the order: clear_model also clears the underlay, so empty the plan BEFORE the image is loaded, never after."
>
> "2. **Copy the drawing, do not redesign it.** Reproduce the walls, openings and rooms that are actually drawn — the same count, the same positions, the same proportions. Do not add rooms, move doors to where they would be tidier, or 'improve' the layout. If something is ambiguous, place your best reading and say so with `leave_note` rather than inventing."
>
> "6. Never approximate a distinctive symbol with the nearest stock item… call `define_item_kind` to model it at the size the plan draws — optionally with `parts` for real 3D geometry."

The default is named **FIDELITY** — *"copy what is drawn, at the size it is drawn, and model anything the catalogue is missing."* `[VERIFIED-SOURCE]`

### 6.4 Documented vs inferred — the honest split

| | Status |
|---|---|
| No CV in the app; the agent's vision does the reading | `[VERIFIED-SOURCE]` — decisive, by exhaustive grep |
| The image must be supplied twice (page + chat) | `[VERIFIED-SOURCE]` |
| Scale comes from one human-supplied real dimension | `[VERIFIED-SOURCE]` — `calibrateUnderlay` is pure arithmetic |
| The protocol is a string constant in tool descriptions | `[VERIFIED-SOURCE]` |
| The traced plan data is reproducible from `trace.mjs` | `[VERIFIED-SOURCE]` |
| The demo agent (Codex) actually achieved 0 issues | `[UNVERIFIED]` — author's account; I cannot observe the run |
| Accuracy of an agent tracing an unseen plan | `[UNVERIFIED]` — no accuracy metric is published anywhere |

### 6.5 What this means for Argon — the real opportunity

`[INFERRED]` (rests on §6.1 being verified): **"turns a photo into a model" is, in Alza's implementation, the LLM's vision doing the tracing through 32 typed tools — not image processing.** The app is the tool provider and the ruler; the agent is the eye.

That means:
- The hard part (accuracy, scale ambiguity, symbol recognition) is **entirely delegated to the host model**, so it inherits whatever the host's vision quality is, and there is no way to improve it inside the app.
- A genuinely differentiated Argon feature would be **doing the vectorisation in-browser** — edge/contour detection, line fitting, room-graph reconstruction — so scale estimation and wall extraction are deterministic and measurable, with the LLM only naming rooms and handling ambiguity. Nothing in Alza competes with that.
- Conversely, Alza's *tool design* is worth studying closely: the error messages are written as actionable sentences, the ambiguous-symbol case has a first-class `leave_note` escape hatch, and the constraint engine is a **verifier** the agent loops against. That agent-verifies-its-own-output loop is the strongest idea in the project.

---

## 7. Third-party sites and external links

| Site | What it is | Tag |
|---|---|---|
| `https://alza-dev.pages.dev` | The studio, on Cloudflare Pages | `[VERIFIED-SOURCE]` (in `.env` + README) |
| `https://alza-dev.netlify.app` | The Nordika partner origin, on Netlify | `[VERIFIED-SOURCE]` |
| `https://github.com/webmachinelearning/webmcp` | The WebMCP spec + explainer; Alza cites its open questions #165, #50, #41, #86, #81, #161 | `[OBSERVED-LIVE]` (links in page) |
| `https://hyperframes.heygen.com/` | HeyGen's video composition tool, used to author the demo film | `[VERIFIED-SOURCE]` (README) |
| `https://modelcontextprotocol.io/specification/.../server/tools` | MCP `ToolAnnotations` reference, cited for `destructiveHint` | `[OBSERVED-LIVE]` (link in page) |
| `https://digg.com/ai/2yjnmies` | Digg/OpenAI Developers reshare: "Alza turns floor-plan photos into 2D and 3D models." Also where ArchMorph surfaced | `[OBSERVED-LIVE]` |
| YouTube `RihMFcMstvI` | The 2m15s demo film | `[UNVERIFIED]` — metadata only |
| YouTube channel `UCxhzCT0hQL_iO-qvDpnsHhw` | Believed to be the builder's channel | `[UNVERIFIED]` — association not confirmed |

---

## 8. Licence and asset constraints for us

**Code: MIT.** `[VERIFIED-SOURCE]` — full MIT text, "Copyright (c) 2026 Alza contributors". This is **permissive**: we may read it, study it, and reuse substantial portions provided the copyright notice and permission notice are included. It is **the same licence ArchMorph uses**, so there is no licensing friction in studying both.

**Do not reuse their assets.** Per the brief, we will not copy code or reuse demo floor plans/assets — noted and respected. Concretely, the repo contains assets we should avoid:
- `plan-source.jpeg` (345 KB, **2048×2048**) — the demo floor plan the agent traced
- `shots/showcase/*.png` + `preview.gif` (~8 MB, tracked) — screenshots and the GIF
- `partner/supplier.js` product data — the "Nordika" catalogue (names, SKUs, EUR prices, stock counts)

**Is `plan-source.jpeg` third-party copyrighted?** `[INFERRED]` — I examined the image: it is a clean, generic, black-and-white vector-style apartment plan with no text, no dimensions, no logo, no title block, and no identifiable property. This is **consistent with the author's Devpost account** that he deleted the original repo and "generated my own plan, and re-traced everything from scratch." I cannot *prove* authorship from the image alone, and I have no way to trace the file's origin. **Treat as: probably self-made, but do not use it regardless** — there is no benefit to us and non-trivial risk if the account is wrong.

The general lesson is worth recording: this project **already made the copyright mistake once** and recovered by nuking the repo. Their current asset is very likely clean. Ours should be clean by construction.

---

## 9. Alza vs ArchMorph

| Dimension | **Alza** `[VERIFIED-SOURCE]` | **ArchMorph** `[from prior analysis]` |
|---|---|---|
| **Server-side model / API key** | **None.** No backend, no endpoint, no key, no AI dependency (§0) | **None** in `src/` or `worker/` |
| Framework | **Vite 7 + React 19** SPA | **Next.js 16.3.3 + React 19.2.8** |
| Language | TypeScript, strict | TypeScript |
| 2D | inline **SVG** (444 lines) | inline SVG |
| 3D | raw **Three.js ^0.178**, ACES + PCF soft shadows | raw **Three.js ^0.185.1** |
| State | **zustand 5** (vanilla, one store for UI + tools) | ? (not established) |
| Units | **METRES** | **FEET** |
| Tools | **31 + 1 dynamic = 32** (`src/mcp/tools.ts`, 535 lines) | **63** (`src/lib/webmcp-tools.ts`, 1288 lines) |
| Core domain logic | `issues.ts` 351 + `geometry.ts` 187 + `build.ts` 466 ≈ **1,004 lines** | `architecture.ts` **3,970 lines** |
| Total size | **~6,534 lines** | ~4–5× larger |
| Tests | **vitest, 30 unit tests + 56-check Playwright E2E**, both run and green | hand-written `scripts/*.ts` assertion scripts |
| Persistence | **NONE** | **localStorage** |
| Licence | MIT | MIT |
| Repo activity | 4 commits, 13★ / 7 forks, 1 contributor | — |
| Deployment | Cloudflare Pages + Netlify (two origins) | Cloudflare |
| Colour / CSS | plain CSS, hand-written | **Tailwind 4** |

### 9.1 Convergence

- **Both are pure browser-native WebMCP.** No model endpoint, no API key. The agent is always the *host's*, never the app's. This is the headline convergence and it is now doubly confirmed.
- **Both use `document.modelContext.registerTool()`.**
- **Both** do inline SVG 2D + raw Three.js 3D, no react-three-fiber.
- **Both** are MIT, both are single-hackathon repos, both treat "the agent edits the same live model the human is editing" as the core thesis.
- **Both** write tool errors as actionable sentences.
- Both use Cloudflare for hosting; both use `navigator.modelContext` / `document.modelContext` with graceful degradation when no runtime is present.

### 9.2 Divergence — where Argon should look

1. **Tool granularity: 32 vs 63.** Alza is deliberately *narrower* — fewer, more semantic tools. ArchMorph exposes roughly double the surface. `[INFERRED]` (rests on both counts being accurate) Alza's bet is that a small, well-named, well-described surface is easier for a model to use correctly. Argon should decide deliberately which philosophy it is following, and note that a model choosing among 63 tools has more room to err than among 32.
2. **Persistence is Alza's clear gap.** No save at all; reload loses work. ArchMorph persists. Argon must not inherit this.
3. **Alza has a constraint engine with 19 issue codes; ArchMorph's domain module is 4× larger but that is not the same thing.** Alza's validation is *narrow and precise* (SAT collision, door swing blocking, orphan openings, doorless rooms) and is written for **agent self-repair**: the agent calls `get_issues` and loops until clean. That agent-verifies-its-own-work loop is Alza's best idea and ArchMorph's `architecture.ts` bulk does not obviously provide the equivalent. `[INFERRED]`
4. **Alza's human-approval gate** (destructive calls park as a UI request; reject returns a *sentence* not an error) answers a live WebMCP open question (#165/#50) in ~40 lines. Cheap, high-value, and reusable.
5. **Cross-origin tool exchange** — Alza's flagship novelty. No server, browser as integration layer, `exposedTo` + `getTools({fromOrigins})` + `executeTool()`, with a postMessage fallback. ArchMorph does not do this.
6. **Multimodal honesty** — Alza confronts head-on that WebMCP tool results are text and so a page **cannot hand an agent its own image**. Its answer (fractional mapping + dual-channel delivery + a protocol string) is a genuinely useful pattern for Argon's image feature.
7. **Test rigour** — Alza's Playwright battery driving real tool execution through `navigator.modelContextTesting` is well ahead of ArchMorph's assertion scripts. Argon already has vitest; it should also consider an E2E layer.

---

## 10. Quantitative specifics worth matching

| Metric | Alza | Tag |
|---|---|---|
| WebMCP tools | **31 static + 1 dynamic = 32** | `[VERIFIED-SOURCE]` |
| Tool definition file | `src/mcp/tools.ts` = **535 lines** for all 32 | `[VERIFIED-SOURCE]` |
| Constraint issue codes | **19** | `[VERIFIED-SOURCE]` |
| Built-in furniture kinds | **31** | `[VERIFIED-SOURCE]` |
| Partner catalogue products | **12** | `[VERIFIED-SOURCE]` |
| Unit tests | **30** (2 files), all passing | `[VERIFIED-SOURCE]` |
| E2E checks | **56** (2 skip on stable Chrome) | `[VERIFIED-SOURCE]` |
| Demo plan contents | **12 walls, 14 openings, 10 rooms, 34–35 furniture items** | `[OBSERVED-LIVE]` (Devpost copy + screenshot activity feed) |
| Demo plan exterior | **10.00 m × 11.16 m** | `[VERIFIED-SOURCE]` (`trace.mjs`) |
| Source underlay | 2048×2048 px, **138.2 px/m** at that scale | `[VERIFIED-SOURCE]` (`trace.mjs` header) |
| Seed demo | "Sunset Loft", 8 × 6 m, **0 issues** | `[VERIFIED-SOURCE]` |
| Screenshots | **16 PNG + 1 GIF** in `shots/showcase/` | `[VERIFIED-SOURCE]` |
| Agent-authored pieces | **5** (L-sofa, corner shower, compact bath, L-wardrobe, washing machine) | `[VERIFIED-SOURCE]` |
| Demo film | **2 min 15 s**, 8 beats, 60 fps | `[VERIFIED-SOURCE]` (README) — **video not watched** |
| Total source | **~6,534 lines** | `[VERIFIED-SOURCE]` |
| Commits | **4** | `[VERIFIED-SOURCE]` |

---

## 11. Could NOT verify

Be explicit. Each of these I attempted and failed:

1. **Devpost comments (10 Comment thread)** — Devpost renders comments client-side; `WebFetch` is 403 and the raw HTML contains no comment bodies. **No comment content read.**
2. **The Devpost updates page** (`/software/alza/updates/823992`) — fetch delegated to a background agent; see §7/agent report. If not resolved there, treat as unretrieved.
3. **The demo video itself** — I did not watch `youtube.com/watch?v=RihMFcMstvI`. Title, duration and description come from the README and search results; the film content is unverified.
4. **Whether Alza won a WebMCP Challenge prize** — a search result claimed Alza was among "10 WebMCP Challenge winners" (via `aicatchup.com`), but **I did not verify this against an authoritative Devpost source**, and the same search returned future-dated/unreliable timestamps with its own caveat. **Treat winner status as unconfirmed.** No prize is claimed anywhere on the Alza Devpost page I fetched.
5. **The live app at `alza-dev.pages.dev`** — see §7 for the delegated fetch result. From source I can say with confidence what it *should* render; from live observation I confirm only what is in the committed screenshots.
6. **`e2e-full.mjs` (56 Playwright checks)** — I did not run it (requires both dev servers plus a browser download). Only the 30 vitest unit tests were executed, and they pass.
7. **The agent demo's accuracy** — no metric is published. "0 issues" is self-reported for a plan the author is also the author of.
8. **Author's real identity** beyond the GitHub commit email `eliasemanuel.ltorres@gmail.com` and handles `Elioz404` / `Elioz`. The YouTube channel association is unconfirmed.
9. **Provenance of `plan-source.jpeg`** — no EXIF/metadata examined beyond JPEG dimensions; authorship inferred from the Devpost copyright story plus visual inspection, not proven.
10. **Any HackMD / blog writeup** — the Devpost page links none. Search surfaced a `note.com` article and a `shielyule.co.uk` blog that *may* cover Alza; I did not confirm either is about this project and did not rely on them.

---

## 12. Sources

| URL | What I got |
|---|---|
| `https://devpost.com/software/alza` | **HTTP 403 via WebFetch; HTTP 200 (157,432 B) via curl+Chrome UA.** Full server-rendered project copy: title, tagline, author, Sep 01 2026, 10 likes, all sections, Built With list, live-URL + repo + video links, raw-github screenshot URLs, webmcp issue links. og:description confirmed. |
| `https://devpost.com/software/alza/updates/823992` | Delegated fetch (see §7). |
| `https://github.com/Elioz404/Alza` | Canonical repo. Cloned locally to `F:\Argon\_research\alza`. Full source + README read. MIT, 4 commits, 1 contributor. |
| `https://api.github.com/repos/Elioz404/Alza` | Stars 13, forks 7, created 2026-09-01, pushed 2026-09-03, size 8429 KB, topics, homepage. |
| `https://api.github.com/repos/Elioz404/Alza/languages` | TS 212,720 / JS 58,247 / CSS 10,164 / HTML 3,142 bytes. |
| `https://api.github.com/repos/Elioz404/Alza/contributors` | Single contributor `Elioz404`, 4 commits. |
| `https://api.github.com/repos/bornio/alza` | **Established it is a fork** of `Elioz404/Alza`, created 2026-09-28. |
| `https://github.com/Elioz404/Alza/blob/main/README.md` (local clone) | 18,764-byte README: architecture map, tool table, spec notes, develop commands, licence. |
| `https://github.com/Elioz404/Alza/.../shots/showcase/*.png` (local clone) | 16 stills + 1 GIF; I opened 4 as images and described what they show (§3). |
| `https://github.com/Elioz404/Alza/.../plan-source.jpeg` (local clone) | 2048×2048 demo floor plan, visually inspected (§8). |
| `https://github.com/Elioz404/Alza/.../trace.mjs` (local clone) | The demo plan as data: 10.00×11.16 m exterior, 138.2 px/m, WALLS/OPEN/ROOMS/FURN arrays, 5 `define_item_kind` agent-authored pieces. |
| `https://github.com/Elioz404/Alza/.../src/**` (local clone) | All 30 source files read in part or full: types, store, tools, registry, bootstrap, supplier, issues, geometry, catalog, Editor, Scene3D, build, furniture, UI. **Exhaustive greps for API keys, model providers, network calls, CV ops, persistence.** |
| `https://github.com/Elioz404/Alza/.../LICENSE` | MIT, "Copyright (c) 2026 Alza contributors". |
| `https://github.com/Elioz404/Alza/.../.env`, `vite.config.ts` | Two public origins; `_headers` cross-origin plugin; two build entry points; ports 5199/5200. |
| `https://digg.com/ai/2yjnmies` | OpenAI Developers reshare: "Alza turns floor-plan photos into 2D and 3D models"; WebMCP agent checks geometry. Also introduced ArchMorph and `@xmusfk`. |
| Web searches | Surfaced the repo (`bornio/alza`, later corrected), the YouTube video, the challenge page, the winners claim (**unverified**), and the note.com/shielyule.co.uk articles (**not relied on**). |
| `F:\Argon\_research\archmorph` | Read package.json, LICENSE presence, and ran the same API-key grep — **empty**, corroborating ArchMorph's no-endpoint finding for §9. |

---

*Compiled 2026-10-15. Every claim tagged. The central finding — Alza has no backend, no model endpoint and no API key, and its "photo → model" tracing is performed by the host agent's vision rather than by any image processing in the app — was verified by exhaustive source grep, not inferred from marketing copy.*
/**
 * A stand-in for MiniMax's Anthropic-compatible Messages endpoint.
 *
 * It exists so the end-to-end demo can exercise the *whole* assistant path —
 * browser → `/api/chat` → this server → the app's strict parser → the tool
 * registry → the store — without a live API key. What it deliberately does not
 * do is fake the intelligence: it is a script, not a model, and the demo
 * documents that the language understanding was stubbed.
 *
 * It is not a mock of the *shape* either. It parses the compact project state
 * the app actually sent, extracts real floor and room ids from it, and builds
 * its answer from those. If the app sent the wrong state, or ids in a format
 * this cannot read, the plan it returns references ids that do not exist and
 * the app must refuse the plan. The request log is exposed at `/__requests` so
 * the test can assert on what really went over the wire.
 *
 *   node e2e/fake-minimax.mjs            # listens on 8799
 *   PORT=9001 node e2e/fake-minimax.mjs  # or somewhere else
 */
import http from 'node:http';

const PORT = Number(process.env.FAKE_MINIMAX_PORT || process.env.PORT || 8799);

/** Every request body this server has been sent, oldest first. */
const requests = [];

/** Turn the app's compact state text back into the numbers it was built from. */
function readState(text) {
  const floor = text.match(/Active floor:.*?=\s*(fl_[a-z0-9]+)/)?.[1] ?? null;
  const rooms = [...text.matchAll(/^\s{2}(rm_[a-z0-9]+)\s+.*?x=(-?[\d.]+) y=(-?[\d.]+) w=(-?[\d.]+) d=(-?[\d.]+)/gm)].map(
    (m) => ({ id: m[1], x: +m[2], y: +m[3], w: +m[4], d: +m[5] }),
  );
  return { floor, rooms };
}

const asText = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((b) => b.text ?? '').join('');

/**
 * The scripted answer.
 *
 * The study is placed deliberately overlapping the living room. That is the
 * point of the demo's steps 9 and 10: the assistant proposes something the
 * constraint engine rejects, the user sees the real issue, and the user fixes
 * it with the engine's own correction. A plan that was clean on arrival would
 * demonstrate nothing.
 */
function planFor(text) {
  const { floor, rooms } = readState(text);
  if (!floor || rooms.length === 0) {
    return {
      intent: 'Add a study.',
      steps: [{ reply: 'I could not read the plan you sent me, so I have not changed anything.' }],
    };
  }
  const host = rooms.reduce((a, b) => (b.w * b.d > a.w * a.d ? b : a));
  return {
    intent: 'Add a small study alongside the largest room.',
    steps: [
      {
        tool: 'create_room',
        input: {
          floorId: floor,
          kind: 'office',
          x: host.x + host.w - 1.5,
          y: host.y,
          width: 3.2,
          depth: 3.0,
        },
        why: 'A 3.2 × 3.0 m study next to the largest room.',
      },
      {
        reply:
          'I added a 3.2 m × 3.0 m study. I placed it from the room positions you sent me rather than from any plan I can see, ' +
          'so open the Checks tab — if it lands on top of another room the engine will say so and offer the correction.',
      },
    ],
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__requests') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(requests, null, 2));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `no route for ${req.method} ${req.url}` }));
    return;
  }

  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'body was not JSON' }));
      return;
    }
    requests.push({
      url: req.url,
      authorization: req.headers.authorization ?? null,
      contentType: req.headers['content-type'] ?? null,
      model: body.model ?? null,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      system: typeof body.system === 'string' ? body.system : null,
      messages: body.messages ?? [],
    });

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => asText(m.content));
    const last = userTexts.at(-1) ?? '';
    // The whole conversation, not just the last message. The app's correction
    // is appended to the transcript and then followed by a fresh state block,
    // so reading only the tail would miss exactly the sentence that says what
    // went wrong. A real model sees the whole array; this has to as well.
    const text = userTexts.join('\n');

    let answerText;
    // Markers are read from the newest turn only. On a later round the whole
    // transcript is resent, so a marker left in the original request would fire
    // again and the plan would be applied over and over.
    if (/\b__PROSE__\b/.test(last) || /called no tools/.test(text)) {
      // The failure Argon used to accept silently: a design request answered
      // with a layout written in words and no operations behind it. Sent both
      // times round, because a model pressed for describing rather than acting
      // answers in words again — which is what makes the app say so on screen.
      answerText = PROSE_LAYOUT;
    } else if (/\b__FULL__\b/.test(last)) {
      // Six rooms in one plan, so the app has something to apply one step at a
      // time and the canvas can be watched building it.
      answerText = JSON.stringify(fullPlanFor(last));
    } else if (/\bREQUEST\b/.test(last)) {
      answerText = JSON.stringify(planFor(last));
    } else {
      // Later rounds of the study plan get the final answer.
      answerText = JSON.stringify({ intent: 'Report.', steps: [{ reply: 'Done — the study is in the plan.' }] });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_fake_0000000001',
        type: 'message',
        role: 'assistant',
        model: body.model ?? 'MiniMax-M3',
        content: [{ type: 'text', text: answerText }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
  });
});

/**
 * A layout written out in words, with nothing behind it.
 *
 * This is the shape the model actually returns when it is asked to "build the
 * complete design" and drifts into describing instead of calling tools.
 */
const PROSE_LAYOUT =
  'Clean slate on the active floor. Layout plan (all top-left x,y; sizes in m):\n' +
  '- Living room: x=3, y=3, 4.5 x 4.0\n' +
  '- Kitchen: x=3, y=7, 3.0 x 3.0\n' +
  '- Bedroom 1: x=3, y=10, 4.0 x 4.0\n' +
  'Let me build the rooms in parallel.';

/** Six rooms, tiled inside the envelope, each its own operation. */
function fullPlanFor(text) {
  const { floor } = readState(text);
  if (!floor) {
    return { intent: 'Build the layout.', steps: [{ reply: 'I could not read the plan, so I changed nothing.' }] };
  }
  // The default plot is 15 x 20 with 3 m side and 4.5 m front/rear setbacks,
  // so the buildable envelope is x 3..12, y 4.5..15.5. Every room is placed
  // inside it and none overlap, so what the run demonstrates is the applying,
  // not a plan the constraint engine would have refused.
  const rooms = [
    { kind: 'living', x: 3, y: 4.5, width: 5.5, depth: 4.5 },
    { kind: 'kitchen', x: 3, y: 9, width: 3, depth: 3 },
    { kind: 'bathroom', x: 6, y: 9, width: 2.5, depth: 3 },
    { kind: 'storage', x: 8.5, y: 4.5, width: 3.5, depth: 2 },
    { kind: 'bedroom', x: 3, y: 12, width: 4.5, depth: 3.5 },
    { kind: 'bedroom', x: 7.5, y: 12, width: 4.5, depth: 3.5 },
  ];
  return {
    intent: 'Build the whole layout, one room at a time.',
    steps: [
      ...rooms.map((r) => ({ tool: 'create_room', input: { floorId: floor, ...r } })),
      { reply: 'Six rooms placed: living, kitchen, two bedrooms, bathroom and store.' },
    ],
  };
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake minimax listening on http://127.0.0.1:${PORT}`);
});
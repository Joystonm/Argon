/**
 * HTTP surface for the Argon AI layer.
 *
 * The browser never sees the MiniMax key: it talks only to this app's own
 * `/api/chat` route, which forwards to MiniMax server-side and returns the
 * Anthropic-style message body unchanged.
 *
 * Everything here is deliberately small. The model is a reasoning layer, not
 * a privileged actor — it may only reach the canonical model through the typed
 * tool registry in `src/tools`, which runs in the browser and validates
 * everything before it mutates state.
 */
import express, { type Express, type Request, type Response } from 'express';
import {
  clientConfig,
  createMessage,
  isConfigured,
  MiniMaxError,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicTool,
} from './minimax.ts';

/** Hard caps so a malformed client cannot produce an unbounded upstream call. */
const LIMITS = {
  messages: 64,
  blocksPerMessage: 128,
  tools: 96,
  systemChars: 24_000,
  textCharsPerBlock: 400_000,
  maxTokensCeiling: 16_000,
  imageBytes: 4_500_000, // ~3.4 MB after base64 overhead, under the 4 MB API image cap
};

function fail(res: Response, status: number, message: string, detail?: unknown) {
  res.status(status).json({ error: message, ...(detail !== undefined ? { detail } : {}) });
}

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

function validateMessages(raw: unknown): AnthropicMessage[] | string {
  if (!Array.isArray(raw)) return 'messages must be an array';
  if (raw.length === 0) return 'messages must not be empty';
  if (raw.length > LIMITS.messages) return `messages exceeds ${LIMITS.messages} entries`;
  const out: AnthropicMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') return 'each message must be an object';
    const role = (m as any).role;
    if (role !== 'user' && role !== 'assistant') return 'message.role must be "user" or "assistant"';
    const content = (m as any).content;
    if (typeof content === 'string') {
      out.push({ role, content: str(content, LIMITS.textCharsPerBlock) });
      continue;
    }
    if (!Array.isArray(content)) return 'message.content must be a string or an array of blocks';
    if (content.length > LIMITS.blocksPerMessage) {
      return `message.content exceeds ${LIMITS.blocksPerMessage} blocks`;
    }
    const blocks: AnthropicContentBlock[] = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') return 'each content block must be an object';
      const type = (b as any).type;
      switch (type) {
        case 'text':
          blocks.push({ type: 'text', text: str((b as any).text, LIMITS.textCharsPerBlock) });
          break;
        case 'thinking':
          blocks.push({
            type: 'thinking',
            thinking: str((b as any).thinking, LIMITS.textCharsPerBlock),
            ...((b as any).signature ? { signature: String((b as any).signature) } : {}),
          });
          break;
        case 'tool_use':
          if (typeof (b as any).name !== 'string') return 'tool_use block requires a name';
          blocks.push({ type: 'tool_use', id: str((b as any).id, 200), name: (b as any).name, input: (b as any).input ?? {} });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: str((b as any).tool_use_id, 200),
            content: str((b as any).content, LIMITS.textCharsPerBlock),
          });
          break;
        case 'image': {
          const src = (b as any).source;
          if (!src || typeof src !== 'object') return 'image block requires a source object';
          if (src.type === 'url') {
            blocks.push({ type: 'image', source: { type: 'url', url: str(src.url, 4000) } });
          } else {
            const data = str(src.data, LIMITS.imageBytes);
            if (!data) return 'image.source.data is empty or too large';
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: str(src.media_type, 40) || 'image/png', data },
            });
          }
          break;
        }
        default:
          return `unsupported content block type: ${String(type)}`;
      }
    }
    out.push({ role, content: blocks });
  }
  return out;
}

function validateTools(raw: unknown): AnthropicTool[] | string {
  if (!Array.isArray(raw)) return [];
  if (raw.length > LIMITS.tools) return `tools exceeds ${LIMITS.tools} entries`;
  const out: AnthropicTool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') return 'each tool must be an object';
    const name = (t as any).name;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      return 'tool.name must be a 1-64 char [a-zA-Z0-9_-] string';
    }
    const schema = (t as any).input_schema;
    if (!schema || typeof schema !== 'object' || (schema as any).type !== 'object') {
      return `tool "${name}".input_schema must be a JSON Schema object`;
    }
    out.push({ name, description: str((t as any).description, 6000), input_schema: schema });
  }
  return out;
}

export function createApiApp(): Express {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => {
    const enabled = isConfigured();
    const cfg = clientConfig();
    let host = '';
    try {
      host = new URL(cfg.baseUrl).host;
    } catch {
      /* malformed base url — report blank rather than throwing */
    }
    res.json({
      ok: true,
      aiEnabled: enabled,
      disabledByConfig: process.env.ARGON_DISABLE_AI === 'true',
      provider: 'minimax',
      model: enabled ? cfg.model : null,
      endpoint: host ? `${host}/v1/messages` : null,
    });
  });

  app.post('/api/chat', async (req: Request, res: Response) => {
    if (!isConfigured()) {
      return fail(
        res,
        503,
        'MiniMax is not configured. Set MINIMAX_API_KEY in the server environment (see .env.example). The studio remains fully usable for manual editing.',
      );
    }

    const body = req.body ?? {};
    const messages = validateMessages(body.messages);
    if (typeof messages === 'string') return fail(res, 400, messages);

    const tools = validateTools(body.tools);
    if (typeof tools === 'string') return fail(res, 400, tools);

    const maxTokens = Math.min(
      Math.max(Number(body.max_tokens) || 4096, 256),
      LIMITS.maxTokensCeiling,
    );
    const temperature =
      typeof body.temperature === 'number'
        ? Math.min(Math.max(body.temperature, 0), 2)
        : undefined;

    const cfg = clientConfig();
    try {
      const message = await createMessage(cfg, {
        model: cfg.model,
        messages,
        max_tokens: maxTokens,
        ...(str(body.system, LIMITS.systemChars) ? { system: str(body.system, LIMITS.systemChars) } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(tools.length ? { tools, tool_choice: { type: 'auto' as const } } : {}),
        ...(body.thinking === true ? { thinking: { type: 'enabled' as const } } : {}),
        ...(body.effort ? { output_config: { effort: body.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } } : {}),
      });
      res.json(message);
    } catch (e) {
      if (e instanceof MiniMaxError) {
        return fail(res, e.status === 0 ? 504 : e.status, e.message);
      }
      return fail(res, 500, `Unexpected server error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return app;
}
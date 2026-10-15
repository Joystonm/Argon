/**
 * MiniMax M3 — Anthropic-compatible Messages API client (server-side only).
 *
 * Verified against https://platform.minimax.io/docs/api-reference/text-anthropic-api
 *
 *   POST {MINIMAX_BASE_URL}/v1/messages
 *   Authorization: Bearer <MINIMAX_API_KEY>
 *
 * The response is an Anthropic-style message:
 *   { id, type, role, model, content: ContentBlock[], stop_reason, usage }
 * where ContentBlock is one of
 *   { type: 'text',      text: string }
 *   { type: 'thinking',  thinking: string }
 *   { type: 'tool_use',  id, name, input }
 *
 * Multi-turn tool conversations require the COMPLETE assistant content array
 * (thinking + text + tool_use blocks) to be appended to the history verbatim.
 */

export interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: { type: string; media_type?: string; data?: string; url?: string };
  signature?: string;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  thinking?: { type: 'enabled' | 'disabled' };
  output_config?: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  metadata?: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class MiniMaxError extends Error {
  // Written out rather than as constructor parameter properties: this file is
  // run directly by `node --experimental-strip-types`, which erases types but
  // cannot erase a parameter property, so the shorthand would stop the server
  // from starting at all.
  readonly status: number;
  readonly detail?: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'MiniMaxError';
    this.status = status;
    this.detail = detail;
  }
}

export function isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ARGON_DISABLE_AI === 'true') return false;
  return Boolean(env.MINIMAX_API_KEY && env.MINIMAX_API_KEY.trim().length > 0);
}

export interface ClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export function clientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const base = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic').replace(/\/+$/, '');
  return {
    apiKey: (env.MINIMAX_API_KEY || '').trim(),
    baseUrl: base,
    model: (env.MINIMAX_MODEL || 'MiniMax-M3').trim(),
    timeoutMs: Number(env.MINIMAX_TIMEOUT_MS || 90_000),
    maxRetries: Number(env.MINIMAX_MAX_RETRIES || 2),
  };
}

/** Retryable transport / server-side failures. */
function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One Messages API round-trip with timeout + bounded retry on transient errors.
 * Network faults and 5xx/429 are retried; 4xx (bad key, bad schema) are not.
 */
export async function createMessage(
  cfg: ClientConfig,
  body: AnthropicRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AnthropicResponse> {
  const url = `${cfg.baseUrl}/v1/messages`;
  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new MiniMaxError(
          `MiniMax request failed (HTTP ${res.status}): ${text.slice(0, 600) || res.statusText}`,
          res.status,
          text,
        );
        if (!isRetryable(res.status) || attempt === cfg.maxRetries) throw err;
        lastError = err;
      } else {
        return (await res.json()) as AnthropicResponse;
      }
    } catch (e) {
      if (e instanceof MiniMaxError) {
        lastError = e;
        if (!isRetryable(e.status) || attempt === cfg.maxRetries) throw e;
      } else {
        const aborted = e instanceof Error && e.name === 'AbortError';
        lastError = new MiniMaxError(
          aborted
            ? `MiniMax request timed out after ${cfg.timeoutMs}ms`
            : `MiniMax request failed: ${e instanceof Error ? e.message : String(e)}`,
          aborted ? 408 : 0,
        );
        if (attempt === cfg.maxRetries) throw lastError;
      }
    } finally {
      clearTimeout(timer);
    }
    // Exponential backoff with jitter-free deterministic pacing.
    await sleep(400 * 2 ** attempt);
  }

  throw lastError instanceof Error
    ? lastError
    : new MiniMaxError('MiniMax request failed', 0);
}

/** Split an assistant message into the pieces the orchestrator cares about. */
export function splitContent(content: AnthropicContentBlock[]): {
  text: string;
  thinking: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
} {
  let text = '';
  let thinking = '';
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
    else if (b.type === 'thinking' && typeof b.thinking === 'string') thinking += b.thinking;
    else if (b.type === 'tool_use' && typeof b.name === 'string') {
      toolUses.push({ id: b.id || `tool_${Math.random().toString(36).slice(2, 10)}`, name: b.name, input: b.input ?? {} });
    }
  }
  return { text: text.trim(), thinking: thinking.trim(), toolUses };
}
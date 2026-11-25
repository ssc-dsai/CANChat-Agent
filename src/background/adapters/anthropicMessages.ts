import type { Settings } from '../../shared/types';
import { resolve } from '../llmNetwork';
import type { ContentPart, LlmMessage, LlmResponseMessage, LlmToolCall, ResponseFormatSpec, ToolDefinition } from '../llmTypes';
import { LlmError } from '../llmTypes';
import { isWorkingStateText, splitWorkingState } from '../workingState';
import { toAnthropicTools } from './toolSchema';
import type { AdapterRequest, ProtocolAdapter } from './types';

// =============================================================================
// Anthropic's /v1/messages API (Claude, and Qwen deployments that mirror it).
// Differences from /chat/completions this adapter bridges:
//  - No `system` role message: the system prompt is a top-level `system`
//    string field, so any `role: 'system'` messages are pulled out and joined.
//  - Auth is `x-api-key` + `anthropic-version` headers, not `Authorization:
//    Bearer` — Anthropic's Bearer scheme is reserved for OAuth, not API keys.
//  - `max_tokens` is *required* (no server-side default), so we fall back to
//    a reasonable default when the user hasn't set one.
//  - Tool calls are `tool_use` content blocks on an assistant message (not a
//    separate `tool_calls` field); tool results are `tool_result` content
//    blocks on a `user` message (not a `role: 'tool'` message) — Anthropic
//    also requires strictly alternating user/assistant turns, so consecutive
//    canonical `tool` messages (parallel tool calls) must merge into one
//    `user` turn with multiple `tool_result` blocks. Consecutive user turns
//    (the agent loop's working-state block after tool results) merge the same way.
//  - Prompt caching is explicit: nothing is cached without `cache_control`.
//    For agent-loop requests (ones that end in a working-state block, see
//    ../workingState.ts) on Anthropic or Bedrock Mantle, two breakpoints go in:
//    the system prompt (covers tools + system) and the last block before the
//    state (covers the conversation so far). The volatile state sits after
//    both, so each step reads the previous step's prefix from cache. Other
//    Messages-compatible servers get no markers, since some reject the field.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface CacheControl { type: 'ephemeral' }
interface Cacheable { cache_control?: CacheControl }
interface AnthropicTextBlock extends Cacheable { type: 'text'; text: string }
interface AnthropicImageBlock extends Cacheable { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
interface AnthropicToolUseBlock extends Cacheable { type: 'tool_use'; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock extends Cacheable { type: 'tool_result'; tool_use_id: string; content: string }
type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

/** `data:image/png;base64,AAAA` -> `{ mediaType: 'image/png', data: 'AAAA' }`. Falls back to jpeg if unparseable. */
function parseDataUrl(url: string): { mediaType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : { mediaType: 'image/jpeg', data: url };
}

function buildAnthropicUrl(base: string): string {
  const versionedBase = /\/v1$/.test(base) ? base : `${base}/v1`;
  return `${versionedBase}/messages`;
}

const EPHEMERAL: CacheControl = { type: 'ephemeral' };

/** Text as blocks, with a trailing working-state block split into a block of its own. */
function textBlocks(text: string): AnthropicTextBlock[] {
  const split = splitWorkingState(text);
  if (!split) return text ? [{ type: 'text', text }] : [];
  return [...(split.stable ? [{ type: 'text' as const, text: split.stable }] : []), { type: 'text', text: split.state }];
}

function asBlocks(content: string | AnthropicBlock[]): AnthropicBlock[] {
  return typeof content === 'string' ? textBlocks(content) : content;
}

function toBlocks(content: ContentPart[]): AnthropicBlock[] {
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    const { mediaType, data } = parseDataUrl(p.image_url.url);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });
}

function buildMessages(messages: LlmMessage[]): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      continue;
    }

    if (m.role === 'tool') {
      const block: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      };
      // Consecutive tool results (parallel tool calls) merge into one user turn.
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    const blocks: AnthropicBlock[] = Array.isArray(m.content) ? toBlocks(m.content) : [];
    if (typeof m.content === 'string') blocks.push(...textBlocks(m.content));
    for (const tc of m.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (role === 'user' && last?.role === 'user' && blocks.length > 0) {
      // Messages turns must alternate; text after tool results joins their turn.
      last.content = [...asBlocks(last.content), ...blocks];
      continue;
    }
    out.push({ role, content: blocks.length > 0 ? blocks : '' });
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out };
}

/** Endpoints known to accept `cache_control`: Anthropic itself and Bedrock Mantle. */
function supportsPromptCaching(settings: Settings, base: string): boolean {
  if (settings.bedrockMantle) return true;
  try {
    const host = new URL(base).hostname;
    return host === 'api.anthropic.com' || /^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Put a cache breakpoint on the last block before the trailing working-state
 * block. Returns false (and marks nothing) when the request has no such block.
 */
function markBeforeWorkingState(messages: AnthropicMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return false;
  const at = last.content.findIndex((b) => b.type === 'text' && isWorkingStateText(b.text));
  if (at < 0) return false;
  if (at > 0) {
    last.content[at - 1].cache_control = EPHEMERAL;
    return true;
  }
  const prev = messages[messages.length - 2];
  if (prev) {
    const blocks = asBlocks(prev.content);
    if (blocks.length > 0) {
      blocks[blocks.length - 1].cache_control = EPHEMERAL;
      prev.content = blocks;
    }
  }
  return true;
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  // `responseFormat` is intentionally unused: the Messages API has no native
  // schema-constrained-decoding field (unlike OpenAI's response_format,
  // Gemini's responseSchema, or Ollama/llama.cpp's grammar-backed `format`).
  // This protocol keeps relying on prompt-based JSON instructions plus the
  // existing looksTruncated/extractWindowAdaptive recovery in graphExtract.ts.
  buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[], _responseFormat?: ResponseFormatSpec): AdapterRequest {
    const { base, key } = resolve(settings, 'chat');
    const { system, messages: anthropicMessages } = buildMessages(messages);
    const cached = supportsPromptCaching(settings, base) && markBeforeWorkingState(anthropicMessages);
    const body: Record<string, unknown> = {
      model: settings.model,
      max_tokens: settings.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: anthropicMessages,
    };
    if (system) body.system = cached ? [{ type: 'text', text: system, cache_control: EPHEMERAL }] : system;
    if (tools && tools.length > 0) body.tools = toAnthropicTools(tools);
    // Some Claude deployments enable thinking modes that reject `temperature`.
    // It is optional in Messages requests, so provider defaults are the portable choice.

    return {
      url: buildAnthropicUrl(base),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
    };
  },

  parseResponse(json: unknown): LlmResponseMessage {
    const data = json as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
    const blocks = data.content;
    if (!blocks || blocks.length === 0) throw new LlmError('Model endpoint returned no content.');

    let text = '';
    const toolCalls: LlmToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          type: 'function',
          function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
    return {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  },
};

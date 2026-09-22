import type { Settings } from '../../shared/types';
import { signRequest } from '../awsSigv4';
import type { ContentPart, LlmMessage, LlmResponseMessage, LlmToolCall, ResponseFormatSpec, ToolDefinition } from '../llmTypes';
import { LlmError } from '../llmTypes';
import type { AdapterRequest, ProtocolAdapter } from './types';

// =============================================================================
// AWS Bedrock's Converse API — one unified request/response shape covering any
// Bedrock-hosted model (Claude, Nova, Llama, Mistral, Titan, ...). Differences
// from /chat/completions this adapter bridges:
//  - Auth is AWS Signature Version 4 (see ../awsSigv4.ts), not a bearer token:
//    `settings.apiKey` holds the AWS secret access key, `settings.awsAccessKeyId`
//    the access key id, `settings.awsRegion` the target region, and the optional
//    `settings.awsSessionToken` an STS session token. There is no OAuth or IAM
//    Identity Center/SSO support here — only static or STS-issued credentials.
//  - The system prompt is a top-level `system` array of text blocks, like
//    Anthropic's Messages API (Bedrock's Claude deployments mirror it).
//  - Tool calls are `toolUse` content blocks on an assistant message; tool
//    results are `toolResult` blocks on a `user` message, keyed by toolUseId.
//  - The model id is baked into the URL path (`/model/{id}/converse`) rather
//    than sent in the body, and the request must be signed after the body is
//    fully built — so, unlike every other adapter, `buildRequest` here is
//    async (see ProtocolAdapter's return type in ./types.ts).
// =============================================================================

const BEDROCK_SERVICE = 'bedrock';

interface ConverseTextBlock { text: string }
interface ConverseImageBlock { image: { format: string; source: { bytes: string } } }
interface ConverseToolUseBlock { toolUse: { toolUseId: string; name: string; input: unknown } }
interface ConverseToolResultBlock { toolResult: { toolUseId: string; content: Array<{ text: string }> } }
type ConverseBlock = ConverseTextBlock | ConverseImageBlock | ConverseToolUseBlock | ConverseToolResultBlock;

interface ConverseMessage {
  role: 'user' | 'assistant';
  content: ConverseBlock[];
}

/** `data:image/png;base64,AAAA` -> `{ format: 'png', data: 'AAAA' }`. Falls back to png if unparseable. */
function parseDataUrl(url: string): { format: string; data: string } {
  const match = /^data:image\/([^;]+);base64,(.*)$/s.exec(url);
  if (!match) return { format: 'png', data: url };
  return { format: match[1] === 'jpg' ? 'jpeg' : match[1], data: match[2] };
}

function toBlocks(content: ContentPart[]): ConverseBlock[] {
  return content.map((p) => {
    if (p.type === 'text') return { text: p.text };
    const { format, data } = parseDataUrl(p.image_url.url);
    return { image: { format, source: { bytes: data } } };
  });
}

function buildMessages(messages: LlmMessage[]): { system: ConverseTextBlock[] | undefined; messages: ConverseMessage[] } {
  const systemBlocks: ConverseTextBlock[] = [];
  const out: ConverseMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) systemBlocks.push({ text: m.content });
      continue;
    }

    if (m.role === 'tool') {
      const block: ConverseToolResultBlock = {
        toolResult: {
          toolUseId: m.tool_call_id ?? '',
          content: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }],
        },
      };
      // Consecutive tool results (parallel tool calls) merge into one user turn.
      const last = out[out.length - 1];
      if (last && last.role === 'user') last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }

    const blocks: ConverseBlock[] = Array.isArray(m.content) ? toBlocks(m.content) : [];
    if (typeof m.content === 'string' && m.content) blocks.push({ text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      blocks.push({ toolUse: { toolUseId: tc.id, name: tc.function.name, input } });
    }
    if (blocks.length > 0) out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks });
  }

  return { system: systemBlocks.length > 0 ? systemBlocks : undefined, messages: out };
}

interface ConverseToolSpec {
  toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}

function toConverseTools(tools: ToolDefinition[]): ConverseToolSpec[] {
  return tools.map((t) => ({
    toolSpec: { name: t.function.name, description: t.function.description, inputSchema: { json: t.function.parameters } },
  }));
}

function defaultEndpoint(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

export const bedrockConverseAdapter: ProtocolAdapter = {
  // `responseFormat` is intentionally unused: Converse has no native
  // schema-constrained-decoding field, same as the Anthropic Messages adapter.
  async buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[], _responseFormat?: ResponseFormatSpec): Promise<AdapterRequest> {
    const region = settings.awsRegion?.trim();
    const accessKeyId = settings.awsAccessKeyId?.trim();
    const secretAccessKey = settings.apiKey?.trim();
    if (!region || !accessKeyId || !secretAccessKey) {
      throw new LlmError('AWS Bedrock requires a region, access key ID, and secret access key. Set them in Settings → Models.');
    }

    const { system, messages: converseMessages } = buildMessages(messages);
    const body: Record<string, unknown> = { messages: converseMessages };
    if (system) body.system = system;
    if (tools && tools.length > 0) body.toolConfig = { tools: toConverseTools(tools) };
    const inferenceConfig: Record<string, unknown> = {};
    if (settings.temperature !== undefined) inferenceConfig.temperature = settings.temperature;
    if (settings.maxTokens !== undefined) inferenceConfig.maxTokens = settings.maxTokens;
    if (Object.keys(inferenceConfig).length > 0) body.inferenceConfig = inferenceConfig;

    const base = (settings.baseUrl?.trim() || defaultEndpoint(region)).replace(/\/+$/, '');
    const url = `${base}/model/${encodeURIComponent(settings.model)}/converse`;
    const bodyJson = JSON.stringify(body);
    const signedHeaders = await signRequest('POST', url, bodyJson, region, BEDROCK_SERVICE, {
      accessKeyId,
      secretAccessKey,
      sessionToken: settings.awsSessionToken?.trim() || undefined,
    });

    return {
      url,
      headers: { 'Content-Type': 'application/json', ...signedHeaders },
      body,
    };
  },

  parseResponse(json: unknown): LlmResponseMessage {
    const data = json as {
      output?: { message?: { content?: Array<{ text?: string; toolUse?: { toolUseId: string; name: string; input: unknown } }> } };
      stopReason?: string;
      message?: string;
    };
    const content = data.output?.message?.content;
    if (!content || content.length === 0) {
      throw new LlmError(`Bedrock returned no content${data.stopReason ? ` (stop reason: ${data.stopReason})` : ''}.`);
    }

    let text = '';
    const toolCalls: LlmToolCall[] = [];
    for (const block of content) {
      if (block.text) text += block.text;
      else if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId,
          type: 'function',
          function: { name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input ?? {}) },
        });
      }
    }
    if (data.stopReason === 'max_tokens' && toolCalls.length === 0) {
      throw new LlmError(
        'Model reached its output token limit (stop reason: max_tokens). Increase Max tokens or reduce the conversation context and retry.',
        { content: text || null },
      );
    }
    return {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  },
};

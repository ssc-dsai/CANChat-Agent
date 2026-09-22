import type { Settings } from '../../shared/types';
import type { LlmMessage, LlmResponseMessage, ResponseFormatSpec, ToolDefinition } from '../llmTypes';

/** What `buildRequest` hands back to the generic fetch/retry wrapper in llmProvider.ts. */
export interface AdapterRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * One implementation per wire protocol (OpenAI chat/completions, OpenAI
 * responses, Anthropic messages, Gemini native, Bedrock Converse). Each
 * adapter is a pure translator between the canonical
 * `LlmMessage[]`/`ToolDefinition[]` shape (used everywhere else in the
 * codebase) and that protocol's request/response JSON — `complete()` in
 * llmProvider.ts is the only caller, and it stays protocol-agnostic
 * (retry/backoff, timeout, error wrapping) by delegating all shape-specific
 * work here. `buildRequest` may return a Promise: every protocol builds its
 * request synchronously except Bedrock Converse, whose AWS Signature Version
 * 4 signing needs the async Web Crypto API (see adapters/bedrockConverse.ts).
 */
export interface ProtocolAdapter {
  buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[], responseFormat?: ResponseFormatSpec): AdapterRequest | Promise<AdapterRequest>;
  parseResponse(json: unknown): LlmResponseMessage;
}

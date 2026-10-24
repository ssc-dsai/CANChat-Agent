import type { ModelProtocol, Settings } from '../../shared/types';
import { anthropicMessagesAdapter } from './anthropicMessages';
import { withBedrockMantle } from './bedrockMantle';
import { geminiNativeAdapter } from './geminiNative';
import { openaiChatAdapter } from './openaiChat';
import { openaiResponsesAdapter } from './openaiResponses';
import type { ProtocolAdapter } from './types';

export type { AdapterRequest, ProtocolAdapter } from './types';

const ADAPTERS: Record<ModelProtocol, ProtocolAdapter> = {
  'chat-completions': openaiChatAdapter,
  responses: openaiResponsesAdapter,
  'anthropic-messages': anthropicMessagesAdapter,
  'gemini-native': geminiNativeAdapter,
};

/**
 * Absent/unrecognized protocol falls back to `'chat-completions'` — today's
 * only behavior. A Bedrock Mantle connection wraps the protocol's adapter
 * with Mantle's endpoint and auth (see ./bedrockMantle.ts).
 */
export function getAdapter(settings: Pick<Settings, 'protocol' | 'bedrockMantle'>): ProtocolAdapter {
  const adapter = ADAPTERS[settings.protocol ?? 'chat-completions'] ?? openaiChatAdapter;
  return settings.bedrockMantle ? withBedrockMantle(adapter, settings.protocol) : adapter;
}

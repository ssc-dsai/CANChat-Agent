import type { Settings } from './types';

// =============================================================================
// Saved-settings migration from the retired AWS Bedrock Converse protocol to
// the Bedrock Mantle host (see src/background/adapters/bedrockMantle.ts).
// Pure, and shared so the background (getSettings) and the workspace editors
// (which read storage directly) agree on what a legacy connection becomes.
// =============================================================================

type Connection = Pick<Settings, 'protocol' | 'bedrockMantle' | 'baseUrl' | 'model'>;

/**
 * A connection saved with `protocol: 'bedrock-converse'` (no longer a
 * ModelProtocol) becomes a Bedrock Mantle connection: Claude model ids keep
 * their native wire format via Anthropic Messages, everything else goes to
 * Chat Completions. Any endpoint override is dropped — it pointed at
 * bedrock-runtime, which is a different host. Region and AWS credentials
 * carry over unchanged (Mantle accepts the same SigV4 credentials). Model ids
 * are left alone; cross-Region inference profile ids (`us.…`, `global.…`) are
 * not served by Mantle and need editing by hand.
 */
export function migrateBedrockConverse<T extends Connection>(c: T): T {
  if ((c.protocol as string | undefined) !== 'bedrock-converse') return c;
  const claude = /(^|\.)anthropic\./.test(c.model);
  return { ...c, bedrockMantle: true, protocol: claude ? 'anthropic-messages' : 'chat-completions', baseUrl: '' };
}

/** Apply migrateBedrockConverse to the top-level connection and every model profile. */
export function migrateSettingsFromConverse(settings: Settings): Settings {
  const out = migrateBedrockConverse(settings);
  if (!settings.modelProfiles?.some((p) => (p.protocol as string | undefined) === 'bedrock-converse')) return out;
  return { ...out, modelProfiles: settings.modelProfiles.map(migrateBedrockConverse) };
}

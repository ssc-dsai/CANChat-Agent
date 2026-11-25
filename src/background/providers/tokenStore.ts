// =============================================================================
// Token storage for subscription-provider connections. Same trust level and
// storage area as the existing Microsoft Graph tokens (background/graphAuth.ts):
// chrome.storage.local, never chrome.storage.sync — a refresh token must never
// leave the device via Chrome's account sync. See docs/providers.md "Threat
// model" for what this does and does not protect against.
//
// When the optional encryption vault (vault.ts) is unlocked, the access and
// refresh tokens are sealed at rest (fields from shared/secretFields.ts). While
// it is locked, a sealed record reads as "not connected"; a token saved while
// locked is stored plaintext and sealed on the next unlock (sealSecretsAtRest).
// =============================================================================

import { PROVIDER_TOKENS_KEY_PREFIX } from '../../shared/secretFields';
import { sealTokenRecord, unsealTokenRecord } from '../secretSealing';
import type { ProviderId } from './types';

export interface StoredProviderTokens {
  schemaVersion?: 1;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  /** Epoch ms when the access token expires (already padded early), or undefined = non-expiring. */
  expiresAt?: number;
  /** Provider-specific extra fields (e.g. GitHub's device-flow interval). */
  extra?: Record<string, unknown>;
}

function key(id: ProviderId): string {
  return `${PROVIDER_TOKENS_KEY_PREFIX}${id}`;
}

export async function loadToken(id: ProviderId): Promise<StoredProviderTokens | null> {
  const k = key(id);
  const r = await chrome.storage.local.get(k);
  const stored = r[k] as Partial<StoredProviderTokens> | undefined;
  if (!stored) return null;
  // Sealed by the vault and the vault is locked: not usable now, but keep it.
  const value = await unsealTokenRecord('provider', stored);
  if (!value) return null;
  if (typeof value.accessToken !== 'string' || value.accessToken.length === 0 || value.accessToken.length > 64 * 1024) {
    await chrome.storage.local.remove(k);
    return null;
  }
  if (value.refreshToken !== undefined && typeof value.refreshToken !== 'string') {
    await chrome.storage.local.remove(k);
    return null;
  }
  // Records created before schemaVersion shipped have the same fields. Stamp
  // the version lazily so upgrades are idempotent and service-worker safe.
  // (The stored — possibly sealed — record is what gets re-written.)
  if (value.schemaVersion !== 1) {
    await chrome.storage.local.set({ [k]: { ...stored, schemaVersion: 1 } });
    return { ...value, schemaVersion: 1 } as StoredProviderTokens;
  }
  return value as StoredProviderTokens;
}

export async function saveToken(id: ProviderId, tokens: StoredProviderTokens): Promise<void> {
  await chrome.storage.local.set({ [key(id)]: await sealTokenRecord('provider', { ...tokens, schemaVersion: 1 as const }) });
}

export async function clearToken(id: ProviderId): Promise<void> {
  await chrome.storage.local.remove(key(id));
}

export function isExpired(tokens: StoredProviderTokens): boolean {
  return typeof tokens.expiresAt === 'number' && Date.now() >= tokens.expiresAt;
}

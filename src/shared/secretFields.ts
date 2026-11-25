// =============================================================================
// The one authoritative list of secret-bearing fields in chrome.storage.
//
// Two consumers must agree on it, so it lives here and nowhere else:
//   - stripSecretsForBackup (below): what a "secrets excluded" backup removes;
//   - background/secretSealing.ts: what the encryption vault seals at rest.
//
// When a new key/token/password field is added to Settings, ModelProfile, a
// capability, or a token record, add it here — the backup-strip test fails on
// any field named like /key|token|secret|password|credential/i that survives a
// stripped fixture, which is the tripwire for forgetting.
// =============================================================================

import { ENC_PREFIX } from './crypto';

/** Secret fields on the top-level Settings record (`ba_settings`). Sealed by the vault. */
export const SETTINGS_SECRET_FIELDS = [
  'apiKey',
  'ideogramApiKey',
  'embeddingApiKey',
  'transcriptionApiKey',
  'awsSessionToken',
  'decisionModelApiKey',
] as const;

/** Secret fields on each `Settings.modelProfiles[*]` entry. Sealed by the vault. */
export const MODEL_PROFILE_SECRET_FIELDS = ['apiKey', 'awsSessionToken'] as const;

/**
 * Identifiers that pair with a secret above (the AWS access key id is the
 * public half of a SigV4 key pair). Not encrypted — they are not secret and are
 * read in several places — but a secrets-excluded backup drops them too, since
 * they are useless without the secret half and still identify the account.
 */
export const SETTINGS_BACKUP_ONLY_FIELDS = ['awsAccessKeyId'] as const;
export const MODEL_PROFILE_BACKUP_ONLY_FIELDS = ['awsAccessKeyId'] as const;

/**
 * Secret fields on each capability (`ba_capabilities[*]`). Every value inside
 * `authConfig` is treated as secret as well (it holds the bearer token).
 */
export const CAPABILITY_SECRET_FIELDS = ['mcpToken'] as const;
/** Secret fields on each legacy hint (`ba_sites[*]`). */
export const SITE_SECRET_FIELDS = ['mcpToken'] as const;

/**
 * Credential records stored under their own chrome.storage.local keys, with the
 * fields of each that are secret. These are never part of a backup (they are
 * not in BACKUP_STORAGE_KEYS); the vault seals the listed fields at rest.
 */
export const TOKEN_RECORD_SECRET_FIELDS = {
  /** Microsoft Graph OAuth tokens (background/graphAuth.ts). */
  graph: ['accessToken', 'refreshToken'],
  /** Subscription-provider OAuth tokens (background/providers/tokenStore.ts). */
  provider: ['accessToken', 'refreshToken'],
  /** AWS IAM Identity Center client registration + OIDC tokens (background/awsSso.ts). */
  awsSso: ['clientSecret', 'accessToken', 'refreshToken'],
} as const satisfies Record<string, readonly string[]>;

export type TokenRecordKind = keyof typeof TOKEN_RECORD_SECRET_FIELDS;

export const GRAPH_TOKENS_STORAGE_KEY = 'graphTokens';
export const PROVIDER_TOKENS_KEY_PREFIX = 'ba_provider_tokens_';
export const AWS_SSO_SESSION_KEY_PREFIX = 'ba_aws_sso_';

/** Which token-record kind (if any) a chrome.storage.local key holds. */
export function tokenRecordKindForKey(key: string): TokenRecordKind | null {
  if (key === GRAPH_TOKENS_STORAGE_KEY) return 'graph';
  if (key.startsWith(PROVIDER_TOKENS_KEY_PREFIX)) return 'provider';
  // Role credentials (ba_aws_sso_creds_*) live in chrome.storage.session only,
  // but exclude them by name anyway so this never misreads one as a session.
  if (key.startsWith(AWS_SSO_SESSION_KEY_PREFIX) && !key.startsWith('ba_aws_sso_creds_')) return 'awsSso';
  return null;
}

/**
 * Storage keys that hold only credentials or key material. A backup never
 * carries them; stripSecretsForBackup removes them if they ever appear.
 */
const SECRET_ONLY_STORAGE_KEYS = new Set(['ba_vault', 'ba_vault_dek', 'ba_vault_last_active', 'ba_auth_tokens', GRAPH_TOKENS_STORAGE_KEY]);
const SECRET_ONLY_STORAGE_PREFIXES = [PROVIDER_TOKENS_KEY_PREFIX, AWS_SSO_SESSION_KEY_PREFIX];

export function isSecretOnlyStorageKey(key: string): boolean {
  return SECRET_ONLY_STORAGE_KEYS.has(key) || SECRET_ONLY_STORAGE_PREFIXES.some((p) => key.startsWith(p));
}

/** Field names that look like credentials — used by tests as a tripwire. */
export const SECRET_FIELD_NAME_RE = /key|token|secret|password|credential/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function blankFields(record: Record<string, unknown>, fields: readonly string[]): void {
  for (const f of fields) {
    if (f in record) record[f] = '';
  }
}

/** Replace every vault envelope string (anywhere in the value) with ''. Ciphertext is useless off-device. */
export function dropVaultCiphertext<T>(value: T): T {
  if (typeof value === 'string') return (value.startsWith(ENC_PREFIX) ? '' : value) as T;
  if (Array.isArray(value)) return value.map((v) => dropVaultCiphertext(v)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = dropVaultCiphertext(v);
    return out as T;
  }
  return value;
}

/**
 * Remove every known secret from a chrome.storage snapshot destined for a
 * backup file (the "exclude secrets" export). Returns a new object; the input
 * is not modified. Covers:
 *   - ba_settings: SETTINGS_SECRET_FIELDS + SETTINGS_BACKUP_ONLY_FIELDS
 *   - ba_settings.modelProfiles[*]: MODEL_PROFILE_SECRET_FIELDS + backup-only ids
 *   - ba_capabilities[*]: mcpToken and every authConfig value
 *   - ba_sites[*]: mcpToken
 *   - credential-only storage keys (vault, Graph/provider/AWS SSO tokens)
 *   - any vault-sealed (`enc:v1:`) value anywhere else in the snapshot
 */
export function stripSecretsForBackup(snapshot: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (isSecretOnlyStorageKey(key)) continue;
    out[key] = structuredClone(value);
  }

  if (isPlainObject(out.ba_settings)) {
    const s = out.ba_settings;
    blankFields(s, SETTINGS_SECRET_FIELDS);
    blankFields(s, SETTINGS_BACKUP_ONLY_FIELDS);
    if (Array.isArray(s.modelProfiles)) {
      for (const p of s.modelProfiles) {
        if (!isPlainObject(p)) continue;
        blankFields(p, MODEL_PROFILE_SECRET_FIELDS);
        blankFields(p, MODEL_PROFILE_BACKUP_ONLY_FIELDS);
      }
    }
  }
  if (Array.isArray(out.ba_capabilities)) {
    for (const c of out.ba_capabilities) {
      if (!isPlainObject(c)) continue;
      blankFields(c, CAPABILITY_SECRET_FIELDS);
      if (isPlainObject(c.authConfig)) blankFields(c.authConfig, Object.keys(c.authConfig));
    }
  }
  if (Array.isArray(out.ba_sites)) {
    for (const site of out.ba_sites) {
      if (isPlainObject(site)) blankFields(site, SITE_SECRET_FIELDS);
    }
  }
  return dropVaultCiphertext(out);
}

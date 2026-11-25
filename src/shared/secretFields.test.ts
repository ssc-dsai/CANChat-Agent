import { describe, expect, it } from 'vitest';
import type { CapabilityRegistryEntry } from './capabilities';
import { ENC_PREFIX } from './crypto';
import {
  CAPABILITY_SECRET_FIELDS,
  dropVaultCiphertext,
  isSecretOnlyStorageKey,
  MODEL_PROFILE_BACKUP_ONLY_FIELDS,
  MODEL_PROFILE_SECRET_FIELDS,
  SECRET_FIELD_NAME_RE,
  SETTINGS_BACKUP_ONLY_FIELDS,
  SETTINGS_SECRET_FIELDS,
  SITE_SECRET_FIELDS,
  stripSecretsForBackup,
  tokenRecordKindForKey,
} from './secretFields';
import type { ModelProfile, Settings, SiteEntry } from './types';

// --- Compile-time tripwire ----------------------------------------------------
// Every Settings / ModelProfile / capability / hint field whose NAME looks like
// a credential must be in the shared lists (or be a known non-secret such as
// maxTokens). Adding e.g. `fooApiKey` to Settings without listing it fails
// `npm run typecheck` right here.
type CredentialWord = 'Key' | 'key' | 'Token' | 'token' | 'Secret' | 'secret' | 'Password' | 'password' | 'Credential' | 'credential';
type CredentialLike<K> = K extends `${string}${CredentialWord}${string}` ? K : never;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const NON_SECRET = 'maxTokens';

const settingsCovered: Equal<
  CredentialLike<keyof Settings>,
  (typeof SETTINGS_SECRET_FIELDS)[number] | (typeof SETTINGS_BACKUP_ONLY_FIELDS)[number] | typeof NON_SECRET
> = true;
const profileCovered: Equal<
  CredentialLike<keyof ModelProfile>,
  (typeof MODEL_PROFILE_SECRET_FIELDS)[number] | (typeof MODEL_PROFILE_BACKUP_ONLY_FIELDS)[number] | typeof NON_SECRET
> = true;
const capabilityCovered: Equal<CredentialLike<keyof CapabilityRegistryEntry>, (typeof CAPABILITY_SECRET_FIELDS)[number]> = true;
const siteCovered: Equal<CredentialLike<keyof SiteEntry>, (typeof SITE_SECRET_FIELDS)[number]> = true;

// --- Fixture: one of every secret-bearing field -------------------------------
const sealed = `${ENC_PREFIX}AAAAciphertext`;

function fixture(): Record<string, unknown> {
  const settings: Settings = {
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-x',
    apiKey: 'sk-main',
    ideogramApiKey: 'ik-image',
    embeddingApiKey: 'sk-embed',
    transcriptionApiKey: 'sk-trans',
    awsAccessKeyId: 'AKIAEXAMPLE',
    awsSessionToken: 'aws-session',
    decisionModelApiKey: 'kev-key',
    maxTokens: 4096,
    systemPrompt: 'be terse',
    graphClientId: 'public-client-id',
    modelProfiles: [
      {
        id: 'p1',
        name: 'local',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama',
        apiKey: 'sk-profile',
        awsAccessKeyId: 'AKIAPROFILE',
        awsSessionToken: 'profile-session',
        maxTokens: 512,
      },
      // A sealed profile key, as stored with a vault.
      { id: 'p2', name: 'sealed', baseUrl: 'https://x.example', model: 'm', apiKey: sealed },
    ],
  };
  const capabilities: CapabilityRegistryEntry[] = [
    {
      id: 'c1',
      kind: 'mcp',
      name: 'Docs MCP',
      description: 'docs',
      source: 'manual',
      mcpUrl: 'https://mcp.example.com',
      mcpToken: 'mcp-token',
      authMethod: 'token',
      authConfig: { token: 'mcp-token', headerValue: 'Bearer xyz' },
    },
  ];
  const sites: SiteEntry[] = [
    { id: 's1', name: 'Legacy MCP', url: '', description: 'd', mcpUrl: 'https://legacy.example', mcpToken: 'legacy-token' },
  ];
  return {
    ba_settings: settings,
    ba_capabilities: capabilities,
    ba_sites: sites,
    ba_memory: [{ text: 'remember this', note: sealed }],
    // Credential-only keys that must never ride along in a backup.
    ba_vault: { saltB64: 'salt', wrapped: { ivB64: 'iv', ctB64: 'ct' } },
    ba_vault_dek: 'raw-dek',
    graphTokens: { accessToken: 'graph-at', refreshToken: 'graph-rt', expiresAt: 1 },
    'ba_provider_tokens_xai-grok': { accessToken: 'xai-at', refreshToken: 'xai-rt' },
    'ba_aws_sso_https://d-123.awsapps.com/start': { clientId: 'cid', clientSecret: 'csecret', accessToken: 'sso-at' },
  };
}

/** Paths of credential-named fields that still hold a non-empty string, plus any surviving ciphertext. */
function survivingSecrets(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return value.startsWith(ENC_PREFIX) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => survivingSecrets(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const p = path ? `${path}.${k}` : k;
    if (SECRET_FIELD_NAME_RE.test(k) && typeof v === 'string' && v !== '') return [p];
    return survivingSecrets(v, p);
  });
}

describe('stripSecretsForBackup', () => {
  it('the fixture really does carry every listed secret field', () => {
    expect([settingsCovered, profileCovered, capabilityCovered, siteCovered]).toEqual([true, true, true, true]);
    const f = fixture();
    const s = f.ba_settings as Record<string, unknown>;
    for (const k of [...SETTINGS_SECRET_FIELDS, ...SETTINGS_BACKUP_ONLY_FIELDS]) expect(s[k], k).toBeTruthy();
    const p = (s.modelProfiles as Record<string, unknown>[])[0];
    for (const k of [...MODEL_PROFILE_SECRET_FIELDS, ...MODEL_PROFILE_BACKUP_ONLY_FIELDS]) expect(p[k], k).toBeTruthy();
    expect(survivingSecrets(f).length).toBeGreaterThan(15);
  });

  it('leaves no credential-named field or vault ciphertext behind', () => {
    expect(survivingSecrets(stripSecretsForBackup(fixture()))).toEqual([]);
  });

  it('drops credential-only storage keys entirely', () => {
    const out = stripSecretsForBackup(fixture());
    for (const k of ['ba_vault', 'ba_vault_dek', 'graphTokens', 'ba_provider_tokens_xai-grok', 'ba_aws_sso_https://d-123.awsapps.com/start']) {
      expect(out, k).not.toHaveProperty([k]);
    }
  });

  it('keeps every non-secret field', () => {
    const out = stripSecretsForBackup(fixture());
    const s = out.ba_settings as Settings;
    expect(s).toMatchObject({ baseUrl: 'https://api.example.com/v1', model: 'gpt-x', maxTokens: 4096, systemPrompt: 'be terse', graphClientId: 'public-client-id' });
    expect(s.modelProfiles?.[0]).toMatchObject({ id: 'p1', baseUrl: 'http://localhost:11434/v1', model: 'llama', maxTokens: 512 });
    const c = (out.ba_capabilities as CapabilityRegistryEntry[])[0];
    expect(c).toMatchObject({ name: 'Docs MCP', mcpUrl: 'https://mcp.example.com', authMethod: 'token' });
    expect((out.ba_sites as SiteEntry[])[0].mcpUrl).toBe('https://legacy.example');
    expect((out.ba_memory as Array<{ text: string }>)[0].text).toBe('remember this');
  });

  it('does not modify its input', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    stripSecretsForBackup(f);
    expect(JSON.stringify(f)).toBe(before);
  });

  it('the tripwire catches a secret field nobody listed', () => {
    const out = stripSecretsForBackup({ ba_settings: { baseUrl: '', apiKey: 'x', model: 'm', someNewServiceToken: 'leak' } });
    expect(survivingSecrets(out)).toEqual(['ba_settings.someNewServiceToken']);
  });

  it('tolerates malformed entries', () => {
    expect(() => stripSecretsForBackup({ ba_settings: null, ba_capabilities: [null, 3], ba_sites: 'x' })).not.toThrow();
  });
});

describe('dropVaultCiphertext', () => {
  it('blanks envelope strings at any depth and keeps everything else', () => {
    expect(dropVaultCiphertext({ a: sealed, b: ['ok', sealed], c: { d: 1, e: 'plain' } })).toEqual({ a: '', b: ['ok', ''], c: { d: 1, e: 'plain' } });
  });
});

describe('storage key classification', () => {
  it('recognises token-record keys', () => {
    expect(tokenRecordKindForKey('graphTokens')).toBe('graph');
    expect(tokenRecordKindForKey('ba_provider_tokens_gitlab-duo')).toBe('provider');
    expect(tokenRecordKindForKey('ba_aws_sso_https://d-1.awsapps.com/start')).toBe('awsSso');
    expect(tokenRecordKindForKey('ba_aws_sso_creds_1_r_https://x')).toBeNull();
    expect(tokenRecordKindForKey('ba_settings')).toBeNull();
  });
  it('flags credential-only keys and nothing a backup legitimately carries', () => {
    expect(isSecretOnlyStorageKey('ba_vault')).toBe(true);
    expect(isSecretOnlyStorageKey('ba_auth_tokens')).toBe(true);
    for (const k of ['ba_settings', 'ba_capabilities', 'ba_sites', 'ba_skills', 'ba_memory', 'ba_conv_index']) {
      expect(isSecretOnlyStorageKey(k), k).toBe(false);
    }
  });
});

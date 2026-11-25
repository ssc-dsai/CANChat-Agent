import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityRegistryEntry } from '../shared/capabilities';
import { ENC_PREFIX } from '../shared/crypto';
import {
  CAPABILITY_SECRET_FIELDS,
  MODEL_PROFILE_SECRET_FIELDS,
  SETTINGS_SECRET_FIELDS,
  SITE_SECRET_FIELDS,
  TOKEN_RECORD_SECRET_FIELDS,
  tokenRecordKindForKey,
} from '../shared/secretFields';
import type { Settings, SiteEntry } from '../shared/types';
import { getAwsSsoStatus } from './awsSso';
import { isMailboxConnected } from './graphAuth';
import { findConnectionByHost } from './providers/apiKeyBridge';
import { loadToken, saveToken } from './providers/tokenStore';
import {
  getCapabilities,
  getCapabilitiesForEdit,
  getSettings,
  getSettingsForEdit,
  plaintextSecretRecordsForErase,
  saveCapabilities,
  saveSettings,
  sealSecretsAtRest,
  unsealBackupSnapshot,
} from './storage';
import { eraseVault, lockVault, setupVault, unlockVault } from './vault';

function area(store: Record<string, unknown>) {
  return {
    async get(keys: string | string[] | null) {
      if (keys === null) return { ...store };
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(obj: Record<string, unknown>) {
      Object.assign(store, structuredClone(obj));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
    async getKeys() {
      return Object.keys(store);
    },
  };
}

let local: Record<string, unknown>;
let session: Record<string, unknown>;
beforeEach(() => {
  local = {};
  session = {};
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(session) } });
});

const SSO_START = 'https://d-1234567890.awsapps.com/start';
const PASS = 'correct horse battery staple';

const settings: Settings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-x',
  apiKey: 'sk-main',
  ideogramApiKey: 'ik-image',
  embeddingApiKey: 'sk-embed',
  transcriptionApiKey: 'sk-trans',
  awsSessionToken: 'aws-session',
  decisionModelApiKey: 'kev-key',
  modelProfiles: [
    {
      id: 'p1',
      name: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok',
      apiKey: 'xai-profile-key',
      awsSessionToken: 'profile-session',
    },
    {
      id: 'p2',
      name: 'sso',
      baseUrl: '',
      model: 'claude',
      apiKey: '',
      bedrockMantle: true,
      awsSso: true,
      awsRegion: 'us-east-1',
      awsSsoStartUrl: SSO_START,
      awsAccountId: '123456789012',
      awsSsoRoleName: 'Bedrock',
    },
  ],
};

const capabilities: CapabilityRegistryEntry[] = [
  {
    id: 'c1',
    kind: 'mcp',
    name: 'Docs',
    description: 'd',
    source: 'manual',
    mcpUrl: 'https://mcp.example.com',
    mcpToken: 'mcp-token',
    authMethod: 'token',
    authConfig: { token: 'mcp-token' },
  },
];
const sites: SiteEntry[] = [{ id: 's1', name: 'Legacy', url: '', description: 'd', mcpUrl: 'https://legacy.example', mcpToken: 'legacy-token' }];

/** Plaintext records as they exist before a vault is created. */
function seedPlaintext() {
  local.ba_settings = structuredClone(settings);
  local.ba_capabilities = structuredClone(capabilities);
  local.ba_sites = structuredClone(sites);
  local.graphTokens = { accessToken: 'graph-at', refreshToken: 'graph-rt', expiresAt: Date.now() + 3600_000 };
  local['ba_provider_tokens_xai-grok'] = { schemaVersion: 1, accessToken: 'xai-at', refreshToken: 'xai-rt' };
  local[`ba_aws_sso_${SSO_START}`] = {
    schemaVersion: 1,
    clientId: 'cid',
    clientSecret: 'client-secret',
    registrationExpiresAt: Date.now() + 86_400_000,
    accessToken: 'sso-at',
    refreshToken: 'sso-rt',
    expiresAt: Date.now() + 3600_000,
  };
}

const isSealed = (v: unknown) => typeof v === 'string' && v.startsWith(ENC_PREFIX);

/** Every secret field (per the shared lists) that is set but NOT ciphertext at rest. */
function unsealedAtRest(): string[] {
  const bad: string[] = [];
  const check = (rec: Record<string, unknown>, fields: readonly string[], where: string) => {
    for (const f of fields) if (rec[f] && !isSealed(rec[f])) bad.push(`${where}.${f}`);
  };
  const s = local.ba_settings as Record<string, unknown>;
  check(s, SETTINGS_SECRET_FIELDS, 'settings');
  (s.modelProfiles as Record<string, unknown>[]).forEach((p, i) => check(p, MODEL_PROFILE_SECRET_FIELDS, `profiles[${i}]`));
  for (const c of local.ba_capabilities as Record<string, unknown>[]) {
    check(c, CAPABILITY_SECRET_FIELDS, 'capability');
    const auth = c.authConfig as Record<string, unknown>;
    check(auth, Object.keys(auth), 'capability.authConfig');
  }
  for (const site of local.ba_sites as Record<string, unknown>[]) check(site, SITE_SECRET_FIELDS, 'site');
  for (const [key, value] of Object.entries(local)) {
    const kind = tokenRecordKindForKey(key);
    if (kind) check(value as Record<string, unknown>, TOKEN_RECORD_SECRET_FIELDS[kind], key);
  }
  return bad;
}

describe('vault sealing coverage', () => {
  it('sealSecretsAtRest seals every listed secret field, and every reader still gets plaintext', async () => {
    seedPlaintext();
    expect(unsealedAtRest().length).toBeGreaterThan(10); // sanity: the fixture starts plaintext
    await setupVault(PASS);
    await sealSecretsAtRest();
    expect(unsealedAtRest()).toEqual([]);
    expect(JSON.stringify(local)).not.toMatch(/sk-main|xai-profile-key|mcp-token|legacy-token|graph-at|xai-at|client-secret|sso-rt/);

    // Non-secret fields stay readable at rest.
    expect((local.ba_settings as Settings).baseUrl).toBe(settings.baseUrl);
    expect((local.ba_settings as Settings).modelProfiles?.[1].awsSsoStartUrl).toBe(SSO_START);

    // Readers: settings (agent), editor, capabilities, provider/Graph/SSO tokens, apiKeyBridge.
    expect(await getSettings()).toEqual(settings);
    expect((await getSettingsForEdit()).settings).toEqual(settings);
    expect(await getCapabilities()).toEqual(capabilities);
    expect((await getCapabilitiesForEdit()).capabilities).toEqual(capabilities);
    expect((await loadToken('xai-grok'))?.accessToken).toBe('xai-at');
    expect(await isMailboxConnected()).toBe(true);
    const sso = { startUrl: SSO_START, ssoRegion: 'us-east-1', accountId: '123456789012', roleName: 'Bedrock' };
    expect((await getAwsSsoStatus(sso)).state).toBe('signed-in');
    expect((await findConnectionByHost('api.x.ai'))?.apiKey).toBe('xai-profile-key');
  });

  it('writes made through the storage layer are sealed directly', async () => {
    await setupVault(PASS);
    await saveSettings(settings);
    await saveCapabilities(capabilities);
    local.ba_sites = structuredClone(sites);
    local.graphTokens = { accessToken: 'graph-at', expiresAt: 1 }; // sealed via sealSecretsAtRest below
    await saveToken('xai-grok', { accessToken: 'xai-at', refreshToken: 'xai-rt' });
    local[`ba_aws_sso_${SSO_START}`] = { schemaVersion: 1, clientId: 'c', clientSecret: 's', registrationExpiresAt: 1 };
    await sealSecretsAtRest();
    expect(unsealedAtRest()).toEqual([]);
  });

  it('locked vault: readers fail closed (no ciphertext, no plaintext)', async () => {
    seedPlaintext();
    await setupVault(PASS);
    await sealSecretsAtRest();
    await lockVault();

    expect(await getSettings()).toBeNull();
    const edit = await getSettingsForEdit();
    expect(edit.locked).toBe(true);
    expect(edit.settings.apiKey).toBe('');
    expect(edit.settings.modelProfiles?.[0].apiKey).toBe('');
    expect(edit.settings.embeddingApiKey).toBeUndefined();
    const caps = await getCapabilities();
    expect(caps[0].mcpToken).toBeUndefined();
    expect(caps[0].authConfig?.token).toBeUndefined();
    expect(await loadToken('xai-grok')).toBeNull();
    expect(local['ba_provider_tokens_xai-grok']).toBeDefined(); // kept for after unlock
    expect(await isMailboxConnected()).toBe(false);
    const sso = { startUrl: SSO_START, ssoRegion: 'us-east-1', accountId: '123456789012', roleName: 'Bedrock' };
    expect((await getAwsSsoStatus(sso)).state).toBe('signed-out');
    expect(await findConnectionByHost('api.x.ai')).toBeNull();
    await expect(saveCapabilities(capabilities)).rejects.toThrow(/locked/i);
    await expect(unsealBackupSnapshot({ ba_settings: local.ba_settings })).rejects.toThrow(/unlock/i);

    expect(await unlockVault(PASS)).toBe(true);
    expect((await getSettings())?.modelProfiles?.[0].apiKey).toBe('xai-profile-key');
  });

  it('an include-secrets backup snapshot is fully decrypted', async () => {
    seedPlaintext();
    await setupVault(PASS);
    await sealSecretsAtRest();
    const snap = await unsealBackupSnapshot({ ba_settings: local.ba_settings, ba_capabilities: local.ba_capabilities, ba_sites: local.ba_sites });
    expect(snap.ba_settings).toEqual(settings);
    expect(snap.ba_capabilities).toEqual(capabilities);
    expect(snap.ba_sites).toEqual(sites);
  });

  it('erasing the vault keeps every secret, now plaintext', async () => {
    seedPlaintext();
    const before = structuredClone(local);
    await setupVault(PASS);
    await sealSecretsAtRest();
    const plaintext = await plaintextSecretRecordsForErase();
    await eraseVault();
    await chrome.storage.local.set(plaintext);
    for (const key of Object.keys(before)) expect(local[key], key).toEqual(before[key]);
    expect(await getSettings()).toEqual(settings);
  });
});

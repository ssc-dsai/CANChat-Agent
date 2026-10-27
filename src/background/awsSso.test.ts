import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwsSsoConfig } from '../shared/awsSso';
import { getAwsSsoCredentials, getAwsSsoStatus, signOutAwsSso, startAwsSsoSignIn } from './awsSso';

function makeArea() {
  const store: Record<string, unknown> = {};
  return {
    store,
    api: {
      async get(key: string | null) {
        if (key === null) return { ...store };
        return key in store ? { [key]: store[key] } : {};
      },
      async set(obj: Record<string, unknown>) {
        Object.assign(store, obj);
      },
      async remove(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
  };
}

const json = (body: unknown, status = 200, errorType?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(errorType ? { 'x-amzn-ErrorType': `${errorType}:http://internal.amazon.com/` } : {}) },
  });

const ROLE_CREDS = {
  roleCredentials: { accessKeyId: 'ASIATEMP', secretAccessKey: 'temp-secret', sessionToken: 'temp-session', expiration: Date.now() + 4 * 3600_000 },
};

let local: ReturnType<typeof makeArea>;
let session: ReturnType<typeof makeArea>;
let fetchMock: ReturnType<typeof vi.fn>;
let n = 0;
// Module-level sign-in state is keyed by start URL, so each test gets its own.
let cfg: AwsSsoConfig;

beforeEach(() => {
  local = makeArea();
  session = makeArea();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', {
    storage: { local: local.api, session: session.api },
    tabs: { create: vi.fn(async () => ({})) },
  });
  cfg = { startUrl: `https://d-${++n}.awsapps.com/start`, ssoRegion: 'ca-central-1', accountId: '123456789012', roleName: 'BedrockUser' };
});

function seedSession(fields: Record<string, unknown>) {
  local.store[`ba_aws_sso_${cfg.startUrl}`] = {
    schemaVersion: 1,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    registrationExpiresAt: Date.now() + 30 * 86400_000,
    ...fields,
  };
}

describe('AWS IAM Identity Center sign-in', () => {
  it('refuses to mint credentials before the user signs in', async () => {
    await expect(getAwsSsoCredentials(cfg)).rejects.toThrow(/Not signed in to AWS IAM Identity Center/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the device grant, polls past authorization_pending, then mints role credentials', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/client/register')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ clientType: 'public', scopes: ['sso:account:access'] });
        return json({ clientId: 'client-id', clientSecret: 'client-secret', clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400 });
      }
      if (url.endsWith('/device_authorization')) {
        expect(JSON.parse(String(init?.body)).startUrl).toBe(cfg.startUrl);
        return json({ deviceCode: 'dev', userCode: 'ABCD-EFGH', verificationUri: 'https://device', verificationUriComplete: 'https://device?code=ABCD-EFGH', expiresIn: 600, interval: 0 });
      }
      if (url.endsWith('/token')) {
        const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/token')).length;
        return tokenCalls === 1
          ? json({ error: 'authorization_pending' }, 400, 'AuthorizationPendingException')
          : json({ accessToken: 'sso-access', refreshToken: 'sso-refresh', expiresIn: 28800 });
      }
      if (url.includes('/federation/credentials')) return json(ROLE_CREDS);
      throw new Error(`unexpected ${url}`);
    });

    const prompt = await startAwsSsoSignIn(cfg);
    expect(prompt.userCode).toBe('ABCD-EFGH');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://device?code=ABCD-EFGH' });
    expect((await getAwsSsoStatus(cfg)).state).toBe('pending');

    await vi.waitFor(async () => expect((await getAwsSsoStatus(cfg)).state).toBe('signed-in'));

    const creds = await getAwsSsoCredentials(cfg);
    expect(creds).toMatchObject({ accessKeyId: 'ASIATEMP', secretAccessKey: 'temp-secret', sessionToken: 'temp-session' });
    const [portalUrl, portalInit] = fetchMock.mock.calls.find(([u]) => String(u).includes('/federation/credentials'))!;
    expect(portalUrl).toBe('https://portal.sso.ca-central-1.amazonaws.com/federation/credentials?account_id=123456789012&role_name=BedrockUser');
    expect((portalInit as RequestInit).headers).toEqual({ 'x-amz-sso_bearer_token': 'sso-access' });

    // Cached in session storage: no second portal call.
    await getAwsSsoCredentials(cfg);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/federation/credentials'))).toHaveLength(1);
  });

  it('silently refreshes an expired access token and keeps the refresh token', async () => {
    seedSession({ accessToken: 'old', refreshToken: 'sso-refresh', expiresAt: Date.now() - 1000 });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/token')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ grantType: 'refresh_token', refreshToken: 'sso-refresh' });
        return json({ accessToken: 'new', expiresIn: 3600 });
      }
      if (url.includes('/federation/credentials')) return json(ROLE_CREDS);
      throw new Error(`unexpected ${url}`);
    });

    await getAwsSsoCredentials(cfg);
    const stored = local.store[`ba_aws_sso_${cfg.startUrl}`] as { accessToken: string; refreshToken: string };
    expect(stored.accessToken).toBe('new');
    expect(stored.refreshToken).toBe('sso-refresh');
  });

  it('asks for a new sign-in when the refresh token has ended', async () => {
    seedSession({ accessToken: 'old', refreshToken: 'dead', expiresAt: Date.now() - 1000 });
    fetchMock.mockResolvedValue(json({ error: 'invalid_grant' }, 400, 'InvalidGrantException'));
    await expect(getAwsSsoCredentials(cfg)).rejects.toThrow(/Not signed in/);
    expect((await getAwsSsoStatus(cfg)).state).toBe('signed-out');
  });

  it('explains a ForbiddenException as a missing permission-set assignment', async () => {
    seedSession({ accessToken: 'tok', expiresAt: Date.now() + 3600_000 });
    fetchMock.mockResolvedValue(json({ message: 'No access' }, 403, 'ForbiddenException'));
    await expect(getAwsSsoCredentials(cfg)).rejects.toThrow(/no Identity Center assignment for permission set "BedrockUser" on account 123456789012/);
  });

  it('sign-out forgets the tokens and cached credentials', async () => {
    seedSession({ accessToken: 'tok', expiresAt: Date.now() + 3600_000 });
    session.store[`ba_aws_sso_creds_123456789012_BedrockUser_${cfg.startUrl}`] = { ...ROLE_CREDS.roleCredentials };
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await signOutAwsSso(cfg);
    expect(local.store).toEqual({});
    expect(session.store).toEqual({});
    expect(fetchMock).toHaveBeenCalledWith('https://portal.sso.ca-central-1.amazonaws.com/logout', expect.objectContaining({ method: 'POST' }));
    expect((await getAwsSsoStatus(cfg)).state).toBe('signed-out');
  });
});

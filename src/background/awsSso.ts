// =============================================================================
// AWS IAM Identity Center (SSO) sign-in for Bedrock Mantle connections.
//
// Chain: org sign-in (Entra, via Identity Center's federation, in a browser tab)
//        -> Identity Center OIDC access token (device authorization grant)
//        -> GetRoleCredentials -> temporary credentials for the permission set
//        -> SigV4-signed Mantle requests (adapters/bedrockMantle.ts)
// so there is no long-lived AWS secret anywhere, and CloudTrail attributes every
// call to the signed-in person rather than a shared key.
//
// Ported from the reference client (src/sso-auth.js in ClientAppBedrockAccess),
// with the AWS SDK calls replaced by the same REST APIs over fetch — this
// service worker deliberately carries no aws-sdk (see awsSigv4.ts):
//   RegisterClient           POST oidc.<r>.amazonaws.com/client/register
//   StartDeviceAuthorization POST oidc.<r>.amazonaws.com/device_authorization
//   CreateToken              POST oidc.<r>.amazonaws.com/token
//   GetRoleCredentials       GET  portal.sso.<r>.amazonaws.com/federation/credentials
//   Logout                   POST portal.sso.<r>.amazonaws.com/logout
// The reference's AWS-CLI-cache reuse and debug profile mode don't apply in a
// browser and are left out.
//
// Storage: the client registration and OIDC access/refresh tokens live in
// chrome.storage.local, keyed by start URL (one token serves every permission
// set in an Identity Center instance) — same trust level as the provider tokens
// in providers/tokenStore.ts, and likewise not run through the vault. The role
// credentials (~hours) live in chrome.storage.session: in memory only, survive
// service-worker eviction, gone when the browser closes. None of it is logged
// or sent anywhere but AWS.
// =============================================================================

import type { AwsSsoConfig } from '../shared/awsSso';
import type { SigV4Credentials } from './awsSigv4';
import { LlmError } from './llmTypes';
import { withSwKeepalive } from './swKeepalive';

const CLIENT_NAME = 'canchat-agent';
// What GetRoleCredentials requires; registering with it is also what makes a
// refresh token available.
const SCOPES = ['sso:account:access'];
// Treat anything as expired a minute early so a request can't die mid-flight.
const CLOCK_SKEW_MS = 60_000;

interface ClientRegistration {
  clientId: string;
  clientSecret: string;
  /** Epoch ms. Registrations self-expire (~90 days) and hold no authority of their own. */
  registrationExpiresAt: number;
}

interface StoredSsoSession extends ClientRegistration {
  schemaVersion: 1;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
}

interface StoredRoleCredentials extends SigV4Credentials {
  /** Epoch ms. */
  expiration: number;
}

export interface AwsSsoSignInPrompt {
  userCode: string;
  /** Verification page, with the code pre-filled when Identity Center provides that. */
  verificationUri: string;
  /** Epoch ms after which the code is no longer accepted. */
  expiresAt: number;
}

export type AwsSsoStatus =
  | { state: 'signed-out' }
  | ({ state: 'pending' } & AwsSsoSignInPrompt)
  | { state: 'signed-in'; expiresAt?: number }
  | { state: 'error'; message: string };

const isFresh = (expiresAt: number | undefined): boolean =>
  typeof expiresAt === 'number' && expiresAt - CLOCK_SKEW_MS > Date.now();

const sessionKey = (startUrl: string) => `ba_aws_sso_${startUrl}`;
const CREDS_PREFIX = 'ba_aws_sso_creds_';
const credsKey = (cfg: AwsSsoConfig) => `${CREDS_PREFIX}${cfg.accountId}_${cfg.roleName}_${cfg.startUrl}`;

const NOT_SIGNED_IN = 'Not signed in to AWS IAM Identity Center. Sign in from Settings → Models.';

async function loadSession(startUrl: string): Promise<StoredSsoSession | null> {
  const k = sessionKey(startUrl);
  const r = await chrome.storage.local.get(k);
  const v = r[k] as StoredSsoSession | undefined;
  return v && typeof v.clientId === 'string' && typeof v.clientSecret === 'string' ? v : null;
}

async function saveSession(startUrl: string, session: Omit<StoredSsoSession, 'schemaVersion'>): Promise<void> {
  await chrome.storage.local.set({ [sessionKey(startUrl)]: { ...session, schemaVersion: 1 } });
}

/** Drop every cached role credential minted from this start URL's sign-in. */
async function clearRoleCredentials(startUrl: string): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CREDS_PREFIX) && k.endsWith(`_${startUrl}`));
  if (keys.length) await chrome.storage.session.remove(keys);
}

class AwsApiError extends Error {
  constructor(readonly name: string, message: string, readonly status: number) {
    super(message);
  }
}

/**
 * AWS JSON errors name themselves in the `x-amzn-ErrorType` header
 * (`AuthorizationPendingException:http://…`) and/or the body (`error`, `__type`).
 */
async function awsError(res: Response, what: string): Promise<AwsApiError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const name =
    res.headers.get('x-amzn-errortype')?.split(':')[0] ||
    (typeof body.__type === 'string' ? body.__type.split('#').pop() : undefined) ||
    (typeof body.error === 'string' ? body.error : undefined) ||
    `HTTP ${res.status}`;
  const detail = [body.message, body.error_description, body.Message].find((m) => typeof m === 'string') as string | undefined;
  return new AwsApiError(name, `${what} failed: ${name}${detail ? ` — ${detail}` : ''}`, res.status);
}

async function oidcPost<T>(region: string, path: string, body: Record<string, unknown>, what: string): Promise<T> {
  const res = await fetch(`https://oidc.${region}.amazonaws.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await awsError(res, what);
  return (await res.json()) as T;
}

/** Register this extension as a public OIDC client — what `aws sso login` does too. */
async function registerClient(cfg: AwsSsoConfig): Promise<ClientRegistration> {
  const res = await oidcPost<{ clientId: string; clientSecret: string; clientSecretExpiresAt?: number }>(
    cfg.ssoRegion,
    '/client/register',
    { clientName: CLIENT_NAME, clientType: 'public', scopes: SCOPES },
    'Identity Center client registration',
  );
  return {
    clientId: res.clientId,
    clientSecret: res.clientSecret,
    registrationExpiresAt: (res.clientSecretExpiresAt ?? 0) * 1000,
  };
}

interface CreateTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

function createToken(cfg: AwsSsoConfig, client: ClientRegistration, grant: Record<string, string>): Promise<CreateTokenResponse> {
  return oidcPost<CreateTokenResponse>(
    cfg.ssoRegion,
    '/token',
    { clientId: client.clientId, clientSecret: client.clientSecret, ...grant },
    'Identity Center sign-in',
  );
}

function sessionFromToken(client: ClientRegistration, token: CreateTokenResponse, previousRefresh?: string): Omit<StoredSsoSession, 'schemaVersion'> {
  return {
    ...client,
    accessToken: token.accessToken,
    // A refresh grant may not rotate the refresh token; keep the old one then.
    refreshToken: token.refreshToken ?? previousRefresh,
    expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
  };
}

// --- Interactive sign-in (device authorization grant, RFC 8628) -------------

interface PendingSignIn {
  prompt: AwsSsoSignInPrompt;
}

/** In-flight sign-ins and the last failure, by start URL — for the settings form's status line. */
const pending = new Map<string, PendingSignIn>();
const failures = new Map<string, string>();

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
}

async function pollForToken(cfg: AwsSsoConfig, client: ClientRegistration, auth: DeviceAuthorization): Promise<CreateTokenResponse> {
  // The interval AWS asks for, honoured; slow_down widens it.
  let intervalMs = (auth.interval ?? 5) * 1000;
  const deadline = Date.now() + (auth.expiresIn ?? 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      return await createToken(cfg, client, {
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        deviceCode: auth.deviceCode,
      });
    } catch (err) {
      const name = err instanceof AwsApiError ? err.name : '';
      if (/^authorization_?pending/i.test(name)) continue;
      if (/^slow_?down/i.test(name)) {
        intervalMs += 5000;
        continue;
      }
      // Expired code, or the user declined: terminal.
      throw err;
    }
  }
  throw new Error('The sign-in code expired before sign-in completed. Start again.');
}

/**
 * Start an interactive sign-in: opens the Identity Center verification page in
 * a new tab and returns the code to show alongside it. Completion is polled in
 * the background; the form follows it through getAwsSsoStatus. Only call this
 * from a user click.
 */
export async function startAwsSsoSignIn(cfg: AwsSsoConfig): Promise<AwsSsoSignInPrompt> {
  const existing = pending.get(cfg.startUrl);
  if (existing && existing.prompt.expiresAt > Date.now()) return existing.prompt;

  const stored = await loadSession(cfg.startUrl);
  // A registration outlives many tokens, so keep it and just re-mint.
  const client: ClientRegistration =
    stored && isFresh(stored.registrationExpiresAt)
      ? { clientId: stored.clientId, clientSecret: stored.clientSecret, registrationExpiresAt: stored.registrationExpiresAt }
      : await registerClient(cfg);

  const auth = await oidcPost<DeviceAuthorization>(
    cfg.ssoRegion,
    '/device_authorization',
    { clientId: client.clientId, clientSecret: client.clientSecret, startUrl: cfg.startUrl },
    'Identity Center sign-in',
  );
  const prompt: AwsSsoSignInPrompt = {
    userCode: auth.userCode,
    verificationUri: auth.verificationUriComplete ?? auth.verificationUri,
    expiresAt: Date.now() + (auth.expiresIn ?? 600) * 1000,
  };
  failures.delete(cfg.startUrl);
  pending.set(cfg.startUrl, { prompt });

  // Polling runs for up to the code's lifetime (minutes), well past the
  // service worker's ~30s idle timer, so keep it alive for the duration.
  void withSwKeepalive(async () => {
    const token = await pollForToken(cfg, client, auth);
    await saveSession(cfg.startUrl, sessionFromToken(client, token));
    // A new sign-in may be a different identity — never reuse the old one's credentials.
    await clearRoleCredentials(cfg.startUrl);
  })
    .catch((err) => failures.set(cfg.startUrl, err instanceof Error ? err.message : String(err)))
    .finally(() => pending.delete(cfg.startUrl));

  await chrome.tabs.create({ url: prompt.verificationUri });
  return prompt;
}

export async function getAwsSsoStatus(cfg: AwsSsoConfig): Promise<AwsSsoStatus> {
  const p = pending.get(cfg.startUrl);
  if (p) return { state: 'pending', ...p.prompt };
  const failure = failures.get(cfg.startUrl);
  if (failure) return { state: 'error', message: failure };
  const stored = await loadSession(cfg.startUrl);
  if (!stored?.accessToken) return { state: 'signed-out' };
  // An expired access token still counts as signed in while it can be refreshed.
  if (isFresh(stored.expiresAt) || (stored.refreshToken && isFresh(stored.registrationExpiresAt))) {
    return { state: 'signed-in', expiresAt: stored.expiresAt };
  }
  return { state: 'signed-out' };
}

/** Forget this start URL's sign-in and credentials, and end the portal session (best effort). */
export async function signOutAwsSso(cfg: AwsSsoConfig): Promise<void> {
  const stored = await loadSession(cfg.startUrl);
  pending.delete(cfg.startUrl);
  failures.delete(cfg.startUrl);
  await chrome.storage.local.remove(sessionKey(cfg.startUrl));
  await clearRoleCredentials(cfg.startUrl);
  if (stored?.accessToken && isFresh(stored.expiresAt)) {
    await fetch(`https://portal.sso.${cfg.ssoRegion}.amazonaws.com/logout`, {
      method: 'POST',
      headers: { 'x-amz-sso_bearer_token': stored.accessToken },
    }).catch(() => {});
  }
}

// --- Non-interactive: token refresh and role credentials --------------------

/** A usable access token: cached, else silently refreshed, else NOT_SIGNED_IN. */
async function getAccessToken(cfg: AwsSsoConfig, { forceRefresh = false } = {}): Promise<string> {
  const stored = await loadSession(cfg.startUrl);
  if (!stored?.accessToken) throw new LlmError(NOT_SIGNED_IN);
  if (!forceRefresh && isFresh(stored.expiresAt)) return stored.accessToken;

  if (stored.refreshToken && isFresh(stored.registrationExpiresAt)) {
    try {
      const token = await createToken(cfg, stored, { grantType: 'refresh_token', refreshToken: stored.refreshToken });
      const next = sessionFromToken(stored, token, stored.refreshToken);
      await saveSession(cfg.startUrl, next);
      return next.accessToken!;
    } catch {
      // Refresh tokens end when the organization's session policy says so —
      // that means a fresh interactive sign-in, not a hard failure.
    }
  }
  await saveSession(cfg.startUrl, { ...stored, accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
  throw new LlmError(NOT_SIGNED_IN);
}

async function fetchRoleCredentials(cfg: AwsSsoConfig, accessToken: string): Promise<StoredRoleCredentials> {
  const url =
    `https://portal.sso.${cfg.ssoRegion}.amazonaws.com/federation/credentials` +
    `?account_id=${encodeURIComponent(cfg.accountId)}&role_name=${encodeURIComponent(cfg.roleName)}`;
  const res = await fetch(url, { headers: { 'x-amz-sso_bearer_token': accessToken } });
  if (!res.ok) throw await awsError(res, 'AWS GetRoleCredentials');
  const { roleCredentials: c } = (await res.json()) as {
    roleCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number };
  };
  return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, expiration: c.expiration };
}

const inFlight = new Map<string, Promise<SigV4Credentials>>();

/**
 * Temporary AWS credentials for the configured permission set, minted from the
 * user's Identity Center sign-in and cached until shortly before they expire.
 * Concurrent callers share one fetch. Throws an LlmError telling the user to
 * sign in when no usable sign-in exists — never prompts by itself.
 */
export function getAwsSsoCredentials(cfg: AwsSsoConfig): Promise<SigV4Credentials> {
  const key = credsKey(cfg);
  const running = inFlight.get(key);
  if (running) return running;
  const work = (async () => {
    const cached = (await chrome.storage.session.get(key))[key] as StoredRoleCredentials | undefined;
    if (cached && isFresh(cached.expiration)) return cached;

    let creds: StoredRoleCredentials;
    try {
      creds = await fetchRoleCredentials(cfg, await getAccessToken(cfg));
    } catch (err) {
      // The portal can reject an access token before its stated expiry; refresh once.
      if (!(err instanceof AwsApiError && err.status === 401)) throw describe(err, cfg);
      try {
        creds = await fetchRoleCredentials(cfg, await getAccessToken(cfg, { forceRefresh: true }));
      } catch (retryErr) {
        throw describe(retryErr, cfg);
      }
    }
    await chrome.storage.session.set({ [key]: creds });
    return creds;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

function describe(err: unknown, cfg: AwsSsoConfig): Error {
  if (err instanceof LlmError) return err;
  if (err instanceof AwsApiError && err.status === 401) return new LlmError(NOT_SIGNED_IN);
  if (err instanceof AwsApiError && err.name === 'ForbiddenException') {
    // A valid sign-in plus "No access" is not an auth failure: Identity Center
    // has no assignment giving *this* identity the permission set on that
    // account — which may mean the user signed in as the wrong one of their accounts.
    return new LlmError(
      `${err.message}. You are signed in, but that identity has no Identity Center assignment for permission set ` +
        `"${cfg.roleName}" on account ${cfg.accountId}. Either it needs the assignment, or you signed in with a ` +
        `different account than the one that has it — sign out and sign in again in Settings → Models.`,
    );
  }
  // Network failures and AWS-side 5xx are worth retrying; a rejected request is not.
  const retryable = !(err instanceof AwsApiError) || err.status >= 500;
  return new LlmError(err instanceof Error ? err.message : String(err), { retryable });
}

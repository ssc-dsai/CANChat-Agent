// =============================================================================
// Microsoft Graph OAuth (auth-code + PKCE) for mail, calendar, and draft
// creation. Runs in the service worker: launches the interactive sign-in via
// chrome.identity, exchanges the code for tokens, and refreshes silently.
// Tokens live in chrome.storage.local (same trust level as the configured API
// key). Pure URL/PKCE construction is in shared/graphAuth.ts. No client secret
// — this is a public PKCE client.
// =============================================================================

import { buildAuthUrl, buildTokenBody, parseCodeFromRedirect, pkcePair, tokenEndpoint } from '../shared/graphAuth';

const TOKEN_KEY = 'graphTokens';

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (already padded 1 min early). */
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function loadTokens(): Promise<StoredTokens | null> {
  const r = await chrome.storage.local.get(TOKEN_KEY);
  return (r[TOKEN_KEY] as StoredTokens) ?? null;
}

async function saveTokens(t: StoredTokens): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: t });
}

export async function disconnectMailbox(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}

export async function isMailboxConnected(): Promise<boolean> {
  return (await loadTokens()) !== null;
}

/** The extension's OAuth redirect URI (register this in the Azure app). */
export function redirectUri(): string {
  return chrome.identity.getRedirectURL();
}

async function exchange(tenant: string, body: string): Promise<StoredTokens> {
  const res = await fetch(tokenEndpoint(tenant), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token request failed (HTTP ${res.status}).`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000, // refresh ~1 min early
  };
}

/** Interactive sign-in (must be triggered by a user gesture). Stores tokens. */
export async function connectMailbox(clientId: string, tenant: string): Promise<void> {
  if (!clientId) throw new Error('Set your Azure app Client ID in Settings first.');
  if (!chrome.identity?.launchWebAuthFlow) throw new Error('chrome.identity is unavailable.');
  const { verifier, challenge } = await pkcePair();
  const authUrl = buildAuthUrl({ tenant, clientId, redirectUri: redirectUri(), codeChallenge: challenge });
  const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!redirect) throw new Error('Sign-in was cancelled.');
  const { code, error } = parseCodeFromRedirect(redirect);
  if (error || !code) throw new Error(error || 'No authorization code returned.');
  const tokens = await exchange(
    tenant,
    buildTokenBody({ clientId, redirectUri: redirectUri(), code, codeVerifier: verifier }),
  );
  await saveTokens(tokens);
}

/** A valid access token, refreshed silently when stale. Throws if not connected. */
export async function getAccessToken(clientId: string, tenant: string): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens) throw new Error('Mailbox not connected — click Connect first.');
  if (Date.now() < tokens.expiresAt) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error('Session expired — reconnect the mailbox.');
  const refreshed = await exchange(
    tenant,
    buildTokenBody({ clientId, redirectUri: redirectUri(), refreshToken: tokens.refreshToken }),
  );
  await saveTokens(refreshed);
  return refreshed.accessToken;
}

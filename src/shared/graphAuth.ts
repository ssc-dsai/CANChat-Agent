// Pure helpers for the Microsoft Graph OAuth (auth-code + PKCE) flow used for
// mail, calendar, and draft creation. URL/body/PKCE construction lives here (no
// chrome.*/network) so it is unit-testable; the interactive launch + token
// storage live in background/graphAuth.ts.
//
// Scope covers three delegated capabilities: reading mail (microsoft365_search,
// mailbox indexing), reading calendar (calendar_search), and creating — never
// sending — drafts (draft_email). Graph has no narrower "create a draft only"
// scope: Mail.ReadWrite is required even just to POST a draft message. This is
// a wider consent ask than a mail-only integration and will likely need admin
// consent in most enterprise tenants.

const AUTHORITY = 'https://login.microsoftonline.com';
export const DEFAULT_SCOPE = 'Mail.Read Mail.ReadWrite Calendars.Read offline_access openid';

export interface AuthUrlParams {
  /** `organizations` (any work/school tenant) or a specific tenant id. */
  tenant: string;
  clientId: string;
  redirectUri: string;
  /** PKCE S256 code challenge. */
  codeChallenge: string;
  scope?: string;
  state?: string;
}

export function authorizeEndpoint(tenant: string): string {
  return `${AUTHORITY}/${encodeURIComponent(tenant || 'organizations')}/oauth2/v2.0/authorize`;
}

export function tokenEndpoint(tenant: string): string {
  return `${AUTHORITY}/${encodeURIComponent(tenant || 'organizations')}/oauth2/v2.0/token`;
}

/** Build the interactive authorize URL for `chrome.identity.launchWebAuthFlow`. */
export function buildAuthUrl(p: AuthUrlParams): string {
  const u = new URL(authorizeEndpoint(p.tenant));
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', p.scope ?? DEFAULT_SCOPE);
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  if (p.state) u.searchParams.set('state', p.state);
  return u.toString();
}

/** Form body for the token endpoint — authorization-code exchange or refresh. */
export function buildTokenBody(args: {
  clientId: string;
  redirectUri: string;
  scope?: string;
  /** Code-exchange path. */
  code?: string;
  codeVerifier?: string;
  /** Refresh path (takes precedence when present). */
  refreshToken?: string;
}): string {
  const b = new URLSearchParams();
  b.set('client_id', args.clientId);
  b.set('scope', args.scope ?? DEFAULT_SCOPE);
  if (args.refreshToken) {
    b.set('grant_type', 'refresh_token');
    b.set('refresh_token', args.refreshToken);
  } else {
    b.set('grant_type', 'authorization_code');
    b.set('code', args.code ?? '');
    b.set('redirect_uri', args.redirectUri);
    b.set('code_verifier', args.codeVerifier ?? '');
  }
  return b.toString();
}

/** Pull the auth code (or an error) out of the redirect URL the flow returns. */
export function parseCodeFromRedirect(redirectUrl: string): { code?: string; error?: string } {
  try {
    const u = new URL(redirectUrl);
    const err = u.searchParams.get('error');
    if (err) return { error: u.searchParams.get('error_description') || err };
    const code = u.searchParams.get('code');
    return code ? { code } : { error: 'No authorization code in the redirect.' };
  } catch {
    return { error: 'Malformed redirect URL.' };
  }
}

// ----- PKCE -----

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A high-entropy code verifier (base64url, RFC 7636 length bounds). */
export function randomVerifier(byteLen = 48): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Derive the S256 code challenge from a verifier. */
export async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomVerifier();
  return { verifier, challenge: await challengeFromVerifier(verifier) };
}

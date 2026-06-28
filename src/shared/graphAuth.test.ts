import { describe, expect, it } from 'vitest';
import {
  buildAuthUrl,
  buildTokenBody,
  challengeFromVerifier,
  parseCodeFromRedirect,
  tokenEndpoint,
} from './graphAuth';

describe('buildAuthUrl', () => {
  it('targets the tenant authorize endpoint with PKCE S256 params', () => {
    const url = buildAuthUrl({
      tenant: 'contoso.onmicrosoft.com',
      clientId: 'abc',
      redirectUri: 'https://ext.chromiumapp.org/',
      codeChallenge: 'CHAL',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    );
    expect(u.searchParams.get('client_id')).toBe('abc');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge')).toBe('CHAL');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('Mail.Read');
    expect(u.searchParams.get('scope')).toContain('offline_access');
  });

  it('falls back to the organizations authority when no tenant is given', () => {
    expect(tokenEndpoint('')).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
  });
});

describe('buildTokenBody', () => {
  it('builds an authorization-code exchange body', () => {
    const body = new URLSearchParams(
      buildTokenBody({ clientId: 'abc', redirectUri: 'https://r/', code: 'CODE', codeVerifier: 'VER' }),
    );
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('code_verifier')).toBe('VER');
    expect(body.get('redirect_uri')).toBe('https://r/');
    expect(body.get('refresh_token')).toBeNull();
  });

  it('prefers the refresh-token grant when a refresh token is present', () => {
    const body = new URLSearchParams(
      buildTokenBody({ clientId: 'abc', redirectUri: 'https://r/', refreshToken: 'RT' }),
    );
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('RT');
    expect(body.get('code')).toBeNull();
  });
});

describe('parseCodeFromRedirect', () => {
  it('extracts the code', () => {
    expect(parseCodeFromRedirect('https://ext.chromiumapp.org/?code=XYZ&state=s')).toEqual({ code: 'XYZ' });
  });
  it('surfaces an OAuth error', () => {
    const r = parseCodeFromRedirect('https://ext.chromiumapp.org/?error=access_denied&error_description=nope');
    expect(r.error).toBe('nope');
    expect(r.code).toBeUndefined();
  });
  it('reports a missing code', () => {
    expect(parseCodeFromRedirect('https://ext.chromiumapp.org/').error).toMatch(/No authorization code/);
  });
});

describe('challengeFromVerifier (RFC 7636 test vector)', () => {
  it('derives the documented S256 challenge', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await challengeFromVerifier(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

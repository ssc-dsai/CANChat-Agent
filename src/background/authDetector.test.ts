import { describe, expect, it } from 'vitest';
import type { PageContent } from '../shared/types';
import { analyzeAuthState } from './authDetector';

// Build a minimal PageContent; callers override the fields each case cares about.
function page(overrides: Partial<PageContent> = {}): PageContent {
  return {
    tabId: 1,
    url: 'https://example.com/listing?page=2',
    title: 'Listings — Page 2',
    text: 'A'.repeat(500),
    metadata: {},
    links: [],
    headings: [],
    extractionStatus: 'ok',
    capturedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('analyzeAuthState', () => {
  it('treats a normal listing page as authenticated', () => {
    expect(analyzeAuthState(page()).status).toBe('authenticated');
  });

  // Regression: the pagination-stall bug. A logged-in page with a "Sign in" link in
  // its header (login-looking title) AND a URL containing a removed broad token must
  // NOT be flagged — url+title corroboration alone is no longer enough.
  it('does NOT flag a listing page with a header sign-in link and a session-ish URL', () => {
    const content = page({
      url: 'https://shop.example.com/products?session=abc123&page=2',
      title: 'Products • Sign in',
      text: 'Product one. Product two. Sign in to save favourites.'.padEnd(500, '.'),
    });
    expect(analyzeAuthState(content).status).toBe('authenticated');
  });

  it('does not flag ordinary URLs containing "auth" or "session" substrings', () => {
    expect(analyzeAuthState(page({ url: 'https://example.com/author/jane' })).status).toBe(
      'authenticated',
    );
    expect(analyzeAuthState(page({ url: 'https://example.com/p?sessionId=9' })).status).toBe(
      'authenticated',
    );
  });

  it('flags a page with a password input (strong signal)', () => {
    const content = page({ metadata: { 'ba:hasPasswordInput': 'true' } });
    expect(analyzeAuthState(content).status).toBe('auth_required');
  });

  it('flags a real login <form> reported by the extractor', () => {
    const content = page({ metadata: { 'ba:hasLoginForm': 'true' } });
    expect(analyzeAuthState(content).status).toBe('auth_required');
  });

  it('flags a redirect to a known identity provider', () => {
    const content = page({ url: 'https://login.microsoftonline.com/common/oauth2/authorize' });
    const result = analyzeAuthState(content);
    expect(result.status).toBe('auth_required');
    expect(result.detectedProvider).toBe('Microsoft');
  });

  it('flags an explicit interstitial: sign-in text + a login-looking URL', () => {
    const content = page({
      url: 'https://example.com/login',
      title: 'Redirecting…',
      text: 'Your session has expired, please sign in to continue.'.padEnd(200, ' '),
    });
    expect(analyzeAuthState(content).status).toBe('auth_required');
  });

  it('does not flag sign-in body text on its own (no corroborating URL/title)', () => {
    const content = page({
      url: 'https://example.com/articles/42',
      title: 'How single sign-on works',
      text: 'This article explains what happens when you sign in to continue.'.padEnd(500, '.'),
    });
    expect(analyzeAuthState(content).status).toBe('authenticated');
  });

  it('reports blocked extraction as blocked, not auth_required', () => {
    expect(analyzeAuthState(page({ extractionStatus: 'blocked' })).status).toBe('blocked');
  });
});

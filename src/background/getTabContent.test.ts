// Regression coverage for the "extractor failed on this site" class of bug.
//
// chrome.tabs.sendMessage RESOLVES WITH `undefined` when no listener answers
// (it only rejects when there is no receiver at all). getTabContent used to
// spread that straight into a PageContent and hand it to analyzeAuthState, which
// dereferences .metadata / .text — so the real cause was replaced by a generic
// TypeError and every failure mode looked identical to the user.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = unknown | (() => unknown);

/** Install a chrome stub whose ba_extract reply is scripted per test. */
function stubChrome(replies: Record<string, Reply>) {
  const sendMessage = vi.fn(async (_tabId: number, req: { kind: string }) => {
    const r = replies[req.kind];
    if (r === '__reject__') throw new Error('Could not establish connection.');
    return typeof r === 'function' ? (r as () => unknown)() : r;
  });
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async () => ({ id: 1, url: 'https://news.example.com/article', title: 'An Article' })),
      sendMessage,
      query: vi.fn(async () => []),
    },
    scripting: { executeScript: vi.fn(async () => [{ result: null }]) },
    tabGroups: { query: vi.fn(async () => []) },
  });
  return sendMessage;
}

describe('getTabContent — malformed content-script replies', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('reports a clear cause when no listener answers (undefined reply)', async () => {
    // Ping answers so injection is considered live, but the extract call returns
    // undefined — the exact shape that used to produce a bogus TypeError.
    stubChrome({ ba_ping: { ok: true }, ba_extract: undefined });
    const { getTabContent } = await import('./browserToolAdapter');

    const content = await getTabContent(1);

    expect(content.extractionStatus).toBe('unsupported');
    expect(content.metadata['ba:note']).toContain('no listener answered');
    // Must not crash, and must stay a well-formed PageContent.
    expect(content.text).toBe('');
    expect(content.links).toEqual([]);
  });

  it('surfaces the real in-page error when extractPage throws', async () => {
    stubChrome({
      ba_ping: { ok: true },
      ba_extract: { ok: false, detail: 'TypeError: boom inside extractPage' },
    });
    const { getTabContent } = await import('./browserToolAdapter');

    const content = await getTabContent(1);

    expect(content.extractionStatus).toBe('unsupported');
    // The actual reason must reach the model, not be swallowed.
    expect(content.metadata['ba:note']).toContain('boom inside extractPage');
  });

  it('fails loudly when the content script can never be reached', async () => {
    // Ping never succeeds, even after injection.
    stubChrome({ ba_ping: '__reject__', ba_extract: undefined });
    const { getTabContent } = await import('./browserToolAdapter');

    const content = await getTabContent(1);

    expect(content.extractionStatus).toBe('unsupported');
    expect(content.metadata['ba:note']).toMatch(/could not be reached|Reload the page/i);
  });

  it('passes a well-formed extraction through untouched', async () => {
    const good = {
      url: 'https://news.example.com/article',
      title: 'An Article',
      text: 'Real article body. '.repeat(50),
      metadata: {},
      links: [],
      headings: [],
      extractionStatus: 'ok' as const,
      capturedAt: new Date().toISOString(),
    };
    stubChrome({ ba_ping: { ok: true }, ba_extract: good });
    const { getTabContent } = await import('./browserToolAdapter');

    const content = await getTabContent(1);

    expect(content.extractionStatus).toBe('ok');
    expect(content.text).toContain('Real article body.');
  });
});

import { expect, openFixtureTab, test } from './fixtures';

test.describe('smoke', () => {
  test('extension loads and the service worker starts', async ({ extensionId, serviceWorker }) => {
    // A real extension id is 32 chars a–p; the SW url is the background script.
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toContain('serviceWorker.js');
  });

  test('a fixture page opens over http', async ({ context, staticServer }) => {
    const page = await openFixtureTab(context, staticServer, 'article.html');
    await expect(page.locator('#headline')).toContainText('Northwest Passage');
  });

  test('the content script injects and reads the page', async ({ context, staticServer, sidebar }) => {
    const article = await openFixtureTab(context, staticServer, 'article.html');
    const fixtureUrl = article.url();

    // Drive chrome.scripting/tabs from an extension page (sidebar is one), exactly
    // as the extension does at runtime: inject contentScript.js then message it.
    const result = await sidebar.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      if (!tab?.id) throw new Error('fixture tab not found');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['contentScript.js'] });
      const ping = (await chrome.tabs.sendMessage(tab.id, { kind: 'ba_ping' })) as { ok?: boolean };
      const extract = (await chrome.tabs.sendMessage(tab.id, { kind: 'ba_extract' })) as {
        title?: string;
        text?: string;
      };
      return { ping, extract };
    }, fixtureUrl);

    expect(result.ping.ok).toBe(true);
    expect(result.extract.title).toContain('Northwest Passage');
    expect(result.extract.text).toContain('Arctic');
  });

  test('the side-panel UI opens and the composer is enabled once configured', async ({ sidebar }) => {
    await expect(sidebar.getByTestId('chat-input')).toBeVisible();
    await expect(sidebar.getByTestId('send')).toBeVisible();
  });
});

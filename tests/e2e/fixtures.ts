// Playwright fixtures for the MV3 extension harness.
//
// - mockLlm / staticServer: worker-scoped, stateless local servers.
// - context: a fresh persistent Chromium context per test with the unpacked
//   `dist/` extension loaded, so the service-worker/agent state never leaks
//   between tests.
// - extensionId: discovered from the background service worker.
// - sidebar: the extension's side-panel UI opened as a tab and pointed at the
//   mock model endpoint (the composer is gated until ba_settings is set).
// - diagnostics: auto fixture capturing console/page-error/request-failure logs
//   and attaching them to failed tests (traces/screenshots/videos come from the
//   Playwright config).

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  test as base,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { startMockLlm, type MockLlm } from './mockLlm';
import { startStatic, type StaticServer } from './staticServer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../../dist');
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

interface Workers {
  mockLlm: MockLlm;
  staticServer: StaticServer;
}

interface Tests {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  sidebar: Page;
  diagnostics: void;
}

export const test = base.extend<Tests, Workers>({
  mockLlm: [
    async ({}, use) => {
      const m = await startMockLlm();
      await use(m);
      await m.close();
    },
    { scope: 'worker' },
  ],

  staticServer: [
    async ({}, use) => {
      const s = await startStatic(FIXTURES_DIR);
      await use(s);
      await s.close();
    },
    { scope: 'worker' },
  ],

  context: async ({}, use) => {
    if (!existsSync(resolve(DIST, 'manifest.json'))) {
      throw new Error(`Extension build not found at ${DIST}. Run "npm run build" first (the test:e2e script does this automatically).`);
    }
    // Extensions require a headed context; CI runs this under xvfb.
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        '--no-sandbox',
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  sidebar: async ({ context, extensionId, mockLlm }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidebar.html`);
    // Configure the model endpoint directly in storage, then reload so the UI
    // re-reads it and enables the composer (it stays disabled until set).
    await page.evaluate((baseUrl) => {
      return chrome.storage.local.set({
        ba_settings: { baseUrl, apiKey: 'test-key', model: 'mock-model' },
      });
    }, `${mockLlm.url}/v1`);
    await page.reload();
    await use(page);
  },

  diagnostics: [
    async ({ context }, use, testInfo) => {
      const console_: string[] = [];
      const pageErrors: string[] = [];
      const requestFailures: string[] = [];
      const wire = (page: Page) => {
        page.on('console', (m) => console_.push(`[${m.type()}] ${m.text()}`));
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        page.on('requestfailed', (r) => requestFailures.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? ''}`));
      };
      context.pages().forEach(wire);
      context.on('page', wire);

      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        const dump = (name: string, lines: string[]) =>
          lines.length && testInfo.attach(name, { body: lines.join('\n'), contentType: 'text/plain' });
        await dump('console.log.txt', console_);
        await dump('page-errors.txt', pageErrors);
        await dump('request-failures.txt', requestFailures);
      }
    },
    { auto: true },
  ],
});

export { expect };

/** Open a fixture page (e.g. "article.html") in its own tab over http. */
export async function openFixtureTab(
  context: BrowserContext,
  staticServer: StaticServer,
  name: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${staticServer.url}/${name}`, { waitUntil: 'domcontentloaded' });
  return page;
}

/**
 * Send a chat message through the sidebar composer (a contenteditable) and click
 * Send. Mirrors how a user drives the UI.
 */
export async function sendChat(sidebar: Page, text: string): Promise<void> {
  const input = sidebar.getByTestId('chat-input');
  await input.click();
  await input.fill(text);
  await sidebar.getByTestId('send').click();
}

// Captures the screenshots referenced by docs/USER-MANUAL.md that the usability
// walkthrough doesn't already produce: the Advanced and Skills settings tabs,
// the skill editor, and a running-agent view (plan + tool activity). Driven
// against the mock model so it's deterministic and offline. Screenshots land in
// docs/user-guide/screenshots/ and are committed as documentation evidence.

import { expect, sendChat, test } from './fixtures';

const SHOTS = 'docs/user-guide/screenshots';
const PANEL = { width: 400, height: 900 };

test.describe('user-manual screenshots', () => {
  test('settings — Advanced tab (Azure, embeddings, transcription, SharePoint)', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sidebar.locator('.header-controls .icon-btn').last().click(); // Settings gear
    await expect(sidebar.locator('.settings-tabs')).toBeVisible();
    await sidebar.getByRole('tab', { name: 'Advanced' }).click();
    await expect(sidebar.getByText('SharePoint')).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/01-settings-advanced.png` });
  });

  test('settings — Skills tab with the two seeded skills', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sidebar.locator('.header-controls .icon-btn').last().click();
    await sidebar.getByRole('tab', { name: 'Skills' }).click();
    await expect(sidebar.getByText('/summarize-tabs')).toBeVisible();
    await expect(sidebar.getByText('/research')).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/02-settings-skills.png` });

    // The skill editor form.
    await sidebar.getByRole('button', { name: 'Add skill' }).first().click();
    await expect(sidebar.locator('.site-form')).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/03-skill-form.png` });
  });

  test('downloads prompt for a location (Save As)', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    // Capture chrome.downloads.download calls instead of opening a real dialog.
    await sidebar.evaluate(() => {
      (window as unknown as { __dl: unknown[] }).__dl = [];
      chrome.downloads.download = ((opts: chrome.downloads.DownloadOptions, cb?: (id: number) => void) => {
        (window as unknown as { __dl: unknown[] }).__dl.push(opts);
        cb?.(1);
      }) as typeof chrome.downloads.download;
    });
    // Backup export is the simplest file save (no model needed).
    await sidebar.locator('.header-controls .icon-btn').last().click(); // Settings
    await sidebar.getByRole('tab', { name: 'Data & privacy' }).click();
    await sidebar.getByText('Backup & Restore').click(); // expand the <details>
    await sidebar.getByRole('button', { name: 'Export backup' }).click();

    await expect
      .poll(() => sidebar.evaluate(() => (window as unknown as { __dl: unknown[] }).__dl.length))
      .toBeGreaterThan(0);
    const opts = (await sidebar.evaluate(
      () => (window as unknown as { __dl: chrome.downloads.DownloadOptions[] }).__dl[0],
    )) as chrome.downloads.DownloadOptions;
    expect(opts.saveAs).toBe(true);
    expect(String(opts.filename)).toContain('canchat-agent-backup-');
  });

  test('Stop ends a running task and frees the UI', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sendChat(sidebar, 'SLOW — take your time then answer.');
    // The task is now in-flight: Stop is enabled (status is not idle).
    const stop = sidebar.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeEnabled();

    await stop.click();
    // Stopping is immediate: status returns to Idle and a notice confirms it,
    // even though the mock's response is still pending server-side.
    await expect(sidebar.locator('.status')).toContainText('Idle');
    await expect(sidebar.locator('.msg-notice', { hasText: 'Task stopped' })).toBeVisible();

    // The UI is freed — a brand-new request works (no "already running" error).
    await sendChat(sidebar, 'Now please summarize the page.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    await expect(sidebar.locator('.banner-error')).toHaveCount(0);
  });

  test('rate limit (429) is backed off and retried automatically', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    // Mock 429s the first attempt (Retry-After: 1) then succeeds.
    await sendChat(sidebar, 'RATE_LIMIT please summarize the page.');
    // A "retrying" notice appears while it backs off...
    await expect(sidebar.locator('.msg-notice', { hasText: 'retrying' })).toBeVisible();
    // ...then the answer arrives, with no error banner — the retry recovered it.
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    await expect(sidebar.locator('.banner-error')).toHaveCount(0);
  });

  test('rate limit surfaces an error when auto-retry is turned off', async ({ context, extensionId, mockLlm }) => {
    const page = await context.newPage();
    await page.setViewportSize(PANEL);
    await page.goto(`chrome-extension://${extensionId}/sidebar.html`);
    await page.evaluate(
      (baseUrl) =>
        chrome.storage.local.set({
          ba_settings: { baseUrl, apiKey: 'test-key', model: 'mock-model', retryOnRateLimit: false },
        }),
      `${mockLlm.url}/v1`,
    );
    await page.reload();

    await sendChat(page, 'RATE_LIMIT no-retry path.');
    // With retries disabled the 429 surfaces immediately as a (rate-limit) error.
    await expect(page.locator('.banner-error')).toBeVisible();
    await expect(page.locator('.banner-error')).toContainText('rate-limit');
    await expect(page.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toHaveCount(0);
  });

  test('self-check gate sends a weak answer back for one revision', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    // The mock's verifier returns "revise" once for a REFLECT_DEMO task, so the
    // loop runs a single self-correction cycle before settling on the answer.
    await sendChat(sidebar, 'REFLECT_DEMO summarize the page.');
    await expect(sidebar.locator('.msg-notice', { hasText: 'Self-checking' })).toBeVisible();
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    await expect(sidebar.locator('.banner-error')).toHaveCount(0);
  });

  test('agent execution — plan panel and tool activity', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sendChat(sidebar, 'PLAN_DEMO: research this topic for me.');
    // The plan the agent laid out is shown to the user.
    await expect(sidebar.locator('.plan-panel')).toBeVisible();
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/04-agent-plan.png` });

    // Expand the tool-activity log (collapsed by default) to show the steps run.
    await sidebar.locator('.activity-toggle').click();
    await expect(sidebar.locator('.activity-list')).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/05-tool-activity.png` });
  });
});

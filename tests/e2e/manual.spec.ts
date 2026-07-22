// Captures the screenshots referenced by docs/USER-MANUAL.md that the usability
// walkthrough doesn't already produce: the Advanced and Skills settings tabs,
// the skill editor, and a running-agent view (plan + tool activity). Driven
// against the mock model so it's deterministic and offline. Screenshots land in
// docs/user-guide/screenshots/ and are committed as documentation evidence.

import { expect, sendChat, test } from './fixtures';

const SHOTS = 'docs/user-guide/screenshots';
const PANEL = { width: 400, height: 900 };

test.describe('user-manual screenshots', () => {
  test('workspace Models page — advanced groups (embeddings, transcription, SharePoint)', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extensionId}/workspace.html#models`);
    await expect(page.getByTestId('advanced-settings')).toBeVisible();
    await expect(page.getByText('SharePoint base URL')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-settings-advanced.png` });
    await page.close();
  });

  test('History rows show an LLM conversation summary, not the last-message snippet', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sendChat(sidebar, 'Please summarize the current page.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

    // The summary is generated fire-and-forget after the turn settles; wait for
    // it to land in the history index before opening the list.
    await expect
      .poll(async () =>
        sidebar.evaluate(async () => {
          const r = await chrome.storage.local.get('ba_conv_index');
          const idx = (r.ba_conv_index as Array<{ summary?: string }>) ?? [];
          return idx[0]?.summary ?? '';
        }),
      )
      .toContain('concise summary of the test conversation');

    await sidebar.locator('.header-controls .icon-btn').first().click(); // History
    const row = sidebar.locator('.conv-item').first();
    await expect(row.locator('.conv-preview')).toContainText('A concise summary of the test conversation.');
  });

  test('upload a file into a knowledge base from the workspace Knowledge page', async ({ context, extensionId, sidebar }) => {
    void sidebar; // fixture configures the model so ingestion can embed
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extensionId}/workspace.html#knowledge`);

    // Reveal the uploader, name a new repo, and choose a small text file.
    await page.locator('.repo-upload-toggle').click();
    await page.locator('.repo-upload input[type="text"]').fill('uploads');
    await page.locator('.repo-drop input[type="file"]').setInputFiles({
      name: 'note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('This is a short uploaded note about arctic shipping lanes for the test.'),
    });
    // The file is queued; Add ingests it.
    await expect(page.locator('.repo-file', { hasText: 'note.txt' })).toBeVisible();
    await page.getByRole('button', { name: 'Add files', exact: true }).click();

    // On success the uploader closes and a banner confirms it; the repo appears.
    await expect(page.locator('.upload-banner')).toContainText('Added 1 file');
    await expect(page.locator('.repo-upload')).toHaveCount(0); // box cleared
    await expect(page.locator('.repo-block', { hasText: 'uploads' })).toBeVisible();
    await page.close();
  });

  test('attach files to a knowledge base from the composer', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    // The 📎 attach control feeds the inline uploader (no drag needed).
    await sidebar.getByTestId('attach-input').setInputFiles({
      name: 'memo.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('A short memo for the composer upload test.'),
    });
    await sidebar.locator('.repo-upload input[type="text"]').fill('composer-uploads');
    await sidebar.getByRole('button', { name: 'Add files', exact: true }).click();

    // Success banner appears and the inline card clears itself.
    await expect(sidebar.locator('.upload-banner')).toContainText('Added 1 file');
    await expect(sidebar.locator('.repo-upload-card')).toHaveCount(0);
  });

  test('workspace Models page — repo-search passages (k) persists', async ({ context, extensionId, sidebar }) => {
    void sidebar; // fixture seeds ba_settings first
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extensionId}/workspace.html#models`);

    const advanced = page.getByTestId('advanced-settings');
    const field = advanced.locator('label.field', { hasText: 'Passages per repository search' }).locator('input');
    await field.fill('10');
    await advanced.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(advanced.locator('.banner-ok')).toBeVisible();

    const saved = await page.evaluate(async () => {
      const r = await chrome.storage.local.get('ba_settings');
      return (r.ba_settings as { repoSearchK?: number }).repoSearchK;
    });
    expect(saved).toBe(10);
    // Patch-save: the connection fields seeded by the fixture must survive an
    // advanced-section save (regression guard for section clobbering).
    const model = await page.evaluate(async () => {
      const r = await chrome.storage.local.get('ba_settings');
      return (r.ba_settings as { model?: string }).model;
    });
    expect(model).toBe('mock-model');
    await page.close();
  });

  test('workspace Skills page with the seeded skills', async ({ context, extensionId, sidebar }) => {
    void sidebar; // fixture seeds the example skills
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extensionId}/workspace.html#skills`);
    await expect(page.getByText('/research')).toBeVisible();
    await expect(page.getByText('/search-sharepoint')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/02-settings-skills.png` });

    // The skill editor form.
    await page.getByRole('button', { name: 'Add skill' }).first().click();
    await expect(page.locator('.site-form')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/03-skill-form.png` });
    await page.close();
  });

  test('downloads prompt for a location (Save As)', async ({ context, extensionId }) => {
    // Backup export is the simplest file save (no model needed) — it lives on
    // the workspace Settings page now. Capture chrome.downloads.download calls
    // in that page instead of opening a real dialog.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/workspace.html#settings`);
    await page.evaluate(() => {
      (window as unknown as { __dl: unknown[] }).__dl = [];
      chrome.downloads.download = ((opts: chrome.downloads.DownloadOptions, cb?: (id: number) => void) => {
        (window as unknown as { __dl: unknown[] }).__dl.push(opts);
        cb?.(1);
      }) as typeof chrome.downloads.download;
    });
    await page.getByRole('button', { name: 'Export backup' }).click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __dl: unknown[] }).__dl.length))
      .toBeGreaterThan(0);
    const opts = (await page.evaluate(
      () => (window as unknown as { __dl: chrome.downloads.DownloadOptions[] }).__dl[0],
    )) as chrome.downloads.DownloadOptions;
    expect(opts.saveAs).toBe(true);
    expect(String(opts.filename)).toContain('canchat-agent-backup-');
    await page.close();
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

  test('create_powerpoint produces a downloadable .pptx card', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sendChat(sidebar, 'CREATE_PPTX make a short deck.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

    // The agent generated a .pptx and offered it as a download card.
    const card = sidebar.locator('.export-card', { hasText: '.pptx' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Download' })).toBeVisible();
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

  test('undo removes the last exchange and refills the composer', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    const undo = sidebar.getByRole('button', { name: /Undo last exchange/ });
    const input = sidebar.getByTestId('chat-input');

    // Nothing to undo on a fresh thread.
    await expect(undo).toBeDisabled();

    await sendChat(sidebar, 'first prompt please summarize.');
    await expect(sidebar.locator('.msg-user', { hasText: 'first prompt' })).toBeVisible();
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    await expect(undo).toBeEnabled();

    await undo.click();
    // The exchange is gone and the removed prompt is back in the composer.
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toHaveCount(0);
    await expect(sidebar.locator('.msg-user', { hasText: 'first prompt' })).toHaveCount(0);
    await expect(input).toHaveText('first prompt please summarize.');
    await expect(undo).toBeDisabled();
  });

  test('undo can be repeated back through multiple exchanges', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    const undo = sidebar.getByRole('button', { name: /Undo last exchange/ });

    await sendChat(sidebar, 'message one.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    await sendChat(sidebar, 'message two.');
    await expect(sidebar.locator('.msg-user', { hasText: 'message two' })).toBeVisible();

    await undo.click(); // removes exchange two
    await expect(sidebar.locator('.msg-user', { hasText: 'message two' })).toHaveCount(0);
    await expect(sidebar.locator('.msg-user', { hasText: 'message one' })).toBeVisible();
    await expect(undo).toBeEnabled();

    await undo.click(); // removes exchange one → empty thread
    await expect(sidebar.locator('.msg-user', { hasText: 'message one' })).toHaveCount(0);
    await expect(undo).toBeDisabled();
  });

  test('plan-execution guard nudges a task that answers over an unstarted plan', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    // The mock sets a 3-step plan, never works it, and tries to answer at 0/3.
    await sendChat(sidebar, 'PLAN_STALL summarize the strategy.');
    // The guard pushes it back once before accepting the final answer.
    await expect(sidebar.locator('.msg-notice', { hasText: 'plan still has unfinished steps' })).toBeVisible();
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

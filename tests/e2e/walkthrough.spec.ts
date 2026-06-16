// Usability walkthrough — drives each major workflow against the mock LLM and
// writes labelled screenshots used as evidence in
// docs/usability-heuristic-evaluation.md. Each test also asserts the surface
// renders, so this doubles as coverage. Screenshots regenerate on every run and
// are committed once as evidence.

import { expect, sendChat, test } from './fixtures';

const SHOTS = 'docs/usability/screenshots';
const PANEL = { width: 400, height: 820 }; // approximate side-panel dimensions

test.describe('walkthrough', () => {
  test('01 — first run auto-opens Settings; closing shows the no-model banner', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize(PANEL);
    await page.goto(`chrome-extension://${extensionId}/sidebar.html`);
    // Fresh context, no ba_settings → the app drops the user straight into the
    // (long) Settings overlay.
    await expect(page.locator('.settings-overlay')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-first-run-settings.png` });
    // Close it → the gated composer + the "no model" warn banner.
    await page.locator('.settings-card > .settings-header .icon-btn').click();
    await expect(page.locator('.banner-warn')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/02-no-model-banner.png` });
  });

  test('02 — configured empty chat', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await expect(sidebar.locator('.chat-empty')).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/03-empty-chat.png` });
  });

  test('03 — chat response from the mock model', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sendChat(sidebar, 'Please summarize the current page.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/04-chat-response.png` });
  });

  test('04 — approval prompt for a state-changing tool', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sendChat(sidebar, 'RUN_JS to read the document title.');
    await expect(sidebar.getByTestId('approval')).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/05-approval-prompt.png` });
  });

  test('05/06 — history overlay and the label picker', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    // Create a saved conversation so History has a row.
    await sendChat(sidebar, 'Please summarize the current page.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

    await sidebar.locator('.header-controls .icon-btn').first().click(); // History
    await expect(sidebar.locator('.settings-overlay')).toBeVisible();
    await expect(sidebar.locator('.conv-item').first()).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/06-history.png` });

    await sidebar.getByRole('button', { name: /labels/i }).first().click();
    await expect(sidebar.locator('.label-picker')).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/07-label-picker.png` });
  });

  test('07/08 — settings overlay (top and lower sections)', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sidebar.locator('.header-controls .icon-btn').last().click(); // Settings gear
    const card = sidebar.locator('.settings-card');
    await expect(card).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/08-settings-top.png` });

    // Scroll to the stacked sub-sections (Skills/Memory/Repos/Backup) to evidence
    // the single long modal.
    await card.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await sidebar.screenshot({ path: `${SHOTS}/09-settings-lower.png` });
  });
});

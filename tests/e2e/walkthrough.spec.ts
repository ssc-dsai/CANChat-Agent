// Usability walkthrough — drives each major workflow against the mock LLM and
// writes labelled screenshots used as evidence in
// docs/usability-heuristic-evaluation.md. Each test also asserts the surface
// renders, so this doubles as coverage. Screenshots regenerate on every run and
// are committed once as evidence.

import { expect, sendChat, test } from './fixtures';

const SHOTS = 'docs/usability/screenshots';
const PANEL = { width: 400, height: 820 }; // approximate side-panel dimensions

test.describe('walkthrough', () => {
  test('01 — first run shows the minimal onboarding (U2)', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize(PANEL);
    await page.goto(`chrome-extension://${extensionId}/sidebar.html`);
    // Fresh context, no ba_settings → a focused welcome with only the 3 required
    // fields, not the full settings modal.
    await expect(page.locator('.onboarding-card')).toBeVisible();
    await expect(page.locator('.onboarding-card .field')).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/01-first-run-onboarding.png` });

    // "Advanced setup" hands off to the full (tabbed) Settings; closing it then
    // shows the gated "no model" banner.
    await page.getByRole('button', { name: /advanced setup/i }).click();
    await expect(page.locator('.settings-tabs')).toBeVisible();
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

    // The per-row "assign labels" popover must not be clipped by the History
    // card's overflow (regression: it used to anchor right:0 and get cut off).
    await sidebar.keyboard.press('Escape');
    await expect(sidebar.locator('.label-picker')).toHaveCount(0);
    await sidebar.locator('.conv-tag-btn').first().click();
    const rowPicker = sidebar.locator('.label-picker');
    await expect(rowPicker).toBeVisible();
    const box = await rowPicker.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(PANEL.width + 1);
    await sidebar.screenshot({ path: `${SHOTS}/11-row-label-picker.png` });
  });

  test('09 — error banner offers plain guidance + Retry (U6)', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sendChat(sidebar, 'FORCE_ERROR to exercise the error path.');
    await expect(sidebar.locator('.banner-error')).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Retry' })).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/10-error-retry.png` });
  });

  test('07/08 — tabbed settings: Model tab and Data tab (U1)', async ({ sidebar }) => {
    await sidebar.setViewportSize(PANEL);
    await sidebar.locator('.header-controls .icon-btn').last().click(); // Settings gear
    await expect(sidebar.locator('.settings-tabs')).toBeVisible();
    // Default Model tab: only the three required fields above the fold.
    await expect(sidebar.locator('.settings-tab.is-active')).toHaveText('Model');
    await sidebar.screenshot({ path: `${SHOTS}/08-settings-model-tab.png` });

    // Data & privacy tab groups the formerly-stacked sub-sections.
    await sidebar.getByRole('tab', { name: 'Data & privacy' }).click();
    await expect(sidebar.getByText('Backup & Restore')).toBeVisible();
    await sidebar.screenshot({ path: `${SHOTS}/09-settings-data-tab.png` });
  });
});

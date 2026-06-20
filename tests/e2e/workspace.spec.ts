import { expect, test } from './fixtures';

// Exercises the full-tab workspace and, critically, the built-in DuckDB engine
// end-to-end inside the loaded extension — the path that was broken when the
// engine loaded its worker/wasm from a CDN (blocked by the MV3 CSP). If the
// local-asset + `wasm-unsafe-eval` fixes regress, the import/query below fail.

test('workspace DuckDB browser imports CSV and runs a query', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/workspace.html`);

  // Composer exists (the workspace is interactive, not a dead mirror).
  await expect(page.locator('.ws-composer-input')).toBeVisible();

  await page.getByRole('button', { name: 'Datasets' }).click();

  await page.getByPlaceholder('table name (e.g. vessels)').fill('ships');
  await page.getByPlaceholder('Paste CSV or JSON here…').fill('name,len\nAlpha,320\nBeta,150\n');
  await page.getByRole('button', { name: /^Import/ }).click();

  // First query compiles + runs wasm; give the engine room to spin up.
  await expect(page.locator('.ws-ds-table')).toContainText('Alpha', { timeout: 45_000 });
  await expect(page.locator('.ws-ds-table')).toContainText('320');

  // A real SQL query over the imported table.
  await page.locator('.ws-ds-sql').fill('SELECT COUNT(*) AS n FROM "ships"');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.locator('.ws-ds-table')).toContainText('2', { timeout: 20_000 });

  await page.close();
});

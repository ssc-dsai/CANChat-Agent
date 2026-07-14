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

test('workspace Memory page lists, edits, confirms, and deletes a node', async ({ serviceWorker, context, extensionId }) => {
  // Seed via the service worker (not the target page) and navigate directly to
  // the #memory hash in one go: a hash-only change on an already-open document
  // is a same-document navigation in Chrome — it does not remount the SPA, so
  // reading location.hash a second time after a bare-URL load never fires.
  const now = new Date().toISOString();
  await serviceWorker.evaluate(
    (iso) =>
      chrome.storage.local.set({
        ba_memory_graph: {
          version: 1,
          nodes: [
            {
              id: 'mem-test-1',
              kind: 'preference',
              label: 'Editor preference',
              summary: 'Prefers dark mode.',
              confidence: 0.9,
              durability: 0.8,
              status: 'active',
              createdAt: iso,
              updatedAt: iso,
              lastConfirmedAt: iso,
              provenance: [{ conversationId: 'c1', excerpt: 'I always use dark mode', at: iso }],
            },
          ],
          edges: [],
        },
      }),
    now,
  );
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/workspace.html#memory`);

  await expect(page.locator('.ws-memory-item', { hasText: 'Editor preference' })).toBeVisible();
  await page.locator('.ws-memory-item', { hasText: 'Editor preference' }).click();
  await expect(page.locator('.ws-memory-detail h2')).toHaveText('Editor preference');
  await expect(page.locator('.ws-memory-provenance')).toContainText('I always use dark mode');

  // Edit the summary and save.
  await page.locator('.ws-memory-detail textarea').fill('Prefers dark mode everywhere, including the terminal.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => {
    const g = (await page.evaluate(() => chrome.storage.local.get('ba_memory_graph'))) as {
      ba_memory_graph?: { nodes: { summary: string }[] };
    };
    return g.ba_memory_graph?.nodes[0]?.summary;
  }).toContain('terminal');

  // Confirm bumps lastConfirmedAt without changing status.
  await page.getByRole('button', { name: 'Confirm (refresh)' }).click();
  await expect.poll(async () => {
    const g = (await page.evaluate(() => chrome.storage.local.get('ba_memory_graph'))) as {
      ba_memory_graph?: { nodes: { lastConfirmedAt: string }[] };
    };
    return g.ba_memory_graph?.nodes[0]?.lastConfirmedAt;
  }).not.toBe(now);

  // Delete removes the node.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(async () => {
    const g = (await page.evaluate(() => chrome.storage.local.get('ba_memory_graph'))) as {
      ba_memory_graph?: { nodes: unknown[] };
    };
    return g.ba_memory_graph?.nodes.length;
  }).toBe(0);
  await expect(page.locator('.ws-memory-empty')).toBeVisible();

  await page.close();
});

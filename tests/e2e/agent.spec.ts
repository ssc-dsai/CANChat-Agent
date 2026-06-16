import { expect, openFixtureTab, sendChat, test } from './fixtures';

// Joins all `tool`-role message contents across the requests the mock received
// from index `start`, so we can assert what a read-only tool actually returned.
function toolResultsSince(requests: { messages: { role: string; content: unknown }[] }[], start: number): string {
  return requests
    .slice(start)
    .flatMap((r) => r.messages.filter((m) => m.role === 'tool'))
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

test.describe('agent loop (mock LLM)', () => {
  test('summarizes a page via the mock endpoint', async ({ sidebar, mockLlm }) => {
    const start = mockLlm.requests.length;
    await sendChat(sidebar, 'Please summarize the current page.');

    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    expect(mockLlm.requests.length).toBeGreaterThan(start); // a /chat/completions POST happened
  });

  test('read-only tool runs without an approval prompt', async ({ sidebar }) => {
    await sendChat(sidebar, 'INSPECT_TABS and tell me what is open.');

    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    // list_tabs is read-only — it must never have raised the approval card.
    await expect(sidebar.getByTestId('approval')).toHaveCount(0);
  });

  test('state-changing tool requires explicit approval', async ({ sidebar }) => {
    await sendChat(sidebar, 'RUN_JS to read the document title.');

    const approval = sidebar.getByTestId('approval');
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Deny' }).click();

    // After denial the loop resolves to a final answer (no in-page exec needed).
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
  });

  test('multiple open tabs are inspected via list_tabs', async ({ context, staticServer, sidebar, mockLlm }) => {
    await openFixtureTab(context, staticServer, 'article.html');
    await openFixtureTab(context, staticServer, 'table.html');

    const start = mockLlm.requests.length;
    await sendChat(sidebar, 'INSPECT_TABS across everything open.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

    const tools = toolResultsSince(mockLlm.requests, start);
    expect(tools).toContain('article.html');
    expect(tools).toContain('table.html');
  });
});

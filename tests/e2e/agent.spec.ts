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

  test('system prefix stays byte-stable across steps (prompt-cache friendly)', async ({ sidebar, mockLlm }) => {
    const start = mockLlm.requests.length;
    // PLAN_DEMO drives a multi-step task (set_plan + list_tabs, then a final
    // answer), so the loop makes several model calls within one task.
    await sendChat(sidebar, 'PLAN_DEMO summarize the open tabs.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

    // Only the main agent-loop requests carry the browser system prompt; the
    // reflection/summarizer/title calls have their own (different) system message.
    const mainReqs = mockLlm.requests
      .slice(start)
      .filter((r) => typeof r.messages[0]?.content === 'string'
        && (r.messages[0].content as string).includes('You are a browser agent'));

    expect(mainReqs.length).toBeGreaterThanOrEqual(2);
    const prefix = mainReqs[0].messages[0].content as string;
    // (a) the system prefix is identical on every step → the provider can cache it
    for (const r of mainReqs) expect(r.messages[0].content).toBe(prefix);
    // (b) the volatile working-state is NOT inside that prefix anymore...
    expect(prefix).not.toContain('=== Working state');
    // (c) ...it now arrives as a trailing system status message each step.
    for (const r of mainReqs) {
      const last = r.messages[r.messages.length - 1];
      expect(last.role).toBe('system');
      expect(typeof last.content === 'string' ? last.content : '').toContain('=== Working state');
    }
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

  test('restoring a conversation reopens the pages it used', async ({ context, staticServer, sidebar }) => {
    const url = `${staticServer.url}/article.html`;
    const opened = () => context.pages().filter((p) => p.url().includes('/article.html'));

    // The agent opens the page into this conversation's tab group.
    await sendChat(sidebar, `OPEN_TABS ${url}`);
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
    await expect.poll(() => opened().length).toBeGreaterThan(0);

    // Close it, so restore has to bring it back.
    await Promise.all(opened().map((p) => p.close()));
    await expect.poll(() => opened().length).toBe(0);

    // Restore the conversation from History.
    await sidebar.locator('.header-controls .icon-btn').first().click(); // History
    await sidebar.locator('.conv-item .conv-body').first().click();

    // The page is reopened and a notice confirms it.
    await expect(sidebar.locator('.msg-notice', { hasText: 'Reopened' })).toBeVisible();
    await expect.poll(() => opened().length).toBeGreaterThan(0);
  });

  test('map workspace: one persistent map the agent drives', async ({ context, sidebar, mockLlm }) => {
    const mapPages = () => context.pages().filter((p) => p.url().includes('/map.html'));

    const start = mockLlm.requests.length;
    // The agent sets the view (Ottawa, zoom 8), then drops a marker (Toronto) on
    // the SAME map, then answers.
    await sendChat(sidebar, 'MAP_DEMO show Ottawa then mark Toronto.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

    // Exactly one map tab exists — both commands reused it (singleton).
    await expect.poll(() => mapPages().length).toBe(1);

    // Read the map responses the agent received (the deterministic, in-band proof
    // the commands hit the one persistent map). The final state shows the Ottawa
    // zoom plus exactly one Toronto marker.
    const states = mockLlm.requests
      .slice(start)
      .flatMap((r) => r.messages.filter((m) => m.role === 'tool'))
      .map((m) => {
        try {
          return JSON.parse(typeof m.content === 'string' ? m.content : '') as {
            ok?: boolean;
            state?: { zoom: number; markers: Array<{ lat: number; lng: number }> };
          };
        } catch {
          return null;
        }
      })
      .filter((r): r is { ok?: boolean; state: { zoom: number; markers: Array<{ lat: number; lng: number }> } } => !!r?.state);

    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states.every((s) => s.ok)).toBe(true);
    const last = states[states.length - 1].state;
    expect(last.zoom).toBe(8);
    expect(last.markers).toHaveLength(1);
    expect(last.markers[0].lat).toBeCloseTo(43.65, 1);
  });

  test('reflection extracts a durable fact and the next turn answers from it', async ({ sidebar, mockLlm }) => {
    await sidebar.evaluate(() => chrome.storage.local.set({ ba_memory_enabled: true }));

    await sendChat(sidebar, 'REMEMBER_ME_DEMO: I always use dark mode. Please summarize the current page.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).last()).toBeVisible();

    // Reflection is fire-and-forget after the turn settles — poll storage for the
    // extracted node rather than assuming it landed before the assistant reply did.
    const graph = () =>
      sidebar.evaluate(
        () =>
          chrome.storage.local.get('ba_memory_graph').then((r) => (r as { ba_memory_graph?: { nodes: { summary: string }[] } }).ba_memory_graph),
      );
    await expect.poll(async () => (await graph())?.nodes.some((n) => n.summary.includes('dark mode')), { timeout: 15000 }).toBe(true);

    // A second, unrelated turn should see the fact in its (byte-stable) system
    // prefix — the core memory tier — without any new tool call being needed.
    const start = mockLlm.requests.length;
    const repliesBefore = await sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).count();
    await sendChat(sidebar, 'Please summarize the current page again.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toHaveCount(repliesBefore + 1);

    const mainReqs = mockLlm.requests
      .slice(start)
      .filter((r) => typeof r.messages[0]?.content === 'string' && (r.messages[0].content as string).includes('You are a browser agent'));
    expect(mainReqs.length).toBeGreaterThan(0);
    expect(mainReqs[0].messages[0].content as string).toContain('dark mode');
  });

  test('reflection extracts an entity from an article and cites its source', async ({ context, staticServer, sidebar, mockLlm }) => {
    await sidebar.evaluate(() => chrome.storage.local.set({ ba_memory_enabled: true }));
    await openFixtureTab(context, staticServer, 'article.html');

    await sendChat(sidebar, 'REMEMBER_ARTICLE_DEMO: read the current page and remember the key facts from it.');
    await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).last()).toBeVisible();

    const graph = () =>
      sidebar.evaluate(
        () =>
          chrome.storage.local.get('ba_memory_graph').then(
            (r) =>
              (r as { ba_memory_graph?: { nodes: { kind: string; summary: string; provenance: { sourceUrl?: string; sourceTitle?: string }[] }[] } })
                .ba_memory_graph,
          ),
      );
    await expect.poll(async () => (await graph())?.nodes.some((n) => n.kind === 'event' && n.summary.includes('Northwest Passage')), {
      timeout: 15000,
    }).toBe(true);

    const node = (await graph())?.nodes.find((n) => n.summary.includes('Northwest Passage'));
    expect(node?.provenance[0]?.sourceUrl).toContain(`${staticServer.url}/article.html`);
    expect(node?.provenance[0]?.sourceTitle).toBe('The Northwest Passage Reopens');
  });
});

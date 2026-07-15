import { expect, sendChat, test } from './fixtures';

// Model orchestration: a role mapped to a profile must route that role's
// background calls to the profile's model, while the main chat loop keeps
// using the top-level Settings model untouched — see
// llmProvider.ts resolveModelForRole and the ~13 call-site retagging in
// agentRuntime.ts.
test('reflection routes to the profile assigned to the reflection role, main loop stays on the default model', async ({ sidebar, mockLlm }) => {
  await sidebar.evaluate(async (baseUrl) => {
    const { ba_settings } = await chrome.storage.local.get('ba_settings');
    await chrome.storage.local.set({
      ba_settings: {
        ...(ba_settings as object),
        modelProfiles: [{ id: 'p1', name: 'Reflection model', baseUrl, apiKey: 'test-key', model: 'reflect-model' }],
        roleProfiles: { reflection: 'p1' },
      },
      ba_memory_enabled: true,
    });
  }, `${mockLlm.url}/v1`);

  const start = mockLlm.requests.length;
  await sendChat(sidebar, 'REMEMBER_ME_DEMO: I always use dark mode. Please summarize the current page.');
  await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).last()).toBeVisible();

  // Reflection is fire-and-forget after the turn settles — poll for the
  // request rather than assuming it landed before the assistant reply did.
  await expect.poll(() => mockLlm.requests.slice(start).some((r) => r.model === 'reflect-model'), { timeout: 15000 }).toBe(true);

  // The main agent-loop requests (identified by the browser-agent system
  // prompt) must never have been routed to the reflection profile's model.
  const mainReqs = mockLlm.requests
    .slice(start)
    .filter((r) => typeof r.messages[0]?.content === 'string' && (r.messages[0].content as string).includes('You are a browser agent'));
  expect(mainReqs.length).toBeGreaterThan(0);
  expect(mainReqs.every((r) => r.model === 'mock-model')).toBe(true);
});

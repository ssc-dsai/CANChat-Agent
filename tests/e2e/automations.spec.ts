import { expect, openFixtureTab, test } from './fixtures';

// Event triggers (Phase 6): opening a matching site fires an unattended run
// through the exact same AgentRuntime.runScheduledTask path a scheduled task
// uses — no new execution engine, only a new way to decide *when* an
// existing, already-approval-gated run happens.
test('an event trigger fires an unattended use_skill run when its site is opened', async ({
  context,
  staticServer,
  sidebar,
  mockLlm,
}) => {
  const host = new URL(staticServer.url).hostname;
  await sidebar.evaluate(
    (h) =>
      chrome.storage.local.set({
        ba_skills: [{ id: 'sk1', name: 'research', description: 'Research a topic', body: 'Do research.' }],
        ba_event_triggers: [
          {
            id: 'trig1',
            name: 'Watch fixture site',
            enabled: true,
            hostPattern: h,
            target: { kind: 'skill', name: 'research' },
            createdAt: new Date().toISOString(),
            cooldownMinutes: 60,
          },
        ],
      }),
    host,
  );

  const start = mockLlm.requests.length;
  await openFixtureTab(context, staticServer, 'article.html');

  // The trigger fires fire-and-forget from chrome.tabs.onUpdated; poll for it.
  await expect.poll(() => mockLlm.requests.slice(start).length > 0, { timeout: 15000 }).toBe(true);

  const mainReqs = mockLlm.requests
    .slice(start)
    .filter((r) => typeof r.messages[0]?.content === 'string' && (r.messages[0].content as string).includes('You are a browser agent'));
  expect(mainReqs.length).toBeGreaterThan(0);
  const lastUser = [...mainReqs[0].messages].reverse().find((m) => m.role === 'user');
  expect(typeof lastUser?.content === 'string' ? lastUser.content : '').toContain('Call use_skill for "research"');

  // lastFiredAt is stamped and a run is recorded.
  const trigger = () =>
    sidebar.evaluate(() => chrome.storage.local.get('ba_event_triggers').then((r) => (r.ba_event_triggers as { lastFiredAt?: string }[])?.[0]));
  await expect.poll(async () => Boolean((await trigger())?.lastFiredAt), { timeout: 15000 }).toBe(true);

  const runs = await sidebar.evaluate(() => chrome.storage.local.get('ba_trigger_runs').then((r) => r.ba_trigger_runs as { triggerId: string }[] | undefined));
  expect(runs?.some((r) => r.triggerId === 'trig1')).toBe(true);
});

test('a trigger inside its cooldown window does not refire', async ({ context, staticServer, sidebar, mockLlm }) => {
  const host = new URL(staticServer.url).hostname;
  await sidebar.evaluate(
    (h) =>
      chrome.storage.local.set({
        ba_skills: [{ id: 'sk1', name: 'research', description: 'Research a topic', body: 'Do research.' }],
        ba_event_triggers: [
          {
            id: 'trig1',
            name: 'Watch fixture site',
            enabled: true,
            hostPattern: h,
            target: { kind: 'skill', name: 'research' },
            createdAt: new Date().toISOString(),
            lastFiredAt: new Date().toISOString(), // just fired — inside the default 60min cooldown
            cooldownMinutes: 60,
          },
        ],
      }),
    host,
  );

  const start = mockLlm.requests.length;
  await openFixtureTab(context, staticServer, 'article.html');
  await sidebar.waitForTimeout(2000);
  expect(mockLlm.requests.length).toBe(start);
});

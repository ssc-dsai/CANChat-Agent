import { expect, sendChat, test } from './fixtures';

// save_as_skill (Phase 5): the agent can package the current task into a
// reusable skill mid-conversation, reusing the existing approval-gated tool
// loop rather than a new unattended sandbox — see agentRuntime.ts
// packageTaskAsSkill. Approval-gated like save_app_playbook.
test('save_as_skill is approval-gated and saves a versioned skill', async ({ sidebar }) => {
  await sendChat(sidebar, 'SAVE_SKILL_DEMO: please save this as a skill.');

  const approval = sidebar.getByTestId('approval');
  await expect(approval).toBeVisible();
  await approval.getByRole('button', { name: 'Approve' }).click();

  await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

  const skills = () =>
    sidebar.evaluate(() => chrome.storage.local.get('ba_skills').then((r) => r.ba_skills as { name: string; version?: string; source?: { kind: string } }[] | undefined));
  await expect.poll(async () => (await skills())?.some((s) => s.name === 'demo-skill'), { timeout: 10000 }).toBe(true);

  const saved = (await skills())!.find((s) => s.name === 'demo-skill')!;
  expect(saved.version).toBe('1.0.0');
  expect(saved.source?.kind).toBe('generated');
});

test('re-saving the same skill patch-bumps its version instead of duplicating', async ({ sidebar }) => {
  const now = new Date().toISOString();
  await sidebar.evaluate(
    (iso) =>
      chrome.storage.local.set({
        ba_skills: [
          { id: 'skill-existing', name: 'demo-skill', description: 'Old version', body: 'Old steps', version: '1.0.0', source: { kind: 'generated', installedAt: iso } },
        ],
      }),
    now,
  );

  await sendChat(sidebar, 'SAVE_SKILL_DEMO: please save this as a skill.');
  const approval = sidebar.getByTestId('approval');
  await expect(approval).toBeVisible();
  await approval.getByRole('button', { name: 'Approve' }).click();
  await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

  const skills = () =>
    sidebar.evaluate(() => chrome.storage.local.get('ba_skills').then((r) => r.ba_skills as { name: string; version?: string }[] | undefined));
  await expect.poll(async () => (await skills())?.find((s) => s.name === 'demo-skill')?.version, { timeout: 10000 }).toBe('1.0.1');
  await expect.poll(async () => (await skills())?.length, { timeout: 10000 }).toBe(1); // updated, not duplicated
});

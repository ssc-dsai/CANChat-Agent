import { expect, sendChat, test } from './fixtures';

// The core risk flagged for the Projects phase: switching the active project
// must never leak another project's durable memory into the system prompt.
// Scoping is a filter (unset projectId = global, visible everywhere), not a
// hard partition — see shared/memoryGraph.ts visibleToProject.
test('active project scopes memory into the system prompt without leaking another project', async ({ sidebar, mockLlm }) => {
  const now = new Date().toISOString();
  await sidebar.evaluate(async (iso) => {
    // Route the memory index's embedding calls at the mock's /embeddings stub
    // (fast, deterministic) instead of the on-device transformers.js embedder,
    // which has nothing to do with project scoping.
    const { ba_settings } = await chrome.storage.local.get('ba_settings');
    await chrome.storage.local.set({
      ba_settings: { ...(ba_settings as object), embedder: 'external' },
      ba_memory_enabled: true,
      ba_projects: [
        { id: 'proj-a', name: 'Project A', createdAt: iso },
        { id: 'proj-b', name: 'Project B', createdAt: iso },
      ],
      ba_active_project: 'proj-a',
      ba_memory_graph: {
        version: 1,
        nodes: [
          {
            id: 'mem-global',
            kind: 'fact',
            label: 'Global fact',
            summary: 'The user likes concise answers.',
            confidence: 0.9,
            durability: 0.9,
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
            lastConfirmedAt: iso,
            provenance: [],
          },
          {
            id: 'mem-a',
            kind: 'fact',
            label: 'Project A fact',
            summary: 'Project A budget is 500k.',
            confidence: 0.9,
            durability: 0.9,
            status: 'active',
            projectId: 'proj-a',
            createdAt: iso,
            updatedAt: iso,
            lastConfirmedAt: iso,
            provenance: [],
          },
          {
            id: 'mem-b',
            kind: 'fact',
            label: 'Project B fact',
            summary: 'Project B secret codename is Falcon.',
            confidence: 0.9,
            durability: 0.9,
            status: 'active',
            projectId: 'proj-b',
            createdAt: iso,
            updatedAt: iso,
            lastConfirmedAt: iso,
            provenance: [],
          },
        ],
        edges: [],
      },
    });
  }, now);

  const start = mockLlm.requests.length;
  await sendChat(sidebar, 'Please summarize the current page.');
  await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();

  const mainReqs = mockLlm.requests
    .slice(start)
    .filter((r) => typeof r.messages[0]?.content === 'string' && (r.messages[0].content as string).includes('You are a browser agent'));
  expect(mainReqs.length).toBeGreaterThan(0);
  const systemPrompt = mainReqs[0].messages[0].content as string;

  // Global and project A facts are visible under the active project (A)...
  expect(systemPrompt).toContain('Project A budget is 500k');
  expect(systemPrompt).toContain('The user likes concise answers');
  // ...but project B's fact must never appear anywhere in the request.
  const fullRequest = JSON.stringify(mainReqs[0]);
  expect(fullRequest).not.toContain('Falcon');
});

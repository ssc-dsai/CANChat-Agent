import { expect, openFixtureTab, test } from './fixtures';

test.describe('WebMCP', () => {
  test('the bridge captures a tool the page registers', async ({ context, staticServer }) => {
    const page = await openFixtureTab(context, staticServer, 'webmcp.html');
    await expect(page.locator('#status')).toHaveText('registered');

    // The MAIN-world bridge records page registrations into this page global,
    // which is exactly what the extension reads via executeScript at runtime.
    const tools = await page.evaluate(() => {
      const reg = (window as unknown as { __CANAGENT_WEBMCP__?: { tools: Map<string, unknown> } }).__CANAGENT_WEBMCP__;
      return reg ? [...reg.tools.keys()] : [];
    });
    expect(tools).toContain('echo');
  });
});

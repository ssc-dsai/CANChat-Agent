// Scene library for the automated demo recording. Each scene drives ONE
// recorded page (Playwright records a video per page, so scenes navigate that
// page between surfaces rather than opening new tabs; auxiliary tabs are
// allowed but their videos are discarded by record.ts).
//
// All model traffic goes to the deterministic mock LLM from the e2e harness,
// so every take is identical and no key is spent. Pacing is explicit: pace()
// beats between actions, typeSlowly() for visible typing, and every click goes
// through the fake-cursor overlay so viewers can follow the pointer.

import type { BrowserContext, Locator, Page } from '@playwright/test';
import { installCursor, moveClick, moveTo } from './cursor.ts';

export interface SceneCtx {
  context: BrowserContext;
  extensionId: string;
  /** Mock LLM base (append /v1 for the endpoint field). */
  mockBase: string;
  staticBase: string;
  /** The recorded page. */
  page: Page;
}

export interface SceneSpec {
  id: string;
  viewport: { width: number; height: number };
  run: (ctx: SceneCtx) => Promise<void>;
}

const pace = (page: Page, ms: number) => page.waitForTimeout(ms);

async function typeSlowly(page: Page, target: Locator, text: string, delay = 42): Promise<void> {
  await moveClick(page, target);
  await target.pressSequentially(text, { delay });
}

/** Write the model settings into extension storage (must run on an extension page). */
async function seedModel(page: Page, mockBase: string): Promise<void> {
  await page.evaluate((baseUrl) => {
    return chrome.storage.local.set({
      ba_settings: { baseUrl, apiKey: 'demo-key', model: 'mock-model' },
    });
  }, `${mockBase}/v1`);
}

async function gotoSidebar(ctx: SceneCtx, opts: { seed?: boolean } = {}): Promise<void> {
  const { page, extensionId, mockBase } = ctx;
  await page.goto(`chrome-extension://${extensionId}/sidebar.html`);
  if (opts.seed !== false) {
    await seedModel(page, mockBase);
    await page.reload();
  }
  await installCursor(page);
}

async function sendDemo(ctx: SceneCtx, text: string): Promise<void> {
  const { page } = ctx;
  await typeSlowly(page, page.getByTestId('chat-input'), text);
  await pace(page, 500);
  await moveClick(page, page.getByTestId('send'));
}

/** Full-screen branded card (title / outro) rendered from a data: URL. */
async function showCard(page: Page, heading: string, sub: string): Promise<void> {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1c1726 0%,#2a1f38 55%,#3a1f4e 100%);font-family:system-ui,-apple-system,sans-serif">
  <div style="text-align:center;max-width:820px;padding:0 40px">
    <div style="font-size:56px;font-weight:800;letter-spacing:-0.02em;background:linear-gradient(135deg,#c887e8 0%,#e86ac9 100%);-webkit-background-clip:text;background-clip:text;color:transparent">${heading}</div>
    <div style="margin-top:18px;font-size:22px;line-height:1.5;color:#cfc4dd">${sub}</div>
  </div></body>`;
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
}

export const sceneSpecs: SceneSpec[] = [
  {
    id: 'title',
    viewport: { width: 1280, height: 800 },
    run: async ({ page }) => {
      await showCard(page, 'CANChat Agent', 'An AI agent in your browser’s side panel — your tabs, your session, your data.');
      await pace(page, 5000);
    },
  },

  {
    id: 'onboarding',
    viewport: { width: 480, height: 800 },
    run: async (ctx) => {
      await gotoSidebar(ctx, { seed: false });
      const { page, mockBase } = ctx;
      const card = page.locator('.onboarding-card');
      await card.waitFor();
      await pace(page, 1600);
      const fields = card.locator('.field input');
      await typeSlowly(page, fields.nth(0), `${mockBase}/v1`, 24);
      await typeSlowly(page, fields.nth(1), 'sk-demo-key', 30);
      await typeSlowly(page, fields.nth(2), 'mock-model', 30);
      await pace(page, 400);
      await moveClick(page, card.getByRole('button', { name: 'Test connection' }));
      await page.locator('.banner-ok').waitFor();
      await pace(page, 1400);
      await moveClick(page, card.getByRole('button', { name: /Save & start/i }));
      await page.locator('.chat-empty').waitFor();
      await pace(page, 1800);
    },
  },

  {
    id: 'summarize',
    viewport: { width: 480, height: 800 },
    run: async (ctx) => {
      // A real article tab exists in the background so the context feels live.
      const article = await ctx.context.newPage();
      await article.goto(`${ctx.staticBase}/article.html`);
      await gotoSidebar(ctx);
      await pace(ctx.page, 1200);
      await sendDemo(ctx, 'Please summarize the current page.');
      await ctx.page.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 900);
      await moveTo(ctx.page, ctx.page.locator('.msg-assistant button', { hasText: 'Copy' }).first());
      await pace(ctx.page, 1800);
      await article.close();
    },
  },

  {
    id: 'plan',
    viewport: { width: 480, height: 800 },
    run: async (ctx) => {
      await gotoSidebar(ctx);
      await sendDemo(ctx, 'PLAN_DEMO: research this topic and summarize what you find.');
      await ctx.page.locator('.plan-panel').waitFor();
      await pace(ctx.page, 1200);
      await ctx.page.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 900);
      await moveClick(ctx.page, ctx.page.locator('.activity-toggle'));
      await ctx.page.locator('.activity-list').waitFor();
      await pace(ctx.page, 2600);
    },
  },

  {
    id: 'approval',
    viewport: { width: 480, height: 800 },
    run: async (ctx) => {
      await gotoSidebar(ctx);
      await sendDemo(ctx, 'RUN_JS to read the document title.');
      const approval = ctx.page.getByTestId('approval');
      await approval.waitFor();
      await pace(ctx.page, 3200); // let the viewer read the reason
      await moveClick(ctx.page, approval.getByRole('button', { name: 'Approve' }));
      await ctx.page.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 1600);
    },
  },

  {
    id: 'knowledge',
    viewport: { width: 1280, height: 800 },
    run: async (ctx) => {
      const { page, extensionId } = ctx;
      await page.goto(`chrome-extension://${extensionId}/workspace.html#knowledge`);
      await seedModel(page, ctx.mockBase);
      await page.reload();
      await installCursor(page);
      await pace(page, 1200);
      await moveClick(page, page.locator('.repo-upload-toggle'));
      await typeSlowly(page, page.locator('.repo-upload input[type="text"]'), 'demo notes', 40);
      await page.locator('.repo-drop input[type="file"]').setInputFiles({
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('A short note about arctic shipping lanes for the demo recording.'),
      });
      await page.locator('.repo-file', { hasText: 'note.txt' }).waitFor();
      await pace(page, 700);
      await moveClick(page, page.getByRole('button', { name: 'Add files', exact: true }));
      await page.locator('.upload-banner').waitFor();
      await pace(page, 1800);

      // Back to the panel: the # mention flyout referencing the new base.
      await page.goto(`chrome-extension://${extensionId}/sidebar.html`);
      await installCursor(page);
      const input = page.getByTestId('chat-input');
      await typeSlowly(page, input, 'What do my notes say? ', 40);
      await input.pressSequentially('#', { delay: 60 });
      await page.locator('.mention-menu, [data-testid="mention-menu"], .hint-menu').first().waitFor({ timeout: 4000 }).catch(() => {});
      await pace(page, 1800);
      await page.keyboard.press('Enter').catch(() => {});
      await pace(page, 1400);
    },
  },

  {
    id: 'history',
    viewport: { width: 480, height: 800 },
    run: async (ctx) => {
      await gotoSidebar(ctx);
      await sendDemo(ctx, 'Please summarize the current page.');
      await ctx.page.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 600);
      await moveClick(ctx.page, ctx.page.locator('.header-controls .icon-btn').first()); // History
      await ctx.page.locator('.conv-item').first().waitFor();
      await pace(ctx.page, 2600);
      await moveClick(ctx.page, ctx.page.locator('.settings-header .icon-btn')); // close
      await pace(ctx.page, 600);
      // The ⋯ More menu: text size, save, undo, learn.
      await moveClick(ctx.page, ctx.page.getByRole('button', { name: 'More actions' }));
      await ctx.page.getByRole('menu').waitFor();
      await pace(ctx.page, 1200);
      const menu = ctx.page.getByRole('menu');
      await moveClick(ctx.page, menu.getByRole('button', { name: 'Larger text' }));
      await pace(ctx.page, 700);
      await moveClick(ctx.page, ctx.page.getByRole('menu').getByRole('button', { name: 'Reset text size' }));
      await pace(ctx.page, 1600);
      await ctx.page.keyboard.press('Escape');
      await moveTo(ctx.page, ctx.page.getByRole('button', { name: /New chat/i }));
      await pace(ctx.page, 1400);
    },
  },

  {
    id: 'skills',
    viewport: { width: 1280, height: 800 },
    run: async (ctx) => {
      const { page, extensionId } = ctx;
      await page.goto(`chrome-extension://${extensionId}/workspace.html#skills`);
      await seedModel(page, ctx.mockBase);
      await page.reload();
      await installCursor(page);
      await page.getByText('/research').waitFor();
      await pace(page, 3200);
      // Slash-command autocomplete in the panel composer.
      await page.goto(`chrome-extension://${extensionId}/sidebar.html`);
      await installCursor(page);
      const input = page.getByTestId('chat-input');
      await typeSlowly(page, input, '/res', 90);
      await pace(page, 2400);
      await page.keyboard.press('Escape');
      await pace(page, 800);
    },
  },

  {
    id: 'workspace',
    viewport: { width: 1280, height: 800 },
    run: async (ctx) => {
      const { page, extensionId } = ctx;
      const t = Date.now();
      await page.goto(`chrome-extension://${extensionId}/workspace.html#models`);
      await seedModel(page, ctx.mockBase);
      // Seed automations + a product so those pages look lived-in.
      await page.evaluate((now) => {
        return Promise.all([
          chrome.storage.local.set({
            ba_skills: [{ id: 'sk1', name: 'research', description: 'Research a topic', body: 'Do research.' }],
            ba_scheduled_tasks: [
              { id: 't1', title: 'Morning news brief', prompt: 'Summarize headlines', schedule: 'daily 08:00', enabled: true, nextRunAt: now + 3600e3, lastRunAt: now - 82800e3, lastStatus: 'ok', createdAt: new Date(now - 6 * 86400e3).toISOString() },
            ],
            ba_scheduled_runs: [
              { id: 'r1', taskId: 't1', startedAt: now - 82800e3, status: 'ok', summary: 'Summarized 12 headlines from 4 sources; nothing urgent flagged.' },
              { id: 'r3', taskId: 't1', startedAt: now - 169200e3, status: 'ok', summary: 'Generated the morning digest.', fileArtifactNames: ['digest-monday.docx'] },
            ],
            ba_event_triggers: [
              { id: 'g1', name: 'Watch Jira board', enabled: true, hostPattern: 'jira.example.com', matchSubPages: true, target: { kind: 'skill', name: 'research' }, cooldownMinutes: 60, lastFiredAt: now - 7200e3, createdAt: new Date().toISOString() },
            ],
          }),
          chrome.runtime.sendMessage({
            type: 'products_import',
            products: [
              { meta: { id: 'p1', filename: 'digest-monday.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createdAt: new Date(now - 86400e3).toISOString(), sizeBytes: 48213, sourceTitle: 'Morning news brief' }, dataB64: btoa('demo') },
            ],
          }),
        ]);
      }, t);
      await page.reload();
      await installCursor(page);
      await page.getByTestId('advanced-settings').waitFor();
      await pace(page, 2000);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 520);
        await pace(page, 1300);
      }
      await moveClick(page, page.getByRole('button', { name: 'Memory' }));
      await pace(page, 2400);
      await moveClick(page, page.getByRole('button', { name: 'Automations' }));
      await page.locator('.ws-item').first().waitFor();
      await pace(page, 3000);
      await moveClick(page, page.getByRole('button', { name: 'Products' }));
      await page.locator('.ws-item', { hasText: 'digest-monday.docx' }).waitFor();
      await moveTo(page, page.getByRole('button', { name: 'Download' }).first());
      await pace(page, 2400);
    },
  },

  {
    id: 'documents',
    viewport: { width: 480, height: 800 },
    run: async (ctx) => {
      await gotoSidebar(ctx);
      await sendDemo(ctx, 'CREATE_PPTX make a short deck about the quarterly review.');
      const card = ctx.page.locator('.export-card', { hasText: '.pptx' });
      await card.waitFor();
      await pace(ctx.page, 800);
      await moveTo(ctx.page, card.getByRole('button', { name: 'Download' }));
      await pace(ctx.page, 2200);
    },
  },

  {
    id: 'resilience',
    viewport: { width: 480, height: 800 },
    run: async (ctx) => {
      await gotoSidebar(ctx);
      await sendDemo(ctx, 'RATE_LIMIT please summarize the page.');
      await ctx.page.locator('.msg-notice', { hasText: 'retrying' }).waitFor();
      await pace(ctx.page, 1000);
      await ctx.page.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 2000);
    },
  },

  {
    id: 'outro',
    viewport: { width: 1280, height: 800 },
    run: async ({ page }) => {
      await showCard(page, 'CANChat Agent', 'On-device by design. Approval-gated by default.<br><br><span style="font-size:18px;color:#9d8fb3">github.com/ssc-dsai/CANChat-Agent</span>');
      await pace(page, 5000);
    },
  },
];

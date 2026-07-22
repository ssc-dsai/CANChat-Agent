// Scene library for the automated demo recording.
//
// Every scene plays out on the STAGE (stage.html, copied into dist/ by
// record.ts): an extension page that draws a realistic browser frame — tab
// strip, URL bar — around a live "website" iframe, with the real side panel
// (sidebar.html) in an iframe beside it. Recording the stage gives the viewer
// the full picture the narration describes: the page on the left, the agent on
// the right. The stage mirrors the browser's real tabs into its fake tab strip
// (chrome.tabs), so tabs the agent opens become visible.
//
// One recorded page per scene (Playwright records per page); the stage page IS
// that page, and scenes navigate it between stage configurations. All model
// traffic goes to the deterministic mock LLM, so takes are identical. Pacing
// is explicit (pace beats, keystroke typing, fake-cursor glides); record.ts
// additionally time-stretches each scene's video to span its narration.

import type { BrowserContext, FrameLocator, Locator, Page, Worker } from '@playwright/test';
import { installCursor, moveClick, moveTo } from './cursor.ts';

export interface SceneCtx {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  /** Mock LLM base (append /v1 for the endpoint field). */
  mockBase: string;
  staticBase: string;
  /** The recorded page (hosts the stage). */
  page: Page;
}

export interface SceneSpec {
  id: string;
  viewport: { width: number; height: number };
  run: (ctx: SceneCtx) => Promise<void>;
}

const VIEW = { width: 1280, height: 800 };

const pace = (page: Page, ms: number) => page.waitForTimeout(ms);

async function typeSlowly(page: Page, target: Locator, text: string, delay = 42): Promise<void> {
  await moveClick(page, target);
  await target.pressSequentially(text, { delay });
}

/** Seed the model connection straight through the service worker's storage. */
function seedModel(ctx: SceneCtx): Promise<void> {
  return ctx.serviceWorker.evaluate((baseUrl) => {
    return chrome.storage.local.set({
      ba_settings: { baseUrl, apiKey: 'demo-key', model: 'mock-model' },
    });
  }, `${ctx.mockBase}/v1`) as Promise<void>;
}

interface StageOpts {
  /** URL for the "website" iframe — http(s) or a dist-relative extension page. */
  web: string;
  panel?: boolean;
  title?: string;
}

/** Navigate the recorded page to a stage configuration; returns frame handles. */
async function openStage(ctx: SceneCtx, opts: StageOpts): Promise<{ web: FrameLocator; panel: FrameLocator }> {
  const q = new URLSearchParams({
    web: opts.web,
    panel: opts.panel === false ? '0' : '1',
    title: opts.title ?? 'The Northwest Passage Reopens',
  });
  await ctx.page.goto(`chrome-extension://${ctx.extensionId}/stage.html?${q.toString()}`);
  await installCursor(ctx.page);
  return {
    web: ctx.page.frameLocator('#web-frame'),
    panel: ctx.page.frameLocator('#panel-frame'),
  };
}

async function sendDemo(ctx: SceneCtx, panel: FrameLocator, text: string): Promise<void> {
  await typeSlowly(ctx.page, panel.getByTestId('chat-input'), text);
  await pace(ctx.page, 500);
  await moveClick(ctx.page, panel.getByTestId('send'));
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
    viewport: VIEW,
    run: async ({ page }) => {
      await showCard(page, 'CANChat Agent', 'An AI agent in your browser’s side panel — your tabs, your session, your data.');
      await pace(page, 5000);
    },
  },

  {
    id: 'onboarding',
    viewport: VIEW,
    run: async (ctx) => {
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      const page = ctx.page;
      const card = panel.locator('.onboarding-card');
      await card.waitFor();
      await pace(page, 2000);
      const fields = card.locator('.field input');
      await typeSlowly(page, fields.nth(0), `${ctx.mockBase}/v1`, 24);
      await typeSlowly(page, fields.nth(1), 'sk-demo-key', 30);
      await typeSlowly(page, fields.nth(2), 'mock-model', 30);
      await pace(page, 500);
      await moveClick(page, card.getByRole('button', { name: 'Test connection' }));
      await panel.locator('.banner-ok').waitFor();
      await pace(page, 1800);
      await moveClick(page, card.getByRole('button', { name: /Save & start/i }));
      await panel.locator('.chat-empty').waitFor();
      await pace(page, 2200);
    },
  },

  {
    id: 'summarize',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      await pace(ctx.page, 1600);
      await sendDemo(ctx, panel, 'Please summarize the current page.');
      await panel.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 1200);
      await moveTo(ctx.page, panel.locator('.msg-assistant button', { hasText: 'Copy' }).first());
      await pace(ctx.page, 2200);
    },
  },

  {
    id: 'plan',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      await sendDemo(ctx, panel, 'PLAN_DEMO: research this topic and summarize what you find.');
      await panel.locator('.plan-panel').waitFor();
      await pace(ctx.page, 1600);
      await panel.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 1200);
      await moveClick(ctx.page, panel.locator('.activity-toggle'));
      await panel.locator('.activity-list').waitFor();
      await pace(ctx.page, 3000);
    },
  },

  {
    id: 'approval',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      await sendDemo(ctx, panel, 'RUN_JS to read the document title.');
      const approval = panel.getByTestId('approval');
      await approval.waitFor();
      await pace(ctx.page, 4200); // let the viewer read the reason
      await moveClick(ctx.page, approval.getByRole('button', { name: 'Approve' }));
      await panel.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 2000);
    },
  },

  {
    id: 'knowledge',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { web } = await openStage(ctx, { web: 'workspace.html#knowledge', panel: false, title: 'CANChat Agent — Workspace' });
      const page = ctx.page;
      await pace(page, 1600);
      await moveClick(page, web.locator('.repo-upload-toggle'));
      await typeSlowly(page, web.locator('.repo-upload input[type="text"]'), 'demo notes', 40);
      await web.locator('.repo-drop input[type="file"]').setInputFiles({
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('A short note about arctic shipping lanes for the demo recording.'),
      });
      await web.locator('.repo-file', { hasText: 'note.txt' }).waitFor();
      await pace(page, 800);
      await moveClick(page, web.getByRole('button', { name: 'Add files', exact: true }));
      await web.locator('.upload-banner').waitFor();
      await pace(page, 2200);

      // Back to the panel beside the article: the # mention flyout.
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      const input = panel.getByTestId('chat-input');
      await typeSlowly(page, input, 'What do my notes say? ', 40);
      await input.pressSequentially('#', { delay: 60 });
      await pace(page, 2200);
      await page.keyboard.press('Enter').catch(() => {});
      await pace(page, 2000);
    },
  },

  {
    id: 'history',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      await sendDemo(ctx, panel, 'Please summarize the current page.');
      await panel.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 800);
      await moveClick(ctx.page, panel.locator('.header-controls .icon-btn').first()); // History
      await panel.locator('.conv-item').first().waitFor();
      await pace(ctx.page, 3200);
      await moveClick(ctx.page, panel.locator('.settings-header .icon-btn')); // close
      await pace(ctx.page, 800);
      await moveClick(ctx.page, panel.getByRole('button', { name: 'More actions' }));
      await panel.getByRole('menu').waitFor();
      await pace(ctx.page, 1600);
      await moveClick(ctx.page, panel.getByRole('menu').getByRole('button', { name: 'Larger text' }));
      await pace(ctx.page, 900);
      await moveClick(ctx.page, panel.getByRole('menu').getByRole('button', { name: 'Reset text size' }));
      await pace(ctx.page, 2000);
      await ctx.page.keyboard.press('Escape');
      await moveTo(ctx.page, panel.getByRole('button', { name: /New chat/i }));
      await pace(ctx.page, 1800);
    },
  },

  {
    id: 'skills',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { web } = await openStage(ctx, { web: 'workspace.html#skills', panel: false, title: 'CANChat Agent — Workspace' });
      await web.getByText('/research').waitFor();
      await pace(ctx.page, 3600);
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      await typeSlowly(ctx.page, panel.getByTestId('chat-input'), '/res', 90);
      await pace(ctx.page, 2800);
      await ctx.page.keyboard.press('Escape');
      await pace(ctx.page, 1000);
    },
  },

  {
    id: 'workspace',
    viewport: VIEW,
    run: async (ctx) => {
      const now = Date.now();
      await seedModel(ctx);
      await ctx.serviceWorker.evaluate((t) => {
        return chrome.storage.local.set({
          ba_skills: [{ id: 'sk1', name: 'research', description: 'Research a topic', body: 'Do research.' }],
          ba_scheduled_tasks: [
            { id: 't1', title: 'Morning news brief', prompt: 'Summarize headlines', schedule: 'daily 08:00', enabled: true, nextRunAt: t + 3600e3, lastRunAt: t - 82800e3, lastStatus: 'ok', createdAt: new Date(t - 6 * 86400e3).toISOString() },
          ],
          ba_scheduled_runs: [
            { id: 'r1', taskId: 't1', startedAt: t - 82800e3, status: 'ok', summary: 'Summarized 12 headlines from 4 sources; nothing urgent flagged.' },
            { id: 'r3', taskId: 't1', startedAt: t - 169200e3, status: 'ok', summary: 'Generated the morning digest.', fileArtifactNames: ['digest-monday.docx'] },
          ],
          ba_event_triggers: [
            { id: 'g1', name: 'Watch Jira board', enabled: true, hostPattern: 'jira.example.com', matchSubPages: true, target: { kind: 'skill', name: 'research' }, cooldownMinutes: 60, lastFiredAt: t - 7200e3, createdAt: new Date().toISOString() },
          ],
        });
      }, now);
      const { web } = await openStage(ctx, { web: 'workspace.html#models', panel: false, title: 'CANChat Agent — Workspace' });
      // Seed a generated product through the worker's message route.
      await ctx.page.evaluate((t) => {
        return chrome.runtime.sendMessage({
          type: 'products_import',
          products: [
            { meta: { id: 'p1', filename: 'digest-monday.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createdAt: new Date(t - 86400e3).toISOString(), sizeBytes: 48213, sourceTitle: 'Morning news brief' }, dataB64: btoa('demo') },
          ],
        });
      }, now);
      await web.getByTestId('advanced-settings').waitFor();
      await pace(ctx.page, 2400);
      // Scroll the console (real mouse must hover the iframe for wheel events).
      await ctx.page.mouse.move(620, 420);
      for (let i = 0; i < 3; i++) {
        await ctx.page.mouse.wheel(0, 520);
        await pace(ctx.page, 1500);
      }
      await moveClick(ctx.page, web.getByRole('button', { name: 'Memory' }));
      await pace(ctx.page, 2800);
      await moveClick(ctx.page, web.getByRole('button', { name: 'Automations' }));
      await web.locator('.ws-item').first().waitFor();
      await pace(ctx.page, 3400);
      await moveClick(ctx.page, web.getByRole('button', { name: 'Products' }));
      await web.locator('.ws-item', { hasText: 'digest-monday.docx' }).waitFor();
      await moveTo(ctx.page, web.getByRole('button', { name: 'Download' }).first());
      await pace(ctx.page, 2800);
    },
  },

  {
    id: 'documents',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      await sendDemo(ctx, panel, 'CREATE_PPTX make a short deck about the quarterly review.');
      const card = panel.locator('.export-card', { hasText: '.pptx' });
      await card.waitFor();
      await pace(ctx.page, 1000);
      await moveTo(ctx.page, card.getByRole('button', { name: 'Download' }));
      await pace(ctx.page, 2600);
    },
  },

  {
    id: 'resilience',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: `${ctx.staticBase}/article.html` });
      await sendDemo(ctx, panel, 'RATE_LIMIT please summarize the page.');
      await panel.locator('.msg-notice', { hasText: 'retrying' }).waitFor();
      await pace(ctx.page, 1400);
      await panel.locator('.msg-assistant', { hasText: 'SUMMARY_OK' }).waitFor();
      await pace(ctx.page, 2400);
    },
  },

  {
    id: 'outro',
    viewport: VIEW,
    run: async ({ page }) => {
      await showCard(page, 'CANChat Agent', 'On-device by design. Approval-gated by default.<br><br><span style="font-size:18px;color:#9d8fb3">github.com/ssc-dsai/CANChat-Agent</span>');
      await pace(page, 5000);
    },
  },
];

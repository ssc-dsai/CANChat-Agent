// Scene library for the automated demo recording (v3: live pages + beat marks).
//
// Scenes play on the STAGE (stage.html): an extension page drawing a browser
// frame — tab strip mirroring the REAL chrome.tabs, URL bar — around a live
// website iframe, with the real side panel beside it. Sites shown are real
// (Wikipedia / Government of Canada pages; a recording-session DNR rule strips
// framing headers). The agent's brain is scripts/demo/demoLlm.ts: scripted but
// REALISTIC responses whose tool calls genuinely execute (open_url opens real
// tabs; search_repo really searches the uploaded note).
//
// SYNC CONTRACT: narration.ts anchors each narration beat to a mark name;
// scenes call mark(ctx, name) at the exact moment that beat's subject appears.
// record.ts cuts the footage at the marks and pads each chunk to its beat's
// audio, so voice and action stay locked together.

import type { BrowserContext, FrameLocator, Locator, Page, Worker } from '@playwright/test';
import { installCursor, moveClick, moveTo } from './cursor.ts';
import type { DemoLang } from './narration.ts';

const LIVE_BY_LANG = {
  en: {
    rideau: 'https://en.wikipedia.org/wiki/Rideau_Canal',
    rideauTitle: 'Rideau Canal — Wikipedia',
    parliament: 'https://en.wikipedia.org/wiki/Parliament_Hill',
    parliamentTitle: 'Parliament Hill — Wikipedia',
    benefits: 'https://www.canada.ca/en/services/benefits.html',
    benefitsTitle: 'Benefits — Canada.ca',
    park: 'https://en.wikipedia.org/wiki/Major%27s_Hill_Park',
    parkTitle: 'Major’s Hill Park — Wikipedia',
    workspaceTitle: 'CANChat Agent — Workspace',
  },
  fr: {
    rideau: 'https://fr.wikipedia.org/wiki/Canal_Rideau',
    rideauTitle: 'Canal Rideau — Wikipédia',
    parliament: 'https://fr.wikipedia.org/wiki/Colline_du_Parlement',
    parliamentTitle: 'Colline du Parlement — Wikipédia',
    benefits: 'https://www.canada.ca/fr/services/prestations.html',
    benefitsTitle: 'Prestations — Canada.ca',
    park: 'https://fr.wikipedia.org/wiki/Parc_de_la_Gatineau',
    parkTitle: 'Parc de la Gatineau — Wikipédia',
    workspaceTitle: 'CANChat Agent — Espace de travail',
  },
} as const;

/** UI labels the scenes click, per interface language (the extension renders
 *  its chrome from ba_language, so locator names must match). */
const UI_BY_LANG = {
  en: {
    testConnection: 'Test connection',
    saveStart: /Save & start/i,
    approve: 'Approve',
    addFiles: 'Add files',
    more: 'More actions',
    larger: 'Larger text',
    resetText: 'Reset text size',
    newChat: /New chat/i,
    memory: 'Memory',
    automations: 'Automations',
    products: 'Products',
    download: 'Download',
    retryProbe: 'retrying',
    copy: 'Copy',
  },
  fr: {
    testConnection: 'Tester la connexion',
    saveStart: /Enregistrer et démarrer/i,
    approve: 'Approuver',
    addFiles: 'Ajouter des fichiers',
    more: 'Plus d’actions',
    larger: 'Texte plus grand',
    resetText: 'Réinitialiser la taille du texte',
    newChat: /Nouvelle conversation/i,
    memory: 'Mémoire',
    automations: 'Automatisations',
    products: 'Produits',
    download: 'Télécharger',
    retryProbe: 'nouvel essai',
    copy: 'Copier',
  },
} as const;

/** Prompts typed into the composer; each pairs with a demoLlm.ts handler. */
const PROMPTS_BY_LANG = {
  en: {
    summarize: 'Summarize this page for me.',
    research: 'Compare Canada’s historic waterways, starting from this Rideau Canal article.',
    approval: 'What is this page’s exact title? Check it directly.',
    kb: 'What does my briefing note say about the canal season? ',
    deck: 'Build a three-slide deck from this article.',
    busy: 'The endpoint looks busy — summarize it anyway.',
    repo: 'briefing notes',
    noteFile: 'canal-brief.txt',
    note:
      'Briefing note — Rideau Canal operations.\nThe navigation season runs mid-May to mid-October; lock staffing is reduced in the shoulder weeks. Official visits should be planned for June through September.',
    answerProbe: { summarize: 'Rideau', plan: 'Comparison across', approval: 'Parliament', kb: 'navigation', busy: 'recovered' },
  },
  fr: {
    summarize: 'Résume cette page pour moi.',
    research: 'Compare les voies navigables historiques du Canada, à partir de cet article sur le canal Rideau.',
    approval: 'Quel est le titre exact de cette page? Vérifie-le directement.',
    kb: 'Que dit ma note d’information sur la saison du canal? ',
    deck: 'Prépare un jeu de trois diapositives à partir de cet article.',
    busy: 'Le point de terminaison semble occupé — résume-la quand même.',
    repo: 'notes d’information',
    noteFile: 'note-canal.txt',
    note:
      'Note d’information — exploitation du canal Rideau.\nLa saison de navigation s’étend de la mi-mai à la mi-octobre; le personnel des écluses est réduit en début et en fin de saison. Planifier les visites officielles de juin à septembre.',
    answerProbe: { summarize: 'canal Rideau', plan: 'Comparaison entre', approval: 'Colline du Parlement', kb: 'saison de navigation', busy: 'rétabli' },
  },
} as const;

export interface SceneCtx {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  /** Demo LLM base (append /v1 for the endpoint field). */
  mockBase: string;
  /** The recorded page (hosts the stage). */
  page: Page;
  /** Beat checkpoints: seconds into the scene, by name (record.ts collects). */
  marks: Array<{ name: string; at: number }>;
  sceneStart: number;
  lang: DemoLang;
}

const live = (ctx: SceneCtx) => LIVE_BY_LANG[ctx.lang];
const ui = (ctx: SceneCtx) => UI_BY_LANG[ctx.lang];
const prompts = (ctx: SceneCtx) => PROMPTS_BY_LANG[ctx.lang];

export interface SceneSpec {
  id: string;
  viewport: { width: number; height: number };
  run: (ctx: SceneCtx) => Promise<void>;
}

const VIEW = { width: 1280, height: 800 };

const pace = (page: Page, ms: number) => page.waitForTimeout(ms);

/** Record a narration checkpoint at "now" (see the sync contract above). */
function mark(ctx: SceneCtx, name: string): void {
  ctx.marks.push({ name, at: (Date.now() - ctx.sceneStart) / 1000 });
}

async function typeSlowly(page: Page, target: Locator, text: string, delay = 42): Promise<void> {
  await moveClick(page, target);
  await target.pressSequentially(text, { delay });
}

/** Seed the model connection straight through the service worker's storage. */
function seedModel(ctx: SceneCtx): Promise<void> {
  return ctx.serviceWorker.evaluate(({ baseUrl, lang }) => {
    return chrome.storage.local.set({
      ba_settings: { baseUrl, apiKey: 'demo-key', model: 'mock-model' },
      ba_language: lang,
    });
  }, { baseUrl: `${ctx.mockBase}/v1`, lang: ctx.lang }) as Promise<void>;
}

/** Language only (for the unseeded onboarding scene's UI). */
function seedLanguage(ctx: SceneCtx): Promise<void> {
  return ctx.serviceWorker.evaluate((lang) => chrome.storage.local.set({ ba_language: lang }), ctx.lang) as Promise<void>;
}

interface StageOpts {
  web: string;
  panel?: boolean;
  title?: string;
}

async function openStage(ctx: SceneCtx, opts: StageOpts): Promise<{ web: FrameLocator; panel: FrameLocator }> {
  const q = new URLSearchParams({
    web: opts.web,
    panel: opts.panel === false ? '0' : '1',
    title: opts.title ?? LIVE_BY_LANG[ctx.lang].rideauTitle,
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
  await pace(ctx.page, 400);
  await moveClick(ctx.page, panel.getByTestId('send'));
}

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
    run: async (ctx) => {
      await showCard(ctx.page, 'CANChat Agent', ctx.lang === 'fr'
        ? 'Un agent IA dans le panneau latéral de votre navigateur — vos onglets, votre session, vos données.'
        : 'An AI agent in your browser’s side panel — your tabs, your session, your data.');
      await pace(ctx.page, 4000);
    },
  },

  {
    id: 'onboarding',
    viewport: VIEW,
    run: async (ctx) => {
      await seedLanguage(ctx);
      const { panel } = await openStage(ctx, { web: live(ctx).rideau });
      const page = ctx.page;
      const card = panel.locator('.onboarding-card');
      await card.waitFor();
      await pace(page, 1500);
      const fields = card.locator('.field input');
      await typeSlowly(page, fields.nth(0), `${ctx.mockBase}/v1`, 24);
      await typeSlowly(page, fields.nth(1), 'sk-demo-key', 30);
      await typeSlowly(page, fields.nth(2), 'mock-model', 30);
      mark(ctx, 'typed');
      await pace(page, 700);
      await moveClick(page, card.getByRole('button', { name: ui(ctx).testConnection }));
      await panel.locator('.banner-ok').waitFor();
      mark(ctx, 'tested');
      await pace(page, 1200);
      await moveClick(page, card.getByRole('button', { name: ui(ctx).saveStart }));
      await panel.locator('.chat-empty').waitFor();
      mark(ctx, 'ready');
      await pace(page, 1500);
    },
  },

  {
    id: 'summarize',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: live(ctx).rideau });
      await pace(ctx.page, 1400);
      await typeSlowly(ctx.page, panel.getByTestId('chat-input'), prompts(ctx).summarize);
      await moveClick(ctx.page, panel.getByTestId('send'));
      mark(ctx, 'asked');
      await panel.locator('.msg-assistant', { hasText: prompts(ctx).answerProbe.summarize }).waitFor();
      mark(ctx, 'answered');
      await pace(ctx.page, 1000);
      await moveTo(ctx.page, panel.locator('.msg-assistant button', { hasText: ui(ctx).copy }).first());
      await pace(ctx.page, 1500);
    },
  },

  {
    id: 'plan',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: live(ctx).rideau });
      await sendDemo(ctx, panel, prompts(ctx).research);
      await panel.locator('.plan-panel').waitFor();
      mark(ctx, 'planned');
      // The agent's open_url calls create REAL tabs; wait until both exist so
      // the stage's tab strip visibly grows before the narration points at it.
      const baseline = ctx.context.pages().length;
      await ctx.page.waitForTimeout(300);
      for (let i = 0; i < 100 && ctx.context.pages().length < baseline + 2; i++) {
        await ctx.page.waitForTimeout(200);
      }
      mark(ctx, 'tabs');
      await panel.locator('.msg-assistant', { hasText: prompts(ctx).answerProbe.plan }).waitFor({ timeout: 30000 });
      mark(ctx, 'answered');
      await pace(ctx.page, 1400);
      await moveClick(ctx.page, panel.locator('.activity-toggle'));
      await panel.locator('.activity-list').waitFor();
      mark(ctx, 'activity');
      await pace(ctx.page, 2200);
    },
  },

  {
    id: 'approval',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: live(ctx).parliament, title: live(ctx).parliamentTitle });
      await pace(ctx.page, 1200);
      await sendDemo(ctx, panel, prompts(ctx).approval);
      const approval = panel.getByTestId('approval');
      await approval.waitFor();
      mark(ctx, 'card');
      await pace(ctx.page, 2600); // let the viewer read the reason
      await moveClick(ctx.page, approval.getByRole('button', { name: ui(ctx).approve }));
      await panel.locator('.msg-assistant', { hasText: prompts(ctx).answerProbe.approval }).waitFor();
      mark(ctx, 'approved');
      await pace(ctx.page, 1800);
    },
  },

  {
    id: 'knowledge',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { web } = await openStage(ctx, { web: 'workspace.html#knowledge', panel: false, title: live(ctx).workspaceTitle });
      const page = ctx.page;
      await pace(page, 1200);
      await moveClick(page, web.locator('.repo-upload-toggle'));
      await typeSlowly(page, web.locator('.repo-upload input[type="text"]'), prompts(ctx).repo, 40);
      await web.locator('.repo-drop input[type="file"]').setInputFiles({
        name: prompts(ctx).noteFile,
        mimeType: 'text/plain',
        buffer: Buffer.from(prompts(ctx).note),
      });
      await web.locator('.repo-file', { hasText: prompts(ctx).noteFile }).waitFor();
      await pace(page, 600);
      await moveClick(page, web.getByRole('button', { name: ui(ctx).addFiles, exact: true }));
      await web.locator('.upload-banner').waitFor();
      mark(ctx, 'uploaded');
      await pace(page, 1800);

      const { panel } = await openStage(ctx, { web: live(ctx).benefits, title: live(ctx).benefitsTitle });
      mark(ctx, 'panel');
      const input = panel.getByTestId('chat-input');
      await typeSlowly(page, input, prompts(ctx).kb, 40);
      await input.pressSequentially('#', { delay: 80 });
      await pace(page, 1400);
      await page.keyboard.press('Enter').catch(() => {});
      await pace(page, 400);
      await moveClick(page, panel.getByTestId('send'));
      await panel.locator('.msg-assistant', { hasText: prompts(ctx).answerProbe.kb }).waitFor({ timeout: 20000 });
      mark(ctx, 'answered');
      await pace(page, 1800);
    },
  },

  {
    id: 'history',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: live(ctx).rideau });
      await sendDemo(ctx, panel, prompts(ctx).summarize);
      await panel.locator('.msg-assistant', { hasText: prompts(ctx).answerProbe.summarize }).waitFor();
      await pace(ctx.page, 600);
      await moveClick(ctx.page, panel.locator('.header-controls .icon-btn').first()); // History
      await panel.locator('.conv-item').first().waitFor();
      mark(ctx, 'opened');
      await pace(ctx.page, 2400);
      await moveClick(ctx.page, panel.locator('.settings-header .icon-btn')); // close
      await pace(ctx.page, 600);
      await moveClick(ctx.page, panel.getByRole('button', { name: ui(ctx).more }));
      await panel.getByRole('menu').waitFor();
      mark(ctx, 'more');
      await pace(ctx.page, 1400);
      // Hover (don't click) the text-size controls: clicking applies CSS zoom
      // inside the panel iframe, which breaks Playwright's coordinate math for
      // every later locator and once stalled a scene for 15 minutes.
      await moveTo(ctx.page, panel.getByRole('menu').getByRole('button', { name: ui(ctx).larger }));
      await pace(ctx.page, 900);
      await moveTo(ctx.page, panel.getByRole('menu').getByRole('button', { name: ui(ctx).resetText }));
      await pace(ctx.page, 1100);
      await ctx.page.keyboard.press('Escape');
      await moveTo(ctx.page, panel.getByRole('button', { name: ui(ctx).newChat }));
      mark(ctx, 'done');
      await pace(ctx.page, 1500);
    },
  },

  {
    id: 'skills',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { web } = await openStage(ctx, { web: 'workspace.html#skills', panel: false, title: live(ctx).workspaceTitle });
      await web.getByText('/research').waitFor();
      await pace(ctx.page, 3000);
      const { panel } = await openStage(ctx, { web: live(ctx).rideau });
      await typeSlowly(ctx.page, panel.getByTestId('chat-input'), '/res', 90);
      mark(ctx, 'slash');
      await pace(ctx.page, 2400);
      await ctx.page.keyboard.press('Escape');
      await pace(ctx.page, 800);
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
      const { web } = await openStage(ctx, { web: 'workspace.html#models', panel: false, title: live(ctx).workspaceTitle });
      await ctx.page.evaluate((t) => {
        return chrome.runtime.sendMessage({
          type: 'products_import',
          products: [
            { meta: { id: 'p1', filename: 'digest-monday.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createdAt: new Date(t - 86400e3).toISOString(), sizeBytes: 48213, sourceTitle: 'Morning news brief' }, dataB64: btoa('demo') },
          ],
        });
      }, now);
      await web.getByTestId('advanced-settings').waitFor();
      await pace(ctx.page, 1800);
      await ctx.page.mouse.move(620, 420);
      mark(ctx, 'scrolled');
      for (let i = 0; i < 3; i++) {
        await ctx.page.mouse.wheel(0, 520);
        await pace(ctx.page, 1300);
      }
      await moveClick(ctx.page, web.getByRole('button', { name: ui(ctx).memory }));
      mark(ctx, 'memory');
      await pace(ctx.page, 2200);
      await moveClick(ctx.page, web.getByRole('button', { name: ui(ctx).automations }));
      await web.locator('.ws-item').first().waitFor();
      mark(ctx, 'automations');
      await pace(ctx.page, 2600);
      await moveClick(ctx.page, web.getByRole('button', { name: ui(ctx).products }));
      await web.locator('.ws-item', { hasText: 'digest-monday.docx' }).waitFor();
      mark(ctx, 'products');
      await moveTo(ctx.page, web.getByRole('button', { name: ui(ctx).download }).first());
      await pace(ctx.page, 2200);
    },
  },

  {
    id: 'documents',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: live(ctx).rideau });
      await pace(ctx.page, 1000);
      await typeSlowly(ctx.page, panel.getByTestId('chat-input'), prompts(ctx).deck);
      await moveClick(ctx.page, panel.getByTestId('send'));
      mark(ctx, 'asked');
      const card = panel.locator('.export-card', { hasText: '.pptx' });
      await card.waitFor({ timeout: 20000 });
      mark(ctx, 'card');
      await pace(ctx.page, 900);
      await moveTo(ctx.page, card.getByRole('button', { name: ui(ctx).download }));
      await pace(ctx.page, 1800);
    },
  },

  {
    id: 'resilience',
    viewport: VIEW,
    run: async (ctx) => {
      await seedModel(ctx);
      const { panel } = await openStage(ctx, { web: live(ctx).park, title: live(ctx).parkTitle });
      await sendDemo(ctx, panel, prompts(ctx).busy);
      await panel.locator('.msg-notice', { hasText: ui(ctx).retryProbe }).waitFor();
      mark(ctx, 'retrying');
      await panel.locator('.msg-assistant', { hasText: prompts(ctx).answerProbe.busy }).waitFor({ timeout: 20000 });
      mark(ctx, 'answered');
      await pace(ctx.page, 2000);
    },
  },

  {
    id: 'outro',
    viewport: VIEW,
    run: async (ctx) => {
      await showCard(ctx.page, 'CANChat Agent', (ctx.lang === 'fr'
        ? 'Local par conception. Approbation requise par défaut.'
        : 'On-device by design. Approval-gated by default.')
        + '<br><br><span style="font-size:18px;color:#9d8fb3">github.com/ssc-dsai/CANChat-Agent</span>');
      await pace(ctx.page, 4000);
    },
  },
];

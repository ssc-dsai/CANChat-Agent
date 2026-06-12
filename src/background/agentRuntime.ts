import type { BackgroundEvent } from '../shared/messages';
import { MEMORY_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from '../shared/schemas';
import type {
  AgentStatus,
  AuthState,
  ChatMessageView,
  PageContent,
  PlanStepStatus,
  PlanView,
  ToolActivity,
} from '../shared/types';
import type { MemoryEntry, Settings, SiteEntry, Skill } from '../shared/types';
import { hostMatches, normalizeHost } from '../shared/url';
import * as browser from './browserToolAdapter';
import { complete, type ContentPart, type LlmMessage, type LlmToolCall } from './llmProvider';
import {
  getMemories,
  getMemoryEnabled,
  getSettings,
  getSites,
  getSkills,
  MEMORY_MAX_ENTRIES,
  saveMemories,
  saveSkills,
} from './storage';
import * as tabContext from './tabContextManager';

const SOFT_STEP_BUDGET = 20; // default tool-iteration budget per task
const STEP_BUDGET_EXTENSION = 10; // granted when the plan still has work left
const HARD_STEP_CEILING = 40; // absolute cap to bound cost
const SITES_PROMPT_LIMIT = 25;
const LLM_TIMEOUT_MS = 120000;
const SINGLE_TAB_CHARS = 12000;
const MULTI_TAB_CHARS = 5000;
const CONVERSATION_CHAR_BUDGET = 90000; // compact older tool output beyond this
const FINDINGS_SHOWN = 20;

interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

/** Tools that mutate page or browser state and therefore need user approval. */
const APPROVAL_REQUIRED = new Set([
  'click_element',
  'fill_input',
  'submit_form',
  'run_javascript', // arbitrary code in the page — always gated
  'press_keys', // keyboard input can submit/trigger — gated
  'click_at', // coordinate click can commit actions — gated
  'drag', // drag can reorder/drop — gated
  'save_app_playbook', // persists a reusable playbook — confirm before storing
  'get_all_tab_contents', // reading all tabs needs explicit approval per spec
]);

/** Read-only / local tools that are safe to run concurrently within one turn. */
const READ_ONLY_TOOLS = new Set([
  'list_tabs',
  'get_active_tab',
  'get_tab_content',
  'get_element_map',
  'detect_auth_state',
  'wait_for_element',
  'search_known_sites',
  'use_skill',
  'set_plan',
  'update_plan',
  'record_finding',
]);

const SYSTEM_PROMPT = `You are a browser agent running in a Chrome extension side panel. The browser is your primary tool environment.

Decision policy:
- Answer from your own knowledge when the question is general and stable and browser access would not materially improve the answer.
- Use browser tools when the user asks about the current page, open tabs, recent or site-specific information, data on websites, or authenticated systems (Jira, dashboards, etc.).
- Whenever an operation can be done through the browser, do it through the browser.
- When the user refers to "the page", "this article", "the site", or a web page without saying which one, assume they mean the currently active tab: call get_active_tab, then get_tab_content on it.

Planning multi-step tasks:
- For any task that needs more than two or three tool calls, FIRST call set_plan with an ordered list of steps. Keep exactly one step in_progress (update_plan), and mark steps done as you finish them. Revise with set_plan if the situation changes.
- Size the plan to the actual work: use as few or as many steps as the task genuinely needs — a 2-step plan for something small, 8+ for something involved. Do NOT pad to a fixed number, and skip planning entirely for trivial one-shot tasks.
- As you discover important intermediate results, call record_finding to save them. Do not rely on scrolling back through history — older tool output gets compacted away, but findings and the plan stay in view in the working-state block.
- A live working-state block (active tab, plan, findings, step budget) is kept at the top of your context and refreshed every step. Watch the remaining step budget and pace yourself; when it runs low, record what matters and produce your best answer.
- You can issue several independent read-only tool calls in one turn — they run in parallel (e.g. get_tab_content on several tabs at once).
- Before giving your final answer, verify the goal is actually met (re-read the page or re-check the result) rather than assuming an action worked.

Working method:
- Use search_web for open-web searches; it opens the browser's default search engine. Read the results with get_tab_content, then navigate to the most relevant result.
- NEVER use the "site:" operator (or other search-engine operators) in a search_web query — not under any circumstances. It returns stale, poorly-ranked results. To search WITHIN a specific site, always go to the site itself: (1) if a known site has a search template for that domain, use it; (2) otherwise navigate to the site and use its own search — fill_input its search box and press_keys "Enter", or load its search URL pattern directly. search_web is only for plain open-web keyword queries with no site restriction.
- Before clicking, filling, or submitting anything, call get_element_map and act on refIds. State-changing actions require user approval; the runtime handles asking.
- Every action that needs approval (click_element, fill_input, submit_form, run_javascript, get_all_tab_contents, save_app_playbook) takes a required "reason" argument. Always set it to a clear, plain-language explanation, written for the user, of what the action does and why it helps the task — this is what they read to decide. No jargon or refIds.
- A run_javascript tool runs JavaScript in the page's own context for tasks the other tools can't express — reading app/framework state or computing over page data. It requires user approval; prefer the dedicated tools when they suffice.
- Choosing a control method: for apps with a usable JavaScript API (maps, charts), driving the page's own object via run_javascript (e.g. a Leaflet map's setView) is the most reliable — prefer it. For ordinary UI, use get_element_map (it now sees into shadow DOM and same-origin iframes, and returns each element's rect) then click_element/fill_input on refIds. Use press_keys for Enter/shortcuts, wait_for_element before acting on content that loads asynchronously, and click_at/drag/scroll_wheel (with coordinates from element rects) for canvas or map content that has no clickable element.
- App playbooks: when you are on a site the user has taught you, its playbook appears automatically above as an "Active app playbook" — follow it to operate that app. The user teaches a new app by typing /learn, which has you explore the site and save a playbook with save_app_playbook.
- If a page requires login, the task pauses automatically and the user is asked to sign in. After they resume, re-fetch the page content.
- The user may attach snapshots (screenshots of tabs). Read charts, tables, and figures directly from those images — they usually exist because DOM extraction could not see that content.
- If a tool reports missing permissions, tell the user which sidebar button to use (e.g. "Use all tabs") and stop.

Answer format:
- Format answers in Markdown (headings, lists, tables, links) — the sidebar renders it.
- Be concise. When your answer draws on tabs or pages, end with a source list in exactly this form, one markdown link per line with the full URL:
Source tabs:
[1] [Jira - Project Board](https://jira.example.com/board)
[2] [Example News Site - Article title](https://news.example.com/article)
- For multi-tab summaries, distinguish findings common across tabs, findings unique to single tabs, and tabs that were inaccessible or blocked by authentication.`;

function formatSite(s: SiteEntry): string {
  return (
    `- ${s.name} — ${s.url}\n  ${s.description}` +
    (s.searchUrlTemplate ? `\n  Search template: ${s.searchUrlTemplate}` : '')
  );
}

function sitesPromptBlock(sites: SiteEntry[]): string {
  if (sites.length === 0) return '';
  if (sites.length > SITES_PROMPT_LIMIT) {
    return `\n\nKnown sites: the user maintains a directory of ${sites.length} known sites. When a task needs data, call search_known_sites first; prefer a matching known site over a generic web search.`;
  }
  return (
    `\n\nKnown sites — a user-curated directory. When a task needs data, check this list first and prefer navigating to a matching site over a generic web search. If an entry has a search template, substitute {query} (URL-encoded) and use navigate to jump straight to its results:\n` +
    sites.map(formatSite).join('\n')
  );
}

function skillsPromptBlock(skills: Skill[], activeHost: string): string {
  if (skills.length === 0) return '';
  // An origin-bound skill matching the current tab is an active app playbook:
  // inject its full body so the agent knows how to operate this app.
  const activePlaybooks = skills.filter((s) => s.origin && activeHost && hostMatches(activeHost, s.origin));
  let block =
    `\n\nSkills — reusable procedures the user has saved. When a task matches a skill's description, call use_skill with its name and follow the returned instructions. The user can also force one by typing /name. Teach a new app with /learn.\n` +
    skills
      .map((s) => `- ${s.name}${s.origin ? ` [app: ${s.origin}]` : ''} — ${s.description}`)
      .join('\n');
  for (const p of activePlaybooks) {
    block += `\n\nActive app playbook for ${p.origin} (you are on this site now — use it to operate the app):\n${p.body}`;
  }
  return block;
}

function memoryPromptBlock(entries: MemoryEntry[]): string {
  const guidance =
    `\n\nMemory — the user has enabled persistent memory on this device. ` +
    `Save genuinely durable facts about the user (their role, projects, interests, preferences, ongoing work) with save_memory as you learn them — one fact per call. ` +
    `Never save secrets, credentials, or sensitive page content. ` +
    `Use update_memory/delete_memory to keep entries current, and honor "forget ..." requests immediately with delete_memory.`;
  if (entries.length === 0) {
    return guidance + `\nMemory is currently empty.`;
  }
  return (
    guidance +
    `\nKnown facts (use them naturally to tailor answers; reference by id when updating):\n` +
    entries.map((e) => `- [${e.id}] ${e.text}`).join('\n')
  );
}

function buildLearnTask(focus: string, existing?: Skill): string {
  const existingBlock = existing
    ? `\nYou already have a playbook for this site (name: "${existing.name}"). REFINE and improve it rather than starting over, and when you save, reuse the name "${existing.name}" so it replaces the current one. Current playbook:\n${existing.body}\n`
    : '';
  return (
    `The user wants you to LEARN how to operate the web app in the current tab and save a reusable playbook. Work through these steps:\n` +
    `1. Call get_active_tab to get the current URL and host (this host is the playbook's origin).\n` +
    `2. Call get_element_map to catalog the interactive controls (search boxes, buttons, toggles).\n` +
    `3. Use run_javascript to introspect the app's live JavaScript and find objects you can drive directly. Probe for common libraries, especially maps:\n` +
    `   - Leaflet: typeof L, and objects with setView/flyTo/getCenter/getZoom.\n` +
    `   - Mapbox/MapLibre GL: objects with jumpTo/flyTo/getCenter.\n` +
    `   - OpenLayers (ol.Map) and Google Maps (google.maps.Map).\n` +
    `   - Scan window for objects exposing those methods; check __NEXT_DATA__ or framework state for data.\n` +
    `4. Call snapshot to capture the interface visually for context.\n` +
    `5. Synthesize a concise playbook: the concrete way to perform this app's key actions (navigate/pan/zoom, search, read data) using code snippets and/or element references, plus gotchas (e.g. CSP blocking eval, login required). Note which control method works best for each action — run_javascript on the app's own objects, element refs (click_element/fill_input), keyboard shortcuts (press_keys), or coordinate gestures (click_at/drag/scroll_wheel). If run_javascript is blocked by CSP, base the playbook on get_element_map + click/fill/press_keys instead.\n` +
    `6. Call save_app_playbook with the origin from step 1, a short kebab name, a one-line description, and the playbook body. The user will be asked to approve the save.\n` +
    `7. Briefly tell the user what you learned and saved.\n` +
    existingBlock +
    (focus ? `\nFocus the exploration on: ${focus}\n` : '') +
    `\nDo not perform destructive actions while exploring; prefer read-only inspection.`
  );
}

function searchKnownSites(sites: SiteEntry[], query: string): string {
  if (sites.length === 0) {
    return 'The known-sites directory is empty. Fall back to search_web or ask the user.';
  }
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const scored = sites
    .map((s) => {
      const haystack = `${s.name} ${s.description} ${s.url}`.toLowerCase();
      const score = terms.filter((t) => haystack.includes(t)).length;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (scored.length === 0) {
    return `No matches among ${sites.length} known sites. Fall back to search_web or ask the user.`;
  }
  return JSON.stringify(scored.map(({ s }) => s));
}

interface PendingApproval {
  requestId: string;
  description: string;
  detail: string;
  resolve: (approved: boolean) => void;
}

interface AuthWait {
  origin: string;
  message: string;
  resolve: () => void;
}

interface PermissionWait {
  origin: string;
  message: string;
  resolve: () => void;
}

export class AgentRuntime {
  private conversation: LlmMessage[] = [];
  private messages: ChatMessageView[] = [];
  private activities: ToolActivity[] = [];
  private status: AgentStatus = 'idle';
  private running = false;
  private stopRequested = false;
  private pauseRequested = false;
  private pauseWaiter: (() => void) | null = null;
  private pendingApproval: PendingApproval | null = null;
  private authWait: AuthWait | null = null;
  private permissionWait: PermissionWait | null = null;
  private abortController: AbortController | null = null;
  private pendingSnapshots: Array<{ dataUrl: string; title: string; url: string }> = [];
  private activityCounter = 0;
  // --- agent-core working state (plan, findings, step budget) ---
  private plan: PlanStep[] | null = null;
  private findings: string[] = [];
  private stepsUsed = 0;
  private stepBudget = SOFT_STEP_BUDGET;
  private toolCallCount = 0;
  private canDistill = false;
  private lastUserText = '';
  private activeHost = '';
  private activeTabLabel = '';
  private systemBase = '';

  constructor(private emit: (event: BackgroundEvent) => void) {}

  // ----- state for newly connected sidebars -----

  fullState(): BackgroundEvent {
    return {
      type: 'full_state',
      status: this.status,
      messages: this.messages,
      activities: this.activities.slice(-50),
      context: tabContext.toSummary(tabContext.getSnapshot()),
      pendingApproval: this.pendingApproval
        ? {
            requestId: this.pendingApproval.requestId,
            description: this.pendingApproval.description,
            detail: this.pendingApproval.detail,
          }
        : null,
      authNotice: this.authWait ? { origin: this.authWait.origin, message: this.authWait.message } : null,
      permissionNotice: this.permissionWait
        ? { origin: this.permissionWait.origin, message: this.permissionWait.message }
        : null,
      pendingSnapshots: this.pendingSnapshots.map((s) => s.dataUrl),
      plan: this.planView(),
      canDistill: this.canDistill,
    };
  }

  private planView(): PlanView | null {
    return this.plan ? { steps: this.plan.map((s) => ({ text: s.text, status: s.status })) } : null;
  }

  attachSnapshot(dataUrl: string, title: string, url: string): void {
    this.pendingSnapshots.push({ dataUrl, title, url });
    this.emit({ type: 'pending_snapshots', thumbs: this.pendingSnapshots.map((s) => s.dataUrl) });
    this.pushChat({
      role: 'notice',
      text: `Snapshot of "${title}" attached — it will be sent with your next message.`,
      timestamp: new Date().toISOString(),
      images: [dataUrl],
    });
  }

  discardSnapshots(): void {
    if (this.pendingSnapshots.length === 0) return;
    this.pendingSnapshots = [];
    this.emit({ type: 'pending_snapshots', thumbs: [] });
    this.notice('Snapshots discarded.');
  }

  // ----- sidebar commands -----

  async handleUserMessage(text: string): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', message: 'A task is already running. Stop it first or wait for it to finish.' });
      return;
    }
    const settings = await getSettings();
    if (!settings) {
      this.emit({
        type: 'error',
        message: 'No model configured. Open Settings and enter an endpoint, API key, and model first.',
      });
      return;
    }

    // Slash-command skill invocation: /name [args] forces a skill.
    let taskText = text;
    const slash = /^\/([a-z0-9-]+)\s*([\s\S]*)$/i.exec(text.trim());
    if (slash) {
      const skills = await getSkills();
      const name = slash[1].toLowerCase();
      // Built-in /learn: explore the current app and save an origin-scoped playbook.
      if (name === 'learn' && !skills.some((s) => s.name.toLowerCase() === 'learn')) {
        // Find an existing playbook for the current site so /learn refines it
        // instead of creating a duplicate.
        let existing: Skill | undefined;
        try {
          const host = normalizeHost((await browser.getActiveTab()).url);
          existing = skills.find((s) => s.origin && hostMatches(host, s.origin));
        } catch {
          // No active tab; proceed without an existing playbook.
        }
        taskText = buildLearnTask(slash[2].trim(), existing);
      } else {
        const skill = skills.find((s) => s.name.toLowerCase() === name);
        if (!skill) {
          const available =
            ['/learn', ...skills.map((s) => `/${s.name}`)].join(', ');
          this.emit({
            type: 'error',
            message: `No skill named "/${slash[1]}". Available: ${available}`,
          });
          return;
        }
        taskText =
          `The user invoked the skill "${skill.name}". Skill instructions:\n${skill.body}\n\n` +
          `User input: ${slash[2].trim() || '(none)'}`;
      }
    }

    // Consume any pending snapshots: shown on the user's message and sent
    // to the model as image content parts.
    const snapshots = this.pendingSnapshots;
    this.pendingSnapshots = [];
    if (snapshots.length > 0) this.emit({ type: 'pending_snapshots', thumbs: [] });

    this.pushChat({
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
      images: snapshots.length > 0 ? snapshots.map((s) => s.dataUrl) : undefined,
    });
    this.running = true;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.abortController = new AbortController();
    // Reset per-task working state.
    this.lastUserText = text;
    this.plan = null;
    this.findings = [];
    this.stepsUsed = 0;
    this.stepBudget = SOFT_STEP_BUDGET;
    this.toolCallCount = 0;
    this.setDistill(false);
    this.emit({ type: 'plan_update', plan: null });

    try {
      await this.runLoop(taskText, snapshots);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError' && this.stopRequested) {
        // User stopped or cleared the task; the abort is expected.
      } else {
        const message =
          err instanceof DOMException && err.name === 'TimeoutError'
            ? `Model request timed out after ${LLM_TIMEOUT_MS / 1000}s.`
            : err instanceof Error
              ? err.message
              : String(err);
        this.setStatus('error', message);
        this.emit({ type: 'error', message });
      }
    } finally {
      this.abortController = null;
      this.running = false;
      if (this.status !== 'error') this.setStatus('idle');
    }
  }

  stop(): void {
    this.stopRequested = true;
    // Cancel any in-flight model request so the loop exits its await promptly.
    this.abortController?.abort();
    if (this.pendingApproval) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.resolve(false);
    }
    if (this.authWait) {
      const wait = this.authWait;
      this.authWait = null;
      wait.resolve();
    }
    if (this.permissionWait) {
      const wait = this.permissionWait;
      this.permissionWait = null;
      wait.resolve();
    }
    if (this.pauseWaiter) {
      const w = this.pauseWaiter;
      this.pauseWaiter = null;
      w();
    }
  }

  clearConversation(): void {
    this.stop();
    this.conversation = [];
    this.messages = [];
    this.activities = [];
    this.pendingSnapshots = [];
    this.plan = null;
    this.findings = [];
    this.stepsUsed = 0;
    this.toolCallCount = 0;
    this.canDistill = false;
    this.setStatus('idle');
    this.emit({ type: 'plan_update', plan: null });
    this.emit(this.fullState());
  }

  private setDistill(available: boolean): void {
    this.canDistill = available;
    this.emit({ type: 'distill_offer', available });
  }

  dismissDistill(): void {
    this.setDistill(false);
  }

  /** Generalize the just-completed task into a reusable skill and save it. */
  async distillSkill(): Promise<void> {
    if (this.running || !this.canDistill) return;
    const settings = await getSettings();
    if (!settings) return;
    this.setDistill(false);
    this.setStatus('thinking', 'Distilling a skill…');
    try {
      const planText = this.plan?.map((s, i) => `${i + 1}. ${s.text}`).join('\n') ?? '(no explicit plan)';
      const prompt: LlmMessage[] = [
        {
          role: 'system',
          content:
            'You convert a completed browser task into a reusable skill for a browser agent. Respond with ONLY a JSON object: {"name": "<lowercase-kebab>", "description": "<one line: when to use this>", "body": "<numbered markdown steps naming the agent tools used, generalized so it works for similar future tasks>"}. No prose, no code fence.',
        },
        {
          role: 'user',
          content: `Original request:\n${this.lastUserText}\n\nPlan that was followed:\n${planText}\n\nKey findings:\n${this.findings.join('\n') || '(none)'}\n\nProduce the skill JSON.`,
        },
      ];
      const reply = await complete(settings, prompt, undefined, this.makeSignal());
      const raw = (reply.content ?? '').trim().replace(/^```(?:json)?|```$/g, '').trim();
      const parsed = JSON.parse(raw) as { name?: string; description?: string; body?: string };
      if (!parsed.name || !parsed.description || !parsed.body) {
        throw new Error('Incomplete skill.');
      }
      const name = parsed.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      const skills = await getSkills();
      const idx = skills.findIndex((s) => s.name.toLowerCase() === name && !s.origin);
      const skill: Skill = {
        id: idx >= 0 ? skills[idx].id : `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        description: parsed.description.trim(),
        body: parsed.body.trim(),
      };
      if (idx >= 0) skills[idx] = skill;
      else skills.push(skill);
      await saveSkills(skills);
      this.notice(`Saved skill /${name} — edit it in Settings → Skills.`);
    } catch (err) {
      this.emit({
        type: 'error',
        message: `Could not distill a skill: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      if (this.status !== 'error') this.setStatus('idle');
    }
  }

  pause(): void {
    if (this.running) this.pauseRequested = true;
  }

  resume(): void {
    this.pauseRequested = false;
    if (this.authWait) {
      const wait = this.authWait;
      this.authWait = null;
      this.emit({ type: 'auth_required', origin: '', message: '' });
      wait.resolve();
      return;
    }
    if (this.permissionWait) {
      const wait = this.permissionWait;
      this.permissionWait = null;
      this.emit({ type: 'permission_required', origin: '', message: '' });
      wait.resolve();
      return;
    }
    if (this.pauseWaiter) {
      const w = this.pauseWaiter;
      this.pauseWaiter = null;
      w();
    }
  }

  approvalResponse(requestId: string, approved: boolean): void {
    if (this.pendingApproval?.requestId === requestId) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.resolve(approved);
    }
  }

  async includeTabContext(scope: 'active' | 'all'): Promise<void> {
    try {
      const snapshot = await tabContext.buildSnapshot(scope);
      this.emit({ type: 'context_update', summary: tabContext.toSummary(snapshot) });
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async refreshContext(): Promise<void> {
    if (!tabContext.getSnapshot()) return;
    try {
      const snapshot = await tabContext.refreshSnapshot();
      this.emit({ type: 'context_update', summary: tabContext.toSummary(snapshot) });
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  // ----- agent loop -----

  private async runLoop(
    userText: string,
    snapshots: Array<{ dataUrl: string; title: string; url: string }> = [],
  ): Promise<void> {
    const settings = (await getSettings())!;

    // (Re)build the system message each task so directory/skill/memory edits apply immediately.
    const memoryEnabled = await getMemoryEnabled();
    const tools = memoryEnabled ? [...TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS] : TOOL_DEFINITIONS;
    const customInstructions = settings.systemPrompt?.trim()
      ? `\n\nUser instructions — the user has configured these standing instructions; follow them within the safety rules above:\n${settings.systemPrompt.trim()}`
      : '';
    // Active tab host drives app-playbook auto-activation.
    this.activeHost = '';
    this.activeTabLabel = '';
    try {
      const tab = await browser.getActiveTab();
      this.activeHost = normalizeHost(tab.url);
      this.activeTabLabel = `${tab.url} "${tab.title}"`;
    } catch {
      // No active tab (or restricted); playbooks just won't auto-activate.
    }
    // The base system prompt is fixed for the task; the live state block is
    // refreshed each turn (see refreshSystemMessage).
    this.systemBase =
      SYSTEM_PROMPT +
      sitesPromptBlock(await getSites()) +
      skillsPromptBlock(await getSkills(), this.activeHost) +
      (memoryEnabled ? memoryPromptBlock(await getMemories()) : '') +
      customInstructions;
    if (this.conversation.length === 0) {
      this.conversation.push({ role: 'system', content: this.systemBase });
    }
    this.refreshSystemMessage();

    const contextBlock = this.buildContextBlock();
    let textContent = contextBlock ? `${contextBlock}\n\n${userText}` : userText;
    if (snapshots.length === 0) {
      this.conversation.push({ role: 'user', content: textContent });
    } else {
      textContent +=
        '\n\n' +
        snapshots
          .map((s, i) => `Attached snapshot ${i + 1}: "${s.title}" — ${s.url}`)
          .join('\n');
      const parts: ContentPart[] = [
        { type: 'text', text: textContent },
        ...snapshots.map(
          (s): ContentPart => ({ type: 'image_url', image_url: { url: s.dataUrl } }),
        ),
      ];
      this.conversation.push({ role: 'user', content: parts });
    }

    for (;;) {
      if (this.stopRequested) {
        this.notice('Task stopped.');
        return;
      }
      await this.waitIfPaused();
      if (this.stopRequested) return;

      // Budget: extend if the plan still has open steps, else wrap up gracefully.
      if (this.stepsUsed >= this.stepBudget) {
        if (this.planHasOpenSteps() && this.stepBudget < HARD_STEP_CEILING) {
          this.stepBudget = Math.min(HARD_STEP_CEILING, this.stepBudget + STEP_BUDGET_EXTENSION);
          this.notice(`Extending the step budget to ${this.stepBudget} to finish the plan.`);
        } else {
          await this.wrapUp(settings);
          return;
        }
      }

      await this.refreshActiveTabLabel();
      this.compactConversation();
      this.refreshSystemMessage();

      this.setStatus('thinking');
      const reply = await complete(settings, this.conversation, tools, this.makeSignal());
      if (this.stopRequested) return;

      if (!reply.tool_calls || reply.tool_calls.length === 0) {
        const text = reply.content ?? '(no response)';
        this.conversation.push({ role: 'assistant', content: text });
        this.pushChat({ role: 'assistant', text, timestamp: new Date().toISOString() });
        this.maybeOfferDistill();
        return;
      }

      this.conversation.push({
        role: 'assistant',
        content: reply.content,
        tool_calls: reply.tool_calls,
      });
      if (reply.content) {
        // Surface the model's visible reasoning summary alongside tool use.
        this.pushChat({ role: 'notice', text: reply.content, timestamp: new Date().toISOString() });
      }

      this.stepsUsed++;
      await this.executeToolCalls(reply.tool_calls);
    }
  }

  private makeSignal(): AbortSignal {
    const taskSignal = this.abortController?.signal;
    return taskSignal
      ? AbortSignal.any([taskSignal, AbortSignal.timeout(LLM_TIMEOUT_MS)])
      : AbortSignal.timeout(LLM_TIMEOUT_MS);
  }

  private async refreshActiveTabLabel(): Promise<void> {
    try {
      const tab = await browser.getActiveTab();
      this.activeTabLabel = `${tab.url} "${tab.title}"`;
    } catch {
      // keep the previous label
    }
  }

  /** Run a turn's tool calls: read-only ones concurrently, the rest in order. */
  private async executeToolCalls(calls: LlmToolCall[]): Promise<void> {
    this.toolCallCount += calls.length;
    const results = new Map<string, string>();
    const run = async (call: LlmToolCall) => {
      results.set(call.id, this.stopRequested ? 'Task stopped by user.' : await this.executeToolCall(call));
    };
    await Promise.all(calls.filter((c) => READ_ONLY_TOOLS.has(c.function.name)).map(run));
    for (const c of calls.filter((c) => !READ_ONLY_TOOLS.has(c.function.name))) {
      await run(c);
    }
    // Preserve original call order in the conversation.
    for (const c of calls) {
      this.conversation.push({ role: 'tool', tool_call_id: c.id, content: results.get(c.id) ?? '' });
    }
  }

  /** Force a final, tools-disabled answer when the budget is exhausted. */
  private async wrapUp(settings: Settings): Promise<void> {
    this.notice('Step budget reached — composing a final answer from what I have.');
    this.refreshSystemMessage();
    this.conversation.push({
      role: 'user',
      content:
        'You have reached your step budget — do not call any more tools. Using your findings and what you already know, give the user your best final answer now, clearly noting anything you could not verify.',
    });
    this.setStatus('thinking');
    const reply = await complete(settings, this.conversation, undefined, this.makeSignal());
    if (this.stopRequested) return;
    const text = reply.content ?? '(no answer)';
    this.conversation.push({ role: 'assistant', content: text });
    this.pushChat({ role: 'assistant', text, timestamp: new Date().toISOString() });
    this.maybeOfferDistill();
  }

  /** Rough char count of a message's content (string or multimodal parts). */
  private static messageLen(m: LlmMessage): number {
    if (typeof m.content === 'string') return m.content.length;
    if (Array.isArray(m.content)) {
      return m.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 1200), 0);
    }
    return 0;
  }

  /** Shrink the oldest tool outputs when the conversation grows too large. */
  private compactConversation(): void {
    let total = this.conversation.reduce((n, m) => n + AgentRuntime.messageLen(m), 0);
    if (total <= CONVERSATION_CHAR_BUDGET) return;
    const protectedTail = 6; // leave the most recent messages intact
    for (let i = 1; i < this.conversation.length - protectedTail && total > CONVERSATION_CHAR_BUDGET; i++) {
      const m = this.conversation[i];
      if (m.role === 'tool' && typeof m.content === 'string' && !m.content.startsWith('[compacted')) {
        const before = m.content.length;
        m.content = '[compacted — important results are in Findings]';
        total -= before - m.content.length;
      }
    }
  }

  private maybeOfferDistill(): void {
    const substantial = (this.plan?.length ?? 0) >= 3 || this.toolCallCount >= 4;
    if (substantial) this.setDistill(true);
  }

  private async executeToolCall(call: LlmToolCall): Promise<string> {
    const name = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return `Error: could not parse arguments for ${name}.`;
    }

    const activity = this.startActivity(name, args);

    if (APPROVAL_REQUIRED.has(name)) {
      const reason =
        typeof args.reason === 'string' && args.reason.trim()
          ? args.reason.trim()
          : 'The agent wants to perform this action.';
      const approved = await this.requestApproval(reason, this.describeAction(name, args));
      if (!approved) {
        this.finishActivity(activity, 'denied', 'User denied this action');
        return 'The user denied this action. Do not retry it; ask the user how to proceed or finish with what you have.';
      }
    }

    this.setStatus('acting', name);
    try {
      const result = await this.dispatchTool(name, args);
      this.finishActivity(activity, 'ok');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finishActivity(activity, 'error', message);
      return `Error from ${name}: ${message}`;
    }
  }

  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tabId = Number(args.tabId);
    switch (name) {
      case 'list_tabs':
        return JSON.stringify(await browser.listTabs());
      case 'get_active_tab':
        return JSON.stringify(await browser.getActiveTab());
      case 'get_tab_content': {
        let content = await browser.getTabContent(tabId);
        if (content.extractionStatus === 'blocked' && content.metadata['ba:origin']) {
          // Pause so the user can grant access from the sidebar, then retry once.
          await this.pauseForPermission(content.metadata['ba:origin']);
          if (!this.stopRequested) content = await browser.getTabContent(tabId);
        }
        await this.pauseIfAuthRequired(content);
        return this.serializeContent(content, SINGLE_TAB_CHARS);
      }
      case 'get_all_tab_contents': {
        const contents = await browser.getAllTabContents();
        return JSON.stringify(contents.map((c) => this.contentForModel(c, MULTI_TAB_CHARS)));
      }
      case 'navigate':
        return JSON.stringify(await browser.navigate(tabId, String(args.url)));
      case 'search_web':
        return JSON.stringify(await browser.searchWeb(String(args.query)));
      case 'search_known_sites':
        return searchKnownSites(await getSites(), String(args.query));
      case 'set_plan':
        return this.setPlan(Array.isArray(args.steps) ? (args.steps as string[]).map(String) : []);
      case 'update_plan':
        return this.updatePlan(Number(args.step), args.status as PlanStepStatus);
      case 'record_finding':
        return this.recordFinding(String(args.text));
      case 'save_memory': {
        const entries = await getMemories();
        if (entries.length >= MEMORY_MAX_ENTRIES) {
          return `Error: memory is full (${MEMORY_MAX_ENTRIES} entries). Consolidate or delete entries before saving more.`;
        }
        const now = new Date().toISOString();
        const entry: MemoryEntry = {
          id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: String(args.text).trim(),
          createdAt: now,
          updatedAt: now,
        };
        await saveMemories([...entries, entry]);
        return `Saved memory [${entry.id}]: ${entry.text}`;
      }
      case 'update_memory': {
        const entries = await getMemories();
        const id = String(args.id);
        const entry = entries.find((e) => e.id === id);
        if (!entry) return `Error: no memory entry with id ${id}.`;
        entry.text = String(args.text).trim();
        entry.updatedAt = new Date().toISOString();
        await saveMemories(entries);
        return `Updated memory [${id}]: ${entry.text}`;
      }
      case 'delete_memory': {
        const entries = await getMemories();
        const id = String(args.id);
        if (!entries.some((e) => e.id === id)) return `Error: no memory entry with id ${id}.`;
        await saveMemories(entries.filter((e) => e.id !== id));
        return `Deleted memory [${id}].`;
      }
      case 'save_app_playbook': {
        const origin = normalizeHost(String(args.origin));
        if (!origin) return 'Error: a site origin is required to save an app playbook.';
        const skills = await getSkills();
        const playbook: Skill = {
          id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: String(args.name).trim() || 'playbook',
          description: String(args.description).trim(),
          body: String(args.body).trim(),
          origin,
        };
        // One playbook per site: replace any existing playbook bound to this
        // origin, regardless of name, so re-learning updates rather than duplicates.
        const idx = skills.findIndex((s) => s.origin === origin);
        const replaced = idx >= 0;
        if (replaced) {
          playbook.id = skills[idx].id;
          skills[idx] = playbook;
        } else {
          skills.push(playbook);
        }
        await saveSkills(skills);
        return `${replaced ? 'Updated' : 'Saved'} app playbook "${playbook.name}" for ${origin}. It will auto-activate on that site.`;
      }
      case 'use_skill': {
        const skills = await getSkills();
        const wanted = String(args.name).toLowerCase().replace(/^\//, '');
        const skill = skills.find((s) => s.name.toLowerCase() === wanted);
        if (!skill) {
          const available = skills.map((s) => s.name).join(', ') || '(none defined)';
          return `Error: no skill named "${wanted}". Available skills: ${available}`;
        }
        return `Skill "${skill.name}" loaded. Follow these instructions for the current task:\n\n${skill.body}`;
      }
      case 'get_element_map':
        return JSON.stringify((await browser.getElementMap(tabId)).slice(0, 120));
      case 'click_element':
        return JSON.stringify(await browser.clickElement(tabId, String(args.selectorOrRef)));
      case 'fill_input':
        return JSON.stringify(
          await browser.fillInput(tabId, String(args.selectorOrRef), String(args.value)),
        );
      case 'submit_form':
        return JSON.stringify(await browser.submitForm(tabId, String(args.selectorOrRef)));
      case 'run_javascript':
        return browser.runJavascript(tabId, String(args.code));
      case 'press_keys':
        return JSON.stringify(
          await browser.pressKeys(tabId, String(args.combo), args.targetRef ? String(args.targetRef) : undefined),
        );
      case 'wait_for_element':
        return JSON.stringify(
          await browser.waitForElement(
            tabId,
            String(args.selector),
            (args.state as 'present' | 'visible' | 'enabled') ?? 'visible',
            typeof args.timeoutMs === 'number' ? args.timeoutMs : 8000,
          ),
        );
      case 'click_at':
        return JSON.stringify(await browser.clickAt(tabId, Number(args.x), Number(args.y)));
      case 'drag':
        return JSON.stringify(
          await browser.drag(tabId, Number(args.fromX), Number(args.fromY), Number(args.toX), Number(args.toY)),
        );
      case 'scroll_wheel':
        return JSON.stringify(await browser.scrollWheel(tabId, Number(args.x), Number(args.y), Number(args.deltaY)));
      case 'wait_for_page_state':
        return JSON.stringify(await browser.waitForPageState(tabId));
      case 'detect_auth_state': {
        const state = await browser.detectAuthState(tabId);
        await this.pauseForAuth(state, tabId);
        return JSON.stringify(state);
      }
      default:
        return `Error: unknown tool ${name}.`;
    }
  }

  // ----- auth pause/resume -----

  private async pauseIfAuthRequired(content: PageContent): Promise<void> {
    if (content.extractionStatus !== 'auth_required') return;
    await this.pauseForAuth(
      { status: 'auth_required', loginUrl: content.url },
      content.tabId,
    );
  }

  private async pauseForAuth(state: AuthState, tabId: number): Promise<void> {
    if (state.status !== 'auth_required' || this.stopRequested) return;
    let origin = '';
    try {
      origin = new URL(state.loginUrl ?? (await chrome.tabs.get(tabId)).url ?? '').hostname;
    } catch {
      origin = 'this site';
    }
    const message = `Authentication required for ${origin}. Complete login in the browser, then click Resume.`;
    this.setStatus('auth_required', message);
    this.emit({ type: 'auth_required', origin, message });
    this.notice(message);
    await new Promise<void>((resolve) => {
      this.authWait = { origin, message, resolve };
    });
    if (!this.stopRequested) {
      this.notice('Resumed. Re-checking the page…');
      this.setStatus('acting');
    }
  }

  private async pauseForPermission(origin: string): Promise<void> {
    if (this.stopRequested) return;
    const message = `CANAgent needs access to ${origin.replace(/^https?:\/\//, '')} to read this page. Allow it to continue.`;
    this.setStatus('awaiting_approval', message);
    this.emit({ type: 'permission_required', origin, message });
    this.notice(message);
    await new Promise<void>((resolve) => {
      this.permissionWait = { origin, message, resolve };
    });
    if (!this.stopRequested) {
      this.notice('Access granted. Retrying…');
      this.setStatus('acting');
    }
  }

  // ----- approvals and pause -----

  private requestApproval(description: string, detail: string): Promise<boolean> {
    this.setStatus('awaiting_approval', description);
    const requestId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ type: 'approval_request', requestId, description, detail });
    return new Promise<boolean>((resolve) => {
      this.pendingApproval = { requestId, description, detail, resolve };
    });
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.pauseRequested) return;
    this.setStatus('paused');
    await new Promise<void>((resolve) => {
      this.pauseWaiter = resolve;
    });
  }

  // ----- working state (plan, findings, budget) -----

  private refreshSystemMessage(): void {
    if (this.conversation.length === 0) return;
    this.conversation[0] = { role: 'system', content: this.systemBase + this.buildStateBlock() };
  }

  private buildStateBlock(): string {
    const remaining = Math.max(0, this.stepBudget - this.stepsUsed);
    const lines: string[] = ['\n\n=== Working state (updated each step) ==='];
    if (this.activeTabLabel) lines.push(`Active tab: ${this.activeTabLabel}`);
    lines.push(`Steps: ${this.stepsUsed}/${this.stepBudget} used (${remaining} left).`);
    if (this.plan) {
      const icon: Record<PlanStepStatus, string> = {
        pending: '[ ]',
        in_progress: '[»]',
        done: '[x]',
        skipped: '[-]',
      };
      lines.push('Plan:');
      this.plan.forEach((s, i) => lines.push(`  ${icon[s.status]} ${i + 1}. ${s.text}`));
    } else {
      lines.push('Plan: none yet. If this task needs more than a couple of steps, call set_plan first.');
    }
    if (this.findings.length > 0) {
      lines.push('Findings so far:');
      this.findings.slice(-FINDINGS_SHOWN).forEach((f) => lines.push(`  - ${f}`));
    }
    if (remaining <= 3) {
      lines.push(
        'You are low on steps. Record any remaining findings and prepare to give your best final answer soon.',
      );
    }
    return lines.join('\n');
  }

  private setPlan(steps: string[]): string {
    this.plan = steps.filter((s) => s.trim()).map((text) => ({ text: text.trim(), status: 'pending' as PlanStepStatus }));
    this.emit({ type: 'plan_update', plan: this.planView() });
    return `Plan set with ${this.plan.length} steps.`;
  }

  private updatePlan(step: number, status: PlanStepStatus): string {
    if (!this.plan || step < 1 || step > this.plan.length) {
      return `Error: no plan step ${step}. Call set_plan first.`;
    }
    this.plan[step - 1].status = status;
    this.emit({ type: 'plan_update', plan: this.planView() });
    return `Step ${step} marked ${status}.`;
  }

  private recordFinding(text: string): string {
    const t = text.trim();
    if (!t) return 'Error: empty finding.';
    this.findings.push(t);
    return `Recorded. (${this.findings.length} findings so far.)`;
  }

  private planHasOpenSteps(): boolean {
    return this.plan?.some((s) => s.status === 'pending' || s.status === 'in_progress') ?? false;
  }

  // ----- helpers -----

  private buildContextBlock(): string {
    const snapshot = tabContext.getSnapshot();
    if (!snapshot) return '';
    const stale = tabContext.isStale(snapshot);
    const perTab = snapshot.tabs.length > 1 ? MULTI_TAB_CHARS : SINGLE_TAB_CHARS;
    const parts = snapshot.tabs.map((t, i) => {
      const body =
        t.extractionStatus === 'ok' || t.extractionStatus === 'partial'
          ? t.text.slice(0, perTab)
          : `(content unavailable: ${t.extractionStatus})`;
      return `[Tab ${i + 1}] tabId=${t.tabId} "${t.title}" ${t.url}\n${body}`;
    });
    return (
      `Context: the user has shared ${snapshot.tabs.length} tab(s) with you` +
      (stale ? ' (captured more than 5 minutes ago; may be stale — re-fetch if freshness matters)' : '') +
      `:\n\n${parts.join('\n\n---\n\n')}`
    );
  }

  private contentForModel(content: PageContent, maxChars: number): Record<string, unknown> {
    return {
      tabId: content.tabId,
      url: content.url,
      title: content.title,
      extractionStatus: content.extractionStatus,
      headings: content.headings.slice(0, 20),
      text: content.text.slice(0, maxChars),
      capturedAt: content.capturedAt,
    };
  }

  private serializeContent(content: PageContent, maxChars: number): string {
    return JSON.stringify({
      ...this.contentForModel(content, maxChars),
      links: content.links.slice(0, 40),
      metadata: content.metadata,
    });
  }

  private describeAction(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case 'get_all_tab_contents':
        return 'Read the contents of all open tabs';
      case 'click_element':
        return `Click element "${args.selectorOrRef}" on tab ${args.tabId}`;
      case 'fill_input':
        return `Type into element "${args.selectorOrRef}" on tab ${args.tabId}: "${String(args.value).slice(0, 80)}"`;
      case 'submit_form':
        return `Submit the form at "${args.selectorOrRef}" on tab ${args.tabId}`;
      case 'run_javascript':
        return `Run JavaScript on tab ${args.tabId}:\n${String(args.code).slice(0, 200)}`;
      case 'press_keys':
        return `Press "${args.combo}" on tab ${args.tabId}`;
      case 'click_at':
        return `Click at (${args.x}, ${args.y}) on tab ${args.tabId}`;
      case 'drag':
        return `Drag (${args.fromX}, ${args.fromY}) → (${args.toX}, ${args.toY}) on tab ${args.tabId}`;
      case 'save_app_playbook':
        return `Save app playbook "${args.name}" for ${normalizeHost(String(args.origin))}:\n${String(args.body).slice(0, 200)}`;
      default:
        return `${name} ${JSON.stringify(args).slice(0, 120)}`;
    }
  }

  private startActivity(tool: string, args: Record<string, unknown>): ToolActivity {
    const activity: ToolActivity = {
      id: `act-${++this.activityCounter}`,
      tool,
      argsSummary: JSON.stringify(args).slice(0, 200),
      status: 'running',
      timestamp: new Date().toISOString(),
    };
    this.activities.push(activity);
    this.emit({ type: 'tool_activity', activity });
    return activity;
  }

  private finishActivity(activity: ToolActivity, status: ToolActivity['status'], detail?: string): void {
    activity.status = status;
    activity.detail = detail;
    this.emit({ type: 'tool_activity', activity });
  }

  private pushChat(message: ChatMessageView): void {
    this.messages.push(message);
    this.emit({ type: 'chat_message', message });
  }

  private notice(text: string): void {
    this.pushChat({ role: 'notice', text, timestamp: new Date().toISOString() });
  }

  private setStatus(status: AgentStatus, detail?: string): void {
    this.status = status;
    this.emit({ type: 'status', status, detail });
  }
}

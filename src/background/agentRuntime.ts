import type { BackgroundEvent } from '../shared/messages';
import { TOOL_DEFINITIONS } from '../shared/schemas';
import type {
  AgentStatus,
  AuthState,
  ChatMessageView,
  PageContent,
  ToolActivity,
} from '../shared/types';
import type { SiteEntry } from '../shared/types';
import * as browser from './browserToolAdapter';
import { complete, type LlmMessage, type LlmToolCall } from './llmProvider';
import { getSettings, getSites } from './storage';
import * as tabContext from './tabContextManager';

const MAX_ITERATIONS = 16;
const SITES_PROMPT_LIMIT = 25;
const SINGLE_TAB_CHARS = 12000;
const MULTI_TAB_CHARS = 5000;

/** Tools that mutate page or browser state and therefore need user approval. */
const APPROVAL_REQUIRED = new Set([
  'click_element',
  'fill_input',
  'submit_form',
  'get_all_tab_contents', // reading all tabs needs explicit approval per spec
]);

const SYSTEM_PROMPT = `You are a browser agent running in a Chrome extension side panel. The browser is your primary tool environment.

Decision policy:
- Answer from your own knowledge when the question is general and stable and browser access would not materially improve the answer.
- Use browser tools when the user asks about the current page, open tabs, recent or site-specific information, data on websites, or authenticated systems (Jira, dashboards, etc.).
- Whenever an operation can be done through the browser, do it through the browser.
- When the user refers to "the page", "this article", "the site", or a web page without saying which one, assume they mean the currently active tab: call get_active_tab, then get_tab_content on it.

Working method:
- Use search_web for web searches; it opens the browser's default search engine. Read the results with get_tab_content, then navigate to the most relevant result.
- Before clicking, filling, or submitting anything, call get_element_map and act on refIds. State-changing actions require user approval; the runtime handles asking.
- If a page requires login, the task pauses automatically and the user is asked to sign in. After they resume, re-fetch the page content.
- If a tool reports missing permissions, tell the user which sidebar button to use (e.g. "Use all tabs") and stop.

Answer format:
- Format answers in Markdown (headings, lists, tables, links) — the sidebar renders it.
- Be concise. When your answer draws on tabs, end with a "Source tabs:" list, e.g.:
Source tabs:
[1] Jira - Project Board
[2] Example News Site - Article title
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
  private activityCounter = 0;

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
        ? { requestId: this.pendingApproval.requestId, description: this.pendingApproval.description }
        : null,
      authNotice: this.authWait ? { origin: this.authWait.origin, message: this.authWait.message } : null,
      permissionNotice: this.permissionWait
        ? { origin: this.permissionWait.origin, message: this.permissionWait.message }
        : null,
    };
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

    this.pushChat({ role: 'user', text, timestamp: new Date().toISOString() });
    this.running = true;
    this.stopRequested = false;
    this.pauseRequested = false;

    try {
      await this.runLoop(text);
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err));
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
      if (this.status !== 'error') this.setStatus('idle');
    }
  }

  stop(): void {
    this.stopRequested = true;
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

  private async runLoop(userText: string): Promise<void> {
    const settings = (await getSettings())!;

    // (Re)build the system message each task so directory edits apply immediately.
    const systemMessage: LlmMessage = {
      role: 'system',
      content: SYSTEM_PROMPT + sitesPromptBlock(await getSites()),
    };
    if (this.conversation.length === 0) {
      this.conversation.push(systemMessage);
    } else {
      this.conversation[0] = systemMessage;
    }

    const contextBlock = this.buildContextBlock();
    this.conversation.push({
      role: 'user',
      content: contextBlock ? `${contextBlock}\n\n${userText}` : userText,
    });

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (this.stopRequested) {
        this.notice('Task stopped.');
        return;
      }
      await this.waitIfPaused();
      if (this.stopRequested) return;

      this.setStatus('thinking');
      const reply = await complete(settings, this.conversation, TOOL_DEFINITIONS);

      if (!reply.tool_calls || reply.tool_calls.length === 0) {
        const text = reply.content ?? '(no response)';
        this.conversation.push({ role: 'assistant', content: text });
        this.pushChat({ role: 'assistant', text, timestamp: new Date().toISOString() });
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

      for (const call of reply.tool_calls) {
        if (this.stopRequested) {
          this.conversation.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Task stopped by user.',
          });
          continue;
        }
        const result = await this.executeToolCall(call);
        this.conversation.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }

    this.notice('Stopped: reached the maximum number of agent steps for one task.');
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
      const approved = await this.requestApproval(this.describeAction(name, args));
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

  private requestApproval(description: string): Promise<boolean> {
    this.setStatus('awaiting_approval', description);
    const requestId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ type: 'approval_request', requestId, description });
    return new Promise<boolean>((resolve) => {
      this.pendingApproval = { requestId, description, resolve };
    });
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.pauseRequested) return;
    this.setStatus('paused');
    await new Promise<void>((resolve) => {
      this.pauseWaiter = resolve;
    });
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

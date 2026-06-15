// =============================================================================
// Browser tool adapter — the bridge between the agent's abstract tools and the
// real `chrome.*` APIs. Every entry here is the implementation of one tool that
// `agentRuntime`'s dispatch switch invokes (e.g. `get_tab_content`,
// `navigate`, `click_element`, `run_javascript`, `list_webmcp_tools`).
//
// Two execution styles appear throughout:
//   - Tab/navigation/group queries go straight through `chrome.tabs` etc.
//   - DOM reads and page actions are injected into the page with
//     `chrome.scripting.executeScript`. Plain inspection runs the bundled
//     `contentScript.js` (isolated world); anything that must see the page's
//     own JS (run_javascript, WebMCP) runs a `func` in `world: 'MAIN'` and can
//     only return JSON-serializable values across that boundary.
//
// Convention: functions return either typed results or, for the script-injected
// tools, a JSON string whose `{ __error }` shape signals failure without
// throwing — so the agent loop always gets a readable tool result.
// =============================================================================

import type { ContentRequest } from '../shared/messages';
import type {
  ActionResult,
  AuthState,
  ElementRef,
  NavigationResult,
  PageContent,
  PageStateResult,
  TabSummary,
} from '../shared/types';
import { analyzeAuthState } from './authDetector';
import { extractOffice, extractPdf } from './offscreenClient';
import { hasAllUrlsAccess } from './permissions';

const PAGE_LOAD_TIMEOUT_MS = 20000;

function toTabSummary(tab: chrome.tabs.Tab, groupTitles?: Map<number, string>): TabSummary {
  const groupId = tab.groupId !== undefined && tab.groupId !== -1 ? tab.groupId : undefined;
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active,
    groupId,
    group: groupId !== undefined ? groupTitles?.get(groupId) : undefined,
  };
}

async function groupTitleMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    for (const g of await chrome.tabGroups.query({})) {
      if (g.title) map.set(g.id, g.title);
    }
  } catch {
    // tabGroups may be unavailable; ignore.
  }
  return map;
}

function emptyContent(
  tabId: number,
  url: string,
  title: string,
  status: PageContent['extractionStatus'],
  note: string,
): PageContent {
  return {
    tabId,
    url,
    title,
    text: '',
    metadata: { 'ba:note': note },
    links: [],
    headings: [],
    extractionStatus: status,
    capturedAt: new Date().toISOString(),
  };
}

function isRestrictedUrl(url: string): boolean {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-untrusted):/.test(url);
}

async function sendToTab<T>(tabId: number, request: ContentRequest): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, request)) as T;
}

/** Inject the content script if it is not already present in the tab. */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendToTab(tabId, { kind: 'ba_ping' });
    return;
  } catch {
    // Not injected yet.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] });
}

export async function listTabs(): Promise<TabSummary[]> {
  const [tabs, titles] = await Promise.all([chrome.tabs.query({}), groupTitleMap()]);
  return tabs.filter((t) => t.id !== undefined).map((t) => toTabSummary(t, titles));
}

/**
 * Resolve the user's active tab resiliently. `lastFocusedWindow` can briefly
 * return nothing when the side panel itself holds focus, so fall back to the
 * current window and finally to any active tab (preferring a real web page over
 * a chrome:// surface). Returns undefined only when there is genuinely no
 * active tab anywhere.
 */
async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true });
    tab = tabs.find((t) => /^https?:/i.test(t.url ?? '')) ?? tabs[0];
  }
  return tab;
}

export async function getActiveTab(): Promise<TabSummary> {
  const tab = await queryActiveTab();
  if (!tab) throw new Error('No active tab found.');
  return toTabSummary(tab, await groupTitleMap());
}

export async function getTabContent(tabId: number): Promise<PageContent> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return emptyContent(tabId, '', '', 'unsupported', 'Tab no longer exists.');
  }
  const url = tab.url ?? '';
  const title = tab.title ?? '';
  if (isRestrictedUrl(url)) {
    return emptyContent(tabId, url, title, 'unsupported', 'Browser-internal pages cannot be read.');
  }
  try {
    await ensureContentScript(tabId);
    const extracted = await sendToTab<Omit<PageContent, 'tabId'>>(tabId, { kind: 'ba_extract' });
    const content: PageContent = { tabId, ...extracted };
    // Flag auth walls at extraction time so callers see it immediately.
    if (analyzeAuthState(content).status === 'auth_required') {
      content.extractionStatus = 'auth_required';
    }
    return content;
  } catch (err) {
    const message = String(err);
    const status = /Cannot access|cannot be scripted|permission/i.test(message)
      ? 'blocked'
      : 'unsupported';
    const content = emptyContent(
      tabId,
      url,
      title,
      status,
      status === 'blocked'
        ? 'No permission to read this tab. The user can grant access with "Use all tabs" or "Allow this site".'
        : `Extraction failed: ${message}`,
    );
    if (status === 'blocked') {
      // Lets the runtime pause and ask the user to grant this origin inline.
      try {
        content.metadata['ba:origin'] = new URL(url).origin;
      } catch {
        // No usable origin; the model gets the blocked note as-is.
      }
    }
    return content;
  }
}

export async function getAllTabContents(): Promise<PageContent[]> {
  if (!(await hasAllUrlsAccess())) {
    throw new Error(
      'Reading all tabs requires broader access. Ask the user to click "Use all tabs" in the sidebar to grant it.',
    );
  }
  const tabs = await listTabs();
  return Promise.all(tabs.map((t) => getTabContent(t.tabId)));
}

function waitForTabComplete(tabId: number, timeoutMs = PAGE_LOAD_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
    // The tab may already be loaded.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish(true);
      })
      .catch(() => finish(false));
  });
}

export async function navigate(tabId: number, url: string): Promise<NavigationResult> {
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (err) {
    return { tabId, url, title: '', status: 'error', error: String(err) };
  }
  // Wait for the navigation to start before watching for completion.
  await new Promise((r) => setTimeout(r, 300));
  const complete = await waitForTabComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId,
    url: tab.url ?? url,
    title: tab.title ?? '',
    status: complete ? 'complete' : 'timeout',
  };
}

/**
 * Search using the browser's default search engine in a new tab, per spec.
 * Results are read back through getTabContent.
 */
export async function searchWeb(query: string): Promise<NavigationResult> {
  await chrome.search.query({ text: query, disposition: 'NEW_TAB' });
  // chrome.search.query does not return the tab; the new results tab becomes
  // the active tab in the current window.
  await new Promise((r) => setTimeout(r, 500));
  const tab = await queryActiveTab();
  if (!tab?.id) {
    return { tabId: -1, url: '', title: '', status: 'error', error: 'Could not locate the search results tab.' };
  }
  const complete = await waitForTabComplete(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  return {
    tabId: tab.id,
    url: loaded.url ?? '',
    title: loaded.title ?? '',
    status: complete ? 'complete' : 'timeout',
  };
}

// Open a URL in a new background tab (caller adds it to the conversation group).
export async function openUrl(url: string): Promise<NavigationResult> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    return { tabId: -1, url, title: '', status: 'error', error: String(err) };
  }
  if (!tab.id) return { tabId: -1, url, title: '', status: 'error', error: 'Tab not created.' };
  const complete = await waitForTabComplete(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  return {
    tabId: tab.id,
    url: loaded.url ?? url,
    title: loaded.title ?? '',
    status: complete ? 'complete' : 'timeout',
  };
}

const GROUP_COLORS: chrome.tabGroups.ColorEnum[] = [
  'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink', 'purple',
];

function colorForName(name: string): chrome.tabGroups.ColorEnum {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/**
 * Add a tab to the conversation's group, creating the group (with title+color)
 * if needed. Returns the live group id (may differ if a stale group was gone).
 */
export async function groupTab(
  tabId: number,
  name: string,
  existingGroupId: number | null,
): Promise<number | null> {
  if (existingGroupId !== null) {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroupId });
      return existingGroupId;
    } catch {
      // Group was closed — fall through and recreate.
    }
  }
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: name, color: colorForName(name) });
    return groupId;
  } catch {
    return null; // grouping unavailable; non-fatal
  }
}

/** True if a live tab group already uses this title (case-insensitive). */
export async function groupTitleTaken(name: string): Promise<boolean> {
  const lower = name.toLowerCase();
  try {
    return (await chrome.tabGroups.query({})).some((g) => (g.title ?? '').toLowerCase() === lower);
  } catch {
    return false;
  }
}

export async function readTabGroup(name: string | undefined, groupId: number | null): Promise<string> {
  let targetId = groupId ?? undefined;
  if (name) {
    const lower = name.toLowerCase();
    try {
      const match = (await chrome.tabGroups.query({})).find(
        (g) => (g.title ?? '').toLowerCase() === lower,
      );
      targetId = match?.id;
    } catch {
      targetId = undefined;
    }
  }
  if (targetId === undefined) {
    return JSON.stringify({ error: `No tab group${name ? ` named "${name}"` : ''} found.` });
  }
  const tabs = await chrome.tabs.query({ groupId: targetId });
  if (tabs.length === 0) return JSON.stringify({ error: 'That tab group has no tabs.' });
  const results = await Promise.all(
    tabs.filter((t) => t.id !== undefined).map((t) => getTabContent(t.id!)),
  );
  return JSON.stringify({
    group: name,
    count: results.length,
    results: results.map((c) => ({
      tabId: c.tabId,
      url: c.url,
      title: c.title,
      extractionStatus: c.extractionStatus,
      text: c.text.slice(0, 6000),
    })),
  });
}

export async function getElementMap(tabId: number): Promise<ElementRef[]> {
  await ensureContentScript(tabId);
  return sendToTab<ElementRef[]>(tabId, { kind: 'ba_element_map' });
}

export async function readAppContent(tabId: number): Promise<string> {
  await ensureContentScript(tabId);
  const result = await sendToTab<{ method: string; text: string; truncated: boolean }>(tabId, {
    kind: 'ba_app_content',
  });
  if (result.method === 'none' || !result.text) {
    return JSON.stringify({
      method: 'none',
      note: 'No extractable text — the content is likely canvas-rendered. Use the snapshot tool and read it with vision.',
    });
  }
  return JSON.stringify(result);
}

export async function clickElement(tabId: number, selectorOrRef: string): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_click', refIdOrSelector: selectorOrRef });
}

export async function fillInput(
  tabId: number,
  selectorOrRef: string,
  value: string,
): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_fill', refIdOrSelector: selectorOrRef, value });
}

export async function submitForm(tabId: number, selectorOrRef: string): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_submit', refIdOrSelector: selectorOrRef });
}

export async function pressKeys(tabId: number, combo: string, targetRef?: string): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_press_keys', combo, targetRef });
}

export async function waitForElement(
  tabId: number,
  selector: string,
  state: 'present' | 'visible' | 'enabled',
  timeoutMs: number,
): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_wait', selector, state, timeoutMs });
}

export async function clickAt(tabId: number, x: number, y: number): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_click_at', x, y });
}

export async function drag(
  tabId: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_drag', fromX, fromY, toX, toY });
}

export async function scrollWheel(tabId: number, x: number, y: number, deltaY: number): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_wheel', x, y, deltaY });
}

export async function scrollStep(tabId: number): Promise<{ scrolled: boolean; atBottom: boolean }> {
  await ensureContentScript(tabId);
  return sendToTab<{ scrolled: boolean; atBottom: boolean }>(tabId, { kind: 'ba_scroll_step' });
}

export async function waitForPageState(tabId: number): Promise<PageStateResult> {
  const complete = await waitForTabComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { tabId, state: complete ? 'complete' : 'timeout', url: tab.url ?? '' };
}

const MAX_JS_RESULT_CHARS = 10000;

// Runs in the page's MAIN world. Arbitrary code via eval, so the result of the
// last expression flows back. Wrapped in async so `await` works. Note: pages
// whose CSP forbids unsafe-eval will throw here — returned as __error, not a crash.
function jsRunner(src: string): Promise<string> {
  return (async () => {
    try {
      // eslint-disable-next-line no-eval
      const result = await (0, eval)(src);
      return JSON.stringify(result ?? null);
    } catch (e) {
      return JSON.stringify({ __error: String(e) });
    }
  })();
}

export async function runJavascript(tabId: number, code: string): Promise<string> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return JSON.stringify({ __error: 'Tab no longer exists.' });
  }
  if (isRestrictedUrl(tab.url ?? '')) {
    return JSON.stringify({ __error: 'Cannot run scripts on browser-internal pages.' });
  }
  let injection: chrome.scripting.InjectionResult<string>[];
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: jsRunner,
      args: [code],
    });
  } catch (err) {
    const message = String(err);
    const note = /Cannot access|cannot be scripted|permission/i.test(message)
      ? 'No permission to run scripts on this tab. The user can grant access with "Allow this site".'
      : message;
    return JSON.stringify({ __error: note });
  }
  let out = injection[0]?.result ?? 'null';
  if (out.length > MAX_JS_RESULT_CHARS) {
    out = out.slice(0, MAX_JS_RESULT_CHARS) + ' …[truncated]';
  }
  return out;
}

// Runs in the page's MAIN world: read the WebMCP registry the bridge populated.
function webmcpListRunner(): string {
  try {
    const reg = (window as unknown as { __CANAGENT_WEBMCP__?: { tools?: Map<string, unknown> } })
      .__CANAGENT_WEBMCP__;
    const tools = reg?.tools ? Array.from(reg.tools.values()) : [];
    return JSON.stringify(
      tools.map((t) => {
        const tool = t as { name?: string; description?: string; inputSchema?: unknown };
        return { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? null };
      }),
    );
  } catch (e) {
    return JSON.stringify({ __error: String(e) });
  }
}

// Runs in the page's MAIN world: invoke a registered WebMCP tool's handler.
function webmcpCallRunner(name: string, args: unknown): Promise<string> {
  return (async () => {
    try {
      const reg = (window as unknown as { __CANAGENT_WEBMCP__?: { tools?: Map<string, unknown> } })
        .__CANAGENT_WEBMCP__;
      const tool = reg?.tools?.get(name) as { execute?: (a: unknown) => unknown } | undefined;
      if (!tool || typeof tool.execute !== 'function') {
        return JSON.stringify({ __error: `No WebMCP tool named "${name}" on this page.` });
      }
      const result = await tool.execute(args);
      return JSON.stringify(result ?? null);
    } catch (e) {
      return JSON.stringify({ __error: String(e) });
    }
  })();
}

export async function listWebmcpTools(tabId: number): Promise<string> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return JSON.stringify({ __error: 'Tab no longer exists.' });
  }
  if (isRestrictedUrl(tab.url ?? '')) {
    return JSON.stringify({ __error: 'Cannot inspect browser-internal pages.' });
  }
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: webmcpListRunner,
    });
    return injection[0]?.result ?? '[]';
  } catch (err) {
    return JSON.stringify({ __error: String(err) });
  }
}

export async function callWebmcpTool(
  tabId: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return JSON.stringify({ __error: 'Tab no longer exists.' });
  }
  if (isRestrictedUrl(tab.url ?? '')) {
    return JSON.stringify({ __error: 'Cannot run scripts on browser-internal pages.' });
  }
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: webmcpCallRunner,
      args: [name, args ?? {}],
    });
    let out = injection[0]?.result ?? 'null';
    if (out.length > MAX_JS_RESULT_CHARS) out = out.slice(0, MAX_JS_RESULT_CHARS) + ' …[truncated]';
    return out;
  } catch (err) {
    return JSON.stringify({ __error: String(err) });
  }
}

export async function readPdf(tabId: number | undefined, url: string | undefined): Promise<string> {
  let target = url;
  if (!target) {
    try {
      const tab = tabId ? await chrome.tabs.get(tabId) : await queryActiveTab();
      target = tab?.url;
    } catch {
      // fall through
    }
  }
  if (!target) return JSON.stringify({ error: 'No URL or tab provided to read a PDF from.' });
  // Cap what we put in the model's context; ingestion (add_to_repo) reads the
  // whole document instead.
  const READ_PDF_CONTEXT_CHARS = 60_000;
  const result = await extractPdf(target, READ_PDF_CONTEXT_CHARS);
  if (!result.ok) return JSON.stringify({ url: target, error: result.error });
  return JSON.stringify({
    url: target,
    pageCount: result.pageCount,
    charCount: result.charCount,
    truncated: result.truncated,
    note: result.truncated
      ? `Only the first ~${READ_PDF_CONTEXT_CHARS.toLocaleString()} characters are shown (full document is ${result.charCount?.toLocaleString()} chars). To search the entire PDF, ingest it with add_to_repo and query it with search_repo.`
      : undefined,
    text: result.text,
  });
}

export async function readOfficeDocument(
  tabId: number | undefined,
  url: string | undefined,
): Promise<string> {
  let target = url;
  if (!target) {
    try {
      const tab = tabId ? await chrome.tabs.get(tabId) : await queryActiveTab();
      target = tab?.url;
    } catch {
      // fall through
    }
  }
  if (!target) return JSON.stringify({ error: 'No URL or tab provided to read an Office file from.' });
  // Cap context like read_pdf; ingestion (add_to_repo) reads the whole document.
  const READ_DOC_CONTEXT_CHARS = 60_000;
  const result = await extractOffice(target, READ_DOC_CONTEXT_CHARS);
  if (!result.ok) return JSON.stringify({ url: target, error: result.error });
  return JSON.stringify({
    url: target,
    format: result.format,
    charCount: result.charCount,
    truncated: result.truncated,
    note: result.truncated
      ? `Only the first ~${READ_DOC_CONTEXT_CHARS.toLocaleString()} characters are shown (full document is ${result.charCount?.toLocaleString()} chars). To search the entire document, ingest it with add_to_repo and query it with search_repo.`
      : undefined,
    text: result.text,
  });
}

// Turn SharePoint's HitHighlightedSummary (with <c0>…</c0> highlights and
// <ddd/> ellipses) into plain text. No DOM in the service worker, so regex.
function cleanSummary(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<ddd\/>/g, '…')
    .replace(/<\/?c\d+>/g, '') // keep the highlighted term text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// SharePoint encodes people as claims tokens like
// "i:0#.f|membership|jane@contoso.com | Jane Smith". Pull a readable name/email.
function cleanUser(raw: string): string | undefined {
  if (!raw) return undefined;
  // Multi-valued props are ';'-separated; take the first principal.
  const first = raw.split(/;\s*/)[0].trim();
  const name = first.includes('|') ? first.split('|').pop()!.trim() : first;
  return name || undefined;
}

interface SharepointSearchOptions {
  query?: string;
  top?: number;
  sortBy?: 'relevance' | 'modified';
  editedByMe?: boolean;
}

async function currentSharepointUser(
  base: string,
): Promise<{ title?: string; email?: string } | { error: string }> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/_api/web/currentuser`, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=nometadata' },
    });
    if (!res.ok) {
      return { error: `Could not determine the signed-in user (HTTP ${res.status}).` };
    }
    const u = (await res.json()) as { Title?: string; Email?: string };
    if (!u.Title && !u.Email) return { error: 'Signed-in user has no name/email.' };
    return { title: u.Title, email: u.Email };
  } catch (err) {
    return { error: `Could not determine the signed-in user: ${String(err)}` };
  }
}

export async function sharepointSearch(base: string, opts: SharepointSearchOptions): Promise<string> {
  const rowlimit = Math.min(25, Math.max(1, opts.top || 10));
  const terms = (opts.query ?? '').replace(/'/g, ' ').trim();

  // Build the KQL querytext. With no terms, scope to documents so a pure
  // "recent files" listing has something to sort.
  const clauses: string[] = [];
  if (terms) clauses.push(terms);

  if (opts.editedByMe) {
    const me = await currentSharepointUser(base);
    if ('error' in me) {
      return JSON.stringify({
        error: `${me.error} Open a tab on ${base} and make sure you are signed in, then retry.`,
      });
    }
    if (me.title) clauses.push(`Editor:"${me.title.replace(/"/g, '')}"`);
  }
  if (clauses.length === 0) clauses.push('IsDocument:1');
  const queryText = clauses.join(' ');

  const props =
    'Title,Path,HitHighlightedSummary,FileType,FileExtension,LastModifiedTime,Author,Editor,EditorOWSUSER';
  let url =
    `${base.replace(/\/+$/, '')}/_api/search/query` +
    `?querytext='${encodeURIComponent(queryText)}'` +
    `&rowlimit=${rowlimit}` +
    `&selectproperties='${encodeURIComponent(props)}'` +
    `&clienttype='ContentSearchRegular'`;
  if (opts.sortBy === 'modified') {
    url += `&sortlist='${encodeURIComponent('LastModifiedTime:descending')}'`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=nometadata' },
    });
  } catch (err) {
    return JSON.stringify({ error: `Could not reach SharePoint at ${base}: ${String(err)}` });
  }
  if (!res.ok) {
    return JSON.stringify({
      error: `SharePoint search failed (HTTP ${res.status}). Make sure you are signed into ${base} in this browser, and that the base URL is correct.`,
    });
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return JSON.stringify({ error: 'SharePoint returned a non-JSON response (are you signed in?).' });
  }
  const rows =
    (data as { PrimaryQueryResult?: { RelevantResults?: { Table?: { Rows?: Array<{ Cells?: Array<{ Key: string; Value: string }> }> } } } })
      ?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? [];
  const results = rows
    .map((row) => {
      const c: Record<string, string> = {};
      for (const cell of row.Cells ?? []) c[cell.Key] = cell.Value;
      return {
        title: c.Title || c.Path || '(untitled)',
        url: c.Path,
        snippet: cleanSummary(c.HitHighlightedSummary),
        fileType: c.FileType || c.FileExtension || undefined,
        createdBy: cleanUser(c.Author),
        modifiedBy: cleanUser(c.Editor) || cleanUser(c.EditorOWSUSER),
        modified: c.LastModifiedTime || undefined,
      };
    })
    .filter((r) => r.url);
  return JSON.stringify({
    base,
    query: queryText,
    sortBy: opts.sortBy ?? 'relevance',
    editedByMe: Boolean(opts.editedByMe),
    count: results.length,
    results,
  });
}

export async function detectAuthState(tabId: number): Promise<AuthState> {
  const content = await getTabContent(tabId);
  if (content.extractionStatus === 'blocked') {
    return { status: 'blocked', reason: content.metadata['ba:note'] };
  }
  if (content.extractionStatus === 'unsupported') {
    return { status: 'unknown', reason: content.metadata['ba:note'] };
  }
  return analyzeAuthState(content);
}

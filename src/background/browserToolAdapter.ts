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
import { hasAllUrlsAccess } from './permissions';

const PAGE_LOAD_TIMEOUT_MS = 20000;

function toTabSummary(tab: chrome.tabs.Tab): TabSummary {
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active,
  };
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
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.id !== undefined).map(toTabSummary);
}

export async function getActiveTab(): Promise<TabSummary> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab found.');
  return toTabSummary(tab);
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
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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

export async function getElementMap(tabId: number): Promise<ElementRef[]> {
  await ensureContentScript(tabId);
  return sendToTab<ElementRef[]>(tabId, { kind: 'ba_element_map' });
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

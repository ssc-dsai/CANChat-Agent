// Sender trust for chrome.runtime messaging.
//
// Content scripts run on every site, so a compromised web renderer can send any
// runtime message the content script could. The browser fills in
// `MessageSender.id`/`url`/`origin` from the sending frame, so they cannot be
// forged by page code: an extension page's URL is inside the extension origin,
// a content script's URL is the web page it runs in.
//
// Kept free of `chrome.*` so it unit-tests in node: callers pass the extension
// identity (`chrome.runtime.id`, `chrome.runtime.getURL('')`).

export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
  tab?: unknown;
}

export interface ExtensionIdentity {
  /** `chrome.runtime.id` */
  id: string;
  /** `chrome.runtime.getURL('')`, e.g. `chrome-extension://<id>/` */
  root: string;
}

/**
 * - `extension_page`: our own side panel, workspace/notebook tabs, offscreen
 *   document, or the service worker. Extension pages opened with
 *   `chrome.tabs.create` (workspace.html, notebooks.html) do carry `sender.tab`,
 *   so trust is decided by URL, not by the absence of a tab.
 * - `content_script`: our content script running inside a web page tab.
 * - `foreign`: anything else (another extension, missing identity, ...).
 */
export type SenderKind = 'extension_page' | 'content_script' | 'foreign';

// `chrome-extension://<id>/` -> `chrome-extension://<id>`. Done by hand because
// `URL.origin` is "null" for non-special schemes outside Chrome.
function rootOrigin(root: string): string {
  return root.replace(/\/+$/, '');
}

export function classifySender(sender: SenderLike | undefined | null, ext: ExtensionIdentity): SenderKind {
  if (!sender || !ext.id || !ext.root || sender.id !== ext.id) return 'foreign';
  const url = typeof sender.url === 'string' ? sender.url : '';
  if (url && url.startsWith(ext.root)) {
    // Belt and braces: when Chrome supplies `origin`, it must agree.
    if (sender.origin === undefined || sender.origin === rootOrigin(ext.root)) return 'extension_page';
    return 'foreign';
  }
  if (sender.tab) return 'content_script';
  return 'foreign';
}

/**
 * The offscreen document only ever hears from the service worker, so it accepts
 * extension-origin senders that are not running in a tab.
 */
export function isExtensionBackgroundSender(sender: SenderLike | undefined | null, ext: ExtensionIdentity): boolean {
  return classifySender(sender, ext) === 'extension_page' && !sender?.tab;
}

/**
 * The only runtime message types our content scripts send
 * (src/content/interactionRecorder.ts). Every other type — vault ops, repo /
 * knowledge-base export/import/delete, scheduled tasks, triggers, settings,
 * providers, projects, memory — is restricted to extension pages.
 */
export const CONTENT_SCRIPT_MESSAGE_TYPES: ReadonlySet<string> = new Set(['learn_record_event']);

/** Long-lived port names, each accepted only from extension pages. */
export const EXTENSION_PAGE_PORT_NAMES: ReadonlySet<string> = new Set(['sidebar']);

export type Authorization = { ok: true; kind: SenderKind } | { ok: false; kind: SenderKind; error: string };

export function authorizeRuntimeMessage(
  type: string,
  sender: SenderLike | undefined | null,
  ext: ExtensionIdentity,
): Authorization {
  const kind = classifySender(sender, ext);
  if (kind === 'extension_page') return { ok: true, kind };
  if (kind === 'content_script' && CONTENT_SCRIPT_MESSAGE_TYPES.has(type)) return { ok: true, kind };
  return {
    ok: false,
    kind,
    error:
      kind === 'content_script'
        ? `Message type "${type}" is restricted to CANChat extension pages.`
        : 'Message rejected: sender is not part of this extension.',
  };
}

export function authorizePort(name: string, sender: SenderLike | undefined | null, ext: ExtensionIdentity): boolean {
  return EXTENSION_PAGE_PORT_NAMES.has(name) && classifySender(sender, ext) === 'extension_page';
}

/**
 * A content script's self-reported page host must match the frame Chrome says
 * sent the message, so a script on one site cannot inject learn-mode steps for
 * another site.
 */
export function senderHostMatches(sender: SenderLike | undefined | null, host: string): boolean {
  if (!sender?.url || !host) return false;
  try {
    return new URL(sender.url).hostname.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

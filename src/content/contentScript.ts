// =============================================================================
// Content script — the in-page message handler. Injected on demand by
// `browserToolAdapter` (via `chrome.scripting.executeScript`) into the page's
// ISOLATED world, where it can read/drive the DOM but not the page's own JS
// globals (that's what the MAIN-world `run_javascript`/WebMCP paths are for).
//
// It listens for `ContentRequest` messages and delegates each to the primitives
// in `domExtractor` (extract page, build element map, click/fill/submit, scroll,
// wait). Built as a single self-contained IIFE (see `vite.content.config.ts`)
// because injected scripts can't have runtime imports.
// =============================================================================

import type { ContentRequest } from '../shared/messages';
import type { PointerTarget } from '../shared/types';
import {
  buildElementMap,
  clickAt,
  clickElement,
  drag,
  extractPage,
  fillInput,
  pressKeys,
  readAppContent,
  scrollStep,
  scrollWheel,
  submitForm,
  waitForElement,
} from './domExtractor';

type MessageHandler = (
  request: ContentRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

declare global {
  interface Window {
    __browserAgentInjected?: boolean;
    __browserAgentHandler?: MessageHandler;
    __browserAgentPointerTarget?: PointerTarget | null;
  }
}

// Re-register on every injection rather than short-circuiting on a boolean flag.
//
// The old `if (!window.__browserAgentInjected)` guard made re-injection a no-op
// once the flag was set — but the flag outlives the *listener*. After an
// extension reload/update the previous content script is orphaned ("Extension
// context invalidated"): its listener is dead while the flag is still true, so
// executeScript would silently register nothing and that tab could never be read
// again. chrome.tabs.sendMessage then resolves `undefined` (it does not reject),
// which used to surface as a bogus "extraction failed" on every site.
//
// Removing the prior handler before adding the new one keeps double-injection
// from registering two listeners (which would double-call sendResponse).
{
  const prior = window.__browserAgentHandler;
  if (prior) {
    try {
      chrome.runtime.onMessage.removeListener(prior);
    } catch {
      // Prior context already invalidated — nothing to remove.
    }
  }

  const handler: MessageHandler = (request: ContentRequest, _sender, sendResponse) => {
    try {
      switch (request.kind) {
        case 'ba_ping':
          sendResponse({ ok: true });
          break;
        case 'ba_extract':
          sendResponse(extractPage());
          break;
        case 'ba_app_content':
          sendResponse(readAppContent());
          break;
        case 'ba_scroll_step':
          sendResponse(scrollStep());
          break;
        case 'ba_element_map':
          sendResponse(buildElementMap());
          break;
        case 'ba_get_pointer_target':
          if (window.__browserAgentPointerTarget) {
            sendResponse({ ok: true, target: window.__browserAgentPointerTarget });
          } else {
            return false;
          }
          break;
        case 'ba_click':
          sendResponse(clickElement(request.refIdOrSelector));
          break;
        case 'ba_fill':
          sendResponse(fillInput(request.refIdOrSelector, request.value));
          break;
        case 'ba_submit':
          sendResponse(submitForm(request.refIdOrSelector));
          break;
        case 'ba_press_keys':
          sendResponse(pressKeys(request.combo, request.targetRef));
          break;
        case 'ba_click_at':
          sendResponse(clickAt(request.x, request.y));
          break;
        case 'ba_drag':
          sendResponse(drag(request.fromX, request.fromY, request.toX, request.toY));
          break;
        case 'ba_wheel':
          sendResponse(scrollWheel(request.x, request.y, request.deltaY));
          break;
        case 'ba_wait':
          // Async: keep the message channel open until the wait resolves.
          waitForElement(request.selector, request.state, request.timeoutMs).then(sendResponse);
          return true;
      }
    } catch (err) {
      // Marked with `ok: false` so the background can tell a genuine in-page
      // failure apart from a missing listener, and report the real reason.
      sendResponse({ ok: false, detail: String(err) });
    }
    return false;
  };

  window.__browserAgentHandler = handler;
  window.__browserAgentInjected = true;
  chrome.runtime.onMessage.addListener(handler);
}

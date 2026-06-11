import type { ContentRequest } from '../shared/messages';
import {
  buildElementMap,
  clickAt,
  clickElement,
  drag,
  extractPage,
  fillInput,
  pressKeys,
  scrollWheel,
  submitForm,
  waitForElement,
} from './domExtractor';

declare global {
  interface Window {
    __browserAgentInjected?: boolean;
  }
}

// Guard against double injection: ensureContentScript pings first, but a
// navigation race can still inject twice.
if (!window.__browserAgentInjected) {
  window.__browserAgentInjected = true;

  chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
    try {
      switch (request.kind) {
        case 'ba_ping':
          sendResponse({ ok: true });
          break;
        case 'ba_extract':
          sendResponse(extractPage());
          break;
        case 'ba_element_map':
          sendResponse(buildElementMap());
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
      sendResponse({ ok: false, detail: String(err) });
    }
    return false;
  });
}

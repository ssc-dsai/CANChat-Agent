import type { ContentRequest } from '../shared/messages';
import {
  buildElementMap,
  clickElement,
  extractPage,
  fillInput,
  submitForm,
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
      }
    } catch (err) {
      sendResponse({ ok: false, detail: String(err) });
    }
    return false;
  });
}

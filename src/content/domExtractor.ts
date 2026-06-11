import type {
  ActionResult,
  ElementRef,
  HeadingSummary,
  LinkSummary,
  PageContent,
} from '../shared/types';
import { pickMainContent, readableText } from './readabilityExtractor';

const MAX_TEXT_CHARS = 20000;
const MAX_LINKS = 100;
const MAX_HEADINGS = 50;

function extractMetadata(): Record<string, string> {
  const metadata: Record<string, string> = {};
  document.querySelectorAll('meta[name], meta[property]').forEach((m) => {
    const key = m.getAttribute('name') ?? m.getAttribute('property') ?? '';
    const value = m.getAttribute('content') ?? '';
    if (key && value && !(key in metadata)) metadata[key] = value.slice(0, 500);
  });

  // Auth-detection hints consumed by the background authDetector.
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  metadata['ba:hasPasswordInput'] = String(passwordInputs.length > 0);
  const loginForm = Array.from(document.querySelectorAll('form')).some((f) => {
    const t = (f.textContent ?? '').toLowerCase();
    return (
      f.querySelector('input[type="password"]') !== null ||
      /sign in|log in|login|authenticate/.test(t)
    );
  });
  metadata['ba:hasLoginForm'] = String(loginForm);
  return metadata;
}

function extractHeadings(): HeadingSummary[] {
  return Array.from(document.querySelectorAll('h1, h2, h3'))
    .slice(0, MAX_HEADINGS)
    .map((h) => ({
      level: Number(h.tagName.slice(1)),
      text: (h.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }))
    .filter((h) => h.text.length > 0);
}

function extractLinks(): LinkSummary[] {
  const seen = new Set<string>();
  const links: LinkSummary[] = [];
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = a.href;
    if (!href.startsWith('http') || seen.has(href)) continue;
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 150);
    if (!text) continue;
    seen.add(href);
    links.push({ text, href });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

export function extractPage(): Omit<PageContent, 'tabId'> {
  const main = pickMainContent(document);
  let text = readableText(main);
  let extractionStatus: PageContent['extractionStatus'] = 'ok';
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    extractionStatus = 'partial';
  }
  return {
    url: location.href,
    title: document.title,
    text,
    metadata: extractMetadata(),
    links: extractLinks(),
    headings: extractHeadings(),
    extractionStatus,
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Element map for controlled page interaction. refIds are stable for the
// lifetime of the injected script; the agent acts on refIds, not raw selectors.
// ---------------------------------------------------------------------------

const refMap = new Map<string, Element>();
let refCounter = 0;

function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node !== document.body && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

const MAP_SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [onclick]';

// Collect interactive elements, descending into shadow roots and same-origin
// iframes so apps built on web components or framed editors (e.g. OWA) are
// reachable. Live elements are stored in refMap so refId resolution works
// across roots.
function collectInteractive(root: Document | ShadowRoot, out: Element[]): void {
  if (out.length >= 200) return;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (out.length >= 200) break;
    if (el.matches(MAP_SELECTOR) && isVisible(el)) out.push(el);
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) collectInteractive(shadow, out);
    if (el instanceof HTMLIFrameElement) {
      try {
        const doc = el.contentDocument;
        if (doc) collectInteractive(doc, out); // same-origin only; throws otherwise
      } catch {
        // Cross-origin iframe — not reachable without chrome.debugger.
      }
    }
  }
}

export function buildElementMap(): ElementRef[] {
  refMap.clear();
  refCounter = 0;
  const elements: Element[] = [];
  collectInteractive(document, elements);
  return elements.map((el) => {
    const refId = `el-${refCounter++}`;
    refMap.set(refId, el);
    const r = el.getBoundingClientRect();
    const text =
      (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) ||
      (el as HTMLInputElement).placeholder ||
      undefined;
    return {
      refId,
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      text,
      selector: cssPath(el),
      visible: true,
      enabled: !(el as HTMLButtonElement).disabled,
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    };
  });
}

function resolveElement(refIdOrSelector: string): Element | null {
  const fromMap = refMap.get(refIdOrSelector);
  if (fromMap && fromMap.isConnected) return fromMap;
  try {
    return document.querySelector(refIdOrSelector);
  } catch {
    return null;
  }
}

// --- realistic synthetic interaction ----------------------------------------

function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function pointerOpts(x: number, y: number): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: 1,
  };
}

// Full pointer/mouse sequence at a coordinate, dispatched on the topmost
// element there. composed:true lets the events cross shadow boundaries.
function dispatchClickSequence(el: Element, x: number, y: number): void {
  const opts = pointerOpts(x, y);
  const up = { ...opts, buttons: 0 };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerenter', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  if (el instanceof HTMLElement) el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', up));
  el.dispatchEvent(new MouseEvent('mouseup', up));
  el.dispatchEvent(new MouseEvent('click', up));
}

export function clickElement(refIdOrSelector: string): ActionResult {
  const el = resolveElement(refIdOrSelector);
  if (!el) return { ok: false, detail: `Element not found: ${refIdOrSelector}` };
  const c = centerOf(el);
  dispatchClickSequence(el, c.x, c.y);
  return { ok: true, detail: `Clicked ${el.tagName.toLowerCase()}` };
}

// Set an input's value through the prototype's native setter so React/Vue
// value tracking registers the change (a plain `el.value =` does not).
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

export function fillInput(refIdOrSelector: string, value: string): ActionResult {
  const el = resolveElement(refIdOrSelector);
  if (!el) return { ok: false, detail: `Element not found: ${refIdOrSelector}` };
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    return { ok: false, detail: 'Element is not an input or textarea' };
  }
  el.focus();
  setNativeValue(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  return { ok: true, detail: `Filled ${el.tagName.toLowerCase()}` };
}

export function submitForm(refIdOrSelector: string): ActionResult {
  const el = resolveElement(refIdOrSelector);
  if (!el) return { ok: false, detail: `Element not found: ${refIdOrSelector}` };
  const form = el instanceof HTMLFormElement ? el : el.closest('form');
  if (!form) return { ok: false, detail: 'No form found for element' };
  form.requestSubmit();
  return { ok: true, detail: 'Form submitted' };
}

// --- keyboard ----------------------------------------------------------------

const KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ' ': 'Space',
};

function codeForKey(key: string): string {
  if (KEY_CODES[key]) return KEY_CODES[key];
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

// combo is "Enter", "Control+Enter", "Shift+Tab", "c", etc.
export function pressKeys(combo: string, targetRef?: string): ActionResult {
  const parts = combo.split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const mods = parts.map((p) => p.toLowerCase());
  const target =
    (targetRef ? resolveElement(targetRef) : null) ??
    (document.activeElement as Element | null) ??
    document.body;
  const init: KeyboardEventInit = {
    key,
    code: codeForKey(key),
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: mods.includes('control') || mods.includes('ctrl'),
    shiftKey: mods.includes('shift'),
    altKey: mods.includes('alt'),
    metaKey: mods.includes('meta') || mods.includes('cmd'),
  };
  if (target instanceof HTMLElement) target.focus();
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true, detail: `Pressed ${combo}` };
}

// --- coordinate gestures (canvas / maps) -------------------------------------

export function clickAt(x: number, y: number): ActionResult {
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, detail: `No element at (${x}, ${y})` };
  dispatchClickSequence(el, x, y);
  return { ok: true, detail: `Clicked at (${x}, ${y}) on ${el.tagName.toLowerCase()}` };
}

export function drag(fromX: number, fromY: number, toX: number, toY: number): ActionResult {
  const el = document.elementFromPoint(fromX, fromY);
  if (!el) return { ok: false, detail: `No element at (${fromX}, ${fromY})` };
  el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts(fromX, fromY)));
  el.dispatchEvent(new MouseEvent('mousedown', pointerOpts(fromX, fromY)));
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    const y = fromY + ((toY - fromY) * i) / steps;
    el.dispatchEvent(new PointerEvent('pointermove', pointerOpts(x, y)));
    el.dispatchEvent(new MouseEvent('mousemove', pointerOpts(x, y)));
  }
  const up = { ...pointerOpts(toX, toY), buttons: 0 };
  el.dispatchEvent(new PointerEvent('pointerup', up));
  el.dispatchEvent(new MouseEvent('mouseup', up));
  return { ok: true, detail: `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})` };
}

export function scrollWheel(x: number, y: number, deltaY: number): ActionResult {
  const el = document.elementFromPoint(x, y) ?? document.body;
  el.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaY }),
  );
  return { ok: true, detail: `Wheel deltaY=${deltaY} at (${x}, ${y})` };
}

// --- wait for element --------------------------------------------------------

export type WaitState = 'present' | 'visible' | 'enabled';

export function waitForElement(
  selector: string,
  state: WaitState,
  timeoutMs: number,
): Promise<ActionResult> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      let el: Element | null = null;
      try {
        el = document.querySelector(selector);
      } catch {
        resolve({ ok: false, detail: `Invalid selector: ${selector}` });
        return;
      }
      const ok =
        el !== null &&
        (state === 'present' ||
          (state === 'visible' && isVisible(el)) ||
          (state === 'enabled' && !(el as HTMLButtonElement).disabled));
      if (ok) {
        resolve({ ok: true, detail: `Element ${state}: ${selector}` });
      } else if (Date.now() >= deadline) {
        resolve({ ok: false, detail: `Timed out after ${timeoutMs}ms waiting for ${selector} to be ${state}` });
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

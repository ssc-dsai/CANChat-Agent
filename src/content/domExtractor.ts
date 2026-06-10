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

export function buildElementMap(): ElementRef[] {
  refMap.clear();
  refCounter = 0;
  const selector = 'a[href], button, input, select, textarea, [role="button"], [onclick]';
  const refs: ElementRef[] = [];
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (!isVisible(el)) continue;
    const refId = `el-${refCounter++}`;
    refMap.set(refId, el);
    const text =
      (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) ||
      (el as HTMLInputElement).placeholder ||
      undefined;
    refs.push({
      refId,
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      text,
      selector: cssPath(el),
      visible: true,
      enabled: !(el as HTMLButtonElement).disabled,
    });
    if (refs.length >= 200) break;
  }
  return refs;
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

export function clickElement(refIdOrSelector: string): ActionResult {
  const el = resolveElement(refIdOrSelector);
  if (!el) return { ok: false, detail: `Element not found: ${refIdOrSelector}` };
  (el as HTMLElement).click();
  return { ok: true, detail: `Clicked ${el.tagName.toLowerCase()}` };
}

export function fillInput(refIdOrSelector: string, value: string): ActionResult {
  const el = resolveElement(refIdOrSelector);
  if (!el) return { ok: false, detail: `Element not found: ${refIdOrSelector}` };
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    return { ok: false, detail: 'Element is not an input or textarea' };
  }
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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

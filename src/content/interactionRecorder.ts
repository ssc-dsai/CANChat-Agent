import type { PointerTarget } from '../shared/types';
import { LEARN_RECORDING_KEY, learnPageRef, type LearnEvent, type LearnRecording } from '../shared/learning';
import { hostMatches } from '../shared/url';

declare global {
  interface Window {
    __browserAgentInjectedInteractionRecorder?: boolean;
  }
}

type RecorderState = {
  active: boolean;
  targetHost: string;
};

function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node !== document.body && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return (el as HTMLAnchorElement).href ? 'link' : undefined;
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'nav') return 'navigation';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  return undefined;
}

function textOf(el: Element): string | undefined {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return text || undefined;
}

function buildTarget(el: Element): PointerTarget {
  const rect = el.getBoundingClientRect();
  const link = el instanceof HTMLAnchorElement ? el : el.closest('a[href]');
  return {
    tag: el.tagName.toLowerCase(),
    selector: cssPath(el),
    text: textOf(el),
    role: el.getAttribute('role')?.trim().split(/\s+/)[0] || implicitRole(el),
    ariaLabel: el.getAttribute('aria-label')?.trim() || undefined,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    href: link instanceof HTMLAnchorElement ? link.href : undefined,
  };
}

function sanitizeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | undefined {
  if (el instanceof HTMLInputElement && (el.type === 'password' || /password|secret|token|api[-_ ]?key/i.test(`${el.name} ${el.id} ${el.placeholder}`))) {
    return '[redacted]';
  }
  const value = 'value' in el ? String(el.value ?? '') : '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function closestInteractive(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('button,a[href],input,textarea,select,[role], [onclick], [tabindex]');
}

function shouldTrackHost(state: RecorderState): boolean {
  return state.active && hostMatches(location.hostname, state.targetHost);
}

function toPageRef(): LearnEvent['page'] | null {
  return learnPageRef(location.href, document.title);
}

async function emit(state: RecorderState, event: Omit<LearnEvent, 'page' | 'timestamp'>): Promise<void> {
  if (!shouldTrackHost(state)) return;
  const page = toPageRef();
  if (!page) return;
  const payload: LearnEvent = { ...event, page, timestamp: new Date().toISOString() };
  try {
    await chrome.runtime.sendMessage({ type: 'learn_record_event', event: payload });
  } catch {
    // Best-effort; the service worker may be asleep briefly.
  }
}

async function syncState(state: RecorderState): Promise<void> {
  try {
    const result = await chrome.storage.local.get(LEARN_RECORDING_KEY);
    const recording = result[LEARN_RECORDING_KEY] as LearnRecording | undefined;
    state.active = Boolean(recording?.active);
    state.targetHost = recording?.targetHost ?? '';
  } catch {
    state.active = false;
    state.targetHost = '';
  }
}

function install(): void {
  if (window.__browserAgentInjectedInteractionRecorder) return;
  window.__browserAgentInjectedInteractionRecorder = true;

  const state: RecorderState = { active: false, targetHost: '' };
  void syncState(state);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(LEARN_RECORDING_KEY in changes)) return;
    const next = changes[LEARN_RECORDING_KEY].newValue as LearnRecording | undefined;
    state.active = Boolean(next?.active);
    state.targetHost = next?.targetHost ?? '';
  });

  document.addEventListener('click', (e) => {
    const el = closestInteractive(e.target);
    if (!el) return;
    void emit(state, { kind: 'click', target: buildTarget(el) });
  }, true);

  document.addEventListener('submit', (e) => {
    const el = e.target instanceof HTMLFormElement ? e.target : e.target instanceof Element ? e.target.closest('form') : null;
    if (!el) return;
    void emit(state, { kind: 'submit', target: buildTarget(el) });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    const tracked = closestInteractive(el) ?? el;
    const value = sanitizeValue(el);
    void emit(state, { kind: 'input', target: buildTarget(tracked), value });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    const tracked = closestInteractive(el);
    if (!tracked) return;
    void emit(state, { kind: 'keydown', target: buildTarget(tracked), key: 'Enter' });
  }, true);
}

install();

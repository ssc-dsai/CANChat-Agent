import type { PointerTarget } from './types';

export const LEARN_RECORDING_KEY = 'ba_learn_recording';

export type LearnEventKind = 'click' | 'input' | 'submit' | 'keydown';

export interface LearnPageRef {
  url: string;
  title: string;
  host: string;
}

export interface LearnEvent {
  kind: LearnEventKind;
  page: LearnPageRef;
  target: PointerTarget;
  timestamp: string;
  value?: string;
  key?: string;
}

export interface LearnRecording {
  active: boolean;
  targetHost: string;
  startedAt: string;
  startPage: LearnPageRef;
  events: LearnEvent[];
}

export function learnPageRef(url: string, title: string): LearnPageRef | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return { url, title: title.trim(), host: u.hostname };
  } catch {
    return null;
  }
}

function summarizeTarget(target: PointerTarget): string {
  const label = target.ariaLabel || target.text || target.role || target.tag;
  return label ? `"${label.slice(0, 80)}"` : target.tag;
}

function sanitizeValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function compactValue(value: string | undefined): string | undefined {
  const trimmed = sanitizeValue(value);
  if (!trimmed) return undefined;
  return /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

function actionSummary(event: LearnEvent): string {
  const target = summarizeTarget(event.target);
  switch (event.kind) {
    case 'click':
      return `Click ${target}`;
    case 'submit':
      return `Submit ${target}`;
    case 'keydown':
      return event.key === 'Enter' ? `Press Enter in ${target}` : `Press ${event.key ?? 'a key'} in ${target}`;
    case 'input': {
      const value = compactValue(event.value);
      return value ? `Type ${value} into ${target}` : `Type into ${target}`;
    }
  }
}

function compactEvents(events: LearnEvent[]): LearnEvent[] {
  const out: LearnEvent[] = [];
  let previousSignature = '';
  for (const event of events) {
    const signature = [
      event.kind,
      event.page.url,
      event.target.selector,
      event.target.ariaLabel ?? '',
      event.target.text ?? '',
      event.value ?? '',
      event.key ?? '',
    ].join('|');
    if (signature === previousSignature) continue;
    previousSignature = signature;
    out.push(event);
  }
  return out;
}

export function buildLearnPlaybook(recording: LearnRecording): { name: string; description: string; body: string } {
  const host = recording.targetHost || recording.startPage.host;
  const title = recording.startPage.title || host;
  const events = compactEvents(recording.events);
  const steps = events.map((event, i) => {
    const pageLabel = event.page.title || event.page.host;
    const prev = events[i - 1]?.page.url;
    const pageSuffix = prev && prev === event.page.url ? '' : pageLabel ? ` (${pageLabel})` : '';
    return `${i + 1}. ${actionSummary(event)}${pageSuffix}`;
  });
  const name = `learn-${host.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()}` || 'learned-playbook';
  const description = `Recorded workflow for ${host}`;
  const body = [
    `# Recorded workflow for ${host}`,
    '',
    `Recorded from ${title}.`,
    '',
    '## Flow',
    ...(steps.length ? steps : ['1. No interactions were captured.']),
    '',
    '## Notes',
    '- This playbook was generated from recorded user interactions.',
    '- Edit it in Settings → Skills to refine wording or add missing context.',
  ].join('\n');
  return { name, description, body };
}

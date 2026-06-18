// Pure normalizer for the model-supplied slide array of create_powerpoint. Kept
// free of chrome.* / pptxgenjs so it's unit-testable and shared between the
// background (validation) and the offscreen generator.

import type { SlideSpec } from './messages';

function toBullets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((b) => String(b).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    // Accept a single string or newline-separated bullets.
    return value
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Coerce the model's `slides` argument into clean SlideSpec[]: trim titles,
 * normalize bullets (array or newline string), keep notes. Drops slides that end
 * up entirely empty. Returns [] for anything non-array.
 */
export function normalizeSlides(input: unknown): SlideSpec[] {
  if (!Array.isArray(input)) return [];
  const out: SlideSpec[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const bullets = toBullets(o.bullets ?? o.body ?? o.points);
    const notes = typeof o.notes === 'string' ? o.notes.trim() : '';
    if (!title && bullets.length === 0 && !notes) continue;
    out.push({ title: title || undefined, bullets, notes: notes || undefined });
  }
  return out;
}

// =============================================================================
// Pure, dependency-free helpers for the saved-conversation feature. Kept
// separate from storage.ts (which touches the chrome.storage global) so the
// title/preview/retention logic is unit-testable in plain Node.
//
// Callers: `agentRuntime.persistCurrentConversation` (deriveTitle/derivePreview)
// and `storage.saveConversation` (pruneIndex).
// =============================================================================

import type { ConversationSummary } from './types';

const TITLE_MAX = 60;
const PREVIEW_MAX = 120;

/**
 * A conversation's display title: the first user message, collapsed to a single
 * line and clipped. Falls back to a generic label when the opening message is
 * empty (e.g. an image-only prompt). The caller localizes the fallback; we emit
 * an empty string so it can substitute its own "Untitled" wording.
 */
export function deriveTitle(firstUserText: string): string {
  let clean = firstUserText.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  // Drop a leading skill invocation token ("/research arctic lanes" →
  // "arctic lanes") so the title reflects the subject, not the command. A bare
  // "/research" with no argument keeps the skill name as the title.
  const slash = /^\/([a-z0-9-]+)(?:\s+([\s\S]+))?$/i.exec(clean);
  if (slash) clean = (slash[2] ?? slash[1]).trim();
  return clip(clean, TITLE_MAX);
}

/** Clip to `max` chars on a word boundary where possible, appending an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  // Only break on a space if it isn't pathologically early (avoids a one-word title).
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd() + '…';
}

/** A short one-line preview for the history list (last meaningful snippet). */
export function derivePreview(text: string): string {
  return clip(text.replace(/\s+/g, ' ').trim(), PREVIEW_MAX);
}

/**
 * Bound the history to `max` entries, dropping the least-recently-updated. The
 * returned object reports which ids were evicted so the caller can delete their
 * (heavy) body records too. Sorts a copy newest-first; never mutates the input.
 */
export function pruneIndex(
  index: ConversationSummary[],
  max: number,
): { kept: ConversationSummary[]; evicted: string[] } {
  if (index.length <= max) {
    return { kept: [...index].sort(byUpdatedDesc), evicted: [] };
  }
  const sorted = [...index].sort(byUpdatedDesc);
  return {
    kept: sorted.slice(0, max),
    evicted: sorted.slice(max).map((c) => c.id),
  };
}

function byUpdatedDesc(a: ConversationSummary, b: ConversationSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

// --- portable single-conversation file (Save to file / Load from file) --------

/** Envelope written around a conversation body when saved to a standalone file. */
export const CONVERSATION_FILE = { app: 'CANChat Agent', kind: 'conversation', version: 1 } as const;

/** A filesystem-safe slug derived from a title, for the download filename. */
export function slugifyTitle(title: string, fallback = 'conversation'): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

/**
 * Validate the JSON text of a saved-conversation file and return its inner body,
 * or null if it isn't one. Pure (no chrome.*) so the UI can check a file before
 * handing it to the service worker, and so it's unit-testable. Accepts the legacy
 * "CANAgent" app tag alongside the current "CANChat Agent".
 */
export function parseConversationFile(
  text: string,
): { messages: unknown[]; conversation: unknown[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const file = parsed as Record<string, unknown>;
  const appOk = file.app === CONVERSATION_FILE.app || file.app === 'CANAgent';
  if (!appOk || file.kind !== 'conversation') return null;
  const body = file.conversation as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return null;
  if (!Array.isArray(body.messages) || !Array.isArray(body.conversation)) return null;
  return body as { messages: unknown[]; conversation: unknown[] };
}

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
  const clean = firstUserText.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > TITLE_MAX ? clean.slice(0, TITLE_MAX - 1).trimEnd() + '…' : clean;
}

/** A short one-line preview for the history list (last meaningful snippet). */
export function derivePreview(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > PREVIEW_MAX ? clean.slice(0, PREVIEW_MAX - 1).trimEnd() + '…' : clean;
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

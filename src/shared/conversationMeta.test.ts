import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_FILE,
  deriveTitle,
  derivePreview,
  parseConversationFile,
  pruneIndex,
  slugifyTitle,
} from './conversationMeta';
import type { ConversationSummary } from './types';

describe('deriveTitle', () => {
  it('collapses whitespace to a single line', () => {
    expect(deriveTitle('  summarize\n  this   page ')).toBe('summarize this page');
  });

  it('clips long text with an ellipsis at the 60-char budget', () => {
    const title = deriveTitle('a'.repeat(100));
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBe(60);
  });

  it('returns empty string for blank input (caller localizes the fallback)', () => {
    expect(deriveTitle('   \n  ')).toBe('');
  });

  it('strips a leading skill-invocation token, keeping the argument', () => {
    expect(deriveTitle('/research arctic shipping lanes')).toBe('arctic shipping lanes');
  });

  it('keeps the skill name when the slash command has no argument', () => {
    expect(deriveTitle('/summarize-tabs')).toBe('summarize-tabs');
  });

  it('truncates on a word boundary rather than mid-word', () => {
    const input = 'analyze the quarterly financial report and highlight the key risks for leadership';
    const title = deriveTitle(input);
    expect(title.endsWith('…')).toBe(true);
    const body = title.slice(0, -1);
    // The clipped body is a clean prefix that ends right before a space.
    expect(input.startsWith(body)).toBe(true);
    expect(input.charAt(body.length)).toBe(' ');
  });
});

describe('derivePreview', () => {
  it('clips at the 120-char budget', () => {
    const preview = derivePreview('x'.repeat(200));
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBe(120);
  });
});

describe('pruneIndex', () => {
  const make = (id: string, updatedAt: string): ConversationSummary => ({
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    preview: '',
  });

  it('returns everything sorted newest-first when under the cap', () => {
    const index = [make('a', '2026-01-01T00:00:00Z'), make('b', '2026-02-01T00:00:00Z')];
    const { kept, evicted } = pruneIndex(index, 10);
    expect(kept.map((c) => c.id)).toEqual(['b', 'a']);
    expect(evicted).toEqual([]);
  });

  it('evicts the oldest entries beyond the cap', () => {
    const index = [
      make('old', '2026-01-01T00:00:00Z'),
      make('mid', '2026-02-01T00:00:00Z'),
      make('new', '2026-03-01T00:00:00Z'),
    ];
    const { kept, evicted } = pruneIndex(index, 2);
    expect(kept.map((c) => c.id)).toEqual(['new', 'mid']);
    expect(evicted).toEqual(['old']);
  });

  it('does not mutate the input array', () => {
    const index = [make('a', '2026-01-01T00:00:00Z'), make('b', '2026-02-01T00:00:00Z')];
    const snapshot = index.map((c) => c.id);
    pruneIndex(index, 1);
    expect(index.map((c) => c.id)).toEqual(snapshot);
  });
});

describe('slugifyTitle', () => {
  it('lowercases and replaces runs of non-alphanumerics with single hyphens', () => {
    expect(slugifyTitle('Arctic Shipping: Lanes & Risks!')).toBe('arctic-shipping-lanes-risks');
  });

  it('falls back when nothing usable remains', () => {
    expect(slugifyTitle('   ')).toBe('conversation');
    expect(slugifyTitle('！！！', 'untitled')).toBe('untitled');
  });
});

describe('parseConversationFile', () => {
  const wrap = (body: unknown, over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...CONVERSATION_FILE, conversation: body, ...over });
  const body = { messages: [{ role: 'user', text: 'hi' }], conversation: [{ role: 'user', content: 'hi' }] };

  it('returns the inner body for a valid file', () => {
    expect(parseConversationFile(wrap(body))).toEqual(body);
  });

  it('accepts the legacy CANAgent app tag', () => {
    expect(parseConversationFile(wrap(body, { app: 'CANAgent' }))).toEqual(body);
  });

  it('rejects malformed JSON', () => {
    expect(parseConversationFile('{not json')).toBeNull();
  });

  it('rejects the wrong kind or a body missing the required arrays', () => {
    expect(parseConversationFile(wrap(body, { kind: 'backup' }))).toBeNull();
    expect(parseConversationFile(wrap({ messages: [] }))).toBeNull();
    expect(parseConversationFile(wrap({ conversation: [] }))).toBeNull();
  });
});

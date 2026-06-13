import { chunkText } from '../shared/repoChunk';
import type { Settings } from '../shared/types';
import * as browser from './browserToolAdapter';
import { embed } from './llmProvider';
import { repoAdd } from './offscreenClient';

export interface IngestResult {
  ok: boolean;
  chunks?: number;
  error?: string;
  needsOcr?: boolean;
}

/** Capture a tab's text (DOM → app-content), chunk, embed, and store it. */
export async function ingestTab(
  settings: Settings,
  repo: string,
  tabId: number,
  title: string,
  url: string,
): Promise<IngestResult> {
  let text = '';
  try {
    const content = await browser.getTabContent(tabId);
    if (content.text && content.text.trim().length > 50) text = content.text;
  } catch {
    // fall through to read_app_content
  }
  if (!text) {
    try {
      const parsed = JSON.parse(await browser.readAppContent(tabId)) as { text?: string };
      if (parsed.text && parsed.text.trim().length > 30) text = parsed.text;
    } catch {
      // no app content
    }
  }
  if (!text || text.trim().length < 30) {
    return { ok: false, needsOcr: true, error: 'No extractable text from this page.' };
  }
  const chunks = chunkText(text);
  if (chunks.length === 0) return { ok: false, error: 'No chunks produced.' };
  let vectors: number[][];
  try {
    vectors = await embed(settings, chunks);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const res = await repoAdd(repo, { name: title || url, url }, chunks, vectors);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, chunks: chunks.length };
}

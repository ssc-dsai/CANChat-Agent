import { chunkText } from '../shared/repoChunk';
import type { Settings } from '../shared/types';
import * as browser from './browserToolAdapter';
import { captureFullPage } from './fullPageCapture';
import { complete, embed, type ContentPart } from './llmProvider';
import { extractPdf, repoAdd } from './offscreenClient';

/** Heuristic: does this URL point at a PDF the pdf.js path can extract? */
function looksLikePdf(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url);
}

// OCR fallback: screenshot the whole (active) tab and have the vision model
// transcribe it. Only works for the active tab (captureVisibleTab limitation).
async function ocrTabText(settings: Settings, tabId: number): Promise<string> {
  const cap = await captureFullPage(tabId, 12);
  if (cap.error || cap.frames.length === 0) return '';
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: 'Transcribe ALL readable text from these screenshots of a web page, top to bottom in reading order. Output only the transcribed text — no commentary, headings, or markup.',
    },
    ...cap.frames.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
  ];
  try {
    const reply = await complete(settings, [{ role: 'user', content: parts }]);
    return (reply.content ?? '').trim();
  } catch {
    return '';
  }
}

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
  allowOcr = false,
): Promise<IngestResult> {
  let text = '';
  // PDFs: pdf.js gives clean, selectable text — try it before the DOM/OCR ladder.
  if (looksLikePdf(url)) {
    try {
      const pdf = await extractPdf(url);
      if (pdf.ok && pdf.text && pdf.text.trim().length > 30) text = pdf.text;
    } catch {
      // fall through to the page-content ladder
    }
  }
  if (!text) {
    try {
      const content = await browser.getTabContent(tabId);
      if (content.text && content.text.trim().length > 50) text = content.text;
    } catch {
      // fall through to read_app_content
    }
  }
  if (!text) {
    try {
      const parsed = JSON.parse(await browser.readAppContent(tabId)) as { text?: string };
      if (parsed.text && parsed.text.trim().length > 30) text = parsed.text;
    } catch {
      // no app content
    }
  }
  if (!text && allowOcr) {
    text = await ocrTabText(settings, tabId); // vision transcription (active tab only)
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

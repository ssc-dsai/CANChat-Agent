// =============================================================================
// Repository ingestion — turn a tab (or a whole tab group) into searchable RAG
// content. For each page it picks the best text source in a ladder: native PDF
// extraction, Office extraction, normal DOM content, app-content fallback, then
// OCR/vision as a last resort. The text is chunked (`chunkText`), embedded
// (`embed`), and written to the OPFS store via `offscreenClient.repoAdd`.
// Called by `agentRuntime` for both the `add_to_repo` tool and the panel's
// "+ Tab / + Group" buttons.
// =============================================================================

import { chunkText } from '../shared/repoChunk';
import type { RepoKind } from '../shared/messages';
import type { Settings } from '../shared/types';
import { resolveOfficeUrl, resolvePdfUrl } from '../shared/url';
import * as browser from './browserToolAdapter';
import { captureFullPage } from './fullPageCapture';
import { complete, embedChunks, embedderId, resolveModelForRole, type ContentPart } from './llmProvider';
import { extractOffice, extractPdf, repoAdd } from './offscreenClient';

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
    const reply = await complete(resolveModelForRole(settings, 'vision'), [{ role: 'user', content: parts }]);
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
  const pdfUrl = resolvePdfUrl(url);
  if (pdfUrl) {
    try {
      const pdf = await extractPdf(pdfUrl);
      if (pdf.ok && pdf.text && pdf.text.trim().length > 30) text = pdf.text;
    } catch {
      // fall through to the page-content ladder
    }
  }
  // Office files (.docx/.pptx/.xlsx, incl. the SharePoint Office-Online viewer
  // wrapper): extract the whole document before the ladder.
  const officeUrl = resolveOfficeUrl(url);
  if (!text && officeUrl) {
    try {
      const office = await extractOffice(officeUrl);
      if (office.ok && office.text && office.text.trim().length > 30) text = office.text;
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
  return storeText(settings, repo, title || url, url, text);
}

/** Chunk → embed → store text as a repo document. Shared by tab and file ingestion. */
export async function storeText(
  settings: Settings,
  repo: string,
  name: string,
  url: string,
  text: string,
  opts: { kind?: RepoKind; docExtra?: { path?: string; mtime?: number; size?: number } } = {},
): Promise<IngestResult> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return { ok: false, error: 'No chunks produced.' };
  let vectors: number[][];
  try {
    vectors = await embedChunks(settings, chunks);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const res = await repoAdd(repo, { name, url }, chunks, vectors, {
    embedModel: embedderId(settings),
    kind: opts.kind,
    docExtra: opts.docExtra,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, chunks: chunks.length };
}

/**
 * Ingest an uploaded file into a repository. Text-like files arrive with their
 * text already read in the UI; PDF/Office files arrive as a data URL the
 * offscreen extractor (pdf.js / OOXML) parses — the same path used for tabs.
 */
export async function ingestFile(
  settings: Settings,
  repo: string,
  file: { name: string; kind: 'text' | 'pdf' | 'office'; text?: string; dataUrl?: string; path?: string; mtime?: number; size?: number },
  repoKind: RepoKind = 'page',
): Promise<IngestResult> {
  let text = (file.text ?? '').trim();
  try {
    if (!text && file.kind === 'pdf' && file.dataUrl) {
      const pdf = await extractPdf(file.dataUrl);
      if (pdf.ok && pdf.text) text = pdf.text.trim();
      else if (!pdf.ok) return { ok: false, error: pdf.error ?? 'Could not read the PDF.' };
    } else if (!text && file.kind === 'office' && file.dataUrl) {
      const office = await extractOffice(file.dataUrl);
      if (office.ok && office.text) text = office.text.trim();
      else if (!office.ok) return { ok: false, error: office.error ?? 'Could not read the document.' };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  if (text.length < 1) return { ok: false, error: 'No extractable text in the file.' };
  // Folder docs keep their relative path as both the display name and url so the
  // agent can cite the file, and as the incremental-sync key in DocMeta.
  const path = file.path;
  const name = path || file.name;
  const url = `file:///${path || file.name}`;
  return storeText(settings, repo, name, url, text, {
    kind: repoKind,
    docExtra: { path, mtime: file.mtime, size: file.size },
  });
}

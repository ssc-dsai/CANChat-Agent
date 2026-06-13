import * as pdfjs from 'pdfjs-dist';
// Vite emits the worker as an asset and gives us its URL.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ExtractPdfRequest, ExtractPdfResponse, RepoRequest, RepoResponse } from '../shared/messages';
import { repoAdd, repoDelete, repoDeleteDoc, repoDocs, repoList, repoSearch } from './repoStore';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Anti-OOM ceiling on total extracted text (~hundreds of pages). Callers that
// need a smaller, context-budget slice pass `maxChars`.
const SAFETY_MAX = 5_000_000;

// Build a page's text from pdf.js items, preserving line breaks via the per-item
// `hasEOL` flag instead of flattening everything to single spaces.
function pageItemsToText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let out = '';
  for (const it of items) {
    out += it.str ?? '';
    if (it.hasEOL) out += '\n';
  }
  return out
    .replace(/[ \t]+/g, ' ') // collapse runs of spaces/tabs, keep newlines
    .replace(/ *\n */g, '\n') // trim spaces around line breaks
    .replace(/\n{3,}/g, '\n\n') // collapse blank-line runs
    .trim();
}

async function extractPdf(url: string, maxChars?: number): Promise<ExtractPdfResponse> {
  let data: ArrayBuffer;
  try {
    // credentials:'include' so cookie-gated PDFs work under the host permission.
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, error: `Could not fetch the PDF (HTTP ${res.status}).` };
    data = await res.arrayBuffer();
  } catch (e) {
    return { ok: false, error: `Could not fetch the PDF: ${String(e)}` };
  }
  try {
    const doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false, // required under MV3 CSP
      disableFontFace: true,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
    let text = '';
    let hitSafety = false;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      text += pageItemsToText(content.items as Array<{ str?: string; hasEOL?: boolean }>) + '\n\n';
      if (text.length > SAFETY_MAX) {
        hitSafety = true;
        break;
      }
    }
    text = text.trim();
    const charCount = text.length;
    const limit = maxChars ?? SAFETY_MAX;
    const truncated = hitSafety || charCount > limit;
    return {
      ok: true,
      pageCount: doc.numPages,
      truncated,
      charCount,
      text: charCount > limit ? text.slice(0, limit).trim() : text,
    };
  } catch (e) {
    return { ok: false, error: `Not a readable PDF: ${String(e)}` };
  }
}

chrome.runtime.onMessage.addListener((message: ExtractPdfRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'extract_pdf') return undefined;
  extractPdf(message.url, message.maxChars).then(sendResponse);
  return true; // async response
});

async function handleRepo(req: RepoRequest): Promise<RepoResponse> {
  try {
    switch (req.op) {
      case 'add':
        return { ok: true, result: await repoAdd(req.repo, req.doc, req.chunks, req.vectors) };
      case 'search':
        return { ok: true, result: await repoSearch(req.repo, req.queryVector, req.k) };
      case 'list':
        return { ok: true, result: await repoList() };
      case 'delete':
        await repoDelete(req.repo);
        return { ok: true };
      case 'docs':
        return { ok: true, result: await repoDocs(req.repo) };
      case 'deleteDoc':
        return { ok: true, result: await repoDeleteDoc(req.repo, req.docId) };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((message: RepoRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen-repo') return undefined;
  handleRepo(message).then(sendResponse);
  return true; // async response
});

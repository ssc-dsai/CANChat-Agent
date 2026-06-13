import * as pdfjs from 'pdfjs-dist';
// Vite emits the worker as an asset and gives us its URL.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ExtractPdfRequest, ExtractPdfResponse, RepoRequest, RepoResponse } from '../shared/messages';
import { repoAdd, repoDelete, repoList, repoSearch } from './repoStore';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PDF_CHARS = 20000;

async function extractPdf(url: string): Promise<ExtractPdfResponse> {
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
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((it) => ('str' in it ? it.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      text += pageText + '\n\n';
      if (text.length > MAX_PDF_CHARS) break;
    }
    const truncated = text.length > MAX_PDF_CHARS;
    return {
      ok: true,
      pageCount: doc.numPages,
      truncated,
      text: text.slice(0, MAX_PDF_CHARS).trim(),
    };
  } catch (e) {
    return { ok: false, error: `Not a readable PDF: ${String(e)}` };
  }
}

chrome.runtime.onMessage.addListener((message: ExtractPdfRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'extract_pdf') return undefined;
  extractPdf(message.url).then(sendResponse);
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

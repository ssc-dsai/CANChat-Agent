import type { ExtractPdfRequest, ExtractPdfResponse } from '../shared/messages';

// pdf.js needs a DOM/worker context the service worker can't provide, so it
// runs in an offscreen document created on demand.

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification: 'Parse PDF files so the agent can read their text.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export async function extractPdf(url: string): Promise<ExtractPdfResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the PDF reader: ${String(e)}` };
  }
  const request: ExtractPdfRequest = { target: 'offscreen', type: 'extract_pdf', url };
  return (await chrome.runtime.sendMessage(request)) as ExtractPdfResponse;
}

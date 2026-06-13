import type { ExtractPdfRequest, ExtractPdfResponse, RepoRequest, RepoResponse } from '../shared/messages';

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

export async function extractPdf(url: string, maxChars?: number): Promise<ExtractPdfResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the PDF reader: ${String(e)}` };
  }
  const request: ExtractPdfRequest = { target: 'offscreen', type: 'extract_pdf', url, maxChars };
  return (await chrome.runtime.sendMessage(request)) as ExtractPdfResponse;
}

async function repoRequest(req: RepoRequest): Promise<RepoResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the repository engine: ${String(e)}` };
  }
  return (await chrome.runtime.sendMessage(req)) as RepoResponse;
}

export function repoAdd(
  repo: string,
  doc: { name: string; url: string },
  chunks: string[],
  vectors: number[][],
): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'add', repo, doc, chunks, vectors });
}

export function repoSearch(repo: string, queryVector: number[], k: number): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'search', repo, queryVector, k });
}

export function repoList(): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'list' });
}

export function repoDelete(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'delete', repo });
}

export function repoDocs(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'docs', repo });
}

export function repoDeleteDoc(repo: string, docId: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'deleteDoc', repo, docId });
}

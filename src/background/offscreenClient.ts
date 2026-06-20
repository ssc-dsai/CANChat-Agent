// =============================================================================
// Offscreen client — the service-worker side of the channel to the offscreen
// document. Ensures the offscreen page exists, then exposes typed wrappers
// (PDF/Office extraction, and the repository store ops) that post a request and
// await the matching response. The receiving end is `offscreen.ts`/`repoStore`.
// =============================================================================

import type {
  DuckDbRequest,
  DuckDbResponse,
  DuckDbOp,
  ExportedRepo,
  ExtractOfficeRequest,
  ExtractOfficeResponse,
  ExtractPdfRequest,
  ExtractPdfResponse,
  GenerateDocumentRequest,
  GenerateDocumentResponse,
  GeneratePresentationRequest,
  SlideSpec,
  RepoRequest,
  RepoResponse,
} from '../shared/messages';

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

export async function generateDocument(
  format: 'docx',
  title: string,
  markdown: string,
): Promise<GenerateDocumentResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the document generator: ${String(e)}` };
  }
  const request: GenerateDocumentRequest = { target: 'offscreen', type: 'generate_document', format, title, markdown };
  return (await chrome.runtime.sendMessage(request)) as GenerateDocumentResponse;
}

export async function generatePresentation(
  title: string,
  slides: SlideSpec[],
): Promise<GenerateDocumentResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the presentation generator: ${String(e)}` };
  }
  const request: GeneratePresentationRequest = { target: 'offscreen', type: 'generate_presentation', title, slides };
  return (await chrome.runtime.sendMessage(request)) as GenerateDocumentResponse;
}

export async function extractOffice(url: string, maxChars?: number): Promise<ExtractOfficeResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the document reader: ${String(e)}` };
  }
  const request: ExtractOfficeRequest = { target: 'offscreen', type: 'extract_office', url, maxChars };
  return (await chrome.runtime.sendMessage(request)) as ExtractOfficeResponse;
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

export function repoExport(): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'export' });
}

export function repoImport(repos: ExportedRepo[]): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'import', repos });
}

// ----- DuckDB data engine -----

/**
 * Send a DuckDB request to the offscreen document, retrying briefly if the
 * document's listener isn't attached yet ("Receiving end does not exist") —
 * a race when concurrent ops hit a cold engine.
 */
async function sendDuckDb(request: DuckDbRequest): Promise<DuckDbResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the data engine: ${String(e)}` };
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return (await chrome.runtime.sendMessage(request)) as DuckDbResponse;
    } catch (e) {
      if (attempt < 10 && /Receiving end does not exist|establish connection/i.test(String(e))) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      return { ok: false, error: String(e) };
    }
  }
}

function duckDbRequest(op: DuckDbOp, sql?: string, tableName?: string, data?: string): Promise<DuckDbResponse> {
  return sendDuckDb({ target: 'offscreen-duckdb', op, sql, tableName, data });
}

export function duckDbQuery(sql: string): Promise<DuckDbResponse> {
  return duckDbRequest('query', sql);
}

export function duckDbImportCsv(tableName: string, data: string): Promise<DuckDbResponse> {
  return duckDbRequest('import_csv', undefined, tableName, data);
}

export function duckDbImportJson(tableName: string, data: string): Promise<DuckDbResponse> {
  return duckDbRequest('import_json', undefined, tableName, data);
}

export function duckDbListTables(): Promise<DuckDbResponse> {
  return duckDbRequest('list_tables');
}

export function duckDbDescribeTable(tableName: string): Promise<DuckDbResponse> {
  return duckDbRequest('describe_table', undefined, tableName);
}

export function duckDbPersistTable(tableName: string): Promise<DuckDbResponse> {
  return duckDbRequest('persist_table', undefined, tableName);
}

export function duckDbLoadTable(tableName: string): Promise<DuckDbResponse> {
  return duckDbRequest('load_table', undefined, tableName);
}

export function duckDbDropTable(tableName: string): Promise<DuckDbResponse> {
  return duckDbRequest('drop_table', undefined, tableName);
}

/** Open a data file (CSV/JSON/Parquet/ZIP) from base64 bytes into one or more tables. */
export function duckDbOpenFile(name: string, bytesB64: string): Promise<DuckDbResponse> {
  return sendDuckDb({ target: 'offscreen-duckdb', op: 'open_file', name, bytesB64 });
}

/** Drop every table and clear all persisted datasets — a fresh engine for a new conversation. */
export function duckDbResetAll(): Promise<DuckDbResponse> {
  return sendDuckDb({ target: 'offscreen-duckdb', op: 'reset_all' });
}

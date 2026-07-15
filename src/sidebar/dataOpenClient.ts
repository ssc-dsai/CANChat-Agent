// Read picked data files and open them into the DuckDB engine via the service
// worker. Mirrors repoUploadClient, but the destination is the data engine, not
// a RAG repository. Returns per-file results so the caller can show a banner.

import type { AddFileResult, DataFileUpload, OpenDataResponse } from '../shared/messages';
import { classifyDataFile, MAX_DATA_BYTES } from '../shared/dataFile';

/** Read a File as base64 (no data-URL prefix). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1)); // strip "data:...;base64,"
    };
    reader.readAsDataURL(file);
  });
}

export interface OpenDataResult {
  results: AddFileResult[];
  tables: string[];
}

/** Open data files into the engine; client-side skips (too big/unsupported) merge in. */
export async function openDataFiles(files: File[], projectId?: string): Promise<OpenDataResult> {
  const skips: AddFileResult[] = [];
  const payload: DataFileUpload[] = [];
  for (const file of files) {
    if (!classifyDataFile(file.name, file.type)) {
      skips.push({ name: file.name, ok: false, error: 'unsupported type' });
      continue;
    }
    if (file.size > MAX_DATA_BYTES) {
      skips.push({ name: file.name, ok: false, error: 'file too large' });
      continue;
    }
    payload.push({ name: file.name, bytesB64: await readBase64(file) });
  }

  if (payload.length === 0) return { results: skips, tables: [] };

  const resp = (await chrome.runtime.sendMessage({ type: 'open_data_files', files: payload, projectId })) as
    | (OpenDataResponse & { results: AddFileResult[] })
    | undefined;
  const serverResults = resp?.results ?? payload.map((f) => ({ name: f.name, ok: false, error: resp?.error ?? 'no response' }));
  return { results: [...serverResults, ...skips], tables: (resp?.tables ?? []).map((t) => t.name) };
}

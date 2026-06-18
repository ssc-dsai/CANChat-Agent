// Shared client for adding files to a repository — used by the Repositories
// settings section and the composer drop. Reads/classifies picked files, sends
// the supported ones to the background's `add_files_to_repo` handler, and merges
// client-side rejects with the per-file server results.

import type { AddFileResult, AddFilesResponse, UploadFile } from '../shared/messages';
import { classifyUpload, MAX_UPLOAD_BYTES } from '../shared/uploadFile';

/** Read picked Files into UploadFile payloads; unsupported/oversized ones become failed results. */
async function readUploadFiles(
  files: File[],
): Promise<{ prepared: UploadFile[]; rejected: AddFileResult[] }> {
  const prepared: UploadFile[] = [];
  const rejected: AddFileResult[] = [];
  for (const file of files) {
    const kind = classifyUpload(file.name, file.type);
    if (!kind) {
      rejected.push({ name: file.name, ok: false, error: 'unsupported type' });
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({ name: file.name, ok: false, error: 'too large' });
      continue;
    }
    if (kind === 'text') {
      prepared.push({ name: file.name, kind, text: await file.text() });
    } else {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      prepared.push({ name: file.name, kind, dataUrl });
    }
  }
  return { prepared, rejected };
}

/** Read + send a set of files to a repository; returns the merged per-file outcomes. */
export async function uploadFilesToRepo(repo: string, files: File[]): Promise<AddFileResult[]> {
  const { prepared, rejected } = await readUploadFiles(files);
  if (prepared.length === 0) return rejected;
  const back = (await chrome.runtime.sendMessage({
    type: 'add_files_to_repo',
    repo,
    files: prepared,
  })) as AddFilesResponse;
  const server = back?.results ?? prepared.map((f) => ({ name: f.name, ok: false, error: back?.error }));
  return [...rejected, ...server];
}

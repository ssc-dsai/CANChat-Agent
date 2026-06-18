// Shared client for adding files to a repository — used by the Repositories
// settings section and the composer drag-drop. Reads/classifies picked files and
// sends them to the background's `add_files_to_repo` handler.

import type { AddFilesResponse, UploadFile } from '../shared/messages';
import { classifyUpload, MAX_UPLOAD_BYTES } from '../shared/uploadFile';

/** Read picked Files into UploadFile payloads, collecting unsupported/oversized ones. */
export async function readUploadFiles(
  files: File[],
): Promise<{ prepared: UploadFile[]; skipped: string[] }> {
  const prepared: UploadFile[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const kind = classifyUpload(file.name, file.type);
    if (!kind) {
      skipped.push(`${file.name} (unsupported type)`);
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      skipped.push(`${file.name} (too large)`);
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
  return { prepared, skipped };
}

/** Read + send a set of files to a repository; merges client-side skips into the result. */
export async function uploadFilesToRepo(repo: string, files: File[]): Promise<AddFilesResponse> {
  const { prepared, skipped } = await readUploadFiles(files);
  if (prepared.length === 0) return { ok: false, added: 0, chunks: 0, skipped };
  const back = (await chrome.runtime.sendMessage({
    type: 'add_files_to_repo',
    repo,
    files: prepared,
  })) as AddFilesResponse;
  return { ...back, skipped: [...skipped, ...(back.skipped ?? [])] };
}

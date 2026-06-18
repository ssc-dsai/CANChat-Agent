// Pure helpers for uploading files into a repository. Classify a picked file by
// extension/MIME into the ingestion path it should take, and bound its size so a
// base64 data URL stays within chrome.runtime messaging limits. Free of chrome.*
// so it can be unit-tested and shared between the UI and the background.

/** How a given file should be turned into text for ingestion. */
export type UploadKind = 'text' | 'pdf' | 'office';

/** Files larger than this are rejected (base64 data-URL transfer guardrail). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'text'];
const OFFICE_EXT = ['docx', 'pptx', 'xlsx'];
const PDF_EXT = ['pdf'];

/** The `accept` attribute value for the file inputs. */
export const UPLOAD_ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.log';

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Classify a file into its ingestion path, or null if unsupported. Extension is
 * authoritative (MIME types for Office files are long and inconsistent); MIME is
 * a fallback for text-like content with no/odd extension.
 */
export function classifyUpload(name: string, mime = ''): UploadKind | null {
  const ext = extOf(name);
  if (PDF_EXT.includes(ext)) return 'pdf';
  if (OFFICE_EXT.includes(ext)) return 'office';
  if (TEXT_EXT.includes(ext)) return 'text';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  if (mime === 'application/pdf') return 'pdf';
  return null;
}

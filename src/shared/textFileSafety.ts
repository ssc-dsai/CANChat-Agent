// =============================================================================
// create_file safety. The agent can be steered by page text, so the files it
// offers for download must not be ones the OS will execute or render as active
// content when the user double-clicks them (.bat, .command, .js, .html, .svg…).
// Only plain-text formats on this allowlist keep their extension; anything else
// gets ".txt" appended, so "report.bat" downloads as "report.bat.txt".
// =============================================================================

const TEXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  sql: 'text/plain',
  css: 'text/css',
  rst: 'text/plain',
  adoc: 'text/plain',
  tex: 'text/plain',
  srt: 'text/plain',
  vtt: 'text/vtt',
};

/** Extensions create_file may produce as-is. */
export const SAFE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(TEXT_MIME));

export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Make a model-supplied filename safe to offer for download: no path parts or
 * reserved characters, no trailing dots/spaces (Windows drops them, turning
 * "x.bat." into "x.bat"), no leading dots, and an allowlisted text extension.
 * Returns '' when nothing usable is left.
 */
export function safeTextFilename(raw: string): string {
  let name = raw
    .replace(/[\\/]/g, '_')
    .replace(/[<>:"|?*\x00-\x1F\x7F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^[. ]+/, '');
  if (!name) return '';
  if (name.length > 120) {
    const ext = fileExtension(name);
    name = name.slice(0, 120 - (ext ? ext.length + 1 : 0)).replace(/[. ]+$/, '') + (ext ? `.${ext}` : '');
  }
  const ext = fileExtension(name);
  if (!SAFE_TEXT_EXTENSIONS.has(ext)) name = `${name}.txt`;
  return name;
}

export function mimeTypeForTextFile(filename: string): string {
  return TEXT_MIME[fileExtension(filename)] ?? 'text/plain';
}

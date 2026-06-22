// Pure helpers for the unified `microsoft365_search` tool: turn the model's
// structured filters into the query strings the cookie-authenticated Microsoft 365
// web APIs expect — KQL for SharePoint/Microsoft Search (files, incl. OneDrive) and
// AQS for the Outlook-on-the-web FindItem endpoint (mail). No chrome.*/network here
// so the construction is unit-testable; the fetches live in browserToolAdapter.ts.

export type SearchSource = 'mail' | 'files' | 'both';
export type SearchOrder = 'relevance' | 'date';

export interface M365SearchFilters {
  source?: SearchSource;
  /** Free-text keywords. */
  query?: string;
  /** Mail: sender name or email. */
  from?: string;
  /** Files: document type, e.g. docx / xlsx / pdf. */
  fileType?: string;
  /** Files: SharePoint site/library URL to scope to. */
  sitePath?: string;
  /** Files: limit to items the signed-in user last edited. */
  editedByMe?: boolean;
  /** Inclusive lower date bound, ISO `YYYY-MM-DD`. */
  since?: string;
  /** Inclusive upper date bound, ISO `YYYY-MM-DD`. */
  until?: string;
  /** `relevance` (default) or `date` (newest first). */
  orderBy?: SearchOrder;
  /** Max results, clamped to [1, 25]. */
  top?: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Clamp the requested result count to a sane [1, 25], default 10. */
export function clampTop(top?: number): number {
  if (!Number.isFinite(top)) return 10;
  return Math.min(25, Math.max(1, Math.floor(top as number)));
}

/** Normalize a file type to a bare lowercase extension (strip a leading dot). */
export function normalizeFileType(fileType?: string): string | undefined {
  const t = (fileType ?? '').trim().toLowerCase().replace(/^\./, '');
  return /^[a-z0-9]+$/.test(t) ? t : undefined;
}

/** Accept only a well-formed ISO date; otherwise undefined (ignored in queries). */
function isoDate(d?: string): string | undefined {
  const v = (d ?? '').trim();
  return ISO_DATE.test(v) ? v : undefined;
}

/** Strip characters that would break a single-quoted KQL `querytext`. */
function kqlSafe(s: string): string {
  return s.replace(/['"]/g, ' ').trim();
}

/**
 * Build the SharePoint/Microsoft Search KQL `querytext` for a file search. The
 * caller resolves the signed-in user's display name (for editedByMe) and passes it
 * as `editorName`, since that needs a network call. Falls back to `IsDocument:1` so
 * a pure "recent files" listing still has rows to sort.
 */
export function buildFileKql(f: M365SearchFilters, editorName?: string): string {
  const clauses: string[] = [];
  const terms = kqlSafe(f.query ?? '');
  if (terms) clauses.push(terms);

  const ft = normalizeFileType(f.fileType);
  if (ft) clauses.push(`filetype:${ft}`);

  const site = (f.sitePath ?? '').trim();
  if (site) clauses.push(`path:"${site.replace(/"/g, '')}"`);

  if (f.editedByMe && editorName) clauses.push(`Editor:"${editorName.replace(/"/g, '')}"`);

  const since = isoDate(f.since);
  const until = isoDate(f.until);
  if (since) clauses.push(`LastModifiedTime>=${since}`);
  if (until) clauses.push(`LastModifiedTime<=${until}`);

  if (clauses.length === 0) clauses.push('IsDocument:1');
  return clauses.join(' ');
}

/**
 * Build the Outlook (OWA) AQS query string for a mail search. An empty result
 * means "no filter" — list recent mail (sorted newest-first by the caller).
 */
export function buildMailQuery(f: M365SearchFilters): string {
  const clauses: string[] = [];
  const terms = kqlSafe(f.query ?? '');
  if (terms) clauses.push(terms);

  const from = (f.from ?? '').trim().replace(/"/g, '');
  if (from) clauses.push(from.includes(' ') ? `from:"${from}"` : `from:${from}`);

  const since = isoDate(f.since);
  const until = isoDate(f.until);
  if (since) clauses.push(`received>=${since}`);
  if (until) clauses.push(`received<=${until}`);

  return clauses.join(' ');
}

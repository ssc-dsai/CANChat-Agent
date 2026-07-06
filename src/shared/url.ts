/** Normalize a hostname or URL to a bare lowercase host without a leading www. */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  // Strip scheme and path if a full URL (or partial) was given.
  host = host.replace(/^[a-z]+:\/\//, '');
  host = host.split('/')[0];
  host = host.split('?')[0];
  host = host.split('#')[0];
  host = host.replace(/^www\./, '');
  return host;
}

/**
 * Reduce a conversation's tab-group tabs to the persistable pages: keep only
 * real http(s) URLs (drop chrome://, about:blank, empty), dedupe by URL, and cap
 * the count so a big research session can't bloat a saved record. Pure — used at
 * save time to snapshot the group for later rehydration.
 */
export function collectGroupUrls(
  tabs: Array<{ url?: string; title?: string }>,
  cap = 16,
): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const t of tabs) {
    const url = t.url ?? '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: t.title ?? '' });
    if (out.length >= cap) break;
  }
  return out;
}

const CHROME_PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

function pathLooksLikePdf(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Return the real PDF URL for a direct PDF URL or Chrome's built-in PDF viewer
 * wrapper (`chrome-extension://mhj.../index.html?src=<pdf-url>`). The browser tab
 * often exposes the wrapper URL, but pdf.js needs the underlying document URL.
 */
export function resolvePdfUrl(url: string): string | null {
  if (pathLooksLikePdf(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'chrome-extension:' || parsed.hostname !== CHROME_PDF_VIEWER_EXTENSION_ID) return null;
  const src = parsed.searchParams.get('src');
  if (!src) return null;
  try {
    const srcUrl = new URL(src);
    if (srcUrl.protocol === 'chrome-extension:' || srcUrl.protocol === 'chrome:' || srcUrl.protocol === 'chrome-untrusted:') return null;
    return src;
  } catch {
    return null;
  }
}

/**
 * Classify a URL by file type so the agent reads documents instead of navigating
 * to them (the browser downloads Office/PDF files rather than rendering, leaving
 * nothing to process). Tests the path extension only, ignoring any query string
 * (e.g. SharePoint's `…/Report.pptx?web=1`). Returns null for normal web pages.
 */
export function documentKindForUrl(url: string): 'office' | 'pdf' | null {
  if (resolvePdfUrl(url)) return 'pdf';
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.(docx?|docm|pptx?|pptm|xlsx?|xlsm)$/.test(pathname)) return 'office';
  if (/\.pdf$/.test(pathname)) return 'pdf';
  return null;
}

/** True when an active tab's host belongs to a playbook's origin (incl. subdomains). */
export function hostMatches(tabHost: string, origin: string): boolean {
  const a = normalizeHost(tabHost);
  const b = normalizeHost(origin);
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b);
}

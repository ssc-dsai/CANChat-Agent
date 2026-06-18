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

/**
 * Classify a URL by file type so the agent reads documents instead of navigating
 * to them (the browser downloads Office/PDF files rather than rendering, leaving
 * nothing to process). Tests the path extension only, ignoring any query string
 * (e.g. SharePoint's `…/Report.pptx?web=1`). Returns null for normal web pages.
 */
export function documentKindForUrl(url: string): 'office' | 'pdf' | null {
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

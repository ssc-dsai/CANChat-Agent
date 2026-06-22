// Environment probe — populates memory with what the extension can detect about
// the signed-in user without any new sign-in: their Microsoft 365 identity (read
// from the SharePoint `/_api/web/currentuser` endpoint over the existing session
// cookie), the enterprise systems they currently have open, and their locale.
// User-initiated (a button in Memory settings) and entirely on-device; gated on the
// memory feature being enabled. The pure helpers are unit-tested.

import { getSettings } from './storage';

/** Enterprise app hosts we surface as "work systems" — an allowlist so ordinary
 *  browsing never leaks into the probe. */
const WORK_HOST_PATTERNS: RegExp[] = [
  /\.sharepoint\.com$/i,
  /(^|\.)outlook\.office(365)?\.com$/i,
  /(^|\.)office\.com$/i,
  /(^|\.)microsoft365\.com$/i,
  /(^|\.)teams\.microsoft\.com$/i,
  /(^|\.)atlassian\.net$/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)servicenow\.com$/i,
  /(^|\.)salesforce\.com$/i,
  /(^|\.)workday\.com$/i,
  /\.gc\.ca$/i,
];

/** Is this hostname one of the known enterprise/work app hosts? */
export function isWorkHost(host: string): boolean {
  return WORK_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * Extract a human-readable sign-in/AD username from a SharePoint `LoginName`,
 * which is a claims token like `i:0#.f|membership|first.last@contoso.com` or a
 * Windows form `0#.w|CONTOSO\\first.last`. Returns the principal after the last
 * `|`, preserving `DOMAIN\\user` and UPN/email forms. Null when unparseable.
 */
export function parseAdUsername(login?: string | null): string | undefined {
  if (!login || typeof login !== 'string') return undefined;
  const principal = (login.includes('|') ? login.split('|').pop()! : login).trim();
  return principal || undefined;
}

async function fetchSpIdentity(
  base: string,
): Promise<{ title?: string; email?: string; adUsername?: string } | { error: string }> {
  const root = base.replace(/\/+$/, '');
  try {
    const res = await fetch(`${root}/_api/web/currentuser?$select=Title,Email,LoginName`, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=nometadata' },
    });
    if (!res.ok) {
      return { error: `Could not read your Microsoft 365 identity (HTTP ${res.status}). Make sure you are signed into ${root}.` };
    }
    const u = (await res.json()) as { Title?: string; Email?: string; LoginName?: string };
    return { title: u.Title, email: u.Email, adUsername: parseAdUsername(u.LoginName) };
  } catch (err) {
    return { error: `Could not reach ${root}: ${String(err)}` };
  }
}

async function resolveSpBase(sharepointBaseUrl?: string): Promise<string | undefined> {
  const base = sharepointBaseUrl?.trim();
  if (base) return base;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url) {
      const u = new URL(tab.url);
      if (/\.sharepoint\.com$/i.test(u.hostname)) return u.origin;
    }
  } catch {
    // no usable active tab
  }
  return undefined;
}

export interface ProbeResult {
  facts: string[];
  notes: string[];
}

/** Gather on-device facts about the signed-in user for memory. */
export async function probeEnvironment(): Promise<ProbeResult> {
  const facts: string[] = [];
  const notes: string[] = [];
  const settings = await getSettings();

  // 1) Microsoft 365 identity via the SharePoint session cookie.
  const spBase = await resolveSpBase(settings?.sharepointBaseUrl);
  if (spBase) {
    const id = await fetchSpIdentity(spBase);
    if ('error' in id) {
      notes.push(id.error);
    } else {
      if (id.title) facts.push(`Name: ${id.title}`);
      if (id.email) facts.push(`Work email: ${id.email}`);
      if (id.adUsername && id.adUsername !== id.email) {
        facts.push(`Sign-in / AD username: ${id.adUsername}`);
      }
    }
  } else {
    notes.push(
      'No Microsoft 365 identity found — set a SharePoint base URL in Settings or open a SharePoint tab, then probe again.',
    );
  }

  // 2) Work systems currently open.
  try {
    const tabs = await chrome.tabs.query({});
    const hosts = new Set<string>();
    for (const t of tabs) {
      if (!t.url) continue;
      try {
        const u = new URL(t.url);
        if (/^https?:$/.test(u.protocol) && isWorkHost(u.hostname)) hosts.add(u.hostname);
      } catch {
        // skip unparseable tab URLs
      }
    }
    const list = [...hosts].sort();
    if (list.length) facts.push(`Uses these work systems (currently open): ${list.slice(0, 12).join(', ')}`);
  } catch {
    // tabs unavailable
  }

  // 3) Locale + timezone.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const lang = typeof navigator !== 'undefined' ? navigator.language : '';
    const bits = [tz && `timezone ${tz}`, lang && `language ${lang}`].filter(Boolean);
    if (bits.length) facts.push(`Locale: ${bits.join(', ')}`);
  } catch {
    // Intl/navigator unavailable
  }

  return { facts, notes };
}

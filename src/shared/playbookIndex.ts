// Pure helpers for the hosted "playbook index" — a JSON file listing installable
// SKILL.md files that the App playbook library polls. No chrome.*/network here so
// parsing is unit-testable; SkillsSection does the fetch + storage write.
//
// Index shape (either a bare array or an object with a `playbooks` array):
//   { "playbooks": [
//       { "name": "search-sharepoint", "description": "…", "file": "search-sharepoint.md" },
//       { "name": "x", "description": "…", "url": "https://host/x/SKILL.md", "origin": "x.com" }
//   ] }
// Each entry points at a SKILL.md via `file` (resolved relative to the index URL)
// or an absolute `url`. `origin` is optional (makes it an app playbook).

/** The bundled default index — the skills/ folder in the project repo. */
export const DEFAULT_PLAYBOOK_INDEX_URL =
  'https://raw.githubusercontent.com/ScottSyms/CANAgent/main/skills/index.json';

export interface RemotePlaybook {
  name: string;
  description: string;
  origin?: string;
  /** Absolute URL of the SKILL.md to fetch on install. */
  url: string;
}

/** Resolve an entry's SKILL.md location to an absolute URL, or null if unusable. */
export function resolvePlaybookUrl(
  entry: { file?: string; url?: string },
  baseUrl: string,
): string | null {
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  if (entry.file) {
    try {
      return new URL(entry.file, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse a playbook index document into a clean list. Tolerates a bare array or a
 * `{ playbooks: [...] }` wrapper; skips entries missing a name or a resolvable
 * SKILL.md location. Never throws — returns [] on malformed JSON.
 */
export function parsePlaybookIndex(text: string, baseUrl: string): RemotePlaybook[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { playbooks?: unknown }).playbooks)
      ? (data as { playbooks: unknown[] }).playbooks
      : null;
  if (!list) return [];

  const out: RemotePlaybook[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name || seen.has(name.toLowerCase())) continue;
    const url = resolvePlaybookUrl(
      {
        file: typeof e.file === 'string' ? e.file : undefined,
        url: typeof e.url === 'string' ? e.url : undefined,
      },
      baseUrl,
    );
    if (!url) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      description: typeof e.description === 'string' ? e.description.trim() : '',
      origin: typeof e.origin === 'string' && e.origin.trim() ? e.origin.trim() : undefined,
      url,
    });
  }
  return out;
}

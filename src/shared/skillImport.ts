// =============================================================================
// Pure helpers for importing a Claude "Agent Skill" (a SKILL.md file) into the
// extension's simpler Skill model. No chrome.*/network here so the parsing and
// compatibility heuristics are unit-testable in plain Node; SkillsSection does
// the actual fetch and storage write.
//
// A SKILL.md is YAML-frontmatter (name, description) + markdown instructions,
// often bundled with scripts the browser agent can't run — detectIncompatibility
// surfaces that so the import can warn rather than silently add a dead skill.
// =============================================================================

/** The extension's skill-name rule (mirrors SkillsSection's NAME_PATTERN). */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Coerce an arbitrary skill name to the strict lowercase-kebab the form requires. */
export function slugifySkillName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return NAME_PATTERN.test(slug) ? slug : slug || 'imported-skill';
}

/**
 * Rewrite a GitHub "blob" page URL to its raw.githubusercontent.com equivalent so
 * it can be fetched as plain text. Passes through URLs that are already raw (or
 * anything else) unchanged.
 */
export function rawGithubUrl(url: string): string {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.trim());
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  return url.trim();
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Split a SKILL.md into a name (slugified), description, and markdown body. Reads
 * a minimal `---`-fenced frontmatter (only `name`/`description` matter), treating
 * everything after the closing fence as the body. When there's no frontmatter the
 * whole text becomes the body and name/description come back empty for the caller
 * to handle.
 */
export function parseSkillFrontmatter(text: string): ParsedSkill {
  const normalized = text.replace(/\r\n/g, '\n');
  const fenced = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!fenced) {
    return { name: '', description: '', body: normalized.trim() };
  }
  const [, frontmatter, body] = fenced;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = stripQuotes(kv[2].trim());
  }
  return {
    name: fields.name ? slugifySkillName(fields.name) : '',
    description: fields.description ?? '',
    body: body.trim(),
  };
}

function stripQuotes(v: string): string {
  return v.replace(/^["']|["']$/g, '').trim();
}

/**
 * Heuristically detect that a skill depends on tools this browser agent does not
 * have (bundled scripts, Python/bash, file I/O, an allowed-tools list naming
 * Bash/exec). Returns a short human-readable reason, or null if it looks like a
 * pure instruction/web skill. Deliberately conservative to limit false alarms.
 */
export function detectIncompatibility(text: string): string | null {
  const t = text.toLowerCase();
  if (/(^|[\s`(])scripts?\//.test(t) || /\.(py|sh)\b/.test(t)) {
    return 'References bundled scripts this browser agent can’t run.';
  }
  if (/\b(python3?|pip|subprocess|bash|shell command|run the script)\b/.test(t)) {
    return 'Mentions Python/shell tooling this browser agent can’t run.';
  }
  if (/allowed-tools\s*:.*\b(bash|execute|shell|computer)\b/.test(t)) {
    return 'Declares tools (Bash/exec) this browser agent doesn’t provide.';
  }
  return null;
}

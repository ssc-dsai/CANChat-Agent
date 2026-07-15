// =============================================================================
// Pure helpers for importing a Claude "Agent Skill" (a SKILL.md file, or a zip
// of one/several) into the extension's simpler Skill model. No chrome.*/network
// here so the parsing, versioning, and compatibility heuristics are
// unit-testable in plain Node; SkillsSection does the actual fetch/file-read
// and storage write.
//
// A SKILL.md is YAML-frontmatter (name, description, and now optionally
// version/allowed-tools) + markdown instructions, often bundled with scripts
// the browser agent can't run — detectIncompatibility surfaces that so the
// import can warn rather than silently add a dead skill. unzipSync is a pure
// decompressor (no DOM/network), so parseSkillZip stays dependency-free too.
// =============================================================================

import { unzipSync } from 'fflate';

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
  /** From an optional `version:` frontmatter field, e.g. "1.2.0". */
  version?: string;
  /** From an optional `allowed-tools:` frontmatter field (comma-separated). */
  declaredTools?: string[];
}

/**
 * Split a SKILL.md into a name (slugified), description, markdown body, and
 * (when present) version/declared-tools metadata. Reads a minimal
 * `---`-fenced frontmatter, treating everything after the closing fence as
 * the body. When there's no frontmatter the whole text becomes the body and
 * name/description come back empty for the caller to handle.
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
  const declaredTools = fields['allowed-tools']
    ? fields['allowed-tools'].split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;
  return {
    name: fields.name ? slugifySkillName(fields.name) : '',
    description: fields.description ?? '',
    body: body.trim(),
    version: fields.version ? fields.version.trim() : undefined,
    declaredTools,
  };
}

function stripQuotes(v: string): string {
  return v.replace(/^["']|["']$/g, '').trim();
}

/**
 * Compare two dotted version strings numerically, segment by segment (not
 * strict semver — no pre-release/build-metadata handling, since skill
 * versions are user/model-authored free text, not npm packages). Non-numeric
 * or missing segments count as 0, so "1.2" < "1.2.1" and "abc" behaves like
 * "0". Returns -1/0/1 like Array.prototype.sort expects.
 */
export function compareSkillVersions(a: string | undefined, b: string | undefined): number {
  const segs = (v: string | undefined) => (v ?? '').split('.').map((s) => Number.parseInt(s, 10) || 0);
  const [x, y] = [segs(a), segs(b)];
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Whether an incoming skill (re-)install should replace an existing one of
 * the same name. Absent-version skills keep the historical behavior — a
 * same-name install always replaces (no data to compare) — but once *both*
 * sides carry a version, an incoming version that is not newer is rejected,
 * so re-running "install skill X" twice with the same bundle is a no-op
 * (not a downgrade) and an older bundle can't clobber a newer local edit.
 */
export function shouldReplaceSkill(existingVersion: string | undefined, incomingVersion: string | undefined): boolean {
  if (!existingVersion || !incomingVersion) return true;
  return compareSkillVersions(incomingVersion, existingVersion) >= 0;
}

/**
 * Bump a skill's version after the agent (re-)distills it from a completed
 * task: absent/unparseable → "1.0.0" (first save); otherwise a patch bump
 * (x.y.z → x.y.(z+1), padding missing segments with 0) — distillation
 * refines wording/steps, not a new major capability, so patch is the
 * conservative default.
 */
export function bumpSkillVersion(existing: string | undefined): string {
  if (!existing) return '1.0.0';
  const parts = existing.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Extract every SKILL.md-shaped member from a zip archive (a single skill,
 * or a "pack" of several under subdirectories) — any `.md` file whose
 * content parses to a non-empty name *and* description via
 * `parseSkillFrontmatter`. Files that don't look like a skill (missing
 * frontmatter, or frontmatter without both fields) are silently skipped
 * rather than erroring, so a zip that also bundles a README doesn't fail the
 * whole import. Throws only if the archive itself can't be decompressed.
 */
export function parseSkillZip(bytes: Uint8Array): ParsedSkill[] {
  const files = unzipSync(bytes);
  const decoder = new TextDecoder();
  const skills: ParsedSkill[] = [];
  for (const [path, data] of Object.entries(files)) {
    if (!/\.md$/i.test(path) || data.length === 0) continue;
    const parsed = parseSkillFrontmatter(decoder.decode(data));
    if (parsed.name && parsed.description) skills.push(parsed);
  }
  return skills;
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

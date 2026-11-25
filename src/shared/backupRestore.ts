// =============================================================================
// Deciding what a backup file may write on restore.
//
// A backup is a file someone may hand you ("our team config"), so restoring one
// is accepting configuration from an outside source. Without limits it could
// overwrite anything in chrome.storage.local — vault keys, OAuth tokens, the
// audit index — or quietly point the model endpoint, embedding endpoint or an
// MCP server at someone else's host, or add a skill whose body becomes trusted
// agent instructions.
//
// So a restore:
//   - writes only the configuration keys a backup is supposed to carry, each
//     with the expected JSON shape (anything else is dropped and reported);
//   - lists every change to where data goes or what the agent is told, so the
//     confirmation shows it before anything is written.
// =============================================================================

/** The chrome.storage.local keys that make up a backup's configuration. */
export const BACKUP_STORAGE_KEYS = [
  'ba_settings',
  'ba_sites',
  'ba_capabilities',
  'ba_skills',
  'ba_memory',
  'ba_memory_graph',
  'ba_lessons',
  'ba_memory_enabled',
  'ba_memory_min_confidence',
  'ba_language',
  'ba_projects',
  'ba_active_project',
  'ba_active_repo',
] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isArrayOfObjects = (v: unknown): boolean => Array.isArray(v) && v.every(isPlainObject);
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === 'string';

const KEY_SHAPES: Record<(typeof BACKUP_STORAGE_KEYS)[number], (v: unknown) => boolean> = {
  ba_settings: isPlainObject,
  ba_sites: isArrayOfObjects,
  ba_capabilities: isArrayOfObjects,
  ba_skills: isArrayOfObjects,
  ba_memory: (v) => Array.isArray(v) || isPlainObject(v),
  ba_memory_graph: (v) => isPlainObject(v) && Array.isArray(v.nodes) && Array.isArray(v.edges),
  ba_lessons: (v) => Array.isArray(v) || isPlainObject(v),
  ba_memory_enabled: (v) => typeof v === 'boolean',
  ba_memory_min_confidence: (v) => typeof v === 'number' && Number.isFinite(v),
  ba_language: (v) => v === 'auto' || v === 'en' || v === 'fr',
  ba_projects: isArrayOfObjects,
  ba_active_project: isStringOrNull,
  ba_active_repo: isStringOrNull,
};

/**
 * Settings that decide where prompts, documents and credentials are sent, or
 * what the agent is instructed to do. Any change to these is shown to the user.
 */
const SENSITIVE_SETTINGS: Array<[field: string, label: string]> = [
  ['baseUrl', 'Model endpoint'],
  ['subscriptionProvider', 'Model provider'],
  ['protocol', 'Model protocol'],
  ['bedrockMantle', 'Bedrock Mantle'],
  ['awsRegion', 'AWS region'],
  ['embeddingBaseUrl', 'Embedding endpoint'],
  ['transcriptionBaseUrl', 'Transcription endpoint'],
  ['decisionModelBaseUrl', 'Decision-model endpoint'],
  ['sharepointBaseUrl', 'SharePoint site'],
  ['playbookIndexUrl', 'Playbook index URL'],
  ['gitlabInstanceUrl', 'GitLab instance'],
  ['gitlabDuoClientId', 'GitLab OAuth client'],
  ['graphClientId', 'Microsoft 365 app (client ID)'],
  ['graphTenant', 'Microsoft 365 tenant'],
  ['systemPrompt', 'Custom system prompt'],
  ['promptOverrides', 'Prompt overrides'],
  ['restrictBackgroundToLocal', 'Keep background work on local models'],
  ['modelProfiles', 'Model profiles'],
  ['roleProfiles', 'Model role assignments'],
];

export interface RestorePlan {
  /** What will be written to chrome.storage.local. */
  bulk: Record<string, unknown>;
  /** Keys in the file that a backup may not set (dropped). */
  ignoredKeys: string[];
  /** Allowed keys whose value had the wrong shape (dropped). */
  invalidKeys: string[];
  /** Human-readable security-relevant changes, for the confirmation. */
  changes: string[];
}

function short(v: unknown, max = 80): string {
  if (v === undefined || v === null || v === '') return '(none)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Endpoints carried by a site / capability entry. */
function endpointsOf(entry: Record<string, unknown>): string[] {
  return ['url', 'mcpUrl', 'searchUrlTemplate']
    .map((k) => entry[k])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

function entryName(entry: Record<string, unknown>): string {
  return String(entry.name ?? entry.id ?? 'unnamed');
}

/**
 * Work out what a restore would write and what it changes. `storage` is the
 * backup's storage map; `current` holds the same keys as they are now;
 * `conversationKeys` are handled separately (re-encrypted on import).
 */
export function planRestore(
  storage: Record<string, unknown>,
  current: Record<string, unknown>,
  conversationKeys: ReadonlySet<string>,
): RestorePlan {
  const allowed = new Set<string>(BACKUP_STORAGE_KEYS);
  const bulk: Record<string, unknown> = {};
  const ignoredKeys: string[] = [];
  const invalidKeys: string[] = [];
  for (const [key, value] of Object.entries(storage)) {
    if (conversationKeys.has(key)) continue;
    if (!allowed.has(key)) {
      ignoredKeys.push(key);
      continue;
    }
    if (!KEY_SHAPES[key as (typeof BACKUP_STORAGE_KEYS)[number]](value)) {
      invalidKeys.push(key);
      continue;
    }
    bulk[key] = value;
  }

  const changes: string[] = [];
  if (isPlainObject(bulk.ba_settings)) {
    const next = bulk.ba_settings;
    const prev = isPlainObject(current.ba_settings) ? current.ba_settings : {};
    for (const [field, label] of SENSITIVE_SETTINGS) {
      if (!same(prev[field], next[field])) changes.push(`${label}: ${short(prev[field])} → ${short(next[field])}`);
    }
  }
  for (const key of ['ba_sites', 'ba_capabilities'] as const) {
    if (!Array.isArray(bulk[key])) continue;
    const prevEndpoints = new Set(
      (Array.isArray(current[key]) ? (current[key] as Array<Record<string, unknown>>) : []).flatMap(endpointsOf),
    );
    for (const entry of bulk[key] as Array<Record<string, unknown>>) {
      for (const endpoint of endpointsOf(entry)) {
        if (!prevEndpoints.has(endpoint)) changes.push(`New site or MCP server "${entryName(entry)}": ${short(endpoint)}`);
      }
    }
  }
  if (Array.isArray(bulk.ba_skills)) {
    const prevSkills = new Map(
      (Array.isArray(current.ba_skills) ? (current.ba_skills as Array<Record<string, unknown>>) : []).map((s) => [
        String(s.name ?? ''),
        String(s.body ?? ''),
      ]),
    );
    for (const skill of bulk.ba_skills as Array<Record<string, unknown>>) {
      const name = String(skill.name ?? '');
      if (prevSkills.get(name) !== String(skill.body ?? '')) {
        changes.push(`${prevSkills.has(name) ? 'Changed' : 'New'} skill (its instructions are given to the agent): /${name}`);
      }
    }
  }
  return { bulk, ignoredKeys, invalidKeys, changes };
}

/** The confirmation text for a restore plan. */
export function describeRestore(plan: RestorePlan, maxLines = 20): string {
  const lines = [
    'Restore will overwrite your current settings, hints, skills, and memory, and replace any repositories or products with the same name/id.',
  ];
  if (plan.changes.length > 0) {
    lines.push('', 'This backup changes where your data is sent or what the agent is told:');
    for (const c of plan.changes.slice(0, maxLines)) lines.push(`• ${c}`);
    if (plan.changes.length > maxLines) lines.push(`• …and ${plan.changes.length - maxLines} more`);
    lines.push('', 'Only restore a backup from a source you trust.');
  }
  const dropped = [...plan.ignoredKeys, ...plan.invalidKeys];
  if (dropped.length > 0) {
    lines.push('', `Skipped ${dropped.length} entr${dropped.length === 1 ? 'y' : 'ies'} a backup may not set: ${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? ', …' : ''}`);
  }
  lines.push('', 'Continue?');
  return lines.join('\n');
}

// =============================================================================
// Durable `chrome.storage.local` key names for the extension's collections.
// This is the single source of truth for the `ba_*` keys: storage.ts reads/writes
// them, and the backup/restore parser (backupFormat.ts), the provider config
// readers, the sidebar, and the service-worker change listener all reference the
// same constants so a rename can't drift between the writer and its readers.
//
// Kept dependency-free (no chrome.*, no other imports) so it is safe to import
// from anywhere — shared/, background/, sidebar/ — without creating cycles.
// =============================================================================

/** Settings (baseUrl, apiKey, model, provider config, playbook index URL, …). */
export const SETTINGS_KEY = 'ba_settings';
/** Legacy known sites, pre-migration to capabilities. */
export const SITES_KEY = 'ba_sites';
/** Sourcing capabilities registry. */
export const CAPABILITIES_KEY = 'ba_capabilities';
/** App playbooks / skills. */
export const SKILLS_KEY = 'ba_skills';
/** Flat memory entries (pre-graph). */
export const MEMORY_KEY = 'ba_memory';
/** Whether persistent memory is enabled at all. */
export const MEMORY_ENABLED_KEY = 'ba_memory_enabled';
/** Minimum confidence for a memory to be retained. */
export const MEMORY_MIN_CONFIDENCE_KEY = 'ba_memory_min_confidence';
/** Graph-structured memory. */
export const MEMORY_GRAPH_KEY = 'ba_memory_graph';
/** Learned lessons / heuristics. */
export const LESSONS_KEY = 'ba_lessons';
/** Project metadata collection. */
export const PROJECTS_KEY = 'ba_projects';
/** The currently active project id. */
export const ACTIVE_PROJECT_KEY = 'ba_active_project';

// --- saved conversations (auto-history) --------------------------------------
/** Lightweight index array of saved conversation summaries. */
export const CONVERSATION_INDEX_KEY = 'ba_conv_index';
/** Body-record key prefix; a conversation's body lives at `${PREFIX}${id}`. */
export const CONVERSATION_KEY_PREFIX = 'ba_conv_';
/** Per-conversation user labels. */
export const CONVERSATION_LABELS_KEY = 'ba_conv_labels';
/** The conversation currently open in the sidebar. */
export const ACTIVE_CONVERSATION_KEY = 'ba_active_conversation';

// --- credentials / session state ---------------------------------------------
/** Encrypted external auth tokens. */
export const AUTH_TOKENS_KEY = 'ba_auth_tokens';
/** "Approve for this session" grants. */
export const SESSION_APPROVALS_KEY = 'ba_session_approvals';

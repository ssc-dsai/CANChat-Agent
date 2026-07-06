// =============================================================================
// Shared domain types used across the UI, the service worker, and the offscreen
// document. Pure data shapes only — no behaviour — so both ends of the message
// protocol agree on what they're exchanging. Persisted shapes (Settings,
// SiteEntry, Skill, MemoryEntry) are also what Backup & Restore serializes.
// =============================================================================

export interface TabSummary {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  /** Chrome tab-group id, if the tab is in a group. */
  groupId?: number;
  /** Tab-group title, if the tab is in a named group. */
  group?: string;
}

export interface LinkSummary {
  text: string;
  href: string;
}

export interface HeadingSummary {
  level: number;
  text: string;
}

export type ExtractionStatus = 'ok' | 'partial' | 'blocked' | 'auth_required' | 'unsupported';

export interface PageContent {
  tabId: number;
  url: string;
  title: string;
  text: string;
  html?: string;
  metadata: Record<string, string>;
  links: LinkSummary[];
  headings: HeadingSummary[];
  extractionStatus: ExtractionStatus;
  capturedAt: string;
}

export interface ElementRef {
  refId: string;
  tagName: string;
  /** Effective ARIA role (explicit or implicit from the tag). */
  role?: string;
  ariaLabel?: string;
  /** Computed accessible name (accname algorithm, simplified). */
  name?: string;
  text?: string;
  /** ARIA states, e.g. ['expanded','selected','disabled']. */
  states?: string[];
  /** Nearest landmark/container, e.g. 'dialog "Compose"'. */
  group?: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  /** Viewport-coordinate bounding box, for coordinate gestures. */
  rect?: { x: number; y: number; width: number; height: number };
}

export type AuthStatus = 'authenticated' | 'auth_required' | 'unknown' | 'blocked';

export interface AuthState {
  status: AuthStatus;
  reason?: string;
  loginUrl?: string;
  detectedProvider?: string;
}

export interface NavigationResult {
  tabId: number;
  url: string;
  title: string;
  status: 'complete' | 'timeout' | 'error';
  error?: string;
}

export interface ActionResult {
  ok: boolean;
  detail?: string;
}

export interface PageStateResult {
  tabId: number;
  state: 'complete' | 'timeout';
  url: string;
}

/** A user-curated known site (or MCP server) the agent can consult when planning tasks. */
export interface SiteEntry {
  id: string;
  name: string;
  /** Website URL. Optional when this entry is an MCP server (mcpUrl set). */
  url: string;
  description: string;
  /** Optional deep-link search URL containing a {query} placeholder. */
  searchUrlTemplate?: string;
  /** When set, this hint is an MCP server: its HTTP (Streamable-HTTP) endpoint. */
  mcpUrl?: string;
  /** Optional bearer token for the MCP server. */
  mcpToken?: string;
}

/** A reusable named procedure the agent can apply to tasks (Claude Code-style). */
export interface Skill {
  id: string;
  /** Lowercase-kebab slug; users invoke it by typing /name in the chat. */
  name: string;
  /** One-liner shown to the model in every task for auto-triggering. */
  description: string;
  /** Full markdown instructions, loaded on demand via the use_skill tool. */
  body: string;
  /**
   * Optional site binding. When set (a normalized hostname like
   * "marinetraffic.com"), the skill is an app playbook: its body auto-injects
   * whenever the active tab's host matches.
   */
  origin?: string;
  /** When true, show a quick-launch button for this skill in the toolbar. */
  showButton?: boolean;
  /** Display text for the quick-launch button; falls back to /name if empty. */
  buttonLabel?: string;
}

/** One durable fact about the user, kept only when memory is enabled. */
export interface MemoryEntry {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** One durable agent-behavior lesson learned from prior tasks. */
export interface LessonEntry {
  id: string;
  /** Concise instruction to apply on similar future tasks. */
  text: string;
  /** Keywords/phrases used to match future tasks. */
  triggers: string[];
  /** Optional normalized site host for site-specific lessons. */
  origin?: string;
  /** Tool names associated with the lesson. */
  tools?: string[];
  /** Number of times a matching lesson was reinforced/merged. */
  uses: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Default on-device embedding model (transformers.js): 384-d MiniLM, ~23 MB
 * int8. Declared here (dependency-free) so the service worker can derive the
 * embedder identity without importing the transformers runtime.
 */
export const DEFAULT_LOCAL_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Azure OpenAI's required api-version (e.g. "2024-02-01"). When set, the
   * adapter switches to Azure mode for every service: it appends
   * ?api-version=… to each request URL and authenticates with the `api-key`
   * header instead of `Authorization: Bearer`. Blank = standard OpenAI shape.
   */
  apiVersion?: string;
  temperature?: number;
  maxTokens?: number;
  /** Default number of passages a repository search returns (search_repo k). Absent = 6. */
  repoSearchK?: number;
  /**
   * Hybrid retrieval for repository search: fuse dense semantic ranking with a
   * BM25 keyword ranking (Reciprocal Rank Fusion) so exact tokens — IDs, codes,
   * surnames — surface alongside semantic matches. Default **on**; set to
   * `false` for pure semantic search. No re-indexing needed either way.
   */
  hybridSearch?: boolean;
  /**
   * Max tool-iteration steps per task (the soft budget). Absent = 20. The plan
   * extension and hard ceiling scale from it: extension = round(maxSteps/2),
   * ceiling = maxSteps * 2 — so 20 preserves the 20/10/40 defaults.
   */
  maxSteps?: number;
  /** Optional user instructions appended to the built-in system prompt. */
  systemPrompt?: string;
  /** Optional SharePoint base URL for the cookie-auth search tool. */
  sharepointBaseUrl?: string;
  /** Optional Outlook-on-the-web base URL for microsoft365_search mail; default https://outlook.office.com. */
  outlookBaseUrl?: string;
  /**
   * Keep the mailbox repo current automatically via an hourly `chrome.alarms`
   * refresh, riding the same Outlook-on-the-web cookie session as a manual
   * index. Default **off** (opt-in) — only takes effect once the mailbox has
   * been indexed at least once; a background refresh never runs the initial
   * full index. Silently no-ops (recorded, not surfaced as an error banner) if
   * the Outlook session has expired.
   */
  mailAutoRefresh?: boolean;
  /**
   * URL of a hosted playbook index (JSON listing installable SKILL.md files).
   * Absent = the bundled default (DEFAULT_PLAYBOOK_INDEX_URL). The App playbook
   * library polls this to offer one-click installs of remote skills.
   */
  playbookIndexUrl?: string;
  /**
   * Which embedder produces RAG vectors. `'local'` (default) runs a small
   * transformers.js model on-device in the offscreen document — nothing leaves
   * the machine. `'external'` POSTs chunk text to the configured /embeddings
   * endpoint. Switching this invalidates existing repos (different model ⇒
   * incompatible vectors), so a repo records the model it was built with and
   * refuses cross-model queries until re-indexed.
   */
  embedder?: 'local' | 'external';
  /** transformers.js model id for the local embedder. Absent = the bundled default. */
  localEmbedModel?: string;
  /** Optional separate model id for the /embeddings route (external RAG). */
  embeddingModel?: string;
  /** Optional separate endpoint base URL for embeddings; blank = use baseUrl. */
  embeddingBaseUrl?: string;
  /** Optional separate API key for embeddings; blank = use apiKey. */
  embeddingApiKey?: string;
  /** Optional speech-to-text model id for the /audio/transcriptions route (voice prompts). */
  transcriptionModel?: string;
  /** Optional separate endpoint base URL for transcription; blank = use baseUrl. */
  transcriptionBaseUrl?: string;
  /** Optional separate API key for transcription; blank = use apiKey. */
  transcriptionApiKey?: string;
  /**
   * Automatically back off and retry transient model-endpoint failures (HTTP 429
   * rate limits and transient 5xx), honoring a Retry-After header. Absent = on;
   * set false to surface those errors immediately instead.
   */
  retryOnRateLimit?: boolean;
  /**
   * Summarize old tool outputs (with a cheap model call) when compacting a long
   * conversation, instead of blanking them — preserves salient facts/URLs the
   * findings list may have missed. Absent = on; set false to skip the extra call
   * and fall back to a static placeholder.
   */
  summarizeObservations?: boolean;
  /**
   * Run one self-check pass over a tool-free final answer before accepting it,
   * giving the agent a chance to fix an incomplete or unverified result. Absent =
   * on; set false to skip the extra call and accept the first answer.
   */
  verifyAnswers?: boolean;
}

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'paused'
  | 'awaiting_approval'
  | 'auth_required'
  | 'error';

export interface ToolActivity {
  id: string;
  tool: string;
  argsSummary: string;
  status: 'running' | 'ok' | 'error' | 'denied';
  detail?: string;
  timestamp: string;
}

/** A structured table the agent produced, downloadable as CSV/JSON. */
export interface DataExport {
  title: string;
  filename: string;
  columns: string[];
  rows: string[][];
}

export interface ChatMessageView {
  role: 'user' | 'assistant' | 'notice';
  text: string;
  timestamp: string;
  /** Data URLs of attached snapshot images, for thumbnail rendering. */
  images?: string[];
  /** A downloadable table attached to this message. */
  dataExport?: DataExport;
  /** A downloadable binary file (e.g. a generated .docx) attached to this message. */
  fileArtifact?: FileArtifact;
}

/** A generated binary document offered to the user as a download. */
export interface FileArtifact {
  filename: string;
  mimeType: string;
  /** File bytes, base64-encoded (binary can't cross the message port directly). */
  dataBase64: string;
}

/**
 * Lightweight history-list entry for a saved conversation. Lives in the
 * `ba_conv_index` array so the History overlay can render without loading every
 * (potentially image-heavy) conversation body. The full body — including the
 * `LlmMessage[]` model context needed to resume — is keyed separately as
 * `ba_conv_<id>` and typed in storage.ts.
 */
export interface ConversationSummary {
  id: string;
  /** First user message, clipped; empty when only an image was sent. */
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Short snippet of the latest message, for the list row (fallback). */
  preview: string;
  /** Model-written 1–2 sentence summary of the conversation, shown in the list row when present. */
  summary?: string;
  /** Ids of the labels assigned to this conversation (see ConversationLabel). */
  labels?: string[];
}

/**
 * A user-defined, colored label for organizing the History list. Stored as a
 * small registry under `ba_conv_labels`; conversations reference labels by id.
 * `color` is a palette *key* (see shared/labelColors.ts), never a raw hex, so
 * theming stays in CSS.
 */
export interface ConversationLabel {
  id: string;
  name: string;
  color: string;
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface PlanView {
  steps: { text: string; status: PlanStepStatus }[];
}

export type ContextScope = 'active' | 'selected' | 'all';

export interface TabContextSnapshot {
  snapshotId: string;
  scope: ContextScope;
  tabs: PageContent[];
  createdAt: string;
}

/** Lightweight view of the snapshot for the sidebar. */
export interface TabContextSummary {
  snapshotId: string;
  scope: ContextScope;
  createdAt: string;
  tabs: Array<{
    tabId: number;
    title: string;
    url: string;
    extractionStatus: ExtractionStatus;
    capturedAt: string;
  }>;
}

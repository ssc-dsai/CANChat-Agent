// =============================================================================
// Message protocol — the typed contract between the side panel (UI) and the
// background service worker. Three channels:
//   - `SidebarCommand`: UI → background over the long-lived Port (user actions).
//   - `BackgroundEvent`: background → UI over the same Port (state/streaming).
//   - `RuntimeRequest` + matching responses: one-shot request/response calls
//     via `chrome.runtime.sendMessage` (test connection, transcription, repos).
// Plus the offscreen-document request/response shapes for PDF/Office/RAG work.
//
// Keeping these as discriminated unions means the `switch` statements in
// `serviceWorker.ts` and `Sidebar.tsx` are exhaustively type-checked.
// =============================================================================

import type {
  AgentStatus,
  ChatMessageView,
  ConversationLabel,
  PlanView,
  Settings,
  TabContextSummary,
  ToolActivity,
} from './types';

/** Commands sent from the sidebar to the background over a long-lived port. */
export type SidebarCommand =
  | { type: 'user_message'; text: string; mentions?: Array<{ kind: 'bookmark' | 'repo'; value: string }> }
  | { type: 'stop_task' }
  | { type: 'clear_conversation' }
  | { type: 'undo_exchange' }
  | { type: 'load_conversation'; id: string }
  | { type: 'delete_conversation'; id: string }
  // `record` is a conversation body already validated by parseConversationFile in
  // the UI; typed as unknown to avoid leaking the background StoredConversation type.
  // `labels` carries any label definitions bundled in the file so the runtime can
  // re-register them on import (best-effort portability).
  | { type: 'import_conversation'; record: unknown; labels?: ConversationLabel[] }
  | { type: 'clear_conversations' }
  | { type: 'set_conversation_labels'; id: string; labels: string[] }
  | { type: 'distill_skill' }
  | { type: 'dismiss_distill' }
  | { type: 'pause_agent' }
  | { type: 'resume_agent' }
  | { type: 'approval_response'; requestId: string; approved: boolean; rememberForSession?: boolean }
  | { type: 'include_active_tab' }
  | { type: 'include_all_tabs' }
  | { type: 'refresh_context' }
  | { type: 'attach_snapshot'; dataUrl: string; title: string; url: string }
  | { type: 'discard_snapshots' }
  | { type: 'capture_page' }
  | { type: 'capture_to_repo'; repo: string; scope: 'tab' | 'group' }
  | { type: 'get_state' }
  | { type: 'ping' };

/** Context about a capability's trust level and auth status for approval UX. */
export interface ApprovalContext {
  /** Tool name being approved (e.g. "call_mcp_tool"). */
  toolName: string;
  /** Capability kind when the tool is sourced from a registered capability. */
  capabilityKind?: string;
  /** Capability name when the tool is sourced from a registered capability. */
  capabilityName?: string;
  /** Trust level of the sourcing capability, if applicable. */
  trustLevel?: string;
  /** Auth method of the sourcing capability, if applicable. */
  authMethod?: string;
  /** Whether auth credentials are configured for this capability. */
  authConfigured: boolean;
}

/** Events pushed from the background to every connected sidebar. */
export type BackgroundEvent =
  | { type: 'chat_message'; message: ChatMessageView }
  | { type: 'status'; status: AgentStatus; detail?: string }
  | { type: 'tool_activity'; activity: ToolActivity }
  | { type: 'approval_request'; requestId: string; description: string; detail: string; approvalContext?: ApprovalContext }
  | { type: 'auth_required'; origin: string; message: string }
  | { type: 'permission_required'; origin: string; message: string }
  | { type: 'context_update'; summary: TabContextSummary | null }
  | { type: 'pending_snapshots'; thumbs: string[] }
  | { type: 'plan_update'; plan: PlanView | null }
  | { type: 'distill_offer'; available: boolean }
  | { type: 'undo_available'; available: boolean }
  | { type: 'undo_done'; restoredText: string }
  | { type: 'error'; message: string }
  | {
      type: 'full_state';
      status: AgentStatus;
      messages: ChatMessageView[];
      activities: ToolActivity[];
      context: TabContextSummary | null;
      pendingApproval: { requestId: string; description: string; detail: string; approvalContext?: ApprovalContext } | null;
      authNotice: { origin: string; message: string } | null;
      permissionNotice: { origin: string; message: string } | null;
      pendingSnapshots: string[];
      plan: PlanView | null;
      canDistill: boolean;
      canUndo: boolean;
    };

/** One-shot messages handled by chrome.runtime.onMessage. */
export type RuntimeRequest =
  | { type: 'test_connection'; settings: Settings }
  | { type: 'repo_list' }
  | { type: 'repo_delete'; repo: string }
  | { type: 'repo_docs'; repo: string }
  | { type: 'repo_doc_delete'; repo: string; docId: string }
  | { type: 'repo_export' }
  | { type: 'repo_import'; repos: ExportedRepo[] }
  | { type: 'add_files_to_repo'; repo: string; files: UploadFile[]; kind?: 'page' | 'folder' | 'mail' }
  // Connect (if needed) and index the user's Office 365 mailbox into a repo via
  // Microsoft Graph; incremental on repeat. Handled in the service worker.
  | { type: 'index_mailbox'; repo: string }
  | { type: 'mailbox_connected' }
  | { type: 'mailbox_disconnect' }
  | { type: 'open_data_files'; files: DataFileUpload[] }
  | { type: 'transcribe_audio'; audioDataUrl: string }
  // Probe the signed-in environment (M365 identity, open work systems, locale) to
  // populate memory; only honored when the memory feature is enabled.
  | { type: 'probe_environment' }
  // Lets extension pages (the workspace data browser) drive the DuckDB engine; the
  // service worker owns the offscreen document, so it routes the op for them.
  | { type: 'duckdb'; op: DuckDbOp; sql?: string; tableName?: string; data?: string };

/** One picked file on its way into a repository (see shared/uploadFile.ts). */
export interface UploadFile {
  name: string;
  kind: 'text' | 'pdf' | 'office';
  /** Set for `kind:'text'` — the file's text content. */
  text?: string;
  /** Set for `kind:'pdf'|'office'` — a base64 data URL the offscreen extractor fetches. */
  dataUrl?: string;
  /** Folder ingestion: path relative to the indexed root (incremental-sync key). */
  path?: string;
  /** Folder ingestion: source file last-modified epoch ms. */
  mtime?: number;
  /** Folder ingestion: source file size in bytes. */
  size?: number;
}

/** One picked data file on its way into the DuckDB engine (base64 bytes). */
export interface DataFileUpload {
  name: string;
  bytesB64: string;
}

/** Result of opening data files into the engine (one entry per created table). */
export interface OpenDataResponse {
  ok: boolean;
  tables: DuckDbTableInfo[];
  error?: string;
}

/** Per-file outcome of an upload, for the uploader's file list. */
export interface AddFileResult {
  name: string;
  ok: boolean;
  chunks?: number;
  error?: string;
}

export interface AddFilesResponse {
  ok: boolean;
  results: AddFileResult[];
  error?: string;
}

// ----- Map workspace channel (background <-> the single map.html tab) -----
// Mirrors the offscreen request/response pattern: messages carry target:'map'
// so only the map page handles them. See mapClient.ts and src/map/main.ts.

/** A command sent to the persistent map page. */
export interface MapCommandMessage {
  target: 'map';
  type: 'map_command';
  command: string; // 'set_view' | 'fly_to' | 'add_marker' | … (map_<x> tool, prefix stripped)
  args: Record<string, unknown>;
}

/** Current state of the one map instance, returned with every command. */
export interface MapState {
  center: [number, number];
  zoom: number;
  basemap: string;
  markers: Array<{ id: string; lat: number; lng: number; label?: string }>;
  shapes: number;
}

export interface MapResponse {
  ok: boolean;
  result?: unknown;
  state?: MapState;
  error?: string;
}

export interface TestConnectionResponse {
  ok: boolean;
  detail: string;
}

export interface TranscribeResponse {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface RepoInfo {
  name: string;
  docs: number;
  chunks: number;
  /** `'folder'` for a locally-indexed directory, else page/tab captures. */
  kind?: 'page' | 'folder' | 'mail';
  /** Embedder the vectors were built with (e.g. `local:Xenova/all-MiniLM-L6-v2`). */
  embedModel?: string;
}

export interface RepoDoc {
  id: string;
  name: string;
  url: string;
  capturedAt: string;
  chunkCount: number;
  /** Folder repos: path relative to the indexed root. */
  path?: string;
  /** Folder repos: source file last-modified epoch ms. */
  mtime?: number;
  /** Folder repos: source file size in bytes. */
  size?: number;
}

/** Request to the offscreen document to parse a PDF (separate sendMessage channel). */
export interface ExtractPdfRequest {
  target: 'offscreen';
  type: 'extract_pdf';
  url: string;
  /** Slice the extracted text to this many chars (omit = whole document). */
  maxChars?: number;
}

export interface ExtractPdfResponse {
  ok: boolean;
  text?: string;
  pageCount?: number;
  truncated?: boolean;
  /** Full extracted length before any maxChars slice. */
  charCount?: number;
  error?: string;
}

export interface ExtractOfficeRequest {
  target: 'offscreen';
  type: 'extract_office';
  url: string;
  /** Slice the extracted text to this many chars (omit = whole document). */
  maxChars?: number;
}

export interface ExtractOfficeResponse {
  ok: boolean;
  text?: string;
  format?: 'docx' | 'pptx' | 'xlsx';
  truncated?: boolean;
  /** Full extracted length before any maxChars slice. */
  charCount?: number;
  error?: string;
}

/**
 * Embed text on-device with the offscreen document's transformers.js model. The
 * offscreen page has the DOM/WASM context the service worker lacks; this keeps
 * the local-RAG embedding path fully on the machine (no /embeddings egress).
 */
export interface EmbedLocalRequest {
  target: 'offscreen';
  type: 'embed_local';
  texts: string[];
  /** transformers.js model id; absent = the offscreen default. */
  model?: string;
}

export interface EmbedLocalResponse {
  ok: boolean;
  /** One vector per input text (row-aligned). */
  vectors?: number[][];
  /** The model id actually used (for the repo model-lock stamp). */
  model?: string;
  error?: string;
}

/** Ask the offscreen document to generate a binary document from markdown. */
export interface GenerateDocumentRequest {
  target: 'offscreen';
  type: 'generate_document';
  /** Output format. Only 'docx' in v1; PDF/XLSX/PPTX can extend this union. */
  format: 'docx';
  title: string;
  markdown: string;
}

export interface GenerateDocumentResponse {
  ok: boolean;
  /** Generated file bytes, base64-encoded. */
  dataBase64?: string;
  mimeType?: string;
  error?: string;
}

/** One slide for create_powerpoint. */
export interface SlideSpec {
  title?: string;
  bullets?: string[];
  notes?: string;
}

/** Ask the offscreen document to generate a .pptx from a structured slide spec. */
export interface GeneratePresentationRequest {
  target: 'offscreen';
  type: 'generate_presentation';
  title: string;
  slides: SlideSpec[];
}

/** Requests to the offscreen document's OPFS RAG store. */
/** A single repository serialized for backup (vectors base64-encoded). */
export interface ExportedRepo {
  name: string;
  meta: unknown;
  chunks: unknown;
  vectorsB64: string;
}

export type RepoRequest =
  | {
      target: 'offscreen-repo';
      op: 'add';
      repo: string;
      doc: { name: string; url: string };
      chunks: string[];
      vectors: number[][];
      embedModel?: string;
      kind?: 'page' | 'folder' | 'mail';
      docExtra?: { path?: string; mtime?: number; size?: number };
    }
  | {
      target: 'offscreen-repo';
      op: 'search';
      repo: string;
      queryVector: number[];
      k: number;
      embedModel?: string;
      /** Raw query text, for the lexical (BM25) half of hybrid search. */
      query?: string;
      /** Fuse semantic + keyword (RRF). When false/absent, pure semantic. */
      hybrid?: boolean;
    }
  | { target: 'offscreen-repo'; op: 'list' }
  | { target: 'offscreen-repo'; op: 'delete'; repo: string }
  | { target: 'offscreen-repo'; op: 'docs'; repo: string }
  | { target: 'offscreen-repo'; op: 'deleteDoc'; repo: string; docId: string }
  | { target: 'offscreen-repo'; op: 'export' }
  | { target: 'offscreen-repo'; op: 'import'; repos: ExportedRepo[] };

export interface RepoResponse {
  ok: boolean;
  error?: string;
  result?: unknown;
}

// ----- DuckDB data engine (offscreen document) -----

export type DuckDbOp = 'query' | 'import_csv' | 'import_json' | 'list_tables' | 'describe_table' | 'persist_table' | 'load_table' | 'drop_table' | 'open_file' | 'reset_all';

export interface DuckDbRequest {
  target: 'offscreen-duckdb';
  op: DuckDbOp;
  sql?: string;
  tableName?: string;
  data?: string;
  /** Base64 file bytes for the `open_file` op (binary: parquet/zip/csv/json). */
  bytesB64?: string;
  /** Original filename for `open_file` — drives format detection + table naming. */
  name?: string;
  persist?: boolean;
}

export interface DuckDbTableInfo {
  name: string;
  columns: string[];
  columnTypes: string[];
  rowCount: number;
  persisted?: boolean;
}

export interface DuckDbResponse {
  ok: boolean;
  error?: string;
  columns?: string[];
  columnTypes?: string[];
  rows?: string[][];
  rowCount?: number;
  tables?: DuckDbTableInfo[];
}

/** Requests handled by the injected content script. */
export type ContentRequest =
  | { kind: 'ba_ping' }
  | { kind: 'ba_extract' }
  | { kind: 'ba_app_content' }
  | { kind: 'ba_scroll_step' }
  | { kind: 'ba_element_map' }
  | { kind: 'ba_click'; refIdOrSelector: string }
  | { kind: 'ba_fill'; refIdOrSelector: string; value: string }
  | { kind: 'ba_submit'; refIdOrSelector: string }
  | { kind: 'ba_press_keys'; combo: string; targetRef?: string }
  | { kind: 'ba_wait'; selector: string; state: 'present' | 'visible' | 'enabled'; timeoutMs: number }
  | { kind: 'ba_click_at'; x: number; y: number }
  | { kind: 'ba_drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'ba_wheel'; x: number; y: number; deltaY: number };

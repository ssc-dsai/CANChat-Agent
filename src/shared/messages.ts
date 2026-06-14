import type {
  AgentStatus,
  ChatMessageView,
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
  | { type: 'distill_skill' }
  | { type: 'dismiss_distill' }
  | { type: 'pause_agent' }
  | { type: 'resume_agent' }
  | { type: 'approval_response'; requestId: string; approved: boolean }
  | { type: 'include_active_tab' }
  | { type: 'include_all_tabs' }
  | { type: 'refresh_context' }
  | { type: 'attach_snapshot'; dataUrl: string; title: string; url: string }
  | { type: 'discard_snapshots' }
  | { type: 'capture_page' }
  | { type: 'capture_to_repo'; repo: string; scope: 'tab' | 'group' }
  | { type: 'get_state' }
  | { type: 'ping' };

/** Events pushed from the background to every connected sidebar. */
export type BackgroundEvent =
  | { type: 'chat_message'; message: ChatMessageView }
  | { type: 'status'; status: AgentStatus; detail?: string }
  | { type: 'tool_activity'; activity: ToolActivity }
  | { type: 'approval_request'; requestId: string; description: string; detail: string }
  | { type: 'auth_required'; origin: string; message: string }
  | { type: 'permission_required'; origin: string; message: string }
  | { type: 'context_update'; summary: TabContextSummary | null }
  | { type: 'pending_snapshots'; thumbs: string[] }
  | { type: 'plan_update'; plan: PlanView | null }
  | { type: 'distill_offer'; available: boolean }
  | { type: 'error'; message: string }
  | {
      type: 'full_state';
      status: AgentStatus;
      messages: ChatMessageView[];
      activities: ToolActivity[];
      context: TabContextSummary | null;
      pendingApproval: { requestId: string; description: string; detail: string } | null;
      authNotice: { origin: string; message: string } | null;
      permissionNotice: { origin: string; message: string } | null;
      pendingSnapshots: string[];
      plan: PlanView | null;
      canDistill: boolean;
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
  | { type: 'transcribe_audio'; audioDataUrl: string };

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
}

export interface RepoDoc {
  id: string;
  name: string;
  url: string;
  capturedAt: string;
  chunkCount: number;
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

/** Requests to the offscreen document's OPFS RAG store. */
/** A single repository serialized for backup (vectors base64-encoded). */
export interface ExportedRepo {
  name: string;
  meta: unknown;
  chunks: unknown;
  vectorsB64: string;
}

export type RepoRequest =
  | { target: 'offscreen-repo'; op: 'add'; repo: string; doc: { name: string; url: string }; chunks: string[]; vectors: number[][] }
  | { target: 'offscreen-repo'; op: 'search'; repo: string; queryVector: number[]; k: number }
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

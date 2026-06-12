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
  | { type: 'user_message'; text: string }
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
export type RuntimeRequest = { type: 'test_connection'; settings: Settings };

export interface TestConnectionResponse {
  ok: boolean;
  detail: string;
}

/** Requests handled by the injected content script. */
export type ContentRequest =
  | { kind: 'ba_ping' }
  | { kind: 'ba_extract' }
  | { kind: 'ba_element_map' }
  | { kind: 'ba_click'; refIdOrSelector: string }
  | { kind: 'ba_fill'; refIdOrSelector: string; value: string }
  | { kind: 'ba_submit'; refIdOrSelector: string }
  | { kind: 'ba_press_keys'; combo: string; targetRef?: string }
  | { kind: 'ba_wait'; selector: string; state: 'present' | 'visible' | 'enabled'; timeoutMs: number }
  | { kind: 'ba_click_at'; x: number; y: number }
  | { kind: 'ba_drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'ba_wheel'; x: number; y: number; deltaY: number };

// =============================================================================
// Sidebar — the side panel's root component and the UI half of the message
// protocol. It opens the long-lived Port to the service worker, mirrors the
// agent's broadcast events into local state (status, messages, plan, tool
// activity, approvals…), and renders the child panels. Commands flow out
// through `send`; nothing here runs agent logic — the background owns that.
//
// The Port is also kept warm with a periodic `ping` so the MV3 worker isn't
// evicted mid-task.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { BackgroundEvent, SidebarCommand } from '../shared/messages';
import type {
  AgentStatus,
  ChatMessageView,
  PlanView,
  Settings,
  TabContextSummary,
  ToolActivity,
} from '../shared/types';
import { ChatPanel } from './ChatPanel';
import { exportConversationHtml } from './conversationExport';
import { PlanPanel } from './PlanPanel';
import { SettingsScreen } from './SettingsScreen';
import { TabContextPanel } from './TabContextPanel';
import { ToolActivityPanel } from './ToolActivityPanel';

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Idle',
  thinking: 'Thinking…',
  acting: 'Using browser…',
  paused: 'Paused',
  awaiting_approval: 'Waiting for approval',
  auth_required: 'Login required',
  error: 'Error',
};

// Pools the per-letter animation randomly draws from. Colour is intentionally
// left untouched (inherited from the status pill).
const FUNK_FONTS = [
  'inherit',
  'Georgia, serif',
  '"Courier New", monospace',
  'Verdana, sans-serif',
  '"Comic Sans MS", "Comic Sans", cursive',
];
const FUNK_WEIGHTS = [400, 500, 600, 700, 800];
const BASE_FONT_PX = 13; // matches .status font-size; vary up to +2pt.

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Per-letter "funky" animated label, shown while the agent is working. */
function StatusLabel({ status }: { status: AgentStatus }) {
  const label = STATUS_LABELS[status];
  const active = status === 'thinking' || status === 'acting';
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!active) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const el = ref.current;
    if (!el) return;
    const tick = () => {
      el.querySelectorAll<HTMLElement>('.status-char').forEach((c) => {
        c.style.fontFamily = pick(FUNK_FONTS);
        c.style.fontWeight = String(pick(FUNK_WEIGHTS));
        c.style.fontStyle = Math.random() < 0.3 ? 'italic' : 'normal';
        c.style.fontSize = `${(BASE_FONT_PX + Math.random() * 2).toFixed(1)}px`;
      });
    };
    tick();
    const id = setInterval(tick, 230);
    return () => clearInterval(id);
  }, [active, label]);

  if (!active) return <>{label}</>;
  return (
    <span ref={ref} class="status-anim">
      {label.split('').map((ch, i) => (
        <span key={i} class="status-char">
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </span>
  );
}

export function Sidebar() {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [context, setContext] = useState<TabContextSummary | null>(null);
  const [approval, setApproval] = useState<{ requestId: string; description: string; detail: string } | null>(null);
  const [authNotice, setAuthNotice] = useState<{ origin: string; message: string } | null>(null);
  const [permissionNotice, setPermissionNotice] = useState<{ origin: string; message: string } | null>(null);
  const [pendingSnapshots, setPendingSnapshots] = useState<string[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [canDistill, setCanDistill] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [uiScale, setUiScale] = useState(() => {
    const s = Number(localStorage.getItem('ba_ui_scale'));
    return s >= 0.8 && s <= 1.6 ? s : 1;
  });

  const applyScale = (next: number) => {
    const clamped = Math.min(1.6, Math.max(0.8, Math.round(next * 10) / 10));
    setUiScale(clamped);
    document.documentElement.style.zoom = String(clamped);
    localStorage.setItem('ba_ui_scale', String(clamped));
  };

  const send = useCallback((command: SidebarCommand) => {
    portRef.current?.postMessage(command);
  }, []);

  useEffect(() => {
    chrome.storage.local.get('ba_settings').then((r) => {
      const s = r.ba_settings as Settings | undefined;
      const ok = Boolean(s?.baseUrl && s?.apiKey && s?.model);
      setConfigured(ok);
      if (!ok) setShowSettings(true);
    });

    let port: chrome.runtime.Port;
    let pingTimer: ReturnType<typeof setInterval>;

    const connect = () => {
      port = chrome.runtime.connect({ name: 'sidebar' });
      portRef.current = port;
      port.onMessage.addListener((event: BackgroundEvent) => {
        switch (event.type) {
          case 'full_state':
            setErrorBanner(null);
            setStatus(event.status);
            setMessages(event.messages);
            setActivities(event.activities);
            setContext(event.context);
            setApproval(event.pendingApproval);
            setAuthNotice(event.authNotice);
            setPermissionNotice(event.permissionNotice);
            setPendingSnapshots(event.pendingSnapshots);
            setPlan(event.plan);
            setCanDistill(event.canDistill);
            break;
          case 'chat_message':
            setMessages((m) => [...m, event.message]);
            break;
          case 'status':
            setStatus(event.status);
            if (event.status !== 'auth_required') setAuthNotice(null);
            if (event.status !== 'awaiting_approval') {
              setApproval(null);
              setPermissionNotice(null);
            }
            break;
          case 'tool_activity':
            setActivities((a) => {
              const idx = a.findIndex((x) => x.id === event.activity.id);
              if (idx >= 0) {
                const next = a.slice();
                next[idx] = { ...event.activity };
                return next;
              }
              return [...a, { ...event.activity }];
            });
            break;
          case 'approval_request':
            setApproval({ requestId: event.requestId, description: event.description, detail: event.detail });
            break;
          case 'auth_required':
            setAuthNotice(event.origin ? { origin: event.origin, message: event.message } : null);
            break;
          case 'permission_required':
            setPermissionNotice(event.origin ? { origin: event.origin, message: event.message } : null);
            break;
          case 'context_update':
            setContext(event.summary);
            break;
          case 'pending_snapshots':
            setPendingSnapshots(event.thumbs);
            break;
          case 'plan_update':
            setPlan(event.plan);
            break;
          case 'distill_offer':
            setCanDistill(event.available);
            break;
          case 'error':
            setErrorBanner(event.message);
            break;
        }
      });
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        // Service worker restarted; reconnect after a beat.
        setTimeout(connect, 500);
      });
      // Keepalive ping so the service worker survives long waits.
      clearInterval(pingTimer);
      pingTimer = setInterval(() => port.postMessage({ type: 'ping' }), 20000);
    };

    connect();
    return () => {
      clearInterval(pingTimer);
      port.disconnect();
    };
  }, []);

  return (
    <div class="sidebar">
      <header class="header">
        <div class="brand">
          <span class="title">CANAssist</span>
          <span class="app-version" title="Build stamp (UTC): YY DDD HH">{__APP_VERSION__}</span>
        </div>
        <span class={`status status-${status}`}>
          <StatusLabel status={status} />
        </span>
        <span class="scale-ctl">
          <button class="scale-btn" title="Smaller text" onClick={() => applyScale(uiScale - 0.1)}>
            A−
          </button>
          <button class="scale-val" title="Reset text size" onClick={() => applyScale(1)}>
            {Math.round(uiScale * 100)}%
          </button>
          <button class="scale-btn" title="Larger text" onClick={() => applyScale(uiScale + 0.1)}>
            A+
          </button>
        </span>
        <button
          class="icon-btn"
          title="Save conversation as HTML"
          onClick={() => exportConversationHtml(messages)}
          disabled={messages.length === 0}
        >
          💾
        </button>
        <button
          class="icon-btn"
          title="Clear conversation"
          onClick={() => send({ type: 'clear_conversation' })}
          disabled={messages.length === 0}
        >
          🗑
        </button>
        <button class="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </header>

      {errorBanner && (
        <div class="banner banner-error">
          <span>{errorBanner}</span>
          <button class="icon-btn" onClick={() => setErrorBanner(null)}>
            ✕
          </button>
        </div>
      )}

      {configured === false && !showSettings && (
        <div class="banner banner-warn">
          No model configured.{' '}
          <button class="link-btn" onClick={() => setShowSettings(true)}>
            Open settings
          </button>
        </div>
      )}

      <TabContextPanel
        context={context}
        send={send}
        busy={status === 'thinking' || status === 'acting' || status === 'awaiting_approval' || status === 'auth_required'}
      />

      <PlanPanel plan={plan} />

      <ChatPanel
        messages={messages}
        status={status}
        approval={approval}
        authNotice={authNotice}
        permissionNotice={permissionNotice}
        pendingSnapshots={pendingSnapshots}
        canDistill={canDistill}
        send={send}
        disabled={configured === false}
      />

      <ToolActivityPanel activities={activities} />

      {showSettings && (
        <SettingsScreen
          onClose={(nowConfigured) => {
            setShowSettings(false);
            if (nowConfigured !== undefined) setConfigured(nowConfigured);
          }}
        />
      )}
    </div>
  );
}

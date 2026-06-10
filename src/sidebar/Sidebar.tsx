import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { BackgroundEvent, SidebarCommand } from '../shared/messages';
import type {
  AgentStatus,
  ChatMessageView,
  Settings,
  TabContextSummary,
  ToolActivity,
} from '../shared/types';
import { ChatPanel } from './ChatPanel';
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

export function Sidebar() {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [context, setContext] = useState<TabContextSummary | null>(null);
  const [approval, setApproval] = useState<{ requestId: string; description: string } | null>(null);
  const [authNotice, setAuthNotice] = useState<{ origin: string; message: string } | null>(null);
  const [permissionNotice, setPermissionNotice] = useState<{ origin: string; message: string } | null>(null);
  const [pendingSnapshots, setPendingSnapshots] = useState<string[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);

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
            setApproval({ requestId: event.requestId, description: event.description });
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
        <span class="title">CANAgent</span>
        <span class={`status status-${status}`}>{STATUS_LABELS[status]}</span>
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

      <TabContextPanel context={context} send={send} />

      <ChatPanel
        messages={messages}
        status={status}
        approval={approval}
        authNotice={authNotice}
        permissionNotice={permissionNotice}
        pendingSnapshots={pendingSnapshots}
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

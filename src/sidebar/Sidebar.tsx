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
import { ConversationsScreen } from './ConversationsScreen';
import { OnboardingScreen } from './OnboardingScreen';
import { exportConversationHtml } from './conversationExport';
import { useT } from './i18n';
import { PlanPanel } from './PlanPanel';
import { SettingsScreen } from './SettingsScreen';
import { TabContextPanel } from './TabContextPanel';
import { ToolActivityPanel } from './ToolActivityPanel';

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

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Per-letter "funky" animated label, shown while the agent is working. */
function StatusLabel({ status }: { status: AgentStatus }) {
  const t = useT();
  const label = t(`status.${status}`);
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
        // Size varies via transform (not font-size) so it never reflows the
        // surrounding header — each letter scales within its fixed slot.
        c.style.transform = `scale(${(1 + Math.random() * 0.18).toFixed(2)})`;
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

// Monochrome line icons (Feather-style, MIT) used in the header. They inherit
// the button's currentColor so they match the theme and hover states — far
// tidier than the multi-colour emoji they replace.
const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
};
const IconHistory = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const IconSave = () => (
  <svg {...svgProps}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);
const IconTrash = () => (
  <svg {...svgProps}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="m6 7 1 13h10l1-13" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);
const IconSettings = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

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
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
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
      if (!ok) setShowOnboarding(true);
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

  const t = useT();

  return (
    <div class="sidebar">
      <header class="header">
        <div class="brand">
          <div class="brand-line">
            <span class="title">CANChat Agent</span>
            <span class={`status status-${status}`}>
              <StatusLabel status={status} />
            </span>
          </div>
          <span class="app-version" title="Build stamp (UTC): YY DDD HH">{__APP_VERSION__}</span>
        </div>
        <div class="header-controls">
          <span class="scale-ctl">
            <button class="scale-btn" title={t('header.smallerText')} onClick={() => applyScale(uiScale - 0.1)}>
              A−
            </button>
            <button class="scale-val" title={t('header.resetText')} onClick={() => applyScale(1)}>
              {Math.round(uiScale * 100)}%
            </button>
            <button class="scale-btn" title={t('header.largerText')} onClick={() => applyScale(uiScale + 0.1)}>
              A+
            </button>
          </span>
          <span class="header-divider" />
          <button class="icon-btn" title={t('header.history')} onClick={() => setShowHistory(true)}>
            <IconHistory />
          </button>
          <button
            class="icon-btn"
            title={t('header.saveConversation')}
            onClick={() => exportConversationHtml(messages)}
            disabled={messages.length === 0}
          >
            <IconSave />
          </button>
          <button
            class="icon-btn"
            title={t('header.clearConversation')}
            onClick={() => send({ type: 'clear_conversation' })}
            disabled={messages.length === 0}
          >
            <IconTrash />
          </button>
          <button class="icon-btn" title={t('header.settings')} onClick={() => setShowSettings(true)}>
            <IconSettings />
          </button>
        </div>
      </header>

      {errorBanner && (
        <div class="banner banner-error">
          <span>{errorBanner}</span>
          <button class="icon-btn" onClick={() => setErrorBanner(null)}>
            ✕
          </button>
        </div>
      )}

      {configured === false && !showSettings && !showOnboarding && (
        <div class="banner banner-warn">
          {t('header.noModel')}{' '}
          <button class="link-btn" onClick={() => setShowSettings(true)}>
            {t('header.openSettings')}
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

      {showOnboarding && (
        <OnboardingScreen
          onClose={(nowConfigured) => {
            setShowOnboarding(false);
            if (nowConfigured !== undefined) setConfigured(nowConfigured);
          }}
          onOpenAdvanced={() => {
            setShowOnboarding(false);
            setShowSettings(true);
          }}
        />
      )}

      {showSettings && (
        <SettingsScreen
          onClose={(nowConfigured) => {
            setShowSettings(false);
            if (nowConfigured !== undefined) setConfigured(nowConfigured);
          }}
        />
      )}

      {showHistory && <ConversationsScreen send={send} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

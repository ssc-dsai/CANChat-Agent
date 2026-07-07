import { useEffect, useState } from 'preact/hooks';
import { MAIL_REPO } from '../shared/graphMail';
import { useT } from './i18n';

export { MAIL_REPO };

const MAILBOX_STATUS_KEY = 'mailAutoRefreshStatus';

interface MailProgress {
  phase: 'fetching' | 'indexing' | 'done';
  added: number;
  skipped: number;
  failed: number;
  current?: string;
}

interface MailAutoRefreshStatus {
  ts: number;
  ok: boolean;
  added?: number;
  failed?: number;
  error?: string;
}

/**
 * "📧 Mailbox" card — index the mailbox into the RAG store via Microsoft Graph
 * (OAuth). Needs a one-time Azure app Client ID in Settings → Advanced, then a
 * "Connect & index" click launches the interactive sign-in.
 */
export function MailboxSection({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [clientId, setClientId] = useState('');
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastAuto, setLastAuto] = useState<MailAutoRefreshStatus | null>(null);

  const checkConnected = () => {
    chrome.runtime
      .sendMessage({ type: 'mailbox_connected' })
      .then((r: { connected?: boolean }) => setConnected(Boolean(r?.connected)))
      .catch(() => setConnected(false));
  };

  // Read the configured Client ID and stay live if Settings changes it.
  useEffect(() => {
    chrome.storage.local.get('ba_settings').then((r) => {
      const s = r.ba_settings as { graphClientId?: string } | undefined;
      setClientId(s?.graphClientId?.trim() ?? '');
    });
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes.ba_settings) return;
      const s = changes.ba_settings.newValue as { graphClientId?: string } | undefined;
      setClientId(s?.graphClientId?.trim() ?? '');
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  useEffect(checkConnected, []);

  // Load the auto-refresh toggle + the last background-refresh result, and stay
  // live if either changes (e.g. the hourly alarm fires while the panel is open).
  useEffect(() => {
    chrome.storage.local.get(['ba_settings', MAILBOX_STATUS_KEY]).then((r) => {
      const s = r.ba_settings as { mailAutoRefresh?: boolean } | undefined;
      setAutoRefresh(Boolean(s?.mailAutoRefresh));
      if (r[MAILBOX_STATUS_KEY]) setLastAuto(r[MAILBOX_STATUS_KEY] as MailAutoRefreshStatus);
    });
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.ba_settings) {
        const s = changes.ba_settings.newValue as { mailAutoRefresh?: boolean } | undefined;
        setAutoRefresh(Boolean(s?.mailAutoRefresh));
      }
      if (changes[MAILBOX_STATUS_KEY]) setLastAuto(changes[MAILBOX_STATUS_KEY].newValue as MailAutoRefreshStatus);
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  const toggleAutoRefresh = async (checked: boolean) => {
    setAutoRefresh(checked); // optimistic; the storage.onChanged handler above reconciles
    const r = await chrome.storage.local.get('ba_settings');
    const settings = (r.ba_settings as Record<string, unknown>) ?? {};
    await chrome.storage.local.set({ ba_settings: { ...settings, mailAutoRefresh: checked } });
  };

  // Live progress broadcast by the service worker during a long index.
  useEffect(() => {
    const onMsg = (msg: unknown) => {
      const m = msg as { type?: string; progress?: MailProgress };
      if (m?.type !== 'mailbox_progress' || !m.progress) return;
      const p = m.progress;
      setStatus(
        p.phase === 'done'
          ? summarize(p)
          : t('mail.indexing', { subject: p.current ?? '', n: String(p.added) }),
      );
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [t]);

  const summarize = (p: MailProgress): string =>
    t('mail.done', { added: String(p.added), skipped: String(p.skipped), failed: String(p.failed) });

  // Also handles first-time connect: the service worker launches the interactive
  // OAuth flow if not already connected, since this only ever runs from a click.
  const index = async () => {
    setBusy(true);
    setStatus(t('mail.starting'));
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'index_mailbox', repo: MAIL_REPO })) as {
        ok: boolean;
        error?: string;
        result?: MailProgress;
      };
      if (!res?.ok) setStatus(t('mail.error', { msg: res?.error ?? 'unknown error' }));
      else {
        setStatus(res.result ? summarize(res.result) : t('mail.done', { added: '?', skipped: '?', failed: '?' }));
        checkConnected();
        onChanged();
      }
    } catch (e) {
      setStatus(t('mail.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(false);
  };

  const disconnect = async () => {
    await chrome.runtime.sendMessage({ type: 'mailbox_disconnect' });
    setConnected(false);
    setStatus(null);
  };

  if (!clientId) {
    return (
      <div class="repo-folder-drop">
        <strong>{t('mail.title')}</strong>
        <span class="settings-note">{t('mail.needClientId')}</span>
      </div>
    );
  }

  return (
    <div class={`repo-folder-drop${busy ? ' repo-folder-drop--busy' : ''}`}>
      <strong>{busy ? t('mail.working') : t('mail.title')}</strong>
      <span class="settings-note">{t('mail.hint')}</span>
      <div class="repo-folder-row">
        <button class="btn" disabled={busy} onClick={() => void index()}>
          {connected ? t('mail.index') : t('mail.connect')}
        </button>
        {connected && (
          <button class="btn" disabled={busy} onClick={() => void disconnect()}>
            {t('mail.disconnect')}
          </button>
        )}
      </div>
      {status && <p class="settings-note repo-folder-status">{status}</p>}

      {connected && (
        <>
          <label class="memory-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => void toggleAutoRefresh((e.target as HTMLInputElement).checked)}
            />
            <span>{t('mail.autoRefresh')}</span>
          </label>
          <p class="settings-note">{t('mail.autoRefreshNote')}</p>
          {lastAuto && (
            <p class="settings-note repo-folder-status">
              {lastAuto.ok
                ? t('mail.autoRefreshLast', {
                    when: new Date(lastAuto.ts).toLocaleString(),
                    added: String(lastAuto.added ?? 0),
                  })
                : t('mail.autoRefreshLastError', { when: new Date(lastAuto.ts).toLocaleString(), msg: lastAuto.error ?? '' })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

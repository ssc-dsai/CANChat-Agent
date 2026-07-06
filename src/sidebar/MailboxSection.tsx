import { useEffect, useState } from 'preact/hooks';
import { MAIL_REPO } from '../shared/owaMail';
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
 * "📧 Mailbox" card — index the mailbox into the RAG store over the user's
 * EXISTING Outlook-on-the-web session (cookie auth; no Azure app, no OAuth). If
 * there's no signed-in Outlook session, prompt the user to open Outlook first.
 */
export function MailboxSection({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [base, setBase] = useState('https://outlook.office.com');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastAuto, setLastAuto] = useState<MailAutoRefreshStatus | null>(null);

  // Probe whether an Outlook web session cookie is present.
  const checkSession = () => {
    chrome.runtime
      .sendMessage({ type: 'mailbox_session' })
      .then((r: { connected?: boolean; base?: string }) => {
        setConnected(Boolean(r?.connected));
        if (r?.base) setBase(r.base);
      })
      .catch(() => setConnected(false));
  };
  useEffect(checkSession, []);

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
        onChanged();
      }
    } catch (e) {
      setStatus(t('mail.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(false);
  };

  // Not signed into Outlook on the web → prompt to open it, then re-check.
  if (connected === false) {
    return (
      <div class="repo-folder-drop">
        <strong>{t('mail.title')}</strong>
        <span class="settings-note">{t('mail.needSession')}</span>
        <div class="repo-folder-row">
          <a class="btn" href={`${base}/mail/`} target="_blank" rel="noreferrer">
            {t('mail.openOutlook')}
          </a>
          <button class="btn" onClick={checkSession}>
            {t('mail.recheck')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class={`repo-folder-drop${busy ? ' repo-folder-drop--busy' : ''}`}>
      <strong>{busy ? t('mail.working') : t('mail.title')}</strong>
      <span class="settings-note">{t('mail.hint')}</span>
      <div class="repo-folder-row">
        <button class="btn" disabled={busy || connected === null} onClick={() => void index()}>
          {t('mail.index')}
        </button>
      </div>
      {status && <p class="settings-note repo-folder-status">{status}</p>}

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
    </div>
  );
}

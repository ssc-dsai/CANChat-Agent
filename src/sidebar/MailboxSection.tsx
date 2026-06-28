import { useEffect, useState } from 'preact/hooks';
import { useT } from './i18n';

/** The single repo that holds the indexed Office 365 mailbox. */
export const MAIL_REPO = '📧 Mailbox';

interface MailProgress {
  phase: 'fetching' | 'indexing' | 'done';
  added: number;
  skipped: number;
  failed: number;
  current?: string;
}

/**
 * "📧 Mailbox" card — connect via Microsoft Graph (OAuth) and index the mailbox
 * into the RAG store, reusing the same on-device embedding pipeline as folders.
 * Hidden until an Azure app Client ID is set in Settings.
 */
export function MailboxSection({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local.get('ba_settings').then((r) => {
      const s = (r.ba_settings ?? {}) as { graphClientId?: string };
      setClientId((s.graphClientId ?? '').trim());
    });
  }, []);

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

  const disconnect = async () => {
    await chrome.runtime.sendMessage({ type: 'mailbox_disconnect' });
    setStatus(t('mail.disconnected'));
  };

  if (!clientId) return <p class="settings-note">{t('mail.needClientId')}</p>;

  return (
    <div class={`repo-folder-drop${busy ? ' repo-folder-drop--busy' : ''}`}>
      <strong>{busy ? t('mail.working') : t('mail.title')}</strong>
      <span class="settings-note">{t('mail.hint')}</span>
      <div class="repo-folder-row">
        <button class="btn" disabled={busy} onClick={() => void index()}>
          {t('mail.index')}
        </button>
        <button class="btn" disabled={busy} onClick={() => void disconnect()}>
          {t('mail.disconnect')}
        </button>
      </div>
      {status && <p class="settings-note repo-folder-status">{status}</p>}
    </div>
  );
}

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
    </div>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { useT } from './i18n';

interface SharePointProgress {
  phase: 'fetching' | 'indexing' | 'done';
  added: number;
  skipped: number;
  failed: number;
  current?: string;
}

function repoNameFor(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    const clean = last.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    return `☁ SharePoint - ${clean || u.hostname}`;
  } catch {
    return '☁ SharePoint';
  }
}

export function SharePointSection({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [libraryUrl, setLibraryUrl] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const onMsg = (msg: unknown) => {
      const m = msg as { type?: string; progress?: SharePointProgress };
      if (m?.type !== 'sharepoint_progress' || !m.progress) return;
      const p = m.progress;
      setStatus(
        p.phase === 'done'
          ? summarize(p)
          : t('sharepoint.indexing', { file: p.current ?? '', n: String(p.added) }),
      );
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [t]);

  const summarize = (p: SharePointProgress): string =>
    t('sharepoint.done', { added: String(p.added), skipped: String(p.skipped), failed: String(p.failed) });

  const submit = async () => {
    const url = libraryUrl.trim();
    const target = (repo || repoNameFor(url)).trim();
    if (!url) {
      setStatus(t('sharepoint.needUrl'));
      return;
    }
    setBusy(true);
    setStatus(t('sharepoint.starting'));
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'index_sharepoint_library',
        repo: target,
        libraryUrl: url,
      })) as { ok?: boolean; error?: string; result?: SharePointProgress };
      if (!res?.ok) setStatus(t('sharepoint.error', { msg: res?.error ?? 'unknown error' }));
      else {
        setRepo(target);
        setStatus(res.result ? summarize(res.result) : t('sharepoint.done', { added: '?', skipped: '?', failed: '?' }));
        onChanged();
      }
    } catch (e) {
      setStatus(t('sharepoint.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
    setBusy(false);
  };

  return (
    <div class={`repo-folder-drop${busy ? ' repo-folder-drop--busy' : ''}`}>
      <strong>{busy ? t('sharepoint.working') : t('sharepoint.title')}</strong>
      <span class="settings-note">{t('sharepoint.hint')}</span>
      <label class="field">
        <span>{t('sharepoint.libraryUrl')}</span>
        <input
          type="url"
          value={libraryUrl}
          placeholder="https://contoso.sharepoint.com/sites/team/Shared%20Documents"
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setLibraryUrl(v);
            if (!repo) setRepo(repoNameFor(v));
          }}
        />
      </label>
      <label class="field">
        <span>{t('sharepoint.repo')}</span>
        <input
          type="text"
          value={repo}
          placeholder={t('sharepoint.repoPlaceholder')}
          onInput={(e) => setRepo((e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="repo-folder-row">
        <button class="btn" disabled={busy || !libraryUrl.trim()} onClick={() => void submit()}>
          {t('sharepoint.index')}
        </button>
      </div>
      {status && <p class="settings-note repo-folder-status">{status}</p>}
    </div>
  );
}

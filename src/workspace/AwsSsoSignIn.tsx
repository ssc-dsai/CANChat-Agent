import { useEffect, useState } from 'preact/hooks';
import type { AwsSsoConfig } from '../shared/awsSso';
import { useT } from '../sidebar/i18n';

// Mirrors background/awsSso.ts's AwsSsoStatus / AwsSsoSignInPrompt, which this
// page can't import (it would pull the service-worker module into the UI bundle).
type Status =
  | { state: 'signed-out' }
  | { state: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { state: 'signed-in'; expiresAt?: number }
  | { state: 'error'; message: string };

type Response = { ok: boolean; status?: Status; error?: string };

const POLL_MS = 2000;

/**
 * Sign-in status and controls for a Bedrock Mantle connection that uses IAM
 * Identity Center. The sign-in itself (device authorization, token cache) runs
 * in the service worker; this only starts it and follows its status. Sign-ins
 * are per start URL, so the main connection and any model profile on the same
 * Identity Center instance share one.
 */
export function AwsSsoSignIn({ config }: { config: AwsSsoConfig | null }) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = config ? JSON.stringify(config) : '';

  const refresh = async (cfg: AwsSsoConfig) => {
    const res = (await chrome.runtime.sendMessage({ type: 'aws_sso_status', config: cfg })) as Response;
    if (res.ok && res.status) setStatus(res.status);
    else setError(res.error ?? 'Could not read the sign-in status.');
  };

  useEffect(() => {
    setStatus(null);
    setError(null);
    if (config) void refresh(config);
  }, [key]);

  // Follow a pending sign-in until the background finishes polling AWS.
  useEffect(() => {
    if (!config || status?.state !== 'pending') return;
    const timer = setInterval(() => void refresh(config), POLL_MS);
    return () => clearInterval(timer);
  }, [key, status?.state]);

  if (!config) return <span class="field-note">{t('settings.awsSsoIncomplete')}</span>;

  const run = async (type: 'aws_sso_sign_in' | 'aws_sso_sign_out') => {
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ type, config })) as Response;
      if (!res.ok) setError(res.error ?? 'Request failed.');
      await refresh(config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="field">
      <span>{t('settings.awsSsoStatus')}</span>
      {status?.state === 'signed-in' && <span class="field-note">{t('settings.awsSsoSignedIn')}</span>}
      {status?.state === 'signed-out' && <span class="field-note">{t('settings.awsSsoSignedOut')}</span>}
      {status?.state === 'pending' && (
        <span class="field-note">
          {t('settings.awsSsoPending')} <strong>{status.userCode}</strong> —{' '}
          <a href={status.verificationUri} target="_blank" rel="noreferrer">{status.verificationUri}</a>
        </span>
      )}
      {status?.state === 'error' && <div class="banner banner-error">{status.message}</div>}
      {error && <div class="banner banner-error">{error}</div>}
      <div class="settings-actions">
        {status?.state === 'signed-in' ? (
          <button class="btn" disabled={busy} onClick={() => void run('aws_sso_sign_out')}>
            {t('settings.awsSsoSignOut')}
          </button>
        ) : (
          <button class="btn" disabled={busy || status?.state === 'pending'} onClick={() => void run('aws_sso_sign_in')}>
            {t('settings.awsSsoSignIn')}
          </button>
        )}
      </div>
    </div>
  );
}

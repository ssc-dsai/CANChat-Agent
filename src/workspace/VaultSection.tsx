import { useEffect, useState } from 'preact/hooks';
import {
  changePassphrase,
  DEFAULT_AUTO_LOCK_MINUTES,
  eraseVault,
  getVaultAutoLockMinutes,
  getVaultState,
  lockVault,
  MAX_AUTO_LOCK_MINUTES,
  setupVault,
  setVaultAutoLockMinutes,
  unlockVault,
  type VaultState,
} from '../background/vault';
import { plaintextSecretRecordsForErase, sealSecretsAtRest } from '../background/storage';
import { Group } from './SettingsControls';

// What the vault actually encrypts — keep in sync with shared/secretFields.ts
// (secrets) and storage.ts / repoStore (conversations, repositories).
const COVERED =
  'API keys (main connection, model profiles, embedding, transcription, image generation, decision model), the AWS session token, MCP server tokens, and Microsoft 365, AWS IAM Identity Center and provider sign-in tokens. Conversations, and the text of on-device repositories (not their embedding vectors), saved while the vault is unlocked are encrypted too.';
const NOT_COVERED =
  'Not encrypted: other settings (endpoints, model names, AWS access key ID, client IDs), hints, skills and memory; conversations saved before the vault was enabled until they are saved again; AWS role credentials, which stay in browser-session memory; and anything saved while the vault is locked (for example a new sign-in), until you next unlock.';

function autoLockText(minutes: number): string {
  return minutes > 0
    ? `Locks automatically after ${minutes} minute${minutes === 1 ? '' : 's'} in which no secret is used (agent tasks and scheduled jobs count as use), and whenever the browser closes.`
    : 'Idle auto-lock is off: the vault stays unlocked until you lock it or the browser closes.';
}

// Manage the application-layer encryption vault (specification.md §8.8): a
// passphrase-derived key wraps the per-install data key that encrypts secrets at
// rest. Opt-in — with no vault, everything stays as before. Runs in the page
// context; vault.ts uses only chrome.storage, and the unlocked key it caches in
// session storage is shared with the service worker, so unlocking here unlocks
// the agent too.
export function VaultSection() {
  const [state, setState] = useState<VaultState | null>(null);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoLock, setAutoLock] = useState(DEFAULT_AUTO_LOCK_MINUTES);
  const [autoLockInput, setAutoLockInput] = useState(String(DEFAULT_AUTO_LOCK_MINUTES));

  const refresh = async () => {
    setState(await getVaultState());
    const minutes = await getVaultAutoLockMinutes();
    setAutoLock(minutes);
    setAutoLockInput(String(minutes));
  };
  useEffect(() => {
    refresh();
  }, []);

  const reset = () => {
    setPass('');
    setConfirm('');
    setNext('');
  };

  const create = async () => {
    if (pass.length < 8) return setMsg({ ok: false, text: 'Use a passphrase of at least 8 characters.' });
    if (pass !== confirm) return setMsg({ ok: false, text: 'The passphrases do not match.' });
    setBusy(true);
    try {
      await setupVault(pass);
      await sealSecretsAtRest(); // encrypt the keys and tokens that were stored in plaintext
      setMsg({
        ok: true,
        text: `Encryption enabled. Your API keys, MCP tokens and sign-in tokens are now encrypted at rest. ${autoLockText(DEFAULT_AUTO_LOCK_MINUTES)}`,
      });
      reset();
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    try {
      const ok = await unlockVault(pass);
      // Seal anything saved in plaintext while the vault was locked (e.g. a sign-in).
      if (ok) await sealSecretsAtRest();
      setMsg(ok ? { ok: true, text: 'Vault unlocked.' } : { ok: false, text: 'Incorrect passphrase.' });
      if (ok) reset();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    await lockVault();
    setMsg({ ok: true, text: 'Vault locked. The agent will need it unlocked to run.' });
    await refresh();
  };

  const saveAutoLock = async () => {
    const minutes = Number(autoLockInput);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_AUTO_LOCK_MINUTES) {
      return setMsg({ ok: false, text: `Enter a whole number of minutes from 0 to ${MAX_AUTO_LOCK_MINUTES} (0 turns idle auto-lock off).` });
    }
    setBusy(true);
    try {
      await setVaultAutoLockMinutes(minutes);
      setMsg({ ok: true, text: autoLockText(minutes) });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const change = async () => {
    if (next.length < 8) return setMsg({ ok: false, text: 'Use a new passphrase of at least 8 characters.' });
    setBusy(true);
    try {
      const ok = await changePassphrase(pass, next);
      setMsg(ok ? { ok: true, text: 'Passphrase changed.' } : { ok: false, text: 'Current passphrase is incorrect.' });
      if (ok) reset();
    } finally {
      setBusy(false);
    }
  };

  // Erase = cryptographic destruction of the wrapped key. To avoid locking the
  // user out of their own keys and sign-ins, first read every vault-covered
  // secret back in plaintext (only possible while unlocked) and re-store them
  // after the vault is gone. Conversations/repositories sealed under it are lost.
  const erase = async () => {
    if (!confirm.toLowerCase().startsWith('erase')) {
      return setMsg({ ok: false, text: 'Type "erase" to confirm destroying the vault.' });
    }
    setBusy(true);
    try {
      const plaintext = await plaintextSecretRecordsForErase();
      await eraseVault();
      if (Object.keys(plaintext).length > 0) await chrome.storage.local.set(plaintext); // now plaintext (no vault)
      setMsg({
        ok: true,
        text: 'Vault erased. Encrypted conversations and repositories were destroyed; your API keys, MCP tokens and sign-in tokens were kept, now unencrypted.',
      });
      reset();
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return null;

  return (
    <div class="ws-vault-section">
      <Group
        title="Encryption vault"
        desc="Optional and off until you set a passphrase. Encrypts secrets at rest with a key derived from your passphrase; the passphrase is never stored and cannot be recovered."
      >
        {msg && <div class={`banner ${msg.ok ? 'banner-ok' : 'banner-error'}`}>{msg.text}</div>}
        <p class="field-note">Encrypted: {COVERED}</p>
        <p class="field-note">{NOT_COVERED}</p>

        {state === 'none' && (
          <>
            <label class="field">
              <span>Passphrase</span>
              <input type="password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} placeholder="at least 8 characters" />
            </label>
            <label class="field">
              <span>Confirm passphrase</span>
              <input type="password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
            </label>
            <p class="field-note">If you forget this passphrase, encrypted data cannot be recovered — there is no backdoor.</p>
            <div class="settings-actions">
              <button class="btn btn-primary" onClick={create} disabled={busy || !pass}>Enable encryption</button>
            </div>
          </>
        )}

        {state === 'locked' && (
          <>
            <label class="field">
              <span>Passphrase</span>
              <input type="password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
            </label>
            <div class="settings-actions">
              <button class="btn btn-primary" onClick={unlock} disabled={busy || !pass}>Unlock</button>
            </div>
          </>
        )}

        {state === 'unlocked' && (
          <>
            <div class="banner banner-ok">
              🔓 Vault is unlocked: the secrets listed above are encrypted at rest and readable until it locks. {autoLockText(autoLock)}
            </div>
            <label class="field">
              <span>Auto-lock after idle minutes (0 = off)</span>
              <input
                type="number"
                min={0}
                max={MAX_AUTO_LOCK_MINUTES}
                step={1}
                value={autoLockInput}
                onInput={(e) => setAutoLockInput((e.target as HTMLInputElement).value)}
              />
            </label>
            <div class="settings-actions">
              <button class="btn" onClick={saveAutoLock} disabled={busy || autoLockInput === String(autoLock)}>Save auto-lock</button>
            </div>
            <label class="field">
              <span>Current passphrase (to change or erase)</span>
              <input type="password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">
              <span>New passphrase</span>
              <input type="password" value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} placeholder="at least 8 characters" />
            </label>
            <div class="settings-actions">
              <button class="btn" onClick={lock} disabled={busy}>Lock now</button>
              <button class="btn" onClick={change} disabled={busy || !pass || !next}>Change passphrase</button>
            </div>
            <label class="field">
              <span>Type "erase" to destroy the vault</span>
              <input type="text" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} placeholder="erase" />
            </label>
            <div class="settings-actions">
              <button class="btn btn-danger" onClick={erase} disabled={busy}>Erase vault</button>
            </div>
          </>
        )}
      </Group>
    </div>
  );
}

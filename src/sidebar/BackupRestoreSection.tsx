import { useState } from 'preact/hooks';
import type { ExportedProduct, ExportedRepo } from '../shared/messages';
import {
  conversationBackupKeys,
  exportConversationsForBackup,
  importConversationsFromBackup,
  sealSecretsAtRest,
  unsealBackupSnapshot,
} from '../background/storage';
import { getVaultState } from '../background/vault';
import { BACKUP_STORAGE_KEYS, describeRestore, planRestore } from '../shared/backupRestore';
import { dropVaultCiphertext, stripSecretsForBackup } from '../shared/secretFields';
import { saveFile } from './download';
import { useT } from './i18n';

// chrome.storage.local keys that make up the user's configuration (and the
// only keys a restore may write — see shared/backupRestore.ts).
const STORAGE_KEYS = [...BACKUP_STORAGE_KEYS];

interface Backup {
  // Current exports tag 'CANChat Agent'; legacy files tagged 'CANAgent' still restore.
  app: 'CANChat Agent' | 'CANAgent';
  kind: 'backup';
  version: number;
  exportedAt: string;
  storage: Record<string, unknown>;
  repos: ExportedRepo[];
  products: ExportedProduct[];
}

export function BackupRestoreSection({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // Default to EXCLUDING the API key from exports (technical-debt.md §6.1): a
  // backup should not carry a bearer secret in plaintext unless deliberately opted in.
  const [includeKey, setIncludeKey] = useState(false);
  const [includeConversations, setIncludeConversations] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const exportAll = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // A backup must be portable, so any vault-encrypted content it includes is
      // decrypted here — which requires the vault unlocked.
      if ((includeKey || includeConversations) && (await getVaultState()) === 'locked') {
        throw new Error('Unlock the encryption vault before exporting encrypted content.');
      }
      let storage = (await chrome.storage.local.get(STORAGE_KEYS)) as Record<string, unknown>;
      if (includeConversations) {
        // Decrypted index + bodies (portable), via the storage layer.
        Object.assign(storage, await exportConversationsForBackup());
      }
      // Secrets: either decrypt every vault-sealed one so the file is portable,
      // or remove every known secret field (shared/secretFields.ts is the single
      // list). Either way no vault ciphertext is written — it is useless
      // off-device and would otherwise leak which fields were set.
      storage = includeKey
        ? dropVaultCiphertext(await unsealBackupSnapshot(storage))
        : stripSecretsForBackup(storage);
      const repos = (await chrome.runtime.sendMessage({ type: 'repo_export' })) as ExportedRepo[];
      const products = (await chrome.runtime.sendMessage({ type: 'products_export' })) as ExportedProduct[];
      const backup: Backup = {
        app: 'CANChat Agent',
        kind: 'backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        storage,
        repos: Array.isArray(repos) ? repos : [],
        products: Array.isArray(products) ? products : [],
      };
      saveFile(
        new Blob([JSON.stringify(backup)], { type: 'application/json' }),
        `canchat-agent-backup-${new Date().toISOString().slice(0, 10)}.json`,
      );
      const n = backup.repos.length;
      const p = backup.products.length;
      const extras = [
        n ? `${n} repositor${n === 1 ? 'y' : 'ies'}` : '',
        p ? `${p} product${p === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      const extraText = extras.length ? `, and ${extras.join(' and ')}` : '';
      setMessage({
        ok: true,
        text: `Exported settings, hints, skills, memory${extraText}.`,
      });
    } catch (e) {
      setMessage({ ok: false, text: `Export failed: ${String(e)}` });
    }
    setBusy(false);
  };

  const importFile = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const data = JSON.parse(await file.text()) as Partial<Backup>;
      if ((data?.app !== 'CANChat Agent' && data?.app !== 'CANAgent') || data?.kind !== 'backup') {
        throw new Error('Not a CANChat Agent backup file.');
      }
      const storage =
        data.storage && typeof data.storage === 'object' && !Array.isArray(data.storage)
          ? (data.storage as Record<string, unknown>)
          : {};
      // Only known configuration keys, with the expected shapes, are written;
      // conversations go through importConversationsFromBackup so they are
      // re-encrypted under the local vault (a raw set would land plaintext).
      const convKeys = new Set(conversationBackupKeys(storage));
      const current = (await chrome.storage.local.get(STORAGE_KEYS)) as Record<string, unknown>;
      const plan = planRestore(storage, current, convKeys);
      if (!window.confirm(describeRestore(plan))) {
        setBusy(false);
        return;
      }
      // A locked vault can't seal the restored secrets — require unlock first.
      if ((await getVaultState()) === 'locked') {
        throw new Error('Unlock the encryption vault before restoring a backup.');
      }
      if (Object.keys(plan.bulk).length > 0) await chrome.storage.local.set(plan.bulk);
      await sealSecretsAtRest(); // seal the restored keys/tokens when a vault is unlocked
      await importConversationsFromBackup(storage);
      if (Array.isArray(data.repos) && data.repos.length) {
        await chrome.runtime.sendMessage({ type: 'repo_import', repos: data.repos });
      }
      if (Array.isArray(data.products) && data.products.length) {
        await chrome.runtime.sendMessage({ type: 'products_import', products: data.products });
      }
      setMessage({ ok: true, text: 'Restore complete. Reloading…' });
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      setMessage({ ok: false, text: `Restore failed: ${String(e)}` });
    }
    setBusy(false);
  };

  return (
    <details class="sites-section settings-acc" open={defaultOpen}>
      <summary class="settings-header settings-acc-summary">
        <strong>Backup &amp; Restore</strong>
      </summary>
      <p class="settings-note">
        Export your configuration — endpoint settings, hints, skills, memory, on-device
        repositories, and generated products — to a single JSON file, and restore it on this or
        another device.
      </p>
      <label class="backup-check">
        <input
          type="checkbox"
          checked={includeKey}
          onChange={(e) => setIncludeKey((e.target as HTMLInputElement).checked)}
        />
        {t('backup.includeSecrets')}
      </label>
      {includeKey ? (
        <p class="settings-note warn">⚠ {t('backup.includeSecretsWarn')}</p>
      ) : (
        <p class="settings-note">{t('backup.secretsExcludedNote')}</p>
      )}
      <label class="backup-check">
        <input
          type="checkbox"
          checked={includeConversations}
          onChange={(e) => setIncludeConversations((e.target as HTMLInputElement).checked)}
        />
        {t('backup.includeConversations')}
      </label>
      {includeConversations && <p class="settings-note warn">⚠ {t('backup.includeConversationsNote')}</p>}
      <div class="settings-actions">
        <button class="btn" disabled={busy} onClick={exportAll}>
          Export backup
        </button>
        <label class={`btn ${busy ? 'btn-disabled' : ''}`}>
          Restore from file…
          <input
            type="file"
            accept="application/json,.json"
            style="display:none"
            disabled={busy}
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              const f = input.files?.[0];
              if (f) void importFile(f);
              input.value = '';
            }}
          />
        </label>
      </div>
      {message && <div class={`banner ${message.ok ? 'banner-ok' : 'banner-error'}`}>{message.text}</div>}
    </details>
  );
}

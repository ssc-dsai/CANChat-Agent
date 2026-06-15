import { useState } from 'preact/hooks';
import type { ExportedRepo } from '../shared/messages';

// chrome.storage.local keys that make up the user's configuration.
const STORAGE_KEYS = ['ba_settings', 'ba_sites', 'ba_skills', 'ba_memory', 'ba_memory_enabled', 'ba_language'];

interface Backup {
  app: 'CANAgent';
  kind: 'backup';
  version: number;
  exportedAt: string;
  storage: Record<string, unknown>;
  repos: ExportedRepo[];
}

export function BackupRestoreSection() {
  const [busy, setBusy] = useState(false);
  const [includeKey, setIncludeKey] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const exportAll = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const storage = (await chrome.storage.local.get(STORAGE_KEYS)) as Record<string, unknown>;
      if (!includeKey && storage.ba_settings && typeof storage.ba_settings === 'object') {
        // Strip the main key and the optional per-service override keys.
        storage.ba_settings = {
          ...(storage.ba_settings as object),
          apiKey: '',
          embeddingApiKey: '',
          transcriptionApiKey: '',
        };
      }
      if (!includeKey && Array.isArray(storage.ba_sites)) {
        // MCP server tokens live in the hints directory — scrub them too.
        storage.ba_sites = (storage.ba_sites as Array<Record<string, unknown>>).map((s) =>
          s && s.mcpToken ? { ...s, mcpToken: '' } : s,
        );
      }
      const repos = (await chrome.runtime.sendMessage({ type: 'repo_export' })) as ExportedRepo[];
      const backup: Backup = {
        app: 'CANAgent',
        kind: 'backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        storage,
        repos: Array.isArray(repos) ? repos : [],
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `canagent-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const n = backup.repos.length;
      setMessage({
        ok: true,
        text: `Exported settings, hints, skills, memory${n ? `, and ${n} repositor${n === 1 ? 'y' : 'ies'}` : ''}.`,
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
      if (data?.app !== 'CANAgent' || data?.kind !== 'backup') {
        throw new Error('Not a CANAgent backup file.');
      }
      const ok = window.confirm(
        'Restore will overwrite your current settings, hints, skills, and memory, and replace any repositories with the same name. Continue?',
      );
      if (!ok) {
        setBusy(false);
        return;
      }
      if (data.storage && typeof data.storage === 'object') {
        await chrome.storage.local.set(data.storage);
      }
      if (Array.isArray(data.repos) && data.repos.length) {
        await chrome.runtime.sendMessage({ type: 'repo_import', repos: data.repos });
      }
      setMessage({ ok: true, text: 'Restore complete. Reloading…' });
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      setMessage({ ok: false, text: `Restore failed: ${String(e)}` });
    }
    setBusy(false);
  };

  return (
    <div class="sites-section">
      <div class="settings-header">
        <strong>Backup &amp; Restore</strong>
      </div>
      <p class="settings-note">
        Export your configuration — endpoint settings, hints, skills, memory, and on-device
        repositories — to a single JSON file, and restore it on this or another device.
      </p>
      <label class="backup-check">
        <input
          type="checkbox"
          checked={includeKey}
          onChange={(e) => setIncludeKey((e.target as HTMLInputElement).checked)}
        />
        Include API key in the backup
      </label>
      {includeKey && (
        <p class="settings-note warn">⚠ The file will contain your API key in plain text — store it securely.</p>
      )}
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
    </div>
  );
}

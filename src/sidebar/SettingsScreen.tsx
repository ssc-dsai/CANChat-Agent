import { useEffect, useState } from 'preact/hooks';
import type { TestConnectionResponse } from '../shared/messages';
import type { Settings } from '../shared/types';
import { KnownSitesSection } from './KnownSitesSection';
import { MemorySection } from './MemorySection';
import { SkillsSection } from './SkillsSection';

interface Props {
  onClose: (configured?: boolean) => void;
}

const EMPTY: Settings = { baseUrl: '', apiKey: '', model: '' };

export function SettingsScreen({ onClose }: Props) {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get('ba_settings').then((r) => {
      if (r.ba_settings) setSettings(r.ba_settings as Settings);
    });
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setSaved(false);
    setTestResult(null);
  };

  const valid = Boolean(settings.baseUrl.trim() && settings.apiKey.trim() && settings.model.trim());

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = (await chrome.runtime.sendMessage({
        type: 'test_connection',
        settings,
      })) as TestConnectionResponse;
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, detail: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const trimmed: Settings = {
      ...settings,
      baseUrl: settings.baseUrl.trim(),
      apiKey: settings.apiKey.trim(),
      model: settings.model.trim(),
      systemPrompt: settings.systemPrompt?.trim() || undefined,
      sharepointBaseUrl: settings.sharepointBaseUrl?.trim().replace(/\/+$/, '') || undefined,
    };
    await chrome.storage.local.set({ ba_settings: trimmed });
    setSaved(true);
  };

  return (
    <div class="settings-overlay">
      <div class="settings-card">
        <div class="settings-header">
          <strong>Settings</strong>
          <button class="icon-btn" onClick={() => onClose(valid && saved ? true : undefined)}>
            ✕
          </button>
        </div>

        <p class="settings-note">
          Connect any OpenAI-compatible endpoint (remote API, local model, or gateway). The key is
          stored only on this device and never synced.
        </p>

        <label class="field">
          <span>Endpoint base URL</span>
          <input
            type="url"
            placeholder="https://api.example.com/v1"
            value={settings.baseUrl}
            onInput={(e) => update({ baseUrl: (e.target as HTMLInputElement).value })}
          />
        </label>

        <label class="field">
          <span>API key</span>
          <input
            type="password"
            placeholder="sk-…"
            value={settings.apiKey}
            onInput={(e) => update({ apiKey: (e.target as HTMLInputElement).value })}
          />
        </label>

        <label class="field">
          <span>Model</span>
          <input
            type="text"
            placeholder="model-name"
            value={settings.model}
            onInput={(e) => update({ model: (e.target as HTMLInputElement).value })}
          />
        </label>

        <div class="field-row">
          <label class="field">
            <span>Temperature (optional)</span>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={settings.temperature ?? ''}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                update({ temperature: v === '' ? undefined : Number(v) });
              }}
            />
          </label>
          <label class="field">
            <span>Max tokens (optional)</span>
            <input
              type="number"
              min="1"
              value={settings.maxTokens ?? ''}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                update({ maxTokens: v === '' ? undefined : Number(v) });
              }}
            />
          </label>
        </div>

        <label class="field">
          <span>SharePoint base URL (optional) — enables search over your SharePoint via the signed-in session; blank = auto-detect from an open SharePoint tab</span>
          <input
            type="url"
            placeholder="https://contoso.sharepoint.com"
            value={settings.sharepointBaseUrl ?? ''}
            onInput={(e) => update({ sharepointBaseUrl: (e.target as HTMLInputElement).value })}
          />
        </label>

        <label class="field">
          <span>Custom instructions (optional) — appended to the agent's built-in instructions; applies from your next message</span>
          <textarea
            class="chat-input"
            rows={5}
            placeholder={'e.g. Answer in French.\nI work in geospatial data — prefer technical depth over simplification.'}
            value={settings.systemPrompt ?? ''}
            onInput={(e) => update({ systemPrompt: (e.target as HTMLTextAreaElement).value })}
          />
        </label>

        {testResult && (
          <div class={`banner ${testResult.ok ? 'banner-ok' : 'banner-error'}`}>{testResult.detail}</div>
        )}
        {saved && <div class="banner banner-ok">Settings saved.</div>}

        <div class="settings-actions">
          <button class="btn" onClick={test} disabled={!valid || testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button class="btn btn-primary" onClick={save} disabled={!valid}>
            Save
          </button>
        </div>

        <hr class="settings-divider" />

        <KnownSitesSection />

        <hr class="settings-divider" />

        <SkillsSection />

        <hr class="settings-divider" />

        <MemorySection />
      </div>
    </div>
  );
}

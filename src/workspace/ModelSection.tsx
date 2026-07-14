import { useEffect, useState } from 'preact/hooks';
import type { TestConnectionResponse } from '../shared/messages';
import type { Settings } from '../shared/types';
import { useT } from '../sidebar/i18n';

const EMPTY: Settings = { baseUrl: '', apiKey: '', model: '' };

// Self-contained connection settings, independent of the sidebar SettingsScreen
// so this page can't regress the onboarding flow or its E2E coverage.
export function ModelSection() {
  const t = useT();
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
      apiVersion: settings.apiVersion?.trim() || undefined,
    };
    await chrome.storage.local.set({ ba_settings: trimmed });
    setSaved(true);
  };

  return (
    <div class="ws-model-page">
      <h2>{t('settings.tabModel')}</h2>

      <label class="field">
        <span>{t('settings.endpointUrl')}</span>
        <input
          type="url"
          placeholder="https://api.example.com/v1"
          value={settings.baseUrl}
          onInput={(e) => update({ baseUrl: (e.target as HTMLInputElement).value })}
        />
      </label>

      <label class="field">
        <span>{t('settings.apiKey')}</span>
        <input
          type="password"
          placeholder="sk-…"
          value={settings.apiKey}
          onInput={(e) => update({ apiKey: (e.target as HTMLInputElement).value })}
        />
      </label>

      <label class="field">
        <span>{t('settings.model')}</span>
        <input
          type="text"
          placeholder="model-name"
          value={settings.model}
          onInput={(e) => update({ model: (e.target as HTMLInputElement).value })}
        />
      </label>

      <label class="field">
        <span>{t('settings.apiVersion')}</span>
        <input
          type="text"
          placeholder="2024-02-01"
          value={settings.apiVersion ?? ''}
          onInput={(e) => update({ apiVersion: (e.target as HTMLInputElement).value })}
        />
      </label>
      <p class="settings-note">{t('settings.apiVersionNote')}</p>

      <div class="field-row">
        <label class="field">
          <span>{t('settings.temperature')}</span>
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
          <span>{t('settings.maxTokens')}</span>
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

      <p class="settings-note">
        Other endpoint options — embeddings, transcription, Azure/SharePoint, and advanced tuning — live
        in the sidebar Settings panel for now.
      </p>

      {testResult && (
        <div class={`banner ${testResult.ok ? 'banner-ok' : 'banner-error'}`}>{testResult.detail}</div>
      )}
      {saved && <div class="banner banner-ok">{t('settings.saved')}</div>}

      <div class="settings-actions">
        <button class="btn" onClick={test} disabled={!valid || testing}>
          {testing ? t('settings.testing') : t('settings.testConnection')}
        </button>
        <button class="btn btn-primary" onClick={save} disabled={!valid}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

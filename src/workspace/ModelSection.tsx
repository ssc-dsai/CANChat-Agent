import { useEffect, useState } from 'preact/hooks';
import type { TestConnectionResponse } from '../shared/messages';
import type { ModelProtocol, Settings } from '../shared/types';
import { getSettingsForEdit, saveSettings } from '../background/storage';
import { useT } from '../sidebar/i18n';
import { Group } from './SettingsControls';

const EMPTY: Settings = { baseUrl: '', apiKey: '', model: '' };

const PROTOCOLS: Array<{ value: ModelProtocol; label: string }> = [
  { value: 'chat-completions', label: 'settings.protocolChatCompletions' },
  { value: 'responses', label: 'settings.protocolResponses' },
  { value: 'anthropic-messages', label: 'settings.protocolAnthropic' },
  { value: 'gemini-native', label: 'settings.protocolGemini' },
  { value: 'bedrock-converse', label: 'settings.protocolBedrock' },
];

// Self-contained connection settings, independent of the sidebar SettingsScreen
// so this page can't regress the onboarding flow or its E2E coverage.
export function ModelSection() {
  const t = useT();
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  // When an encryption vault exists but is locked, secrets can't be decrypted or
  // safely overwritten — gate the form and point the user at the Vault section.
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    getSettingsForEdit().then(({ settings, locked }) => {
      // The Connection type selector (subscription providers requiring a local
      // companion) was removed — drop any stale value from older saved settings
      // rather than leaving the endpoint/API-key fields hidden with no way back.
      setSettings({ ...settings, subscriptionProvider: undefined });
      setLocked(locked);
    });
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setSaved(false);
    setTestResult(null);
  };

  const isBedrock = settings.protocol === 'bedrock-converse';
  const valid = isBedrock
    ? Boolean(settings.apiKey.trim() && settings.model.trim() && settings.awsAccessKeyId?.trim() && settings.awsRegion?.trim())
    : Boolean(settings.baseUrl.trim() && settings.apiKey.trim() && settings.model.trim());

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

  // Patch-save: merge only this section's fields over a fresh (decrypted) read,
  // so saving here can't revert what AdvancedSettingsSection (same page, same
  // storage object) saved after this component mounted. saveSettings re-encrypts
  // secrets when a vault is unlocked, and throws if it is locked.
  const save = async () => {
    try {
      const { settings: current } = await getSettingsForEdit();
      await saveSettings({
        ...current,
        baseUrl: settings.baseUrl.trim(),
        apiKey: settings.apiKey.trim(),
        model: settings.model.trim(),
        subscriptionProvider: undefined,
        protocol: settings.protocol,
        ideogramApiKey: settings.ideogramApiKey?.trim() || undefined,
        apiVersion: settings.apiVersion?.trim() || undefined,
        awsRegion: settings.awsRegion?.trim() || undefined,
        awsAccessKeyId: settings.awsAccessKeyId?.trim() || undefined,
        awsSessionToken: settings.awsSessionToken?.trim() || undefined,
        decisionModelBaseUrl: settings.decisionModelBaseUrl?.trim() || undefined,
        decisionModelApiKey: settings.decisionModelApiKey?.trim() || undefined,
      });
      setSaved(true);
    } catch (e) {
      setTestResult({ ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div class="ws-model-page">
      <h2>{t('settings.tabModel')}</h2>

      {locked && (
        <div class="banner banner-error">
          🔒 The encryption vault is locked. Unlock it in the Vault section to view or change connection settings.
        </div>
      )}

      <Group title={t('settings.groupConnection')} desc={t('settings.note')}>
        <label class="field">
          <span>{t('settings.endpointUrl')}</span>
          <input
            type="url"
            placeholder={isBedrock ? 'https://bedrock-runtime.<region>.amazonaws.com (optional override)' : 'https://api.example.com/v1'}
            value={settings.baseUrl}
            onInput={(e) => update({ baseUrl: (e.target as HTMLInputElement).value })}
          />
          {isBedrock && <span class="field-note">{t('settings.bedrockEndpointNote')}</span>}
        </label>

        <label class="field">
          <span>{isBedrock ? t('settings.awsSecretAccessKey') : t('settings.apiKey')}</span>
          <input
            type="password"
            placeholder={isBedrock ? 'AWS secret access key' : 'sk-…'}
            value={settings.apiKey}
            onInput={(e) => update({ apiKey: (e.target as HTMLInputElement).value })}
          />
        </label>

        <label class="field">
          <span>{t('settings.model')}</span>
          <input
            type="text"
            placeholder={isBedrock ? 'anthropic.claude-3-5-sonnet-20241022-v2:0' : 'model-name'}
            value={settings.model}
            onInput={(e) => update({ model: (e.target as HTMLInputElement).value })}
          />
        </label>

        <label class="field">
          <span>{t('settings.protocol')}</span>
          <select
            value={settings.protocol ?? 'chat-completions'}
            onChange={(e) => update({ protocol: (e.target as HTMLSelectElement).value as ModelProtocol })}
          >
            {PROTOCOLS.map((p) => (
              <option key={p.value} value={p.value}>
                {t(p.label)}
              </option>
            ))}
          </select>
          <span class="field-note">{t('settings.protocolNote')}</span>
        </label>

        {isBedrock && <>
          <label class="field">
            <span>{t('settings.awsRegion')}</span>
            <input
              type="text"
              placeholder="us-east-1"
              value={settings.awsRegion ?? ''}
              onInput={(e) => update({ awsRegion: (e.target as HTMLInputElement).value })}
            />
          </label>

          <label class="field">
            <span>{t('settings.awsAccessKeyId')}</span>
            <input
              type="text"
              placeholder="AKIA…"
              value={settings.awsAccessKeyId ?? ''}
              onInput={(e) => update({ awsAccessKeyId: (e.target as HTMLInputElement).value })}
            />
          </label>

          <label class="field">
            <span>{t('settings.awsSessionToken')}</span>
            <input
              type="password"
              placeholder={t('settings.awsSessionTokenPlaceholder')}
              value={settings.awsSessionToken ?? ''}
              onInput={(e) => update({ awsSessionToken: (e.target as HTMLInputElement).value })}
            />
            <span class="field-note">{t('settings.awsSessionTokenNote')}</span>
          </label>
        </>}

        {!isBedrock && <label class="field">
          <span>{t('settings.apiVersion')}</span>
          <input
            type="text"
            placeholder="2024-02-01"
            value={settings.apiVersion ?? ''}
            onInput={(e) => update({ apiVersion: (e.target as HTMLInputElement).value })}
          />
          <span class="field-note">{t('settings.apiVersionNote')}</span>
        </label>}
      </Group>

      <Group title={t('settings.groupImage')} desc={t('settings.groupImageDesc')}>
        <label class="field">
          <span>{t('settings.ideogramApiKey')}</span>
          <input
            type="password"
            placeholder="ik-…"
            value={settings.ideogramApiKey ?? ''}
            onInput={(e) => update({ ideogramApiKey: (e.target as HTMLInputElement).value })}
          />
        </label>
      </Group>

      <Group title={t('settings.groupDecisionModel')} desc={t('settings.groupDecisionModelDesc')}>
        <label class="field">
          <span>{t('settings.decisionModelBaseUrl')}</span>
          <input
            type="url"
            placeholder="http://localhost:8009"
            value={settings.decisionModelBaseUrl ?? ''}
            onInput={(e) => update({ decisionModelBaseUrl: (e.target as HTMLInputElement).value })}
          />
          <span class="field-note">{t('settings.decisionModelBaseUrlNote')}</span>
        </label>

        <label class="field">
          <span>{t('settings.decisionModelApiKey')}</span>
          <input
            type="password"
            placeholder={t('settings.decisionModelApiKeyPlaceholder')}
            value={settings.decisionModelApiKey ?? ''}
            onInput={(e) => update({ decisionModelApiKey: (e.target as HTMLInputElement).value })}
          />
        </label>
      </Group>

      {testResult && (
        <div class={`banner ${testResult.ok ? 'banner-ok' : 'banner-error'}`}>{testResult.detail}</div>
      )}
      {saved && <div class="banner banner-ok">{t('settings.saved')}</div>}

      <div class="settings-actions">
        <button class="btn" onClick={test} disabled={!valid || testing || locked}>
          {testing ? t('settings.testing') : t('settings.testConnection')}
        </button>
        <button class="btn btn-primary" onClick={save} disabled={!valid || locked}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

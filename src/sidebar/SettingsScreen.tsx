import { useEffect, useRef, useState } from 'preact/hooks';
import type { TestConnectionResponse } from '../shared/messages';
import type { Settings } from '../shared/types';
import { BackupRestoreSection } from './BackupRestoreSection';
import { CapabilitiesSection } from './CapabilitiesSection';
import { DOCS_URL } from './links';
import { LANGUAGE_STORAGE_KEY, useT, type LangPref } from './i18n';
import { MemorySection } from './MemorySection';
import { RepositoriesSection } from './RepositoriesSection';
import { SkillsSection } from './SkillsSection';

interface Props {
  onClose: (configured?: boolean) => void;
}

const EMPTY: Settings = { baseUrl: '', apiKey: '', model: '' };

type SettingsTab = 'model' | 'advanced' | 'skills' | 'data';
const TABS: ReadonlyArray<[SettingsTab, string]> = [
  ['model', 'settings.tabModel'],
  ['advanced', 'settings.tabAdvanced'],
  ['skills', 'settings.tabSkills'],
  ['data', 'settings.tabData'],
];

export function SettingsScreen({ onClose }: Props) {
  const t = useT();
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [langPref, setLangPref] = useState<LangPref>('auto');
  const [tab, setTab] = useState<SettingsTab>('model');
  const cardRef = useRef<HTMLDivElement>(null);

  // Switching tabs resets the scroll so the (now shorter) section starts at top.
  const switchTab = (next: SettingsTab) => {
    setTab(next);
    if (cardRef.current) cardRef.current.scrollTop = 0;
  };
  // Test/Save act on the `settings` object, so they belong to the field tabs.
  const showModelActions = tab === 'model' || tab === 'advanced';

  useEffect(() => {
    chrome.storage.local.get(['ba_settings', LANGUAGE_STORAGE_KEY]).then((r) => {
      if (r.ba_settings) setSettings(r.ba_settings as Settings);
      if (r[LANGUAGE_STORAGE_KEY]) setLangPref(r[LANGUAGE_STORAGE_KEY] as LangPref);
    });
  }, []);

  // Writing the preference triggers the LanguageProvider's storage listener, so
  // the whole UI re-renders into the chosen language immediately.
  const changeLanguage = (pref: LangPref) => {
    setLangPref(pref);
    void chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: pref });
  };

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
      systemPrompt: settings.systemPrompt?.trim() || undefined,
      sharepointBaseUrl: settings.sharepointBaseUrl?.trim().replace(/\/+$/, '') || undefined,
      embeddingModel: settings.embeddingModel?.trim() || undefined,
      embeddingBaseUrl: settings.embeddingBaseUrl?.trim().replace(/\/+$/, '') || undefined,
      embeddingApiKey: settings.embeddingApiKey?.trim() || undefined,
      transcriptionModel: settings.transcriptionModel?.trim() || undefined,
      transcriptionBaseUrl: settings.transcriptionBaseUrl?.trim().replace(/\/+$/, '') || undefined,
      transcriptionApiKey: settings.transcriptionApiKey?.trim() || undefined,
      retryOnRateLimit: settings.retryOnRateLimit ?? true,
      verifyAnswers: settings.verifyAnswers ?? true,
      summarizeObservations: settings.summarizeObservations ?? true,
    };
    await chrome.storage.local.set({ ba_settings: trimmed });
    setSaved(true);
  };

  return (
    <div class="settings-overlay">
      <div class="settings-card" ref={cardRef}>
        <div class="settings-header">
          <strong>{t('settings.title')}</strong>
          <button class="icon-btn" onClick={() => onClose(valid && saved ? true : undefined)}>
            ✕
          </button>
        </div>

        <div class="settings-tabs" role="tablist">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              class={`settings-tab ${tab === key ? 'is-active' : ''}`}
              onClick={() => switchTab(key)}
            >
              {t(label)}
            </button>
          ))}
        </div>

        {tab === 'model' && (
        <>
        <label class="field">
          <span>{t('settings.language')}</span>
          <select
            value={langPref}
            onChange={(e) => changeLanguage((e.target as HTMLSelectElement).value as LangPref)}
          >
            <option value="auto">{t('settings.languageAuto')}</option>
            <option value="en">{t('settings.languageEn')}</option>
            <option value="fr">{t('settings.languageFr')}</option>
          </select>
        </label>
        <p class="settings-note">{t('settings.languageNote')}</p>

        <p class="settings-note">{t('settings.note')}</p>

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
        </>
        )}

        {tab === 'advanced' && (
        <>
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

        <label class="memory-toggle">
          <input
            type="checkbox"
            checked={settings.retryOnRateLimit ?? true}
            onChange={(e) => update({ retryOnRateLimit: (e.target as HTMLInputElement).checked })}
          />
          <span>{t('settings.retryOnRateLimit')}</span>
        </label>
        <p class="settings-note">{t('settings.retryOnRateLimitNote')}</p>

        <label class="memory-toggle">
          <input
            type="checkbox"
            checked={settings.verifyAnswers ?? true}
            onChange={(e) => update({ verifyAnswers: (e.target as HTMLInputElement).checked })}
          />
          <span>{t('settings.verifyAnswers')}</span>
        </label>
        <p class="settings-note">{t('settings.verifyAnswersNote')}</p>

        <label class="memory-toggle">
          <input
            type="checkbox"
            checked={settings.summarizeObservations ?? true}
            onChange={(e) => update({ summarizeObservations: (e.target as HTMLInputElement).checked })}
          />
          <span>{t('settings.summarizeObservations')}</span>
        </label>
        <p class="settings-note">{t('settings.summarizeObservationsNote')}</p>

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

        <div class="field-row">
          <label class="field">
            <span>{t('settings.embeddingModel')}</span>
            <input
              type="text"
              placeholder="text-embedding-3-small"
              value={settings.embeddingModel ?? ''}
              onInput={(e) => update({ embeddingModel: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>{t('settings.repoSearchK')}</span>
            <input
              type="number"
              min="1"
              placeholder="6"
              value={settings.repoSearchK ?? ''}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                update({ repoSearchK: v === '' ? undefined : Number(v) });
              }}
            />
          </label>
          <label class="field">
            <span>{t('settings.maxSteps')}</span>
            <input
              type="number"
              min="1"
              max="1000"
              placeholder="20"
              value={settings.maxSteps ?? ''}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                update({ maxSteps: v === '' ? undefined : Number(v) });
              }}
            />
          </label>
        </div>
        <p class="settings-note">{t('settings.repoSearchKNote')}</p>
        <p class="settings-note">{t('settings.maxStepsNote')}</p>

        <div class="field-row">
          <label class="field">
            <span>{t('settings.embeddingUrl')}</span>
            <input
              type="url"
              placeholder="https://embeddings.example.com/v1"
              value={settings.embeddingBaseUrl ?? ''}
              onInput={(e) => update({ embeddingBaseUrl: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>{t('settings.embeddingKey')}</span>
            <input
              type="password"
              placeholder="sk-…"
              value={settings.embeddingApiKey ?? ''}
              onInput={(e) => update({ embeddingApiKey: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>

        <label class="field">
          <span>{t('settings.transcriptionModel')}</span>
          <input
            type="text"
            placeholder="whisper-1"
            value={settings.transcriptionModel ?? ''}
            onInput={(e) => update({ transcriptionModel: (e.target as HTMLInputElement).value })}
          />
        </label>

        <div class="field-row">
          <label class="field">
            <span>{t('settings.transcriptionUrl')}</span>
            <input
              type="url"
              placeholder="https://stt.example.com/v1"
              value={settings.transcriptionBaseUrl ?? ''}
              onInput={(e) => update({ transcriptionBaseUrl: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>{t('settings.transcriptionKey')}</span>
            <input
              type="password"
              placeholder="sk-…"
              value={settings.transcriptionApiKey ?? ''}
              onInput={(e) => update({ transcriptionApiKey: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>

        <label class="field">
          <span>{t('settings.sharepointUrl')}</span>
          <input
            type="url"
            placeholder="https://contoso.sharepoint.com"
            value={settings.sharepointBaseUrl ?? ''}
            onInput={(e) => update({ sharepointBaseUrl: (e.target as HTMLInputElement).value })}
          />
        </label>

        <label class="field">
          <span>{t('settings.customInstructions')}</span>
          <textarea
            class="chat-input"
            rows={5}
            placeholder={t('settings.customInstructionsPlaceholder')}
            value={settings.systemPrompt ?? ''}
            onInput={(e) => update({ systemPrompt: (e.target as HTMLTextAreaElement).value })}
          />
        </label>
        </>
        )}

        {showModelActions && (
        <>
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
        </>
        )}

        {tab === 'skills' && <SkillsSection />}

        {tab === 'data' && (
        <>
        <CapabilitiesSection />
        <MemorySection />
        <RepositoriesSection />
        <BackupRestoreSection />
        </>
        )}

        <div class="settings-about">
          <span>CANChat Agent · build {__APP_VERSION__}</span>
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
            {t('settings.help')}
          </a>
        </div>
      </div>
    </div>
  );
}

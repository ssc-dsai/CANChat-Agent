import { useEffect, useState } from 'preact/hooks';
import { BackupRestoreSection } from '../sidebar/BackupRestoreSection';
import { DOCS_URL } from '../sidebar/links';
import { LANGUAGE_STORAGE_KEY, useT, type LangPref } from '../sidebar/i18n';

export function ConsoleSettingsPage() {
  const t = useT();
  const [langPref, setLangPref] = useState<LangPref>('auto');

  useEffect(() => {
    chrome.storage.local.get(LANGUAGE_STORAGE_KEY).then((r) => {
      if (r[LANGUAGE_STORAGE_KEY]) setLangPref(r[LANGUAGE_STORAGE_KEY] as LangPref);
    });
  }, []);

  const changeLanguage = (pref: LangPref) => {
    setLangPref(pref);
    void chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: pref });
  };

  return (
    <div class="ws-settings-page">
      <h2>{t('settings.title')}</h2>

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

      <BackupRestoreSection defaultOpen />

      <div class="settings-about">
        <span>CANChat Agent · build {__APP_VERSION__}</span>
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
          {t('settings.help')}
        </a>
      </div>
    </div>
  );
}

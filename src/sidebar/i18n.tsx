// =============================================================================
// In-app localization (English / French) for the side-panel UI.
//
// We use a small dictionary + a stored preference rather than chrome.i18n,
// because chrome.i18n follows the browser UI language and can't be switched
// in-app at runtime — and the requirement is a user-selectable EN/FR toggle.
//
// The preference lives in chrome.storage.local under `ba_language`
// ('auto' | 'en' | 'fr'); 'auto' resolves to the browser language. Components
// read the translator via `useT()` and re-render live when the toggle changes.
//
// Translation note: the French here is a DRAFT for review by a qualified
// translator before official Government of Canada use (see docs/TRAINING.md).
// Keys are grouped by screen to make that review a single-file pass.
// =============================================================================

import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';

export type Lang = 'en' | 'fr';
export type LangPref = 'auto' | Lang;

export const LANGUAGE_STORAGE_KEY = 'ba_language';

type Dict = Record<string, string>;

const EN: Dict = {
  // common
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.add': 'Add',
  'common.dismiss': 'Dismiss',
  // header
  'header.saveConversation': 'Save conversation as HTML',
  'header.clearConversation': 'Clear conversation',
  'header.settings': 'Settings',
  'header.smallerText': 'Smaller text',
  'header.resetText': 'Reset text size',
  'header.largerText': 'Larger text',
  'header.noModel': 'No model configured.',
  'header.openSettings': 'Open settings',
  // status
  'status.idle': 'Idle',
  'status.thinking': 'Thinking…',
  'status.acting': 'Using browser…',
  'status.paused': 'Paused',
  'status.awaiting_approval': 'Waiting for approval',
  'status.auth_required': 'Login required',
  'status.error': 'Error',
  // settings — language
  'settings.language': 'Language',
  'settings.languageNote': 'Interface language. “Auto” follows your browser.',
  'settings.languageAuto': 'Auto',
  'settings.languageEn': 'English',
  'settings.languageFr': 'Français',
  // settings — model config
  'settings.title': 'Settings',
  'settings.note':
    'Connect any OpenAI-compatible endpoint (remote API, local model, or gateway). The key is stored only on this device and never synced.',
  'settings.endpointUrl': 'Endpoint base URL',
  'settings.apiKey': 'API key',
  'settings.model': 'Model',
  'settings.temperature': 'Temperature (optional)',
  'settings.maxTokens': 'Max tokens (optional)',
  'settings.embeddingModel':
    'Embedding model (optional) — for local repositories; defaults to the model above if blank',
  'settings.embeddingUrl': 'Embedding endpoint base URL (optional) — blank uses the main endpoint above',
  'settings.embeddingKey': 'Embedding API key (optional) — blank uses the main key',
  'settings.transcriptionModel':
    'Transcription model (optional) — enables voice prompts (mic button); must be a speech-to-text model your endpoint exposes at /audio/transcriptions',
  'settings.transcriptionUrl':
    'Transcription endpoint base URL (optional) — blank uses the main endpoint above',
  'settings.transcriptionKey': 'Transcription API key (optional) — blank uses the main key',
  'settings.sharepointUrl':
    'SharePoint base URL (optional) — enables search over your SharePoint via the signed-in session; blank = auto-detect from an open SharePoint tab',
  'settings.customInstructions':
    "Custom instructions (optional) — appended to the agent's built-in instructions; applies from your next message",
  'settings.customInstructionsPlaceholder':
    'e.g. Answer in French.\nI work in geospatial data — prefer technical depth over simplification.',
  'settings.saved': 'Settings saved.',
  'settings.testing': 'Testing…',
  'settings.testConnection': 'Test connection',
};

const FR: Dict = {
  // common
  'common.cancel': 'Annuler',
  'common.close': 'Fermer',
  'common.save': 'Enregistrer',
  'common.delete': 'Supprimer',
  'common.edit': 'Modifier',
  'common.add': 'Ajouter',
  'common.dismiss': 'Ignorer',
  // header
  'header.saveConversation': 'Enregistrer la conversation en HTML',
  'header.clearConversation': 'Effacer la conversation',
  'header.settings': 'Paramètres',
  'header.smallerText': 'Texte plus petit',
  'header.resetText': 'Réinitialiser la taille du texte',
  'header.largerText': 'Texte plus grand',
  'header.noModel': 'Aucun modèle configuré.',
  'header.openSettings': 'Ouvrir les paramètres',
  // status
  'status.idle': 'Inactif',
  'status.thinking': 'Réflexion…',
  'status.acting': 'Utilisation du navigateur…',
  'status.paused': 'En pause',
  'status.awaiting_approval': 'En attente d’approbation',
  'status.auth_required': 'Connexion requise',
  'status.error': 'Erreur',
  // settings — language
  'settings.language': 'Langue',
  'settings.languageNote': 'Langue de l’interface. « Auto » suit votre navigateur.',
  'settings.languageAuto': 'Auto',
  'settings.languageEn': 'English',
  'settings.languageFr': 'Français',
  // settings — model config
  'settings.title': 'Paramètres',
  'settings.note':
    'Connectez n’importe quel point de terminaison compatible avec OpenAI (API distante, modèle local ou passerelle). La clé est stockée uniquement sur cet appareil et n’est jamais synchronisée.',
  'settings.endpointUrl': 'URL de base du point de terminaison',
  'settings.apiKey': 'Clé d’API',
  'settings.model': 'Modèle',
  'settings.temperature': 'Température (facultatif)',
  'settings.maxTokens': 'Jetons maximum (facultatif)',
  'settings.embeddingModel':
    'Modèle d’intégration (facultatif) — pour les dépôts locaux; utilise le modèle ci-dessus si vide',
  'settings.embeddingUrl':
    'URL de base du point de terminaison d’intégration (facultatif) — vide = point de terminaison principal ci-dessus',
  'settings.embeddingKey': 'Clé d’API d’intégration (facultatif) — vide = clé principale',
  'settings.transcriptionModel':
    'Modèle de transcription (facultatif) — active les invites vocales (bouton micro); doit être un modèle de reconnaissance vocale exposé par votre point de terminaison à /audio/transcriptions',
  'settings.transcriptionUrl':
    'URL de base du point de terminaison de transcription (facultatif) — vide = point de terminaison principal ci-dessus',
  'settings.transcriptionKey': 'Clé d’API de transcription (facultatif) — vide = clé principale',
  'settings.sharepointUrl':
    'URL de base SharePoint (facultatif) — active la recherche dans votre SharePoint via la session ouverte; vide = détection automatique à partir d’un onglet SharePoint ouvert',
  'settings.customInstructions':
    'Instructions personnalisées (facultatif) — ajoutées aux instructions intégrées de l’agent; s’appliquent dès votre prochain message',
  'settings.customInstructionsPlaceholder':
    'p. ex. Réponds en français.\nJe travaille en données géospatiales — privilégie la profondeur technique à la simplification.',
  'settings.saved': 'Paramètres enregistrés.',
  'settings.testing': 'Essai en cours…',
  'settings.testConnection': 'Tester la connexion',
};

export const MESSAGES: Record<Lang, Dict> = { en: EN, fr: FR };

/** Resolve a stored preference to a concrete language. */
export function resolveLang(pref: LangPref | undefined): Lang {
  if (pref === 'en' || pref === 'fr') return pref;
  try {
    return chrome.i18n.getUILanguage().toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

export type Translator = (key: string, params?: Record<string, string | number>) => string;

/** Look up a key, fall back to English then the raw key, and interpolate {name} params. */
export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  let s = MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

const LangContext = createContext<{ lang: Lang; t: Translator }>({
  lang: 'en',
  t: (key) => key,
});

export function LanguageProvider({ children }: { children: ComponentChildren }) {
  // Seed from the browser language so an "auto" user sees no English flash;
  // storage (an explicit choice) resolves a tick later.
  const [lang, setLang] = useState<Lang>(() => resolveLang('auto'));
  useEffect(() => {
    const load = () =>
      chrome.storage.local
        .get(LANGUAGE_STORAGE_KEY)
        .then((r) => setLang(resolveLang(r[LANGUAGE_STORAGE_KEY] as LangPref | undefined)));
    load();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (LANGUAGE_STORAGE_KEY in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  const t: Translator = (key, params) => translate(lang, key, params);
  return <LangContext.Provider value={{ lang, t }}>{children}</LangContext.Provider>;
}

export function useT(): Translator {
  return useContext(LangContext).t;
}

export function useLang(): Lang {
  return useContext(LangContext).lang;
}

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
  'header.history': 'Conversation history',
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
  'status.acting': 'Browsing…',
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
  'settings.tabModel': 'Model',
  'settings.tabAdvanced': 'Advanced',
  'settings.tabSkills': 'Skills',
  'settings.tabData': 'Data & privacy',
  'onboarding.title': 'Welcome to CANChat Agent',
  'onboarding.intro':
    'An AI agent that uses your browser as its tools — ask about the current page, your open tabs, or the web. To begin, connect a model. The key is stored only on this device and never synced.',
  'onboarding.start': 'Save & start',
  'onboarding.advanced': 'Advanced setup…',
  'settings.note':
    'Connect any OpenAI-compatible endpoint (remote API, local model, or gateway). The key is stored only on this device and never synced.',
  'settings.endpointUrl': 'Endpoint base URL',
  'settings.apiKey': 'API key',
  'settings.model': 'Model',
  'settings.apiVersion': 'Azure API version (optional)',
  'settings.apiVersionNote':
    'Set this only for Azure OpenAI (e.g. 2024-02-01). When filled, requests use Azure’s api-version query parameter and api-key header. Your endpoint URL should point at the deployment, e.g. https://NAME.openai.azure.com/openai/deployments/DEPLOYMENT',
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
  // History overlay
  'conversations.title': 'Conversation history',
  'conversations.empty': 'No saved conversations yet. Conversations are saved automatically as you chat.',
  'conversations.untitled': 'Untitled conversation',
  'conversations.continue': 'Continue',
  'conversations.save': 'Save',
  'conversations.export': 'Export',
  'conversations.delete': 'Delete',
  'conversations.load': 'Load from file…',
  'conversations.clearAll': 'Clear all',
  'conversations.confirmDelete': 'Delete “{title}”? This cannot be undone.',
  'conversations.confirmClearAll': 'Delete all {n} saved conversations? This cannot be undone.',
  'conversations.imported': 'Conversation loaded.',
  'conversations.importError': 'That file isn’t a CANChat Agent conversation.',
  'conversations.messageCount': '{n} messages',
  'conversations.labels': 'Labels',
  'conversations.filterByLabel': 'Filter by label',
  'conversations.allLabels': 'All conversations',
  'conversations.noMatches': 'No conversations match the selected labels.',
  'conversations.assignLabels': 'Labels',
  'conversations.newLabel': 'New label',
  'conversations.labelNamePlaceholder': 'Label name',
  'conversations.addLabel': 'Add',
  'conversations.renameLabel': 'Rename',
  'conversations.deleteLabel': 'Delete label',
  'conversations.confirmDeleteLabel': 'Delete the label “{name}”? It will be removed from every conversation.',
  'conversations.clearFilter': 'Clear',
  'conversations.noLabels': 'No labels yet. Create one below.',
  // Backup & Restore
  'backup.includeConversations': 'Include saved conversations',
  'backup.includeConversationsNote':
    'Conversations can contain page content and screenshots. Off by default — only export them if you intend to.',
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
  'header.history': 'Historique des conversations',
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
  'status.acting': 'Navigation…',
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
  'settings.tabModel': 'Modèle',
  'settings.tabAdvanced': 'Avancé',
  'settings.tabSkills': 'Compétences',
  'settings.tabData': 'Données et confidentialité',
  'onboarding.title': 'Bienvenue dans CANChat Agent',
  'onboarding.intro':
    'Un agent IA qui utilise votre navigateur comme outils — posez des questions sur la page actuelle, vos onglets ouverts ou le Web. Pour commencer, connectez un modèle. La clé est stockée uniquement sur cet appareil et n’est jamais synchronisée.',
  'onboarding.start': 'Enregistrer et démarrer',
  'onboarding.advanced': 'Configuration avancée…',
  'settings.note':
    'Connectez n’importe quel point de terminaison compatible avec OpenAI (API distante, modèle local ou passerelle). La clé est stockée uniquement sur cet appareil et n’est jamais synchronisée.',
  'settings.endpointUrl': 'URL de base du point de terminaison',
  'settings.apiKey': 'Clé d’API',
  'settings.model': 'Modèle',
  'settings.apiVersion': 'Version d’API Azure (facultatif)',
  'settings.apiVersionNote':
    'À remplir uniquement pour Azure OpenAI (p. ex. 2024-02-01). Si renseigné, les requêtes utilisent le paramètre api-version et l’en-tête api-key d’Azure. L’URL du point de terminaison doit viser le déploiement, p. ex. https://NOM.openai.azure.com/openai/deployments/DEPLOIEMENT',
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
  // Historique
  'conversations.title': 'Historique des conversations',
  'conversations.empty':
    'Aucune conversation enregistrée pour l’instant. Les conversations sont enregistrées automatiquement au fil de l’échange.',
  'conversations.untitled': 'Conversation sans titre',
  'conversations.continue': 'Continuer',
  'conversations.save': 'Enregistrer',
  'conversations.export': 'Exporter',
  'conversations.delete': 'Supprimer',
  'conversations.load': 'Charger depuis un fichier…',
  'conversations.clearAll': 'Tout effacer',
  'conversations.confirmDelete': 'Supprimer « {title} »? Cette action est irréversible.',
  'conversations.confirmClearAll':
    'Supprimer les {n} conversations enregistrées? Cette action est irréversible.',
  'conversations.imported': 'Conversation chargée.',
  'conversations.importError': 'Ce fichier n’est pas une conversation CANChat Agent.',
  'conversations.messageCount': '{n} messages',
  'conversations.labels': 'Étiquettes',
  'conversations.filterByLabel': 'Filtrer par étiquette',
  'conversations.allLabels': 'Toutes les conversations',
  'conversations.noMatches': 'Aucune conversation ne correspond aux étiquettes sélectionnées.',
  'conversations.assignLabels': 'Étiquettes',
  'conversations.newLabel': 'Nouvelle étiquette',
  'conversations.labelNamePlaceholder': 'Nom de l’étiquette',
  'conversations.addLabel': 'Ajouter',
  'conversations.renameLabel': 'Renommer',
  'conversations.deleteLabel': 'Supprimer l’étiquette',
  'conversations.confirmDeleteLabel':
    'Supprimer l’étiquette « {name} »? Elle sera retirée de toutes les conversations.',
  'conversations.clearFilter': 'Effacer',
  'conversations.noLabels': 'Aucune étiquette pour l’instant. Créez-en une ci-dessous.',
  // Sauvegarde et restauration
  'backup.includeConversations': 'Inclure les conversations enregistrées',
  'backup.includeConversationsNote':
    'Les conversations peuvent contenir le contenu de pages et des captures d’écran. Désactivé par défaut — ne les exportez que si vous le souhaitez.',
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

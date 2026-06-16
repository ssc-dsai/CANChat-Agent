// =============================================================================
// Persistence — thin typed accessors over `chrome.storage.local` for the four
// durable collections (settings, hints/sites, skills, memory). These `ba_*`
// keys are exactly what Backup & Restore exports/imports. Everything is
// device-local and never synced; the API key in particular never leaves here.
// =============================================================================

import { pruneIndex } from '../shared/conversationMeta';
import type {
  ChatMessageView,
  ConversationLabel,
  ConversationSummary,
  MemoryEntry,
  PlanStepStatus,
  Settings,
  SiteEntry,
  Skill,
} from '../shared/types';
import type { LlmMessage } from './llmProvider';

const SETTINGS_KEY = 'ba_settings';
const SITES_KEY = 'ba_sites';
const SKILLS_KEY = 'ba_skills';
const MEMORY_KEY = 'ba_memory';
const MEMORY_ENABLED_KEY = 'ba_memory_enabled';

export const MEMORY_MAX_ENTRIES = 100;

// --- saved conversations (auto-history) ---------------------------------------
// One lightweight index array plus one body record per conversation. Splitting
// them keeps the History list cheap to render and lets autosave rewrite a single
// body instead of one giant blob.
export const CONVERSATION_INDEX_KEY = 'ba_conv_index';
export const CONVERSATION_KEY_PREFIX = 'ba_conv_';
export const CONVERSATION_LABELS_KEY = 'ba_conv_labels';
export const MAX_SAVED_CONVERSATIONS = 100;

/** Storage key for a conversation body. Index entries are keyed by id alone. */
export function conversationKey(id: string): string {
  return `${CONVERSATION_KEY_PREFIX}${id}`;
}

/**
 * Full saved conversation. Carries both the visible transcript and the complete
 * `LlmMessage[]` model context, so `AgentRuntime.loadConversation` can restore
 * the agent's full memory and the user can truly continue the thread.
 */
export interface StoredConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageView[];
  conversation: LlmMessage[];
  /** True once an LLM topic title has been generated, so autosave stops re-deriving the heuristic. */
  autoTitled?: boolean;
  /** Ids of the labels assigned to this conversation (mirrors the index entry). */
  labels?: string[];
  /** Best-effort working state, so a resumed thread keeps its plan/findings. */
  plan?: { text: string; status: PlanStepStatus }[];
  findings?: string[];
  lastTaskUrl?: string;
}

// chrome.storage.local only — the API key must never sync across devices.
export async function getSettings(): Promise<Settings | null> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = result[SETTINGS_KEY] as Settings | undefined;
  if (!settings || !settings.baseUrl || !settings.apiKey || !settings.model) return null;
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function getSites(): Promise<SiteEntry[]> {
  const result = await chrome.storage.local.get(SITES_KEY);
  const sites = result[SITES_KEY];
  return Array.isArray(sites) ? (sites as SiteEntry[]) : [];
}

export async function saveSites(sites: SiteEntry[]): Promise<void> {
  await chrome.storage.local.set({ [SITES_KEY]: sites });
}

export async function getSkills(): Promise<Skill[]> {
  const result = await chrome.storage.local.get(SKILLS_KEY);
  const skills = result[SKILLS_KEY];
  return Array.isArray(skills) ? (skills as Skill[]) : [];
}

export async function saveSkills(skills: Skill[]): Promise<void> {
  await chrome.storage.local.set({ [SKILLS_KEY]: skills });
}

export async function getMemoryEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(MEMORY_ENABLED_KEY);
  return result[MEMORY_ENABLED_KEY] === true; // off by default
}

export async function setMemoryEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [MEMORY_ENABLED_KEY]: enabled });
}

export async function getMemories(): Promise<MemoryEntry[]> {
  const result = await chrome.storage.local.get(MEMORY_KEY);
  const entries = result[MEMORY_KEY];
  return Array.isArray(entries) ? (entries as MemoryEntry[]) : [];
}

export async function saveMemories(entries: MemoryEntry[]): Promise<void> {
  await chrome.storage.local.set({ [MEMORY_KEY]: entries });
}

/** The History list, newest-first. Read by the runtime and (directly) the UI. */
export async function getConversationIndex(): Promise<ConversationSummary[]> {
  const result = await chrome.storage.local.get(CONVERSATION_INDEX_KEY);
  const index = result[CONVERSATION_INDEX_KEY];
  return Array.isArray(index) ? (index as ConversationSummary[]) : [];
}

/** Load one full conversation body, or null if it has been pruned/deleted. */
export async function getConversation(id: string): Promise<StoredConversation | null> {
  const key = conversationKey(id);
  const result = await chrome.storage.local.get(key);
  return (result[key] as StoredConversation | undefined) ?? null;
}

/**
 * Upsert a conversation: write its body, refresh its index entry, then prune the
 * index back to MAX_SAVED_CONVERSATIONS (deleting the evicted bodies too). The
 * caller supplies the summary fields it derived from the transcript.
 */
export async function saveConversation(
  record: StoredConversation,
  summary: Omit<ConversationSummary, 'id' | 'createdAt'>,
): Promise<void> {
  await chrome.storage.local.set({ [conversationKey(record.id)]: record });

  const index = await getConversationIndex();
  const existing = index.find((c) => c.id === record.id);
  const entry: ConversationSummary = {
    id: record.id,
    createdAt: existing?.createdAt ?? record.createdAt,
    ...summary,
    // Label assignments are owned by the UI, not the autosave summary — preserve
    // whatever is already on the index entry (or the record) so a per-turn
    // autosave of the active conversation never wipes them.
    labels: existing?.labels ?? record.labels ?? [],
  };
  const next = [...index.filter((c) => c.id !== record.id), entry];
  const { kept, evicted } = pruneIndex(next, MAX_SAVED_CONVERSATIONS);
  await chrome.storage.local.set({ [CONVERSATION_INDEX_KEY]: kept });
  if (evicted.length > 0) {
    await chrome.storage.local.remove(evicted.map(conversationKey));
  }
}

/** The label registry: every user-defined label. Editable directly by the UI. */
export async function getConversationLabels(): Promise<ConversationLabel[]> {
  const result = await chrome.storage.local.get(CONVERSATION_LABELS_KEY);
  const labels = result[CONVERSATION_LABELS_KEY];
  return Array.isArray(labels) ? (labels as ConversationLabel[]) : [];
}

export async function saveConversationLabels(labels: ConversationLabel[]): Promise<void> {
  await chrome.storage.local.set({ [CONVERSATION_LABELS_KEY]: labels });
}

/**
 * Assign labels to one conversation: rewrite its index entry's `labels` and, if
 * the body record still exists, the body's `labels` too (so file export/import
 * carries the assignment). Routed through the runtime to avoid racing autosave.
 */
export async function setConversationLabels(id: string, labels: string[]): Promise<void> {
  const index = await getConversationIndex();
  const next = index.map((c) => (c.id === id ? { ...c, labels } : c));
  await chrome.storage.local.set({ [CONVERSATION_INDEX_KEY]: next });

  const body = await getConversation(id);
  if (body) {
    await chrome.storage.local.set({ [conversationKey(id)]: { ...body, labels } });
  }
}

/** Remove a conversation's body and its index entry. */
export async function deleteConversation(id: string): Promise<void> {
  const index = await getConversationIndex();
  await chrome.storage.local.set({
    [CONVERSATION_INDEX_KEY]: index.filter((c) => c.id !== id),
  });
  await chrome.storage.local.remove(conversationKey(id));
}

/** Remove every saved conversation: all body records and the index itself. */
export async function clearAllConversations(): Promise<void> {
  const index = await getConversationIndex();
  await chrome.storage.local.remove([
    CONVERSATION_INDEX_KEY,
    ...index.map((c) => conversationKey(c.id)),
  ]);
}

/** Seed example skills on first install only (key unset). */
export async function seedSkillsIfEmpty(): Promise<void> {
  const result = await chrome.storage.local.get(SKILLS_KEY);
  if (result[SKILLS_KEY] !== undefined) return;
  const examples: Skill[] = [
    {
      id: 'skill-example-summarize-tabs',
      name: 'summarize-tabs',
      description: 'Synthesize the content of all open tabs into a structured summary.',
      body: [
        '1. Call list_tabs to enumerate open tabs.',
        '2. Call get_all_tab_contents (the user will be asked to approve).',
        '3. Group what you find:',
        '   - **Common themes** appearing across multiple tabs.',
        '   - **Unique findings** per tab worth knowing.',
        '   - **Inaccessible tabs** (blocked, auth-required, or browser-internal) listed briefly.',
        '4. Keep the summary scannable: short sections, bullets, no filler.',
        '5. End with the standard "Source tabs:" citation list with URLs.',
      ].join('\n'),
    },
    {
      id: 'skill-example-research',
      name: 'research',
      description:
        'Research a question on the web: search, read multiple sources, cross-check, and cite.',
      body: [
        '1. If a known site from the directory plausibly covers the topic, start there; otherwise call search_web with a focused query.',
        '2. Read the results page with get_tab_content and pick the 2-3 most credible, relevant results.',
        '3. Navigate to each and extract the relevant facts.',
        '4. Cross-check: note where sources agree and disagree. Do not present a single source as settled fact.',
        '5. If results are thin, refine the query once and search again before giving up.',
        '6. Answer concisely, flag uncertainty explicitly, and end with the "Source tabs:" citation list with URLs.',
      ].join('\n'),
    },
  ];
  await chrome.storage.local.set({ [SKILLS_KEY]: examples });
}

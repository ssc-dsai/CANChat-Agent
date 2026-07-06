// =============================================================================
// Persistence — thin typed accessors over `chrome.storage.local` for the four
// durable collections (settings, hints/sites, skills, memory). These `ba_*`
// keys are exactly what Backup & Restore exports/imports. Everything is
// device-local and never synced; the API key in particular never leaves here.
// =============================================================================

import { pruneIndex } from '../shared/conversationMeta';
import type { CapabilityRegistryEntry } from '../shared/capabilities';
import { migrateSitesToCapabilities } from '../shared/capabilities';
import type {
  ChatMessageView,
  ConversationLabel,
  ConversationSummary,
  LessonEntry,
  MemoryEntry,
  PlanStepStatus,
  Settings,
  SiteEntry,
  Skill,
} from '../shared/types';
import type { LlmMessage } from './llmProvider';

const SETTINGS_KEY = 'ba_settings';
const SITES_KEY = 'ba_sites';
const CAPABILITIES_KEY = 'ba_capabilities';
const SKILLS_KEY = 'ba_skills';
const MEMORY_KEY = 'ba_memory';
const MEMORY_ENABLED_KEY = 'ba_memory_enabled';
const LESSONS_KEY = 'ba_lessons';

export const MEMORY_MAX_ENTRIES = 100;
export const LESSON_MAX_ENTRIES = 50;

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
  /** Model-written 1–2 sentence summary, mirrored into the history index row. */
  summary?: string;
  /** Name of this conversation's tab group, so restore can recreate it by name. */
  groupName?: string;
  /** Pages in the conversation's tab group, reopened on restore so they stay queryable. */
  groupUrls?: { url: string; title: string }[];
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

export async function getCapabilities(): Promise<CapabilityRegistryEntry[]> {
  const result = await chrome.storage.local.get([CAPABILITIES_KEY, SITES_KEY]);
  const caps = result[CAPABILITIES_KEY];
  if (Array.isArray(caps) && caps.length > 0) return caps as CapabilityRegistryEntry[];
  const sites = result[SITES_KEY];
  if (Array.isArray(sites) && sites.length > 0) {
    const migrated = migrateSitesToCapabilities(sites as SiteEntry[]);
    await chrome.storage.local.set({ [CAPABILITIES_KEY]: migrated });
    return migrated;
  }
  return [];
}

export async function saveCapabilities(entries: CapabilityRegistryEntry[]): Promise<void> {
  await chrome.storage.local.set({ [CAPABILITIES_KEY]: entries });
}

export async function migrateLegacySites(): Promise<void> {
  const result = await chrome.storage.local.get([CAPABILITIES_KEY, SITES_KEY]);
  if (result[CAPABILITIES_KEY] !== undefined) return;
  const sites = result[SITES_KEY];
  if (!Array.isArray(sites) || sites.length === 0) return;
  const migrated = migrateSitesToCapabilities(sites as SiteEntry[]);
  await chrome.storage.local.set({ [CAPABILITIES_KEY]: migrated });
}

// --- Auth token storage (session-scoped, cleared on SW restart) ---------------

const AUTH_TOKENS_KEY = 'ba_auth_tokens';
const SESSION_APPROVALS_KEY = 'ba_session_approvals';

export async function getAuthTokens(): Promise<Record<string, string>> {
  try {
    const result = await chrome.storage.session.get(AUTH_TOKENS_KEY);
    return (result[AUTH_TOKENS_KEY] as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

export async function setAuthToken(capabilityId: string, token: string): Promise<void> {
  const tokens = await getAuthTokens();
  tokens[capabilityId] = token;
  await chrome.storage.session.set({ [AUTH_TOKENS_KEY]: tokens });
}

export async function clearAuthToken(capabilityId: string): Promise<void> {
  const tokens = await getAuthTokens();
  delete tokens[capabilityId];
  await chrome.storage.session.set({ [AUTH_TOKENS_KEY]: tokens });
}

// --- Session-level approval tracking (allow for session) ----------------------
// Stores tool names that the user has approved for the current session.
// Cleared on service worker restart.

export async function getSessionApprovals(): Promise<Set<string>> {
  try {
    const result = await chrome.storage.session.get(SESSION_APPROVALS_KEY);
    const arr = result[SESSION_APPROVALS_KEY] as string[] | undefined;
    return new Set(arr ?? []);
  } catch {
    return new Set();
  }
}

export async function addSessionApproval(toolName: string): Promise<void> {
  const approvals = await getSessionApprovals();
  approvals.add(toolName);
  await chrome.storage.session.set({ [SESSION_APPROVALS_KEY]: [...approvals] });
}

export async function clearSessionApprovals(): Promise<void> {
  await chrome.storage.session.set({ [SESSION_APPROVALS_KEY]: [] });
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

export async function getLessons(): Promise<LessonEntry[]> {
  const result = await chrome.storage.local.get(LESSONS_KEY);
  const entries = result[LESSONS_KEY];
  return Array.isArray(entries) ? (entries as LessonEntry[]) : [];
}

export async function saveLessons(entries: LessonEntry[]): Promise<void> {
  await chrome.storage.local.set({ [LESSONS_KEY]: entries.slice(0, LESSON_MAX_ENTRIES) });
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
    {
      id: 'skill-example-search-sharepoint',
      name: 'search-sharepoint',
      description:
        'Search your SharePoint and OneDrive files via the microsoft365_search tool (REST over the signed-in session) — defaults to recent content files, with filters for document type, site, author, and date.',
      body: [
        'Goal: answer a SharePoint/OneDrive file question accurately using the microsoft365_search tool, which calls the SharePoint/Microsoft Search REST API over your signed-in session (no setup or token; covers SharePoint sites AND OneDrive).',
        '',
        'Step 1 — Call microsoft365_search with source:\'files\' and map the request to its parameters (let the tool build the query — do not hand-write KQL):',
        '- topic words → query',
        '- document type → fileType (docx | xlsx | pptx | pdf)',
        '- a specific site/library → sitePath (its URL, e.g. https://contoso.sharepoint.com/sites/Finance)',
        '- "files I edited" / "my files" → editedByMe:true (the tool resolves your identity)',
        '- a date window → since / until (YYYY-MM-DD); file searches default to orderBy:\'date\' (most recent first), use orderBy:\'relevance\' only when explicitly requested',
        '- how many → top (default 10, max 25)',
        '',
        'Step 2 — Resolve the site URL when the user names a site but not its address: ask, or use an open *.sharepoint.com tab. The tenant base comes from Settings or an open SharePoint tab automatically.',
        '',
        'Step 3 — Read the response: results are under "files" (or "filesError" if it failed). If filesError says there is no base URL, tell the user to set the SharePoint base URL in Settings (or open a SharePoint tab) and retry.',
        '',
        'Step 4 — If results are empty or weak, loosen once (drop fileType, or simplify the terms) and retry before reporting nothing.',
        '',
        'Step 5 — Present each hit as: **Title** (linked to its url) — file type, last modified, editor; one-line snippet. End with the standard "Source tabs:" list of the result URLs. Never invent files not in the results.',
        '',
        'Note: this is REST over your cookie session, not the Graph bearer-token API. By default it searches user-content file types (Office docs, PDFs, text/html, images, audio, video), not executables/components like DLLs. The simpler sharepoint_search tool (files only) is an alternative if needed. To read a file\'s full contents, pass its url to read_office_document or read_pdf.',
      ].join('\n'),
    },
    {
      id: 'skill-example-search-mail',
      name: 'search-mail',
      description:
        'Search your Outlook mail via the microsoft365_search endpoint tool (REST over the signed-in session) — filter by sender, time, and keywords. Use Outlook web UI only if the endpoint fails.',
      body: [
        'Goal: answer an email question using the microsoft365_search endpoint tool, which calls Outlook-on-the-web\'s REST endpoint over your signed-in session and returns messages directly (no setup or token). Do NOT open Outlook or use page automation first.',
        '',
        'Step 1 — Always call microsoft365_search with source:\'mail\' first and map the request to its parameters:',
        '- sender → from (name or email, e.g. "Brian Ray")',
        '- topic words → query (matches subject + body)',
        '- a date window → since / until (YYYY-MM-DD)',
        '- "latest" / "most recent" / "last N" → orderBy:\'date\' and top:N (e.g. top:5 for "last five")',
        '',
        'Step 2 — Read the response: messages are under "mail" (or "mailError" if it failed). Each is {subject, from, received, url, preview}.',
        '',
        'Step 3 — Present each match as: **Subject** — sender, date; one-line preview, linked to its url. End with a "Source tabs:" list of the message URLs. Never invent messages. If results are thin, loosen the query once (drop the tightest filter) and retry.',
        '',
        'Fallback — ONLY if the response has a "mailError" or session error: explain that the endpoint could not establish an Outlook/Microsoft 365 session and ask the user to sign in once, then retry. If it still fails, drive the Outlook web UI. Open https://outlook.office.com/mail/ (the task pauses for sign-in if a login wall appears; if an outlook-owa / outlook-live playbook is active, follow it). Focus the search box (press_keys "/", else fill_input it), type a keyword query (e.g. from:"Brian Ray" received>=2024-01-01), press_keys "Enter", then read the list with get_tab_content. These page actions are approval-gated — give a clear reason like "search your mailbox for X".',
      ].join('\n'),
    },
    {
      id: 'skill-example-map',
      name: 'map',
      description: 'Show and manipulate a live map — center/zoom, fly, basemaps, markers, shapes, GeoJSON, animation.',
      body: [
        'There is ONE persistent map (opens automatically in its own tab on first use and is reused every time — never start a new one). All map_* tools act on it and need no approval.',
        '1. Call map_get_state first to see the current center/zoom, basemap, and what is already on the map; build on it rather than resetting.',
        '2. Move the view with map_set_view (instant) or map_fly_to (animated). Switch the basemap with map_set_basemap (osm | carto-light | carto-dark, or a custom tile url).',
        '3. Add elements: map_add_marker (returns an id), map_add_shape (circle/polyline/polygon/rectangle), map_add_geojson (set fit:true to frame it).',
        '4. Animate a marker along a route with map_animate using its id and a path of [lat,lng] points.',
        '5. Use map_fit_bounds to frame multiple features, and map_clear (all | markers | shapes) to reset overlays.',
        '6. Tell the user what you placed/changed; the map stays open for follow-up requests.',
      ].join('\n'),
    },
  ];
  await chrome.storage.local.set({ [SKILLS_KEY]: examples });
}

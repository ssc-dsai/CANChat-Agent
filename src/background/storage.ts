// =============================================================================
// Persistence — thin typed accessors over `chrome.storage.local` for the four
// durable collections (settings, hints/sites, skills, memory). These `ba_*`
// keys are exactly what Backup & Restore exports/imports. Everything is
// device-local and never synced; the API key in particular never leaves here.
// =============================================================================

import type { MemoryEntry, Settings, SiteEntry, Skill } from '../shared/types';

const SETTINGS_KEY = 'ba_settings';
const SITES_KEY = 'ba_sites';
const SKILLS_KEY = 'ba_skills';
const MEMORY_KEY = 'ba_memory';
const MEMORY_ENABLED_KEY = 'ba_memory_enabled';

export const MEMORY_MAX_ENTRIES = 100;

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

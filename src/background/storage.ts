import type { Settings, SiteEntry } from '../shared/types';

const SETTINGS_KEY = 'ba_settings';
const SITES_KEY = 'ba_sites';

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

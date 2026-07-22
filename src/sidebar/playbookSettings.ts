// Load/save for the App playbook library index URL (ba_settings.playbookIndexUrl).
// Shared by the sidebar Skills panel and the Workspace console settings page so
// both edit the same stored value. The default is treated as "unset" so shipping
// a new default in a future release reaches users who never customized it.

import { DEFAULT_PLAYBOOK_INDEX_URL } from '../shared/playbookIndex';

export async function loadIndexUrl(): Promise<string> {
  const r = await chrome.storage.local.get('ba_settings');
  const s = r.ba_settings as { playbookIndexUrl?: string } | undefined;
  return s?.playbookIndexUrl?.trim() || DEFAULT_PLAYBOOK_INDEX_URL;
}

export async function saveIndexUrl(url: string): Promise<void> {
  const r = await chrome.storage.local.get('ba_settings');
  const s = (r.ba_settings as Record<string, unknown>) ?? {};
  const trimmed = url.trim();
  if (trimmed && trimmed !== DEFAULT_PLAYBOOK_INDEX_URL) s.playbookIndexUrl = trimmed;
  else delete s.playbookIndexUrl;
  await chrome.storage.local.set({ ba_settings: s });
}

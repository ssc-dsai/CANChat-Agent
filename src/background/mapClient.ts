// Map client — the service-worker side of the channel to the single map.html
// tab. Mirrors offscreenClient: ensure the page exists (here, a visible tab that
// is kept as a singleton), then post a command and await the typed response.
// The receiving end is src/map/main.ts.

import type { MapResponse } from '../shared/messages';

const MAP_URL = chrome.runtime.getURL('map.html');

// The one map workspace tab. Cached across calls; revalidated each time so a
// closed tab is transparently reopened.
let mapTabId: number | null = null;

async function findMapTab(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ url: MAP_URL });
    return tabs[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Round-trip a no-op command to see whether the map page is loaded and listening. */
async function ping(): Promise<boolean> {
  try {
    const res = (await chrome.runtime.sendMessage({ target: 'map', type: 'map_command', command: 'ping', args: {} })) as
      | MapResponse
      | undefined;
    return Boolean(res?.ok);
  } catch {
    return false; // "receiving end does not exist" until the page finishes loading
  }
}

/**
 * Guarantee exactly one map tab exists and is ready. Reuses a cached or already
 * open map tab; otherwise opens one and waits (polling ping) for it to load.
 */
async function ensureMapTab(): Promise<void> {
  if (mapTabId !== null) {
    try {
      await chrome.tabs.get(mapTabId);
      if (await ping()) return;
    } catch {
      mapTabId = null;
    }
  }
  const existing = await findMapTab();
  if (existing !== null) {
    mapTabId = existing;
    if (await ping()) return;
  } else {
    const tab = await chrome.tabs.create({ url: MAP_URL, active: true });
    mapTabId = tab.id ?? null;
  }
  for (let i = 0; i < 50; i++) {
    if (await ping()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The map workspace did not finish loading.');
}

/** Send a command to the single map and return its response (opening the map if needed). */
export async function mapCommand(command: string, args: Record<string, unknown> = {}): Promise<MapResponse> {
  try {
    await ensureMapTab();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  try {
    return (await chrome.runtime.sendMessage({ target: 'map', type: 'map_command', command, args })) as MapResponse;
  } catch (e) {
    mapTabId = null; // tab likely closed mid-flight; next call reopens it
    return { ok: false, error: String(e) };
  }
}

// IndexedDB persistence for imported backup data, in the add-in's own origin.
// IndexedDB (not localStorage) because repositories carry multi-MB int8 vector
// blobs; structured clone stores the Int8Array directly. Two stores: `config`
// (settings/skills/sites/memory) and `repos` (one ParsedRepo per repo name).

import type { ParsedBackup, ParsedRepo } from '../../src/shared/backupFormat';
import type { MemoryEntry, Settings, SiteEntry, Skill } from '../../src/shared/types';

const DB_NAME = 'canchat-word-addin';
const DB_VERSION = 1;
const CONFIG = 'config';
const REPOS = 'repos';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CONFIG)) db.createObjectStore(CONFIG);
      if (!db.objectStoreNames.contains(REPOS)) db.createObjectStore(REPOS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value, key));
}
async function get<T>(store: string, key: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}
async function allKeys(store: string): Promise<string[]> {
  return tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()).then((k) => k.map(String));
}

/** Replace all stored config + repositories with a freshly parsed backup. */
export async function importBackup(parsed: ParsedBackup): Promise<void> {
  if (parsed.settings) await put(CONFIG, 'settings', parsed.settings);
  await put(CONFIG, 'skills', parsed.skills);
  await put(CONFIG, 'sites', parsed.sites);
  await put(CONFIG, 'memory', parsed.memory);
  // Wipe existing repos, then write the imported set (replace, like the extension).
  const existing = await allKeys(REPOS);
  await Promise.all(existing.map((name) => tx(REPOS, 'readwrite', (s) => s.delete(name))));
  await Promise.all(parsed.repos.map((r) => put(REPOS, r.name, r)));
}

export const loadSettings = () => get<Settings>(CONFIG, 'settings');
export const loadSkills = () => get<Skill[]>(CONFIG, 'skills').then((s) => s ?? []);
export const loadSites = () => get<SiteEntry[]>(CONFIG, 'sites').then((s) => s ?? []);
export const loadMemory = () => get<MemoryEntry[]>(CONFIG, 'memory').then((m) => m ?? []);

export const getRepo = (name: string) => get<ParsedRepo>(REPOS, name);

/** Repository names with their document/chunk counts, for the picker. */
export async function listRepos(): Promise<Array<{ name: string; docs: number; chunks: number }>> {
  const names = await allKeys(REPOS);
  const repos = await Promise.all(names.map((n) => getRepo(n)));
  return repos
    .filter((r): r is ParsedRepo => !!r)
    .map((r) => ({ name: r.name, docs: r.meta.docs?.length ?? 0, chunks: r.meta.chunkCount ?? 0 }));
}

/** Persist just the endpoint settings (e.g. after editing the base URL / key). */
export async function saveSettings(settings: Settings): Promise<void> {
  await put(CONFIG, 'settings', settings);
}

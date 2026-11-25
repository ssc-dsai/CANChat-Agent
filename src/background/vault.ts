// =============================================================================
// Encryption vault — lifecycle around the crypto primitives (shared/crypto.ts),
// implementing specification.md §8.8 with a *user-derived* key:
//
//   passphrase --PBKDF2--> KEK --wraps--> DEK --AES-GCM--> sensitive values
//
// The wrapped DEK + salt live in chrome.storage.local (`ba_vault`); the unlocked
// raw DEK is cached in chrome.storage.session (`ba_vault_dek`) — memory-only,
// gone when the browser closes, but surviving service-worker eviction so the
// user only unlocks once per browser session. The passphrase is never stored.
//
// The vault is OPT-IN: with no `ba_vault`, vaultEncrypt/vaultDecrypt pass values
// through unchanged, so existing installs are unaffected. Cryptographic erasure
// (§8.8) = destroying the wrapped DEK, which is what eraseVault does.
//
// Idle auto-lock: the unlocked DEK is forgotten once no secret has been
// encrypted or decrypted for `autoLockMinutes` (default 30; 0 = never; stored
// on the vault record). It is enforced lazily on every DEK read — so a stale
// DEK is never used, in any context — and proactively by a chrome.alarms tick
// once the service worker calls registerVaultAutoLock(), which wipes the DEK
// from session memory even if nothing touches the vault.
// =============================================================================

import {
  base64ToBytes,
  bytesToBase64,
  decryptString,
  DEFAULT_PBKDF2_ITERATIONS,
  deriveKek,
  encryptString,
  exportDekRaw,
  generateDek,
  importDek,
  isEncrypted,
  newSalt,
  unwrapDek,
  wrapDek,
  type WrappedDek,
} from '../shared/crypto';

const VAULT_KEY = 'ba_vault';
const DEK_SESSION_KEY = 'ba_vault_dek';
/** Epoch ms of the last vault use (session storage, alongside the DEK). */
const LAST_ACTIVE_SESSION_KEY = 'ba_vault_last_active';

export const VAULT_AUTOLOCK_ALARM = 'vault-auto-lock';
export const DEFAULT_AUTO_LOCK_MINUTES = 30;
export const MAX_AUTO_LOCK_MINUTES = 24 * 60;
/** Don't rewrite the last-active stamp more often than this (every decrypt would otherwise write). */
const ACTIVITY_WRITE_THROTTLE_MS = 30_000;

interface VaultRecord {
  version: 1;
  saltB64: string;
  iterations: number;
  wrapped: WrappedDek;
  /** Idle minutes before the unlocked key is forgotten. Absent = DEFAULT_AUTO_LOCK_MINUTES; 0 = never. */
  autoLockMinutes?: number;
}

/** Clamp a stored/requested auto-lock setting to a whole number in [0, MAX]. Absent/invalid = default. */
export function normalizeAutoLockMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_AUTO_LOCK_MINUTES;
  return Math.min(MAX_AUTO_LOCK_MINUTES, Math.round(value));
}

/**
 * Pure timing rule for the idle auto-lock: true once `minutes` have passed
 * since `lastActiveMs`. `minutes` 0 disables it. A missing stamp is NOT
 * expired (the caller re-stamps it), and a clock that moved backwards is
 * treated as fresh activity rather than as infinitely idle.
 */
export function isIdleExpired(lastActiveMs: number | undefined, nowMs: number, minutes: number): boolean {
  if (!(minutes > 0)) return false;
  if (typeof lastActiveMs !== 'number' || !Number.isFinite(lastActiveMs)) return false;
  return nowMs - lastActiveMs >= minutes * 60_000;
}

export type VaultState = 'none' | 'locked' | 'unlocked';

async function readVault(): Promise<VaultRecord | null> {
  // chrome.storage can be absent in some contexts the store runs in (notably the
  // offscreen document on certain Chrome builds). Mirror readSessionDekRaw's
  // tolerance: with no storage API there is no readable vault record, so report
  // "no vault" instead of throwing a cryptic `reading 'local'` TypeError that
  // would abort every repoAdd/repoSearch through assertVaultUsable. When the API
  // *is* present, behaviour is unchanged and the vault stays fully enforced.
  if (!chrome?.storage?.local) return null;
  const r = await chrome.storage.local.get(VAULT_KEY);
  return (r[VAULT_KEY] as VaultRecord | undefined) ?? null;
}

async function readSessionValue<T>(key: string): Promise<T | undefined> {
  try {
    const r = await chrome.storage.session.get(key);
    return r[key] as T | undefined;
  } catch {
    return undefined;
  }
}

let lastActivityWrite = 0;

async function stampActivity(now: number): Promise<void> {
  lastActivityWrite = now;
  try {
    await chrome.storage.session.set({ [LAST_ACTIVE_SESSION_KEY]: now });
  } catch {
    // session storage unavailable — nothing cached to protect
  }
}

/**
 * The cached raw DEK, or null when locked. Applies the idle auto-lock: a DEK
 * idle past the vault's timeout is wiped here and reported as locked, so no
 * caller ever decrypts with it again.
 */
async function readSessionDekRaw(vault: VaultRecord | null): Promise<Uint8Array | null> {
  const b64 = await readSessionValue<string>(DEK_SESSION_KEY);
  if (!b64) return null;
  const now = Date.now();
  const lastActive = await readSessionValue<number>(LAST_ACTIVE_SESSION_KEY);
  if (isIdleExpired(lastActive, now, normalizeAutoLockMinutes(vault?.autoLockMinutes))) {
    await lockVault();
    return null;
  }
  // Unlocked before auto-lock existed (no stamp yet): start the clock now.
  if (typeof lastActive !== 'number') await stampActivity(now);
  return base64ToBytes(b64);
}

/** Whether a vault exists and, if so, whether it is currently unlocked. */
export async function getVaultState(): Promise<VaultState> {
  const vault = await readVault();
  if (!vault) return 'none';
  return (await readSessionDekRaw(vault)) ? 'unlocked' : 'locked';
}

/** The vault's idle auto-lock setting in minutes (0 = never). Default when no vault. */
export async function getVaultAutoLockMinutes(): Promise<number> {
  return normalizeAutoLockMinutes((await readVault())?.autoLockMinutes);
}

/** Change the idle auto-lock (minutes, 0 = never). Stored on the vault record; needs a vault. */
export async function setVaultAutoLockMinutes(minutes: number): Promise<void> {
  const vault = await readVault();
  if (!vault) throw new Error('No vault to configure.');
  const autoLockMinutes = normalizeAutoLockMinutes(minutes);
  await chrome.storage.local.set({ [VAULT_KEY]: { ...vault, autoLockMinutes } satisfies VaultRecord });
  // Count the change itself as activity so a shorter timeout doesn't lock instantly.
  if (await readSessionValue<string>(DEK_SESSION_KEY)) await stampActivity(Date.now());
}

/**
 * Lock the vault now if it has been idle past its timeout. Returns the state
 * afterwards. Called on each auto-lock alarm tick (and safe to call anytime).
 */
export async function enforceVaultIdleLock(): Promise<VaultState> {
  const state = await getVaultState(); // readSessionDekRaw does the actual locking
  if (state !== 'unlocked') clearAutoLockAlarm();
  return state;
}

// chrome.alarms may be missing (tests, some contexts) and its calls return a
// promise in MV3; never let either surface as an error — the lazy check on
// every DEK read is the guarantee, the alarm only wipes the key sooner.
function quietly(run: () => unknown): void {
  try {
    const p = run() as { catch?: (f: () => void) => unknown } | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // alarms unavailable in this context
  }
}

function scheduleAutoLockAlarm(): void {
  quietly(() => chrome.alarms?.create?.(VAULT_AUTOLOCK_ALARM, { periodInMinutes: 1 }));
}

function clearAutoLockAlarm(): void {
  quietly(() => chrome.alarms?.clear?.(VAULT_AUTOLOCK_ALARM));
}

/**
 * Service-worker hook: listen for the auto-lock alarm and check once at
 * startup. Must be called synchronously at the top level of the service worker
 * so Chrome wakes it for the alarm. Without it the idle lock is still enforced
 * on every vault read, but the DEK stays in session memory until then.
 */
export function registerVaultAutoLock(): void {
  if (!chrome?.alarms?.onAlarm) return;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === VAULT_AUTOLOCK_ALARM) void enforceVaultIdleLock();
  });
  void enforceVaultIdleLock().then((state) => {
    if (state === 'unlocked') scheduleAutoLockAlarm();
  });
}

export async function isVaultUnlocked(): Promise<boolean> {
  return (await getVaultState()) === 'unlocked';
}

/** Create a new vault from a passphrase. Fails if one already exists. */
export async function setupVault(passphrase: string): Promise<void> {
  if (!passphrase) throw new Error('A passphrase is required.');
  if (await readVault()) throw new Error('A vault already exists. Change or erase it instead.');
  const salt = newSalt();
  const iterations = DEFAULT_PBKDF2_ITERATIONS;
  const dek = await generateDek();
  const kek = await deriveKek(passphrase, salt, iterations);
  const wrapped = await wrapDek(kek, dek);
  const record: VaultRecord = {
    version: 1,
    saltB64: bytesToBase64(salt),
    iterations,
    wrapped,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  };
  await chrome.storage.local.set({ [VAULT_KEY]: record });
  await cacheDek(dek);
}

/** Unlock an existing vault. Returns false on a wrong passphrase (never throws for that). */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const vault = await readVault();
  if (!vault) throw new Error('No vault to unlock.');
  const kek = await deriveKek(passphrase, base64ToBytes(vault.saltB64), vault.iterations);
  try {
    const dek = await unwrapDek(kek, vault.wrapped); // GCM auth throws on wrong passphrase
    await cacheDek(dek);
    return true;
  } catch {
    return false;
  }
}

/** Forget the unlocked DEK (re-lock). The vault record stays; unlock again to use it. */
export async function lockVault(): Promise<void> {
  try {
    await chrome.storage.session.remove(DEK_SESSION_KEY);
    await chrome.storage.session.remove(LAST_ACTIVE_SESSION_KEY);
  } catch {
    // session storage unavailable — nothing cached anyway
  }
  lastActivityWrite = 0;
  clearAutoLockAlarm();
}

/** Re-wrap the DEK under a new passphrase (fresh salt). Requires the current one. */
export async function changePassphrase(current: string, next: string): Promise<boolean> {
  const vault = await readVault();
  if (!vault) throw new Error('No vault to change.');
  if (!next) throw new Error('A new passphrase is required.');
  const curKek = await deriveKek(current, base64ToBytes(vault.saltB64), vault.iterations);
  let dek: CryptoKey;
  try {
    dek = await unwrapDek(curKek, vault.wrapped);
  } catch {
    return false; // wrong current passphrase
  }
  const salt = newSalt();
  const iterations = DEFAULT_PBKDF2_ITERATIONS;
  const kek = await deriveKek(next, salt, iterations);
  const wrapped = await wrapDek(kek, dek);
  await chrome.storage.local.set({
    [VAULT_KEY]: {
      version: 1,
      saltB64: bytesToBase64(salt),
      iterations,
      wrapped,
      ...(vault.autoLockMinutes !== undefined ? { autoLockMinutes: vault.autoLockMinutes } : {}),
    } satisfies VaultRecord,
  });
  await cacheDek(dek);
  return true;
}

/**
 * Cryptographic erasure (§8.8): destroy the wrapped DEK and the session copy.
 * Any values encrypted under it become permanently unrecoverable — callers that
 * want the plaintext back must re-enter it afterwards.
 */
export async function eraseVault(): Promise<void> {
  await chrome.storage.local.remove(VAULT_KEY);
  await lockVault();
}

async function cacheDek(dek: CryptoKey): Promise<void> {
  const raw = await exportDekRaw(dek);
  await chrome.storage.session.set({ [DEK_SESSION_KEY]: bytesToBase64(raw) });
  await stampActivity(Date.now());
  scheduleAutoLockAlarm();
}

/** The unlocked DEK (null when no vault, locked, or idle-expired). Each use counts as activity. */
async function unlockedDek(): Promise<CryptoKey | null> {
  const vault = await readVault();
  if (!vault) return null;
  const raw = await readSessionDekRaw(vault);
  if (!raw) return null;
  const now = Date.now();
  if (Math.abs(now - lastActivityWrite) >= ACTIVITY_WRITE_THROTTLE_MS) await stampActivity(now);
  return importDek(raw);
}

/**
 * Encrypt a value if the vault is unlocked; otherwise return it unchanged.
 * "Unchanged" covers both the no-vault case (opt-in: stay plaintext) and the
 * locked case (callers should not be writing secrets while locked; the UI gates
 * that). Never double-encrypts an already-enveloped value.
 */
export async function vaultEncrypt(value: string): Promise<string> {
  if (!value || isEncrypted(value)) return value;
  const dek = await unlockedDek();
  return dek ? encryptString(dek, value) : value;
}

/**
 * Decrypt a value if it is an envelope and the vault is unlocked. Returns the
 * value unchanged when it is plaintext (no vault / legacy). Returns `null` when
 * the value IS encrypted but the vault is locked or erased — the signal for
 * "need unlock" (e.g. getSettings then treats the config as unavailable, which
 * correctly renders the agent inert until the user unlocks).
 */
export async function vaultDecrypt(value: string): Promise<string | null> {
  if (!isEncrypted(value)) return value;
  const dek = await unlockedDek();
  if (!dek) return null;
  try {
    return await decryptString(dek, value);
  } catch {
    return null; // tampered or DEK mismatch
  }
}

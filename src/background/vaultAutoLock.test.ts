import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changePassphrase,
  DEFAULT_AUTO_LOCK_MINUTES,
  enforceVaultIdleLock,
  getVaultAutoLockMinutes,
  getVaultState,
  isIdleExpired,
  lockVault,
  normalizeAutoLockMinutes,
  registerVaultAutoLock,
  setupVault,
  setVaultAutoLockMinutes,
  unlockVault,
  vaultDecrypt,
  vaultEncrypt,
  VAULT_AUTOLOCK_ALARM,
} from './vault';

const MIN = 60_000;

describe('isIdleExpired (pure timing rule)', () => {
  const t0 = 1_700_000_000_000;
  it('is not expired before the timeout and is expired at/after it', () => {
    expect(isIdleExpired(t0, t0 + 29 * MIN, 30)).toBe(false);
    expect(isIdleExpired(t0, t0 + 30 * MIN - 1, 30)).toBe(false);
    expect(isIdleExpired(t0, t0 + 30 * MIN, 30)).toBe(true);
    expect(isIdleExpired(t0, t0 + 300 * MIN, 30)).toBe(true);
  });
  it('0 (or a non-positive value) disables it', () => {
    expect(isIdleExpired(t0, t0 + 10_000 * MIN, 0)).toBe(false);
    expect(isIdleExpired(t0, t0 + 10_000 * MIN, -5)).toBe(false);
  });
  it('a missing stamp or a clock that went backwards is not expiry', () => {
    expect(isIdleExpired(undefined, t0, 30)).toBe(false);
    expect(isIdleExpired(t0, t0 - 60 * MIN, 30)).toBe(false);
  });
});

describe('normalizeAutoLockMinutes', () => {
  it('defaults absent/invalid values and clamps the rest', () => {
    expect(normalizeAutoLockMinutes(undefined)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(normalizeAutoLockMinutes('10')).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(normalizeAutoLockMinutes(-1)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(normalizeAutoLockMinutes(Number.NaN)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    expect(normalizeAutoLockMinutes(0)).toBe(0);
    expect(normalizeAutoLockMinutes(12.4)).toBe(12);
    expect(normalizeAutoLockMinutes(10_000_000)).toBe(24 * 60);
  });
});

// --- Integration with a stubbed chrome.storage and a controllable clock -------

function area(store: Record<string, unknown>) {
  return {
    async get(key: string) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(obj: Record<string, unknown>) {
      Object.assign(store, obj);
    },
    async remove(key: string) {
      delete store[key];
    },
  };
}

let session: Record<string, unknown>;
let alarmListeners: Array<(a: { name: string }) => void>;
let alarms: Map<string, unknown>;
const PASS = 'correct horse battery staple';

beforeEach(() => {
  session = {};
  alarmListeners = [];
  alarms = new Map();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T09:00:00Z'));
  vi.stubGlobal('chrome', {
    storage: { local: area({}), session: area(session) },
    alarms: {
      create: vi.fn(async (name: string, info: unknown) => void alarms.set(name, info)),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      onAlarm: { addListener: (fn: (a: { name: string }) => void) => alarmListeners.push(fn) },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (minutes: number) => vi.setSystemTime(Date.now() + minutes * MIN);

describe('vault idle auto-lock', () => {
  it('new vaults default to 30 minutes and schedule the auto-lock alarm', async () => {
    await setupVault(PASS);
    expect(await getVaultAutoLockMinutes()).toBe(30);
    expect(alarms.has(VAULT_AUTOLOCK_ALARM)).toBe(true);
  });

  it('locks after the idle timeout, wiping the cached key', async () => {
    await setupVault(PASS);
    const sealed = await vaultEncrypt('sk-secret');
    advance(29);
    expect(await getVaultState()).toBe('unlocked');
    advance(2); // 31 minutes since the last use
    expect(await vaultDecrypt(sealed)).toBeNull();
    expect(await getVaultState()).toBe('locked');
    expect(session.ba_vault_dek).toBeUndefined();
    expect(alarms.has(VAULT_AUTOLOCK_ALARM)).toBe(false);
    // Unlocking again works and restarts the clock.
    expect(await unlockVault(PASS)).toBe(true);
    expect(await vaultDecrypt(sealed)).toBe('sk-secret');
  });

  it('using a secret counts as activity and pushes the deadline out', async () => {
    await setupVault(PASS);
    const sealed = await vaultEncrypt('sk-secret');
    for (let i = 0; i < 6; i++) {
      advance(20); // 120 minutes in total, never 30 idle
      expect(await vaultDecrypt(sealed)).toBe('sk-secret');
    }
    advance(30);
    expect(await getVaultState()).toBe('locked');
  });

  it('merely checking the state is not activity', async () => {
    await setupVault(PASS);
    for (let i = 0; i < 3; i++) {
      advance(10);
      await getVaultState();
    }
    expect(await getVaultState()).toBe('locked');
  });

  it('honours a configured timeout, and 0 turns it off', async () => {
    await setupVault(PASS);
    await setVaultAutoLockMinutes(5);
    expect(await getVaultAutoLockMinutes()).toBe(5);
    advance(4);
    expect(await getVaultState()).toBe('unlocked');
    advance(1);
    expect(await getVaultState()).toBe('locked');

    await unlockVault(PASS);
    await setVaultAutoLockMinutes(0);
    advance(7 * 24 * 60);
    expect(await getVaultState()).toBe('unlocked');
  });

  it('changing the passphrase keeps the auto-lock setting', async () => {
    await setupVault(PASS);
    await setVaultAutoLockMinutes(12);
    expect(await changePassphrase(PASS, 'another long passphrase')).toBe(true);
    expect(await getVaultAutoLockMinutes()).toBe(12);
  });

  it('a key cached before auto-lock existed (no stamp) starts its clock on first read', async () => {
    await setupVault(PASS);
    delete session.ba_vault_last_active;
    advance(60);
    expect(await getVaultState()).toBe('unlocked');
    advance(31);
    expect(await getVaultState()).toBe('locked');
  });

  it('the alarm handler registered by the service worker locks an idle vault', async () => {
    await setupVault(PASS);
    registerVaultAutoLock();
    expect(alarmListeners).toHaveLength(1);
    advance(31);
    alarmListeners[0]({ name: 'something-else' });
    await Promise.resolve();
    expect(session.ba_vault_dek).toBeDefined(); // other alarms are ignored
    alarmListeners[0]({ name: VAULT_AUTOLOCK_ALARM });
    await vi.waitFor(() => expect(session.ba_vault_dek).toBeUndefined());
    expect(await enforceVaultIdleLock()).toBe('locked');
  });

  it('lockVault clears the activity stamp and the alarm', async () => {
    await setupVault(PASS);
    await lockVault();
    expect(session.ba_vault_last_active).toBeUndefined();
    expect(alarms.has(VAULT_AUTOLOCK_ALARM)).toBe(false);
  });
});

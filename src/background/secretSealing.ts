// =============================================================================
// Sealing secrets at rest through the encryption vault (vault.ts), driven by
// the single field list in shared/secretFields.ts so the vault and the
// secrets-excluded backup always agree on what a secret is.
//
//   seal*   — encrypt every listed field (vaultEncrypt: no-op with no vault or
//             while locked, never double-encrypts).
//   unseal* — decrypt every listed field. Plaintext (legacy / no vault) passes
//             through. A field that IS ciphertext but can't be decrypted (vault
//             locked or erased) is reported via `locked: true` and left blank,
//             so readers fail closed — they never see ciphertext as a secret.
// =============================================================================

import type { CapabilityRegistryEntry } from '../shared/capabilities';
import { isEncrypted } from '../shared/crypto';
import {
  CAPABILITY_SECRET_FIELDS,
  MODEL_PROFILE_SECRET_FIELDS,
  SETTINGS_SECRET_FIELDS,
  SITE_SECRET_FIELDS,
  TOKEN_RECORD_SECRET_FIELDS,
  type TokenRecordKind,
} from '../shared/secretFields';
import type { ModelProfile, Settings, SiteEntry } from '../shared/types';
import { vaultDecrypt, vaultEncrypt } from './vault';

export interface Unsealed<T> {
  value: T;
  /** True when at least one field was ciphertext that could not be decrypted. */
  locked: boolean;
}

type AnyRecord = Record<string, unknown>;

async function sealFields<T extends object>(record: T, fields: readonly string[]): Promise<T> {
  const out = { ...record } as AnyRecord;
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string' && v) out[f] = await vaultEncrypt(v);
  }
  return out as T;
}

async function unsealFields<T extends object>(record: T, fields: readonly string[]): Promise<Unsealed<T>> {
  const out = { ...record } as AnyRecord;
  let locked = false;
  for (const f of fields) {
    const v = out[f];
    if (typeof v !== 'string' || !isEncrypted(v)) continue;
    const dec = await vaultDecrypt(v);
    if (dec === null) {
      locked = true;
      // `apiKey` is a required string; optional secrets become absent so
      // "blank = fall back to apiKey" style `??` defaults keep working.
      if (f === 'apiKey') out[f] = '';
      else delete out[f];
    } else {
      out[f] = dec;
    }
  }
  return { value: out as T, locked };
}

// --- Settings (+ model profiles) ---------------------------------------------

export async function sealSettings(settings: Settings): Promise<Settings> {
  const out = await sealFields(settings, SETTINGS_SECRET_FIELDS);
  if (Array.isArray(settings.modelProfiles)) {
    out.modelProfiles = await Promise.all(
      settings.modelProfiles.map((p) => sealFields<ModelProfile>(p, MODEL_PROFILE_SECRET_FIELDS)),
    );
  }
  return out;
}

export async function unsealSettings(settings: Settings): Promise<Unsealed<Settings>> {
  const top = await unsealFields(settings, SETTINGS_SECRET_FIELDS);
  let locked = top.locked;
  if (Array.isArray(settings.modelProfiles)) {
    const profiles: ModelProfile[] = [];
    for (const p of settings.modelProfiles) {
      const r = await unsealFields<ModelProfile>(p, MODEL_PROFILE_SECRET_FIELDS);
      locked ||= r.locked;
      profiles.push(r.value);
    }
    top.value.modelProfiles = profiles;
  }
  return { value: top.value, locked };
}

// --- Capabilities / legacy sites ---------------------------------------------

export async function sealCapability(c: CapabilityRegistryEntry): Promise<CapabilityRegistryEntry> {
  const out = await sealFields(c, CAPABILITY_SECRET_FIELDS);
  if (c.authConfig) out.authConfig = await sealFields(c.authConfig, Object.keys(c.authConfig));
  return out;
}

export async function unsealCapability(c: CapabilityRegistryEntry): Promise<Unsealed<CapabilityRegistryEntry>> {
  const r = await unsealFields(c, CAPABILITY_SECRET_FIELDS);
  let locked = r.locked;
  if (c.authConfig) {
    const a = await unsealFields(c.authConfig, Object.keys(c.authConfig));
    locked ||= a.locked;
    r.value.authConfig = a.value;
  }
  // A token that can't be decrypted is absent (unsealFields deletes it), so
  // auth resolution reports "not configured" rather than sending ciphertext.
  return { value: r.value, locked };
}

export async function sealSite(s: SiteEntry): Promise<SiteEntry> {
  return sealFields(s, SITE_SECRET_FIELDS);
}

export async function unsealSite(s: SiteEntry): Promise<Unsealed<SiteEntry>> {
  return unsealFields(s, SITE_SECRET_FIELDS);
}

export async function sealCapabilities(list: CapabilityRegistryEntry[]): Promise<CapabilityRegistryEntry[]> {
  return Promise.all(list.map(sealCapability));
}

export async function unsealCapabilities(list: CapabilityRegistryEntry[]): Promise<Unsealed<CapabilityRegistryEntry[]>> {
  const out: CapabilityRegistryEntry[] = [];
  let locked = false;
  for (const c of list) {
    const r = await unsealCapability(c);
    locked ||= r.locked;
    out.push(r.value);
  }
  return { value: out, locked };
}

// --- Credential records under their own storage keys --------------------------

/** Encrypt the secret fields of a Graph / provider / AWS SSO token record. */
export async function sealTokenRecord<T extends object>(kind: TokenRecordKind, record: T): Promise<T> {
  return sealFields(record, TOKEN_RECORD_SECRET_FIELDS[kind]);
}

/**
 * Decrypt a token record's secret fields. Returns null when any of them is
 * ciphertext the vault can't open (locked/erased) — callers treat that as
 * "not signed in", which is the graceful outcome while the vault is locked.
 */
export async function unsealTokenRecord<T extends object>(kind: TokenRecordKind, record: T): Promise<T | null> {
  const r = await unsealFields(record, TOKEN_RECORD_SECRET_FIELDS[kind]);
  return r.locked ? null : r.value;
}

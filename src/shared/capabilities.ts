import type { SiteEntry } from './types';

export type CapabilityKind = 'bookmark' | 'mcp' | 'rest' | 'webmcp' | 'model' | 'knowledge' | 'skill';
export type AuthMethod = 'none' | 'browser-session' | 'oauth' | 'token';
export type TrustLevel = 'public' | 'verified' | 'enterprise' | 'local';
export type CapabilitySource = 'manual' | 'bookmark-discovery' | 'webmcp-discovery' | 'remote-registry';

export interface CapabilityRegistryEntry {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  url?: string;
  authMethod?: AuthMethod;
  authConfig?: Record<string, string>;
  availableTools?: string[];
  availableSkills?: string[];
  trustLevel?: TrustLevel;
  tags?: string[];
  source: CapabilitySource;
  discoveredAt?: string;
  lastSeenAt?: string;
  mcpUrl?: string;
  mcpToken?: string;
  searchUrlTemplate?: string;
}

/**
 * Trust-level hierarchy: higher index = more trusted.
 * Enforcement: a tool from a capability with trust level below the required
 * threshold prompts for approval even if the tool is normally read-only.
 */
const TRUST_ORDER: TrustLevel[] = ['public', 'verified', 'enterprise', 'local'];

export function trustLevelIndex(level: TrustLevel | undefined): number {
  const idx = level ? TRUST_ORDER.indexOf(level) : -1;
  return idx < 0 ? 0 : idx; // undefined -> public-equivalent (lowest trust)
}

/** True when `capability` is trusted enough to skip approval for its tools. */
export function isTrustedForAutoApproval(capability: CapabilityKind | undefined, trustLevel: TrustLevel | undefined): boolean {
  const _cap = capability;
  void _cap;
  return trustLevelIndex(trustLevel) >= trustLevelIndex('enterprise');
}

/**
 * Human-readable label for each trust level.
 * Shown in approval prompts and capability lists.
 */
export function trustLevelLabel(level: TrustLevel | undefined): string {
  switch (level) {
    case 'public': return 'Public (untrusted)';
    case 'verified': return 'Verified';
    case 'enterprise': return 'Enterprise';
    case 'local': return 'Local (fully trusted)';
    default: return 'Unknown';
  }
}

/**
 * Human-readable label for each auth method.
 */
export function authMethodLabel(method: AuthMethod | undefined): string {
  switch (method) {
    case 'none': return 'No auth';
    case 'browser-session': return 'Browser session';
    case 'oauth': return 'OAuth';
    case 'token': return 'Token';
    default: return 'Not configured';
  }
}

/** Check whether a capability has auth credentials configured. */
export function hasAuthConfig(c: CapabilityRegistryEntry): boolean {
  if (c.authMethod === 'none' || !c.authMethod) return true;
  if (c.authMethod === 'browser-session') return true;
  if (c.authMethod === 'token') return !!c.authConfig?.token;
  return false;
}

/**
 * Resolve the effective auth for a capability — merges stored config with
 * any runtime-provided token to produce a request-ready auth header.
 */
export function resolveAuth(c: CapabilityRegistryEntry): { method: AuthMethod; token?: string } | null {
  if (!c.authMethod || c.authMethod === 'none' || c.authMethod === 'browser-session') {
    return { method: c.authMethod ?? 'none' };
  }
  if (c.authMethod === 'token') {
    const token = c.authConfig?.token;
    if (!token) return null;
    return { method: 'token', token };
  }
  return null;
}

export function migrateSiteToCapability(s: SiteEntry): CapabilityRegistryEntry {
  return {
    id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: s.mcpUrl ? 'mcp' : 'bookmark',
    name: s.name,
    description: s.description,
    url: s.url || undefined,
    authMethod: s.mcpToken ? 'token' : 'browser-session',
    authConfig: s.mcpToken ? { token: s.mcpToken } : undefined,
    trustLevel: 'local',
    tags: s.mcpUrl ? ['mcp'] : [],
    source: 'manual',
    discoveredAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    mcpUrl: s.mcpUrl,
    mcpToken: s.mcpToken,
    searchUrlTemplate: s.searchUrlTemplate,
  };
}

export function migrateSitesToCapabilities(sites: SiteEntry[]): CapabilityRegistryEntry[] {
  if (!Array.isArray(sites) || sites.length === 0) return [];
  return sites.map(migrateSiteToCapability);
}

export function toSiteEntry(c: CapabilityRegistryEntry): SiteEntry {
  return {
    id: c.id,
    name: c.name,
    url: c.url ?? '',
    description: c.description,
    searchUrlTemplate: c.searchUrlTemplate,
    mcpUrl: c.mcpUrl,
    mcpToken: c.mcpToken,
  };
}

// =============================================================================
// AWS IAM Identity Center (SSO) configuration for Bedrock Mantle connections.
// Pure helpers shared by the background (background/awsSso.ts, which runs the
// sign-in and mints credentials) and the settings forms. Nothing here is a
// secret: the start URL, account ID, and permission-set name only say *where*
// to sign in — the tokens and role credentials never leave the service worker.
// =============================================================================

import type { Settings } from './types';

export interface AwsSsoConfig {
  /** Identity Center AWS access portal URL, e.g. https://d-1234567890.awsapps.com/start */
  startUrl: string;
  /** Region the Identity Center instance lives in. */
  ssoRegion: string;
  /** 12-digit AWS account that holds the Bedrock access. */
  accountId: string;
  /** Permission set name to exchange the sign-in for (GetRoleCredentials' role_name). */
  roleName: string;
}

type SsoFields = Pick<Settings, 'bedrockMantle' | 'awsSso' | 'awsSsoStartUrl' | 'awsSsoRegion' | 'awsAccountId' | 'awsSsoRoleName' | 'awsRegion'>;

/** True when the connection authenticates to Bedrock Mantle through IAM Identity Center. */
export function usesAwsSso(s: SsoFields | undefined): boolean {
  return Boolean(s?.bedrockMantle && s.awsSso);
}

/**
 * The complete SSO config for a connection, or null when any part is missing.
 * A blank SSO region falls back to the Bedrock region (the common case: one
 * region for both).
 */
export function ssoConfigFromSettings(s: SsoFields): AwsSsoConfig | null {
  if (!usesAwsSso(s)) return null;
  const cfg = {
    startUrl: s.awsSsoStartUrl?.trim().replace(/\/+$/, '') ?? '',
    ssoRegion: s.awsSsoRegion?.trim() || s.awsRegion?.trim() || '',
    accountId: s.awsAccountId?.trim() ?? '',
    roleName: s.awsSsoRoleName?.trim() ?? '',
  };
  return isValidSsoConfig(cfg) ? cfg : null;
}

/**
 * Whether a saved connection has everything it needs to make a request:
 * a model plus a subscription, an SSO config, or an endpoint and API key.
 * Bedrock Mantle derives its endpoint from the region when baseUrl is blank.
 */
export function isConnectionConfigured(s: Settings | undefined): boolean {
  if (!s?.model) return false;
  if (s.subscriptionProvider) return true;
  if (usesAwsSso(s)) return ssoConfigFromSettings(s) !== null;
  return Boolean((s.baseUrl || s.bedrockMantle) && s.apiKey);
}

const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * Shape check for a config arriving over runtime messaging. The region is
 * interpolated into AWS hostnames (oidc.<region>.amazonaws.com), so it must be
 * a bare region name — anything else could steer the user's token elsewhere.
 */
export function isValidSsoConfig(c: unknown): c is AwsSsoConfig {
  if (!c || typeof c !== 'object') return false;
  const { startUrl, ssoRegion, accountId, roleName } = c as Record<string, unknown>;
  if (typeof startUrl !== 'string' || typeof ssoRegion !== 'string' || typeof accountId !== 'string' || typeof roleName !== 'string') {
    return false;
  }
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && AWS_REGION_RE.test(ssoRegion) && /^\d{12}$/.test(accountId) && roleName.length > 0;
}

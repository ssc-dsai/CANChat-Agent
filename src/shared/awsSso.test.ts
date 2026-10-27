import { describe, expect, it } from 'vitest';
import { isConnectionConfigured, isValidSsoConfig, ssoConfigFromSettings } from './awsSso';
import type { Settings } from './types';

const sso: Settings = {
  baseUrl: '',
  apiKey: '',
  model: 'anthropic.claude-sonnet-5',
  bedrockMantle: true,
  awsRegion: 'ca-central-1',
  awsSso: true,
  awsSsoStartUrl: ' https://d-1234567890.awsapps.com/start/ ',
  awsAccountId: '123456789012',
  awsSsoRoleName: 'BedrockUser',
};

describe('AWS SSO config', () => {
  it('builds a config, defaulting the SSO region to the Bedrock region', () => {
    expect(ssoConfigFromSettings(sso)).toEqual({
      startUrl: 'https://d-1234567890.awsapps.com/start',
      ssoRegion: 'ca-central-1',
      accountId: '123456789012',
      roleName: 'BedrockUser',
    });
    expect(ssoConfigFromSettings({ ...sso, awsSsoRegion: 'us-east-1' })?.ssoRegion).toBe('us-east-1');
  });

  it('is null unless SSO is on, on Mantle, and complete', () => {
    expect(ssoConfigFromSettings({ ...sso, awsSso: false })).toBeNull();
    expect(ssoConfigFromSettings({ ...sso, bedrockMantle: false })).toBeNull();
    expect(ssoConfigFromSettings({ ...sso, awsSsoRoleName: ' ' })).toBeNull();
  });

  it('rejects regions and URLs that could redirect the token to another host', () => {
    const base = { startUrl: 'https://d-1.awsapps.com/start', ssoRegion: 'ca-central-1', accountId: '123456789012', roleName: 'R' };
    expect(isValidSsoConfig(base)).toBe(true);
    expect(isValidSsoConfig({ ...base, ssoRegion: 'evil.example.com/#' })).toBe(false);
    expect(isValidSsoConfig({ ...base, startUrl: 'http://d-1.awsapps.com/start' })).toBe(false);
    expect(isValidSsoConfig({ ...base, accountId: '1234' })).toBe(false);
    expect(isValidSsoConfig(null)).toBe(false);
  });

  it('treats a complete SSO connection as configured without an API key', () => {
    expect(isConnectionConfigured(sso)).toBe(true);
    expect(isConnectionConfigured({ ...sso, awsAccountId: '' })).toBe(false);
    expect(isConnectionConfigured({ ...sso, awsSso: false })).toBe(false);
    expect(isConnectionConfigured({ ...sso, awsSso: false, apiKey: 'k' })).toBe(true);
    expect(isConnectionConfigured({ baseUrl: 'https://x', apiKey: 'k', model: '' })).toBe(false);
  });
});

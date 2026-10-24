import { describe, expect, it } from 'vitest';
import { migrateBedrockConverse, migrateSettingsFromConverse } from '../../shared/bedrockMantle';
import type { ModelProtocol, Settings } from '../../shared/types';
import { getAdapter } from './index';

const apiKeySettings: Settings = {
  baseUrl: '',
  apiKey: 'bedrock-api-key',
  model: 'openai.gpt-oss-120b',
  protocol: 'chat-completions',
  bedrockMantle: true,
  awsRegion: 'us-east-1',
};

const sigv4Settings: Settings = {
  ...apiKeySettings,
  apiKey: 'secret-access-key',
  awsAccessKeyId: 'AKIDEXAMPLE',
};

const hi = [{ role: 'user' as const, content: 'hi' }];

describe('Bedrock Mantle adapter', () => {
  it('sends Chat Completions to the region default with a Bedrock API key', async () => {
    const req = await getAdapter(apiKeySettings).buildRequest(apiKeySettings, hi);
    expect(req.url).toBe('https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer bedrock-api-key');
    expect((req.body as { model: string }).model).toBe('openai.gpt-oss-120b');
  });

  it('routes each protocol to its Mantle path', async () => {
    const cases: Array<[ModelProtocol, string]> = [
      ['responses', 'https://bedrock-mantle.us-west-2.api.aws/v1/responses'],
      ['anthropic-messages', 'https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages'],
    ];
    for (const [protocol, url] of cases) {
      const s = { ...apiKeySettings, protocol, awsRegion: 'us-west-2' };
      const req = await getAdapter(s).buildRequest(s, hi);
      expect(req.url).toBe(url);
    }
  });

  it('sends the Bedrock API key as x-api-key for Anthropic Messages', async () => {
    const s: Settings = { ...apiKeySettings, protocol: 'anthropic-messages', model: 'anthropic.claude-sonnet-5' };
    const req = await getAdapter(s).buildRequest(s, hi);
    expect(req.headers['x-api-key']).toBe('bedrock-api-key');
    expect(req.headers['anthropic-version']).toBeDefined();
  });

  it('honors a base URL override (e.g. the /openai/v1 prefix)', async () => {
    const s = { ...apiKeySettings, baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1/' };
    const req = await getAdapter(s).buildRequest(s, hi);
    expect(req.url).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions');
  });

  it('ignores an Azure api-version on Mantle', async () => {
    const s = { ...apiKeySettings, apiVersion: '2024-02-01' };
    const req = await getAdapter(s).buildRequest(s, hi);
    expect(req.url).not.toContain('api-version');
    expect(req.headers['api-key']).toBeUndefined();
  });

  it('signs with SigV4 for the bedrock-mantle service when an access key ID is set', async () => {
    const req = await getAdapter(sigv4Settings).buildRequest(sigv4Settings, hi);
    expect(req.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request/);
    expect(req.headers['x-amz-date']).toBeDefined();
    expect(req.headers['x-amz-security-token']).toBeUndefined();
    expect(JSON.stringify(req.headers)).not.toContain('secret-access-key');
  });

  it('drops the x-api-key header and keeps the secret out when signing Anthropic Messages', async () => {
    const s: Settings = { ...sigv4Settings, protocol: 'anthropic-messages', model: 'anthropic.claude-sonnet-5' };
    const req = await getAdapter(s).buildRequest(s, hi);
    expect(req.headers['x-api-key']).toBeUndefined();
    expect(req.headers.Authorization).toContain('/bedrock-mantle/aws4_request');
    expect(JSON.stringify(req.headers)).not.toContain('secret-access-key');
  });

  it('includes a session token when set', async () => {
    const s = { ...sigv4Settings, awsSessionToken: 'session-token-value' };
    const req = await getAdapter(s).buildRequest(s, hi);
    expect(req.headers['x-amz-security-token']).toBe('session-token-value');
  });

  it('requires a region and a key, and rejects Gemini native', async () => {
    const build = (s: Settings) => getAdapter(s).buildRequest(s, hi);
    await expect(build({ ...apiKeySettings, awsRegion: undefined })).rejects.toThrow(/region/i);
    await expect(build({ ...apiKeySettings, apiKey: '' })).rejects.toThrow(/Bedrock API key/);
    await expect(build({ ...sigv4Settings, apiKey: '' })).rejects.toThrow(/secret access key/i);
    await expect(build({ ...apiKeySettings, protocol: 'gemini-native' })).rejects.toThrow(/Gemini/);
  });

  it('leaves non-Mantle connections on the plain adapter', async () => {
    const s: Settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', model: 'm' };
    const req = await getAdapter(s).buildRequest(s, hi);
    expect(req.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('parses responses with the wrapped protocol', () => {
    const msg = getAdapter(apiKeySettings).parseResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
    expect(msg.content).toBe('ok');
  });
});

describe('migrateBedrockConverse', () => {
  const legacy = {
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    apiKey: 'secret',
    model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    protocol: 'bedrock-converse' as unknown as ModelProtocol,
    awsRegion: 'us-east-1',
    awsAccessKeyId: 'AKIDEXAMPLE',
  };

  it('moves Claude models to Anthropic Messages on Mantle and drops the runtime endpoint', () => {
    expect(migrateBedrockConverse(legacy)).toEqual({
      ...legacy,
      protocol: 'anthropic-messages',
      bedrockMantle: true,
      baseUrl: '',
    });
  });

  it('moves other models to Chat Completions', () => {
    expect(migrateBedrockConverse({ ...legacy, model: 'meta.llama3-70b-instruct-v1:0' }).protocol).toBe('chat-completions');
  });

  it('leaves current connections untouched', () => {
    const s: Settings = { baseUrl: 'x', apiKey: 'k', model: 'm', protocol: 'responses' };
    expect(migrateBedrockConverse(s)).toBe(s);
  });

  it('migrates model profiles too', () => {
    const settings: Settings = {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      modelProfiles: [{ id: 'p1', name: 'Bedrock', ...legacy }],
    };
    const out = migrateSettingsFromConverse(settings);
    expect(out.protocol).toBeUndefined();
    expect(out.modelProfiles?.[0]).toMatchObject({ protocol: 'anthropic-messages', bedrockMantle: true, baseUrl: '' });
  });
});

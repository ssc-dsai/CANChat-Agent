import { describe, expect, it } from 'vitest';
import type { Settings } from '../shared/types';
import { apiVersion, authHeaders, buildUrl } from './llmProvider';

const base: Settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt' };

describe('apiVersion (Azure mode detection)', () => {
  it('is undefined for a standard OpenAI endpoint', () => {
    expect(apiVersion(base)).toBeUndefined();
  });

  it('returns the trimmed version string when set', () => {
    expect(apiVersion({ ...base, apiVersion: '  2024-02-01 ' })).toBe('2024-02-01');
  });

  it('treats a blank string as not-Azure', () => {
    expect(apiVersion({ ...base, apiVersion: '   ' })).toBeUndefined();
  });
});

describe('buildUrl', () => {
  it('appends only the route path for standard OpenAI', () => {
    expect(buildUrl('https://api.example.com/v1', '/chat/completions', undefined)).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('appends the api-version query param in Azure mode', () => {
    expect(
      buildUrl(
        'https://name.openai.azure.com/openai/deployments/gpt4o',
        '/chat/completions',
        '2024-02-01',
      ),
    ).toBe(
      'https://name.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-02-01',
    );
  });
});

describe('authHeaders', () => {
  it('uses Bearer auth for standard OpenAI', () => {
    expect(authHeaders('sk-test', undefined)).toEqual({ Authorization: 'Bearer sk-test' });
  });

  it('uses the api-key header in Azure mode', () => {
    expect(authHeaders('sk-test', '2024-02-01')).toEqual({ 'api-key': 'sk-test' });
  });
});

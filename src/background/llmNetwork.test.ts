import { describe, expect, it } from 'vitest';
import type { Settings } from '../shared/types';
import { resolve } from './llmNetwork';

const base = { baseUrl: 'https://api.provider.example/v1', apiKey: 'main-key', model: 'm' } as Settings;

describe('resolve (endpoint + key per service)', () => {
  it('uses the main endpoint and key when there is no override', () => {
    expect(resolve(base, 'embedding')).toEqual({ base: 'https://api.provider.example/v1', key: 'main-key' });
  });

  it('lets the main key follow an override on the same origin', () => {
    const s = { ...base, embeddingBaseUrl: 'https://api.provider.example/embeddings-deploy/' };
    expect(resolve(s, 'embedding')).toEqual({ base: 'https://api.provider.example/embeddings-deploy', key: 'main-key' });
  });

  it('never sends the main key to a different host', () => {
    const s = { ...base, embeddingBaseUrl: 'https://attacker.example/v1' };
    expect(resolve(s, 'embedding').key).toBe('');
    const t = { ...base, transcriptionBaseUrl: 'http://localhost:9000/v1' };
    expect(resolve(t, 'transcription').key).toBe('');
  });

  it('uses the override’s own key when set', () => {
    const s = { ...base, embeddingBaseUrl: 'https://other.example/v1', embeddingApiKey: 'emb-key' };
    expect(resolve(s, 'embedding')).toEqual({ base: 'https://other.example/v1', key: 'emb-key' });
  });
});

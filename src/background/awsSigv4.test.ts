import { describe, expect, it } from 'vitest';
import { canonicalUri, signRequest } from './awsSigv4';

describe('signRequest', () => {
  it('produces a well-formed SigV4 Authorization header', async () => {
    const headers = await signRequest(
      'POST',
      'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions',
      '{"messages":[]}',
      'us-east-1',
      'bedrock-mantle',
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    );

    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers['x-amz-security-token']).toBeUndefined();
  });

  it('includes and signs the session token when present', async () => {
    const headers = await signRequest(
      'POST',
      'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions',
      '{}',
      'us-east-1',
      'bedrock-mantle',
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session-token-value' },
    );

    expect(headers['x-amz-security-token']).toBe('session-token-value');
    expect(headers.Authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
  });

  it('changes the signature when the body or the secret key changes', async () => {
    const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
    const a = await signRequest('POST', 'https://host.example.com/v1/chat/completions', '{"a":1}', 'us-east-1', 'bedrock-mantle', creds);
    const b = await signRequest('POST', 'https://host.example.com/v1/chat/completions', '{"a":2}', 'us-east-1', 'bedrock-mantle', creds);
    expect(a.Authorization).not.toBe(b.Authorization);

    const c = await signRequest('POST', 'https://host.example.com/v1/chat/completions', '{"a":1}', 'us-east-1', 'bedrock-mantle', {
      ...creds,
      secretAccessKey: 'a-different-secret',
    });
    expect(a.Authorization).not.toBe(c.Authorization);
  });

  it('scopes the signature to the given region and service', async () => {
    const headers = await signRequest(
      'POST',
      'https://bedrock-mantle.eu-west-1.api.aws/v1/chat/completions',
      '{}',
      'eu-west-1',
      'bedrock-mantle',
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    );
    expect(headers.Authorization).toContain('/eu-west-1/bedrock-mantle/aws4_request');
  });
});

describe('canonicalUri', () => {
  it('double-encodes reserved characters in path segments (%3A -> %253A)', () => {
    expect(canonicalUri('/v1/models/openai.gpt-oss-120b-1%3A0')).toBe('/v1/models/openai.gpt-oss-120b-1%253A0');
  });

  it('leaves plain paths and the root untouched', () => {
    expect(canonicalUri('/v1/chat/completions')).toBe('/v1/chat/completions');
    expect(canonicalUri('')).toBe('/');
    expect(canonicalUri('/')).toBe('/');
  });
});

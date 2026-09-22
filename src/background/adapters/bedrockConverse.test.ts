import { describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/types';
import type { LlmMessage } from '../llmTypes';
import { bedrockConverseAdapter } from './bedrockConverse';

const settings: Settings = {
  baseUrl: '',
  apiKey: 'secret-access-key',
  model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  protocol: 'bedrock-converse',
  awsRegion: 'us-east-1',
  awsAccessKeyId: 'AKIDEXAMPLE',
};

describe('bedrockConverseAdapter.buildRequest', () => {
  it('builds the default region endpoint and signs the request', async () => {
    const req = await bedrockConverseAdapter.buildRequest(settings, [{ role: 'user', content: 'hi' }]);
    expect(req.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse',
    );
    expect(req.headers.Authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/');
    expect(req.headers['x-amz-date']).toBeDefined();
    expect(req.headers['x-amz-security-token']).toBeUndefined();
  });

  it('honors a custom endpoint override', async () => {
    const req = await bedrockConverseAdapter.buildRequest(
      { ...settings, baseUrl: 'https://vpce-example.bedrock-runtime.us-east-1.vpce.amazonaws.com' },
      [{ role: 'user', content: 'hi' }],
    );
    expect(req.url).toBe(
      'https://vpce-example.bedrock-runtime.us-east-1.vpce.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse',
    );
  });

  it('includes and signs a session token when set', async () => {
    const req = await bedrockConverseAdapter.buildRequest(
      { ...settings, awsSessionToken: 'session-token-value' },
      [{ role: 'user', content: 'hi' }],
    );
    expect(req.headers['x-amz-security-token']).toBe('session-token-value');
  });

  it('throws without region/access key/secret', async () => {
    await expect(bedrockConverseAdapter.buildRequest({ ...settings, awsRegion: undefined }, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /region/i,
    );
    await expect(bedrockConverseAdapter.buildRequest({ ...settings, awsAccessKeyId: undefined }, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /access key/i,
    );
    await expect(bedrockConverseAdapter.buildRequest({ ...settings, apiKey: '' }, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /secret access key/i,
    );
  });

  it('pulls the system message out to a top-level system field', async () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ];
    const req = await bedrockConverseAdapter.buildRequest(settings, messages);
    expect(req.body).toMatchObject({
      system: [{ text: 'be helpful' }],
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    });
  });

  it('maps an assistant tool_call to a toolUse block and merges consecutive tool results into one user turn', async () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'weather in SF and NYC?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '72F sunny' },
      { role: 'tool', tool_call_id: 'call_2', content: '60F rainy' },
    ];
    const req = await bedrockConverseAdapter.buildRequest(settings, messages);
    const body = req.body as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { toolUse: { toolUseId: 'call_1', name: 'get_weather', input: { city: 'SF' } } },
        { toolUse: { toolUseId: 'call_2', name: 'get_weather', input: { city: 'NYC' } } },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { toolResult: { toolUseId: 'call_1', content: [{ text: '72F sunny' }] } },
        { toolResult: { toolUseId: 'call_2', content: [{ text: '60F rainy' }] } },
      ],
    });
  });

  it('translates tools into toolSpec entries', async () => {
    const tools = [{ type: 'function' as const, function: { name: 'f', description: 'd', parameters: { type: 'object' } } }];
    const req = await bedrockConverseAdapter.buildRequest(settings, [{ role: 'user', content: 'hi' }], tools);
    expect((req.body as { toolConfig: unknown }).toolConfig).toEqual({
      tools: [{ toolSpec: { name: 'f', description: 'd', inputSchema: { json: { type: 'object' } } } }],
    });
  });

  it('includes inferenceConfig only when temperature/maxTokens are set', async () => {
    const bare = await bedrockConverseAdapter.buildRequest(settings, [{ role: 'user', content: 'hi' }]);
    expect(bare.body).not.toHaveProperty('inferenceConfig');

    const withConfig = await bedrockConverseAdapter.buildRequest(
      { ...settings, temperature: 0.5, maxTokens: 300 },
      [{ role: 'user', content: 'hi' }],
    );
    expect((withConfig.body as { inferenceConfig: unknown }).inferenceConfig).toEqual({ temperature: 0.5, maxTokens: 300 });
  });
});

describe('bedrockConverseAdapter.parseResponse', () => {
  it('joins text blocks and extracts toolUse blocks as tool_calls', () => {
    const message = bedrockConverseAdapter.parseResponse({
      output: {
        message: {
          content: [
            { text: 'Let me check.' },
            { toolUse: { toolUseId: 'tooluse_1', name: 'get_weather', input: { city: 'SF' } } },
          ],
        },
      },
      stopReason: 'tool_use',
    });
    expect(message.content).toBe('Let me check.');
    expect(message.tool_calls).toEqual([
      { id: 'tooluse_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
  });

  it('throws when there is no output content', () => {
    expect(() => bedrockConverseAdapter.parseResponse({ output: { message: { content: [] } } })).toThrow();
  });

  it('throws with the partial content when stopped by max_tokens and no tool call was made', () => {
    let thrown: unknown;
    try {
      bedrockConverseAdapter.parseResponse({
        output: { message: { content: [{ text: 'partial' }] } },
        stopReason: 'max_tokens',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ content: 'partial' });
    expect((thrown as Error).message).toContain('Increase Max tokens');
  });
});

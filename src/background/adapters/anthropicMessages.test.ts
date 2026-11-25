import { describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/types';
import type { LlmMessage } from '../llmTypes';
import { withTrailingState } from '../workingState';
import { anthropicMessagesAdapter } from './anthropicMessages';

const settings: Settings = { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', model: 'claude-opus-5' };

describe('anthropicMessagesAdapter.buildRequest', () => {
  it('pulls the system message out to a top-level system field', async () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ];
    const req = await anthropicMessagesAdapter.buildRequest(settings, messages);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.body).toMatchObject({
      system: 'be helpful',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
  });

  it('preserves a versioned OpenCode Zen base URL', async () => {
    const req = await anthropicMessagesAdapter.buildRequest(
      { ...settings, baseUrl: 'https://opencode.ai/zen/v1/', model: 'claude-sonnet-4-6' },
      [{ role: 'user', content: 'hi' }],
    );
    expect(req.url).toBe('https://opencode.ai/zen/v1/messages');
  });

  it('defaults max_tokens when unset', async () => {
    const req = await anthropicMessagesAdapter.buildRequest(settings, [{ role: 'user', content: 'hi' }]);
    expect((req.body as { max_tokens: number }).max_tokens).toBe(4096);
  });

  it('uses settings.maxTokens when set', async () => {
    const req = await anthropicMessagesAdapter.buildRequest({ ...settings, maxTokens: 500 }, [{ role: 'user', content: 'hi' }]);
    expect((req.body as { max_tokens: number }).max_tokens).toBe(500);
  });

  it('omits temperature for Claude deployments that reject it', async () => {
    const req = await anthropicMessagesAdapter.buildRequest(
      { ...settings, temperature: 0 },
      [{ role: 'user', content: 'hi' }],
    );
    expect(req.body).not.toHaveProperty('temperature');
  });

  it('maps an assistant tool_call to a tool_use block and merges consecutive tool results into one user turn', async () => {
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
    const req = await anthropicMessagesAdapter.buildRequest(settings, messages);
    const body = req.body as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
        { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'NYC' } },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '72F sunny' },
        { type: 'tool_result', tool_use_id: 'call_2', content: '60F rainy' },
      ],
    });
  });

  it('translates a data-url image_url part into an Anthropic base64 image block', async () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ];
    const req = await anthropicMessagesAdapter.buildRequest(settings, messages);
    const body = req.body as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('includes translated tools with input_schema', async () => {
    const tools = [{ type: 'function' as const, function: { name: 'f', description: 'd', parameters: { type: 'object' } } }];
    const req = await anthropicMessagesAdapter.buildRequest(settings, [{ role: 'user', content: 'hi' }], tools);
    expect((req.body as { tools: unknown }).tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
  });
});

describe('anthropicMessagesAdapter prompt caching', () => {
  type Block = { type: string; text?: string; cache_control?: unknown };
  type Body = { system: unknown; messages: Array<{ role: string; content: Block[] }> };
  const toolTurn: LlmMessage[] = [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_tabs', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ];

  it('puts the state after tool results in the same user turn, with a breakpoint just before it', async () => {
    const req = await anthropicMessagesAdapter.buildRequest(settings, withTrailingState(toolTurn, 'Steps: 1/20'));
    const body = req.body as Body;
    expect(body.system).toEqual([{ type: 'text', text: 'be helpful', cache_control: { type: 'ephemeral' } }]);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const last = body.messages[2].content;
    expect(last.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(last[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(last[1].text).toContain('Steps: 1/20');
    expect(last[1].cache_control).toBeUndefined();
  });

  it('splits the state off a plain user message and marks the text before it', async () => {
    const msgs = withTrailingState([{ role: 'system', content: 'be helpful' }, { role: 'user', content: 'go' }], 'S');
    const body = (await anthropicMessagesAdapter.buildRequest(settings, msgs)).body as Body;
    const content = body.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'go', cache_control: { type: 'ephemeral' } });
    expect(content[1].text?.startsWith('<working_state>')).toBe(true);
  });

  it('sends the same bytes before the breakpoint on consecutive steps', async () => {
    const step1 = (await anthropicMessagesAdapter.buildRequest(settings, withTrailingState(toolTurn.slice(0, 2), 'Steps: 0/20'))).body as Body;
    const step2 = (await anthropicMessagesAdapter.buildRequest(settings, withTrailingState(toolTurn, 'Steps: 1/20'))).body as Body;
    expect(step2.system).toEqual(step1.system);
    // Step 1's first user block (marked there) is the same block in step 2, unmarked.
    const { cache_control: _marker, ...first } = step1.messages[0].content[0];
    expect(step2.messages[0].content[0]).toEqual(first);
  });

  it('caches on Bedrock Mantle hosts', async () => {
    const mantle = { ...settings, baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/anthropic' };
    const body = (await anthropicMessagesAdapter.buildRequest(mantle, withTrailingState(toolTurn, 'S'))).body as Body;
    expect(Array.isArray(body.system)).toBe(true);
  });

  it('adds no markers on other Messages-compatible servers', async () => {
    const other = { ...settings, baseUrl: 'https://opencode.ai/zen/v1' };
    const body = (await anthropicMessagesAdapter.buildRequest(other, withTrailingState(toolTurn, 'S'))).body as Body;
    expect(body.system).toBe('be helpful');
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  it('adds no markers to requests without a working-state block', async () => {
    const body = (await anthropicMessagesAdapter.buildRequest(settings, toolTurn)).body as Body;
    expect(body.system).toBe('be helpful');
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });
});

describe('anthropicMessagesAdapter.parseResponse', () => {
  it('joins text blocks and extracts tool_use blocks as tool_calls', () => {
    const message = anthropicMessagesAdapter.parseResponse({
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
      ],
    });
    expect(message.content).toBe('Let me check.');
    expect(message.tool_calls).toEqual([
      { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
  });

  it('throws when content is empty', () => {
    expect(() => anthropicMessagesAdapter.parseResponse({ content: [] })).toThrow();
  });
});

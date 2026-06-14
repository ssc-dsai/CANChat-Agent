import { describe, expect, it } from 'vitest';
import { parseBody } from './mcpClient';

describe('parseBody (MCP transport response parsing)', () => {
  it('parses a single JSON object into one message', () => {
    const out = parseBody('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}', 'application/json');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
  });

  it('parses a JSON array of messages', () => {
    const out = parseBody('[{"jsonrpc":"2.0","id":1},{"jsonrpc":"2.0","id":2}]', 'application/json');
    expect(out.map((m) => m.id)).toEqual([1, 2]);
  });

  it('extracts JSON payloads from SSE data lines', () => {
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}',
      '',
      ': keep-alive',
      '',
    ].join('\n');
    const out = parseBody(sse, 'text/event-stream');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(3);
  });

  it('ignores non-JSON SSE data lines without throwing', () => {
    const sse = 'data: not-json\n\ndata: {"jsonrpc":"2.0","id":4}\n';
    const out = parseBody(sse, 'text/event-stream');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(4);
  });

  it('returns an empty array for an empty body', () => {
    expect(parseBody('', 'application/json')).toEqual([]);
    expect(parseBody('   ', 'application/json')).toEqual([]);
  });

  it('handles multiple SSE events', () => {
    const sse = 'data: {"id":1}\n\ndata: {"id":2}\n\n';
    const out = parseBody(sse, 'text/event-stream');
    expect(out.map((m) => m.id)).toEqual([1, 2]);
  });
});

